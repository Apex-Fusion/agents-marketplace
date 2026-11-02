// HTTP routes of the M4 services (Part 2 Section 8.6). Register with
// `createResolverServer(resolver, { routes: [m4Routes(services)] })`.
//
//   GET  /.well-known/jwks.json                   RFC 7517 JWK Set of the gateway keys
//   GET  /.well-known/oauth-authorization-server  RFC 8414 metadata
//   POST /token                                   RFC 8693 token exchange (DPoP-bound tokens)
//   POST /introspect                              RFC 7662
//   POST /revoke                                  RFC 7009
//   POST /spiffe/nonce                            single-use nonce for /spiffe/x509-svid
//   POST /spiffe/x509-svid                        X.509-SVID for a P-256 certification request
//   POST /spiffe/jwt-svid                         JWT-SVID (ES256)
//   GET  /spiffe/bundle                           SPIFFE bundle (https_web profile)
//   GET  /status/bsl/{n}                          W3C Bitstring Status List credential (application/vc+jwt)
//   GET  /status/tsl/{n}                          IETF Token Status List token (application/statuslist+jwt)
//   GET  /agents/{id}/credential                  identity credential (application/vc+jwt)

import type { IncomingMessage, ServerResponse } from "node:http";
import { identityCredential } from "../m4/credential.js";
import { M4Error, errorResponse, jsonResponse, publicData, unavailable, type M4Request, type M4Response } from "../m4/http.js";
import type { M4Services } from "../m4/index.js";
import { authorizationServerMetadata, jwks } from "../m4/metadata.js";
import { CapacityError } from "../m4/replay.js";
import type { Route } from "./http.js";

/** Largest request body that the M4 endpoints read. */
export const MAX_BODY_BYTES = 65_536;
const KEY_SET_MAX_AGE_S = 300;

type Handler = (req: M4Request) => Promise<M4Response> | M4Response;

interface Endpoint {
  readonly method: "GET" | "POST";
  /** For the error log, which never contains a DID or an identifier (Part 2 Section 8.1). */
  readonly name: string;
  readonly handler: Handler;
}

const STATUS_LIST = /^\/status\/(bsl|tsl)\/(0|[1-9][0-9]{0,8})$/;
const CREDENTIAL = /^\/agents\/([0-9a-f]{64})\/credential$/;

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function write(res: ServerResponse, response: M4Response, extra: Record<string, string> = {}): void {
  res.writeHead(response.status, { ...response.headers, ...extra, "content-length": Buffer.byteLength(response.body) });
  res.end(response.body);
}

const signedList = (contentType: string, refreshMs: number, signed: string | null): M4Response => {
  if (signed === null) throw new M4Error(404, "not_found", "no such status list");
  return { status: 200, headers: { "content-type": contentType, ...publicData(Math.max(1, Math.round(refreshMs / 1000))) }, body: signed };
};

export function m4Routes(services: M4Services): Route {
  const { context, tokens, spiffe, statusLists } = services;
  const refreshMs = context.settings.statusListRefreshMs;
  const statusList = async (kind: string, n: number): Promise<M4Response> => {
    let signed: string | null;
    try {
      signed = kind === "bsl" ? await statusLists.bitstringStatusList(n) : await statusLists.tokenStatusList(n);
    } catch (e) {
      context.log(`identity-gateway: status lists unavailable: ${e instanceof Error ? e.message : String(e)}`);
      throw unavailable("the status lists could not be built from the ledger");
    }
    return signedList(kind === "bsl" ? "application/vc+jwt" : "application/statuslist+jwt", refreshMs, signed);
  };

  const fixed: Record<string, Endpoint> = {
    "/.well-known/jwks.json": { method: "GET", name: "jwks", handler: () => jsonResponse(200, jwks(context.keys), publicData(KEY_SET_MAX_AGE_S)) },
    "/.well-known/oauth-authorization-server": {
      method: "GET",
      name: "metadata",
      handler: () => jsonResponse(200, authorizationServerMetadata(context.settings), publicData(KEY_SET_MAX_AGE_S)),
    },
    "/token": { method: "POST", name: "token", handler: (req) => tokens.token(req) },
    "/introspect": { method: "POST", name: "introspect", handler: (req) => tokens.introspect(req) },
    "/revoke": { method: "POST", name: "revoke", handler: (req) => tokens.revoke(req) },
    "/spiffe/nonce": { method: "POST", name: "spiffe nonce", handler: () => spiffe.nonce() },
    "/spiffe/x509-svid": { method: "POST", name: "x509-svid", handler: (req) => spiffe.x509(req) },
    "/spiffe/jwt-svid": { method: "POST", name: "jwt-svid", handler: (req) => spiffe.jwt(req) },
    "/spiffe/bundle": { method: "GET", name: "spiffe bundle", handler: () => spiffe.bundle() },
  };

  const endpointOf = (path: string): Endpoint | null => {
    if (Object.prototype.hasOwnProperty.call(fixed, path)) return fixed[path]!;
    const list = STATUS_LIST.exec(path);
    if (list) return { method: "GET", name: "status list", handler: () => statusList(list[1]!, Number(list[2])) };
    const credential = CREDENTIAL.exec(path);
    if (credential) return { method: "GET", name: "identity credential", handler: () => identityCredential(context, statusLists, credential[1]!) };
    return null;
  };

  return async (req, res, path) => {
    const endpoint = endpointOf(path);
    if (endpoint === null) return false;
    const method = req.method ?? "";
    const allowed = endpoint.method === "GET" ? ["GET", "HEAD"] : ["POST"];
    if (!allowed.includes(method)) {
      write(res, errorResponse(new M4Error(405, "invalid_request", `use ${allowed.join(" or ")}`)), { allow: allowed.join(", ") });
      return true;
    }
    let response: M4Response;
    try {
      const body = endpoint.method === "POST" ? await readBody(req) : Buffer.alloc(0);
      response = await endpoint.handler({ method, path, headers: req.headers, headersDistinct: req.headersDistinct, body });
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        write(res, errorResponse(new M4Error(413, "invalid_request", `the body is larger than ${MAX_BODY_BYTES} bytes`)), { connection: "close" });
        return true;
      }
      if (e instanceof M4Error) response = errorResponse(e);
      else if (e instanceof CapacityError) response = errorResponse(unavailable(e.message));
      else {
        context.log(`identity-gateway: ${endpoint.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        response = errorResponse(new M4Error(500, "server_error", "the gateway could not complete the request"));
      }
    }
    write(res, response);
    return true;
  };
}
