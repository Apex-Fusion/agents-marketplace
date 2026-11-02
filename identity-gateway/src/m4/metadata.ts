// GET /.well-known/oauth-authorization-server (RFC 8414 Section 3) and GET /.well-known/jwks.json
// (RFC 7517 Section 5: both gateway keys, `kid` = the key's DID URL).

import type { GatewayKeys } from "../keys/gateway-keys.js";
import { tokenEndpoint, type M4Settings } from "./context.js";
import { DELEGATION_DETAILS_TYPE } from "./delegation.js";
import { TOKEN_EXCHANGE_GRANT } from "./tokens.js";

const AGENT_JWT_ALGS = ["EdDSA", "Ed25519"];

/** RFC 8414 Section 2 metadata. The gateway has no authorization endpoint, so it supports no response type. */
export function authorizationServerMetadata(settings: M4Settings): Record<string, unknown> {
  const base = settings.baseUrl;
  return {
    issuer: base,
    token_endpoint: tokenEndpoint(settings),
    jwks_uri: `${base}/.well-known/jwks.json`,
    response_types_supported: [],
    grant_types_supported: [TOKEN_EXCHANGE_GRANT],
    token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
    token_endpoint_auth_signing_alg_values_supported: AGENT_JWT_ALGS,
    introspection_endpoint: `${base}/introspect`,
    introspection_endpoint_auth_methods_supported: ["private_key_jwt"],
    introspection_endpoint_auth_signing_alg_values_supported: AGENT_JWT_ALGS,
    revocation_endpoint: `${base}/revoke`,
    revocation_endpoint_auth_methods_supported: ["private_key_jwt"],
    revocation_endpoint_auth_signing_alg_values_supported: AGENT_JWT_ALGS,
    // RFC 9449 Section 5.1.
    dpop_signing_alg_values_supported: ["EdDSA", "Ed25519", "ES256"],
    // RFC 9396 Section 10.
    authorization_details_types_supported: [DELEGATION_DETAILS_TYPE],
  };
}

export function jwks(keys: GatewayKeys): { keys: unknown[] } {
  return { keys: [keys.ed25519.publicJwk, keys.p256.publicJwk] };
}
