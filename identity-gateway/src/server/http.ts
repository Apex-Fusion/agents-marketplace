// DID Resolution HTTPS binding (DID Resolution v1.0 Section 11; method spec Section 6.4):
// GET /1.0/identifiers/{did}. Bodies are the JCS (RFC 8785) serialisation of the result.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalize } from "../resolve/jcs.js";
import { ResolutionError } from "../resolve/errors.js";
import { DID_DOCUMENT_MEDIA_TYPE, errorResult, httpStatus, type ResolutionResult } from "../resolve/resolver.js";

const PREFIX = "/1.0/identifiers/";
const RESULT_MEDIA_TYPE = "application/did-resolution";
const DOCUMENT_TYPES = new Set([DID_DOCUMENT_MEDIA_TYPE, "application/did+ld+json", "application/did+json"]);
const RESULT_TYPES = new Set([RESULT_MEDIA_TYPE, "application/ld+json", "application/json", "application/*", "*/*"]);

export interface Resolver {
  resolve(did: string, options: Record<string, string>): Promise<ResolutionResult>;
}

type Log = (message: string) => void;

/**
 * The representation the client asked for: the complete resolution result, the DID document only,
 * or null when nothing acceptable is offered. Media ranges are taken in header order; q=0 excludes one.
 */
export function negotiate(accept: string | undefined): "result" | "document" | null {
  if (!accept?.trim()) return "result";
  for (const range of accept.split(",")) {
    const [type = "", ...params] = range.split(";").map((s) => s.trim().toLowerCase());
    if (params.some((p) => /^q=0(?:\.0{0,3})?$/.test(p))) continue;
    if (DOCUMENT_TYPES.has(type)) return "document";
    if (RESULT_TYPES.has(type)) return "result";
  }
  return null;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function resolveRequest(resolver: Resolver, url: URL, log: Log): Promise<ResolutionResult> {
  let did: string;
  try {
    did = decodeURIComponent(url.pathname.slice(PREFIX.length));
  } catch {
    return errorResult(new ResolutionError("INVALID_DID", "Invalid DID", "the path is not valid percent-encoding"));
  }
  try {
    return await resolver.resolve(did, Object.fromEntries(url.searchParams));
  } catch (e) {
    log(`resolve ${did} failed: ${e instanceof Error ? e.message : String(e)}`);
    return errorResult(new ResolutionError("INTERNAL_ERROR", "Internal error", "the resolver could not read the ledger; retry later"));
  }
}

export function createResolverServer(resolver: Resolver, log: Log = (m) => console.error(m)): Server {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://resolver.invalid");
    if (!url.pathname.startsWith(PREFIX)) return send(res, 404, "text/plain; charset=utf-8", "not found\n");
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      return send(res, 405, "text/plain; charset=utf-8", "method not allowed\n");
    }

    const representation = negotiate(req.headers.accept);
    const result =
      representation === null
        ? errorResult(
            new ResolutionError("REPRESENTATION_NOT_SUPPORTED", "Representation not supported", `supported: ${RESULT_MEDIA_TYPE}, ${DID_DOCUMENT_MEDIA_TYPE}`),
          )
        : await resolveRequest(resolver, url, log);
    const status = httpStatus(result);
    if (representation === "document" && result.didDocument !== null) {
      return send(res, status, DID_DOCUMENT_MEDIA_TYPE, canonicalize(result.didDocument));
    }
    send(res, status, RESULT_MEDIA_TYPE, canonicalize(result));
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "internal error\n");
      else res.destroy();
    });
  });
}
