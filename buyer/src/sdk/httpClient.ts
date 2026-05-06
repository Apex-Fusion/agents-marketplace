/**
 * buyer/src/sdk/httpClient.ts — tiny fetch wrapper with timeout + error normalisation.
 *
 * Used by the SDK to call indexer and supplier endpoints. Errors are
 * mapped to the SDK's IndexerError / SupplierError taxonomy by the caller;
 * this module only provides a thin abstraction that:
 *   - applies an AbortController-based timeout
 *   - reads JSON bodies and reports parse failures
 *   - normalises non-2xx into a uniform { status, body, parseError } shape
 */

import * as mod from "./httpClient.js";

export interface HttpClientOpts {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  defaultTimeoutMs?: number;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
  parseError: boolean;
}

export class HttpError extends Error {
  public readonly kind: "timeout" | "network" | "non_2xx" | "parse_error";
  public readonly status?: number;
  public readonly body?: unknown;
  constructor(
    kind: "timeout" | "network" | "non_2xx" | "parse_error",
    message: string,
    opts?: { status?: number; body?: unknown },
  ) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.status = opts?.status;
    this.body = opts?.body;
  }
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: HttpClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const sep = path.startsWith("/") ? "" : "/";
    let url = `${this.baseUrl}${sep}${path}`;
    if (query) {
      const params: string[] = [];
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        params.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
      if (params.length > 0) {
        url += (url.includes("?") ? "&" : "?") + params.join("&");
      }
    }
    return url;
  }

  async getJson(
    path: string,
    opts?: { timeoutMs?: number; query?: Record<string, string | undefined> },
  ): Promise<HttpResult> {
    const url = this.buildUrl(path, opts?.query);
    return mod._performRequest(this.fetchImpl, url, {
      method: "GET",
      timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs,
    });
  }

  async postJson(
    path: string,
    body: unknown,
    opts?: { timeoutMs?: number; headers?: Record<string, string> },
  ): Promise<HttpResult> {
    const url = this.buildUrl(path);
    return mod._performRequest(this.fetchImpl, url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs,
    });
  }
}

interface PerformRequestInit {
  method: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}

/**
 * _performRequest — exported for monkey-patch hooks but otherwise internal.
 *
 * Maps low-level fetch behaviour into a structured HttpResult:
 *   - AbortError or "abort" name → HttpError("timeout")
 *   - other thrown errors        → HttpError("network")
 *   - non-2xx                    → HttpResult with ok=false; caller decides
 *   - JSON parse failure         → HttpResult with parseError=true
 */
export async function _performRequest(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: PerformRequestInit,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);

  // Distinguish "fetch impl threw synchronously" (an unusual mock or a host
  // bug) from "fetch impl returned a Promise that rejected" (real network /
  // abort). We do this by wrapping ONLY the call expression — not the await —
  // so that a synchronous throw is captured here, and asynchronous rejections
  // fall through to the await/catch below. Either path produces a regular
  // HttpError("network") that propagates to the caller — no special-casing.
  let pending: Promise<Response>;
  try {
    pending = fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    throw new HttpError("network", `network error: ${e?.message ?? String(err)}`);
  }

  let response: Response;
  try {
    response = await pending;
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError" || /abort/i.test(e?.message ?? "")) {
      throw new HttpError("timeout", `request to ${url} timed out`);
    }
    throw new HttpError("network", `network error: ${e?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown = undefined;
  let parseError = false;
  let text = "";
  try {
    text = await response.text();
  } catch {
    // ignore — keep text=""
  }
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseError = true;
      parsed = text;
    }
  }
  return { status: response.status, ok: response.ok, body: parsed, parseError };
}
