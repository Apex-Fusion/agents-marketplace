// Background fetches under the amplification rules (Part 1 Section 9; Part 2 Section 8.5):
// - only `https` URLs, without credentials;
// - the host must resolve to public unicast addresses only; the check runs for each connection and
//   each redirect, and the connection goes to the checked address (no second DNS lookup);
// - no redirect to another host (another host name or port), at most 5 redirects;
// - at most 1 MiB of body, at most 10 seconds for the whole fetch;
// - at most one fetch per host each minute (a fetch with its redirects counts once).
// DNS and HTTP are injected, so that tests need no network (transport.ts has the real ones).

import { createHash } from "node:crypto";
import { once } from "node:events";
import { isIP } from "node:net";
import { isPublicUnicast } from "./address.js";
import type { Clock } from "./clock.js";

export const FETCH_LIMITS = {
  /** 1 MiB. */
  maxBytes: 1_048_576,
  timeoutMs: 10_000,
  /** At most one fetch per host in this interval. */
  hostIntervalMs: 60_000,
  maxRedirects: 5,
} as const;

export type FetchLimits = { readonly [K in keyof typeof FETCH_LIMITS]: number };

export type FetchFailure =
  /** The URL or a redirect target is not `https`, or it carries credentials. */
  | "notHttps"
  /** The host resolves to an address that is not public unicast. */
  | "privateAddress"
  /** The host name does not resolve. */
  | "dns"
  /** A redirect names another host. */
  | "otherHost"
  | "tooManyRedirects"
  /** The body is larger than the size limit. */
  | "tooLarge"
  /** The fetch took longer than the time limit. */
  | "timeout"
  /** A connection, TLS or HTTP error. */
  | "network";

export class FetchError extends Error {
  constructor(
    readonly code: FetchFailure,
    message: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** The host cannot be reached now, so the other probes of the same job would fail too. */
export function hostUnreachable(e: unknown): boolean {
  return e instanceof FetchError && (e.code === "privateAddress" || e.code === "dns" || e.code === "timeout" || e.code === "network" || e.code === "notHttps");
}

export interface TransportRequest {
  readonly url: URL;
  /** The checked address; the transport connects to it and to nothing else. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  /** Lowercase header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Discards the rest of the body and closes the connection. */
  close(): void;
}

/** One HTTPS exchange, without redirects and without content decoding. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** The addresses of a host name. */
export type Lookup = (hostname: string) => Promise<ReadonlyArray<{ readonly address: string; readonly family: 4 | 6 }>>;

export interface FetchRequest {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface FetchResult {
  /** The URL that gave the body (after redirects). */
  readonly url: string;
  readonly status: number;
  /** Lowercase header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** Start of the fetch, POSIX milliseconds. */
  readonly fetchedAt: number;
  /** SHA-256 of the body, lowercase hex. */
  readonly sha256: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Spaces fetches to each host: a fetch starts at least `intervalMs` after the previous one started. */
export class HostRateLimiter {
  private readonly nextStart = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly clock: Clock,
    private readonly intervalMs: number = FETCH_LIMITS.hostIntervalMs,
  ) {}

  /** Waits for the next free slot of `host` and takes it. Callers for one host get slots in call order. */
  take(host: string): Promise<void> {
    const mine = (this.queues.get(host) ?? Promise.resolve()).then(async () => {
      const wait = (this.nextStart.get(host) ?? -Infinity) - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.nextStart.set(host, this.clock.now() + this.intervalMs);
    });
    const tail = mine.catch(() => undefined);
    this.queues.set(host, tail);
    void tail.then(() => {
      if (this.queues.get(host) === tail) this.queues.delete(host);
      if (this.nextStart.size > 4096) {
        const now = this.clock.now();
        for (const [h, at] of this.nextStart) if (at <= now) this.nextStart.delete(h);
      }
    });
    return mine;
  }
}

function httpsUrl(text: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw new FetchError("notHttps", "the URL is not valid");
  }
  if (url.protocol !== "https:") throw new FetchError("notHttps", "only https URLs are fetched");
  if (url.username || url.password) throw new FetchError("notHttps", "a URL with credentials is not fetched");
  return url;
}

/** Host name without the brackets of an IPv6 literal. */
const bareHost = (url: URL): string => (url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname).toLowerCase();

export interface SafeFetcherOptions {
  readonly lookup: Lookup;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly limits?: Partial<FetchLimits>;
}

export class SafeFetcher {
  readonly limits: FetchLimits;
  private readonly limiter: HostRateLimiter;

  constructor(private readonly options: SafeFetcherOptions) {
    this.limits = { ...FETCH_LIMITS, ...options.limits };
    this.limiter = new HostRateLimiter(options.clock, this.limits.hostIntervalMs);
  }

  /** Fetches `target` under the rules above; throws FetchError. Any HTTP status is a result. */
  async fetch(target: string, request: FetchRequest = {}): Promise<FetchResult> {
    let url = httpsUrl(target);
    await this.limiter.take(bareHost(url));
    const fetchedAt = this.options.clock.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    let method = request.method ?? "GET";
    let body = request.body ?? null;
    try {
      for (let redirects = 0; ; redirects++) {
        const { address, family } = await this.publicAddress(url, controller.signal);
        const response = await this.options.transport({
          url,
          address,
          family,
          method,
          headers: { "accept-encoding": "identity", ...request.headers },
          body,
          signal: controller.signal,
        });
        const location = response.headers.location;
        if (!REDIRECTS.has(response.status) || location === undefined) {
          const bytes = await this.readBody(response);
          return {
            url: url.href,
            status: response.status,
            headers: response.headers,
            body: bytes,
            fetchedAt,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }
        response.close();
        if (redirects >= this.limits.maxRedirects) throw new FetchError("tooManyRedirects", `more than ${this.limits.maxRedirects} redirects`);
        const next = httpsUrl(location, url);
        if (bareHost(next) !== bareHost(url) || next.port !== url.port) throw new FetchError("otherHost", "a redirect names another host");
        if (response.status === 303 || (method === "POST" && (response.status === 301 || response.status === 302))) {
          method = "GET";
          body = null;
        }
        url = next;
      }
    } catch (e) {
      if (e instanceof FetchError) throw e;
      if (controller.signal.aborted) throw new FetchError("timeout", `the fetch took longer than ${this.limits.timeoutMs} ms`);
      throw new FetchError("network", e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  /** The address to connect to: every address of the host must be public unicast. */
  private async publicAddress(url: URL, signal: AbortSignal): Promise<{ address: string; family: 4 | 6 }> {
    const host = bareHost(url);
    const literal = isIP(host);
    let addresses: ReadonlyArray<{ readonly address: string; readonly family: 4 | 6 }>;
    if (literal) {
      addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
    } else {
      if (signal.aborted) throw new FetchError("timeout", `the fetch took longer than ${this.limits.timeoutMs} ms`);
      const timedOut = once(signal, "abort").then(() => Promise.reject(new FetchError("timeout", `the fetch took longer than ${this.limits.timeoutMs} ms`)));
      // The race below handles a rejection before the lookup ends; this handles one after it.
      timedOut.catch(() => undefined);
      try {
        addresses = await Promise.race([this.options.lookup(host), timedOut]);
      } catch (e) {
        if (e instanceof FetchError) throw e;
        throw new FetchError("dns", "the host name does not resolve");
      }
    }
    if (addresses.length === 0) throw new FetchError("dns", "the host name has no address");
    if (!addresses.every((a) => isPublicUnicast(a.address))) throw new FetchError("privateAddress", "the host resolves to an address that is not public unicast");
    return addresses[0]!;
  }

  private async readBody(response: TransportResponse): Promise<Uint8Array> {
    const max = this.limits.maxBytes;
    const declared = response.headers["content-length"];
    if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > max) {
      response.close();
      throw new FetchError("tooLarge", `the body is larger than ${max} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > max) {
        response.close();
        throw new FetchError("tooLarge", `the body is larger than ${max} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
