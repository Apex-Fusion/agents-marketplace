// HTTPS binding (Part 1 Section 7.4): GET /1.0/identifiers/{did}, as DID Resolution v1.0 defines
// it, and GET /healthz. Both also answer HEAD as RFC 9110 requires (Section 9.1; Section 9.3.2: the
// status and header fields of GET, without the body). Bodies are the JCS (RFC 8785) serialisation.
// Every response has Cache-Control: no-store. The server writes no request log; it logs errors
// without the DID.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ResolutionError } from "../resolve/errors.js";
import { canonicalize } from "../resolve/jcs.js";
import type { ResolutionOptionsInput } from "../resolve/options.js";
import { DID_MEDIA_TYPE, errorResult, httpStatus, type ResolutionResult } from "../resolve/resolver.js";
import { RESOLUTION_MEDIA_TYPE, negotiate } from "./accept.js";

const PREFIX = "/1.0/identifiers/";

export interface DidResolver {
  resolveDid(did: string, options: ResolutionOptionsInput): Promise<ResolutionResult>;
}

/** A route outside the HTTPS binding (renderings, M4 services). Returns false when the request is not its own. */
export type Route = (req: IncomingMessage, res: ServerResponse, path: string, query: string) => Promise<boolean>;

export interface ServerOptions {
  /** Error log. */
  readonly log?: (message: string) => void;
  /** Extra routes, tried in order before the 404. */
  readonly routes?: readonly Route[];
}

function send(res: ServerResponse, status: number, contentType: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

async function resolveRequest(resolver: DidResolver, encodedDid: string, query: string): Promise<ResolutionResult> {
  let did: string;
  try {
    did = decodeURIComponent(encodedDid);
  } catch {
    return errorResult(new ResolutionError("INVALID_DID", "Invalid DID: the path is not valid percent-encoding"));
  }
  return resolver.resolveDid(did, new URLSearchParams(query));
}

export function createResolverServer(resolver: DidResolver, options: ServerOptions = {}): Server {
  const log = options.log ?? ((message: string) => console.error(message));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? "/";
    const q = target.indexOf("?");
    const path = q < 0 ? target : target.slice(0, q);
    const query = q < 0 ? "" : target.slice(q + 1);

    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "method not allowed\n", { allow: "GET, HEAD" });
      return send(res, 200, "application/json", '{"status":"ok"}');
    }
    for (const route of options.routes ?? []) if (await route(req, res, path, query)) return;
    if (!path.startsWith(PREFIX)) return send(res, 404, "text/plain; charset=utf-8", "not found\n");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "method not allowed\n", { allow: "GET, HEAD" });

    const representation = negotiate(req.headers.accept);
    const result =
      representation === null
        ? errorResult(new ResolutionError("REPRESENTATION_NOT_SUPPORTED", `Representation not supported: offered ${RESOLUTION_MEDIA_TYPE} and ${DID_MEDIA_TYPE}`))
        : await resolveRequest(resolver, path.slice(PREFIX.length), query);
    const status = httpStatus(result);
    // Errors and results with deactivated: true always get the resolution result.
    if (representation === "document" && status === 200 && result.didDocument !== null) {
      return send(res, status, DID_MEDIA_TYPE, canonicalize(result.didDocument));
    }
    send(res, status, RESOLUTION_MEDIA_TYPE, canonicalize(result));
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`identity-gateway: request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "internal error\n");
      else res.destroy();
    });
  });
}
