// M4 configuration from the environment. The M4 services start only when both key files are set.
// The public origin is the gateway's one base URL, GATEWAY_BASE_URL (render/config.ts reads it):
// it is the RFC 8414 issuer, and `<base>/token` is the audience of agent JWTs.
//
//   GATEWAY_ED25519_KEY_FILE      PEM private key file of the Ed25519 key (no group or other access)
//   GATEWAY_P256_KEY_FILE         PEM private key file of the P-256 key (no group or other access)
//   GATEWAY_VECTOR_ID             the gateway's own identifier (64 hex); required with the key files
//   DELEGATION_POLICY_ID          delegation contract policy ID (= script hash); optional
//   DELEGATION_ADDRESS            its enterprise address; optional, must match the policy
//   STATUS_LIST_REFRESH_SECONDS   how long built status lists are used, default 60

import { registryOf } from "../resolve/settings.js";
import type { M4Settings } from "./context.js";

export interface M4Config extends M4Settings {
  readonly keyFiles: { readonly ed25519: string; readonly p256: string };
}

/**
 * Null when M4 is not configured (no key files). Throws on a partial or invalid configuration.
 * `baseUrl` is the validated public https origin of the gateway.
 */
export function loadM4Config(env: NodeJS.ProcessEnv, baseUrl: string): M4Config | null {
  const ed25519 = env.GATEWAY_ED25519_KEY_FILE || undefined;
  const p256 = env.GATEWAY_P256_KEY_FILE || undefined;
  if (ed25519 === undefined && p256 === undefined) return null;
  if (ed25519 === undefined || p256 === undefined) throw new Error("set both GATEWAY_ED25519_KEY_FILE and GATEWAY_P256_KEY_FILE, or neither");
  const gatewayId = env.GATEWAY_VECTOR_ID ?? "";
  if (!/^[0-9a-f]{64}$/.test(gatewayId)) throw new Error("GATEWAY_VECTOR_ID must be the gateway's identifier: 64 lowercase hex characters");
  const delegationPolicy = env.DELEGATION_POLICY_ID || undefined;
  if (!delegationPolicy && env.DELEGATION_ADDRESS) throw new Error("DELEGATION_ADDRESS needs DELEGATION_POLICY_ID");
  const refreshText = env.STATUS_LIST_REFRESH_SECONDS || "60";
  if (!/^\d+$/.test(refreshText) || Number(refreshText) < 1 || Number(refreshText) > 3600) {
    throw new Error(`STATUS_LIST_REFRESH_SECONDS must be an integer from 1 to 3600, got "${refreshText}"`);
  }
  return {
    keyFiles: { ed25519, p256 },
    gatewayId,
    baseUrl,
    trustDomain: new URL(baseUrl).hostname,
    delegation: delegationPolicy ? registryOf(delegationPolicy, env.DELEGATION_ADDRESS || undefined) : null,
    statusListRefreshMs: Number(refreshText) * 1000,
  };
}
