// A fake network for the background jobs: DNS answers, TXT records and HTTPS handlers by method and
// URL, and a clock whose sleep advances time at once. Nothing here opens a socket.

import { once } from "node:events";
import { createPrivateKey, sign } from "node:crypto";
import type { Clock } from "../../src/fetch/clock.js";
import { SafeFetcher, type FetchLimits, type Lookup, type Transport, type TransportRequest, type TransportResponse } from "../../src/fetch/fetcher.js";
import type { TxtLookup } from "../../src/fetch/linkage.js";

export const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

export class TestClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(public t: number = T0) {}
  now = (): number => this.t;
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

export interface FakeResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
  /** Body chunks, sent in order (instead of `body`). */
  readonly chunks?: readonly Uint8Array[];
  /** After the chunks, the body waits until the fetch is aborted. */
  readonly stallBody?: boolean;
  /** The response never comes; the request waits until the fetch is aborted. */
  readonly stall?: boolean;
}

export type Handler = (request: TransportRequest, body: string) => FakeResponse | Promise<FakeResponse>;

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly address: string;
  readonly at: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

async function* bodyStream(chunks: readonly Uint8Array[], stall: boolean, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    if (signal.aborted) throw new Error("aborted");
    yield chunk;
  }
  if (stall) {
    if (!signal.aborted) await once(signal, "abort");
    throw new Error("aborted");
  }
}

export class FakeNet {
  readonly dns = new Map<string, string[]>();
  readonly txtRecords = new Map<string, string[][]>();
  readonly handlers = new Map<string, Handler>();
  readonly calls: Call[] = [];
  readonly lookups: string[] = [];
  readonly txtLookups: string[] = [];
  closed = 0;

  constructor(readonly clock: TestClock = new TestClock()) {}

  /** Gives a host its addresses; by default one public address of 93.184.216.0/24 (the TEST-NET ranges are refused). */
  host(name: string, ...addresses: string[]): this {
    this.dns.set(name, addresses.length ? addresses : [`93.184.216.${(this.dns.size % 250) + 1}`]);
    return this;
  }

  on(url: string, handler: Handler | FakeResponse, method: "GET" | "POST" = "GET"): this {
    this.handlers.set(`${method} ${url}`, typeof handler === "function" ? handler : () => handler);
    return this;
  }

  json(url: string, value: unknown, method: "GET" | "POST" = "GET", status = 200): this {
    return this.on(url, { status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) }, method);
  }

  lookup: Lookup = async (hostname) => {
    this.lookups.push(hostname);
    const addresses = this.dns.get(hostname);
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? (6 as const) : (4 as const) }));
  };

  transport: Transport = async (request): Promise<TransportResponse> => {
    const body = request.body ? Buffer.from(request.body).toString("utf8") : "";
    this.calls.push({ method: request.method, url: request.url.href, address: request.address, at: this.clock.now(), headers: request.headers, body });
    const handler = this.handlers.get(`${request.method} ${request.url.href}`);
    const answer: FakeResponse = handler ? await handler(request, body) : { status: 404, body: "not found" };
    if (answer.stall) {
      if (!request.signal.aborted) await once(request.signal, "abort");
      throw new Error("aborted");
    }
    const chunks = answer.chunks ?? [typeof answer.body === "string" ? Buffer.from(answer.body, "utf8") : (answer.body ?? new Uint8Array())];
    return {
      status: answer.status ?? 200,
      headers: Object.fromEntries(Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: bodyStream(chunks, answer.stallBody ?? false, request.signal),
      close: () => {
        this.closed++;
      },
    };
  };

  txt: TxtLookup = async (name) => {
    this.txtLookups.push(name);
    const records = this.txtRecords.get(name);
    if (!records) throw Object.assign(new Error(`queryTxt ENODATA ${name}`), { code: "ENODATA" });
    return records;
  };

  fetcher(limits?: Partial<FetchLimits>): SafeFetcher {
    return new SafeFetcher({ lookup: this.lookup, transport: this.transport, clock: this.clock, limits });
  }
}

/** A throwaway Ed25519 private key from a repeated seed byte (the public key is ed25519Key(seedByte) of test/support/keys.ts). */
export function ed25519Signer(seedByte: number): (data: Uint8Array) => Buffer {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seedByte)]), format: "der", type: "pkcs8" });
  return (data) => sign(null, data, key);
}

/** A compact JWS (RFC 7515 Section 7.1) with the given header and payload. */
export function compactJws(header: object, payload: object, signer: (data: Uint8Array) => Uint8Array): string {
  const head = Buffer.from(JSON.stringify(header)).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.${Buffer.from(signer(Buffer.from(`${head}.${body}`))).toString("base64url")}`;
}
