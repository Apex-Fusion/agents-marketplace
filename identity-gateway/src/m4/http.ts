// Request and response values of the M4 handlers, independent of node:http, and the error format.
// Errors use the OAuth 2.0 error response members (RFC 6749 Section 5.2): `error` and
// `error_description`. Responses that contain tokens, and all POST responses, have
// `Cache-Control: no-store` (RFC 6749 Section 5.1).

import type { IncomingHttpHeaders } from "node:http";

export interface M4Request {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** Each header field's values as received; RFC 9449 Section 4.3 needs exactly one DPoP field. */
  readonly headersDistinct: Readonly<Record<string, readonly string[] | undefined>>;
  readonly body: Buffer;
}

export interface M4Response {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const NO_STORE = { "cache-control": "no-store" } as const;

/** Public, cacheable data that browsers may also read (Token Status List Section 8.1 asks for CORS). */
export const publicData = (maxAgeSeconds: number): Record<string, string> => ({
  "cache-control": `public, max-age=${maxAgeSeconds}`,
  "access-control-allow-origin": "*",
});

export class M4Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    description: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(description);
  }
}

export function jsonResponse(status: number, value: unknown, headers: Readonly<Record<string, string>> = NO_STORE): M4Response {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) };
}

export function errorResponse(error: M4Error): M4Response {
  return jsonResponse(error.status, { error: error.code, error_description: error.message }, { ...NO_STORE, ...error.headers });
}

export const invalidRequest = (description: string): M4Error => new M4Error(400, "invalid_request", description);
export const unavailable = (description: string): M4Error => new M4Error(503, "temporarily_unavailable", description, { "retry-after": "5" });

function mediaType(req: M4Request): string {
  return (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * An `application/x-www-form-urlencoded` body (RFC 6749 Appendix B). A parameter without a value
 * counts as omitted (RFC 6749 Section 3.2).
 */
export function parseForm(req: M4Request): Map<string, string[]> {
  if (mediaType(req) !== "application/x-www-form-urlencoded") throw invalidRequest("the body must be application/x-www-form-urlencoded");
  const params = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(req.body.toString("utf8"))) {
    if (value === "") continue;
    params.set(name, [...(params.get(name) ?? []), value]);
  }
  return params;
}

/** The single value of a form parameter; RFC 6749 Section 3.2 forbids repeated parameters. */
export function single(params: Map<string, string[]>, name: string): string | undefined {
  const values = params.get(name);
  if (values === undefined) return undefined;
  if (values.length > 1) throw invalidRequest(`the parameter ${name} appears more than once`);
  return values[0];
}

/** A JSON object body (`application/json`). */
export function parseJsonObject(req: M4Request): Record<string, unknown> {
  if (mediaType(req) !== "application/json") throw invalidRequest("the body must be application/json");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw invalidRequest("the body is not UTF-8 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidRequest("the body is not a JSON object");
  return value as Record<string, unknown>;
}
