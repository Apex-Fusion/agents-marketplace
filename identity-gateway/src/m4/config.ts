// M4 configuration from the environment. The M4 services start only when both key files are set.
// The public origin is the gateway's one base URL, GATEWAY_BASE_URL (render/config.ts reads it):
// it is the RFC 8414 issuer, and `<base>/token` is the audience of agent JWTs.
//
//   GATEWAY_ED25519_KEY_FILE      PEM private key file of the Ed25519 key (no group or other access)
//   GATEWAY_P256_KEY_FILE         PEM private key file of the P-256 key (no group or other access)
//   GATEWAY_VECTOR_ID             the gateway's own identifier (64 hex); required with the key files
//   DELEGATION_POLICY_ID          delegation contract policy ID (= script hash); optional
//   DELEGATION_ADDRESS            its enterprise address; optional, must match the policy
//   STATUS_LIST_REFRESH_SECONDS             how old built status lists are before a request builds them
//                                           again, default 60 (1 to 2400)
//   STATUS_LIST_BACKGROUND_REFRESH_SECONDS  how old they are before the timer builds them again, with
//                                           no request, default 600 (60 to 2400, not below the first)
//   STATUS_LIST_FOLLOW_SECONDS              how often the timer reads the changes of the chain into the
//                                           lists, default 10 (0, or a multiple of 10 up to 300; 0: the
//                                           lists change only when a build ends)
// The limits come from the timing rule in status-lists.ts: an interval plus the allowance for the
// check of the timer and for a build must fit in the validity of a list.

import { registryOf } from "../resolve/settings.js";
import type { M4Settings } from "./context.js";
import { DEFAULT_BACKGROUND_REFRESH_MS, DEFAULT_FOLLOW_MS, checkTiming } from "./status-lists.js";

export interface M4Config extends M4Settings {
  readonly keyFiles: { readonly ed25519: string; readonly p256: string };
}

/** The value of a variable in whole seconds, as milliseconds; `fallback` (seconds) when it is not set. */
function seconds(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const text = env[name] || String(fallback);
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number of seconds, got "${text}"`);
  return Number(text) * 1000;
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
  const statusListRefreshMs = seconds(env, "STATUS_LIST_REFRESH_SECONDS", 60);
  const statusListBackgroundRefreshMs = seconds(env, "STATUS_LIST_BACKGROUND_REFRESH_SECONDS", DEFAULT_BACKGROUND_REFRESH_MS / 1000);
  const statusListFollowMs = seconds(env, "STATUS_LIST_FOLLOW_SECONDS", DEFAULT_FOLLOW_MS / 1000);
  checkTiming(statusListRefreshMs, statusListBackgroundRefreshMs, statusListFollowMs);
  return {
    keyFiles: { ed25519, p256 },
    gatewayId,
    baseUrl,
    trustDomain: new URL(baseUrl).hostname,
    delegation: delegationPolicy ? registryOf(delegationPolicy, env.DELEGATION_ADDRESS || undefined) : null,
    statusListRefreshMs,
    statusListBackgroundRefreshMs,
    statusListFollowMs,
  };
}
