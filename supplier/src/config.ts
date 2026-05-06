/**
 * supplier/src/config.ts — Load and validate supplier configuration from env.
 *
 * loadConfig(env) is a pure function (takes a Record<string, string> rather than
 * reading process.env directly) so tests can inject fake environments.
 *
 * Required env vars:
 *   SUPPLIER_PRIV_KEY_HEX  — 64-char hex Ed25519 private key
 *   OGMIOS_URL             — ws:// or wss:// URL
 *   OLLAMA_URL             — http:// URL for local Ollama
 *   ADVERT_REF             — "<64hex>#<int>" OutputReference to the supplier's advert UTxO
 *   NETWORK_ID             — "0" (testnet) or "1" (mainnet)
 *
 * Optional:
 *   PORT                   — listen port (default 8080)
 *   OLLAMA_TIMEOUT_MS      — ollama request timeout in ms (default 120_000)
 *   LIVE_CHAIN             — "1" opts in to live-chain submit/await (default off).
 *                            Any other value (including "true", "yes", "TRUE")
 *                            keeps the supplier in read-only mode for safety.
 *
 * On error: throws Error whose message names the offending field (matches
 * supplier-config.test.ts assertion that error message mentions field name).
 */

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;
const NON_NEG_INT_RE = /^(?:0|[1-9]\d*)$/;
const POS_INT_RE = /^[1-9]\d*$/;

export interface AdvertRef {
  txHash: string;
  index: number;
}

export interface SupplierConfig {
  supplierPrivKeyHex: string;
  ogmiosUrl: string;
  ollamaUrl: string;
  advertRef: AdvertRef;
  networkId: 0 | 1;
  port: number;
  ollamaTimeoutMs: number;
  /**
   * When true, the supplier boots a LiveOgmiosProvider (real submitTx/awaitTx).
   * Default false → ReadOnlyOgmiosProvider (safe; no chain writes).
   * Only the literal env value "1" sets this to true.
   */
  liveChain: boolean;
}

function requireField(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`loadConfig: missing required env var ${name}`);
  }
  return v;
}

export function parseAdvertRef(ref: string): AdvertRef {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error('parseAdvertRef: ref must be a non-empty "<txHash>#<index>" string');
  }
  const hashIdx = ref.indexOf("#");
  if (hashIdx < 0) {
    throw new Error('parseAdvertRef: missing "#" separator in advert ref');
  }
  const txHash = ref.slice(0, hashIdx);
  const indexStr = ref.slice(hashIdx + 1);
  if (!TX_HASH_RE.test(txHash)) {
    throw new Error("parseAdvertRef: txHash must be 64 hex chars (32 bytes)");
  }
  if (!NON_NEG_INT_RE.test(indexStr)) {
    throw new Error("parseAdvertRef: index must be a non-negative integer");
  }
  return { txHash, index: Number(indexStr) };
}

export function loadConfig(env: Record<string, string | undefined>): SupplierConfig {
  const supplierPrivKeyHex = requireField(env, "SUPPLIER_PRIV_KEY_HEX");
  if (!HEX64_RE.test(supplierPrivKeyHex)) {
    throw new Error("loadConfig: SUPPLIER_PRIV_KEY_HEX must be 64 hex chars (32 bytes)");
  }

  const ogmiosUrl = requireField(env, "OGMIOS_URL");
  const ollamaUrl = requireField(env, "OLLAMA_URL");
  const advertRefStr = requireField(env, "ADVERT_REF");
  const advertRef = parseAdvertRef(advertRefStr);

  const networkIdStr = requireField(env, "NETWORK_ID");
  if (networkIdStr !== "0" && networkIdStr !== "1") {
    throw new Error('loadConfig: NETWORK_ID must be "0" (testnet) or "1" (mainnet)');
  }
  const networkId: 0 | 1 = networkIdStr === "1" ? 1 : 0;

  const portStr = env.PORT;
  let port = 8080;
  if (portStr !== undefined && portStr !== "") {
    if (!POS_INT_RE.test(portStr)) {
      throw new Error("loadConfig: PORT must be a positive integer");
    }
    port = Number(portStr);
  }

  const timeoutStr = env.OLLAMA_TIMEOUT_MS;
  let ollamaTimeoutMs = 120_000;
  if (timeoutStr !== undefined && timeoutStr !== "") {
    if (!POS_INT_RE.test(timeoutStr)) {
      throw new Error("loadConfig: OLLAMA_TIMEOUT_MS must be a positive integer");
    }
    ollamaTimeoutMs = Number(timeoutStr);
  }

  // LIVE_CHAIN: only the literal "1" opts in to live-chain mode. Any other
  // value (including "true", "yes", "TRUE", "", undefined) keeps the supplier
  // in safe read-only mode. Real submissions require explicit opt-in.
  const liveChain = env.LIVE_CHAIN === "1";

  return {
    supplierPrivKeyHex,
    ogmiosUrl,
    ollamaUrl,
    advertRef,
    networkId,
    port,
    ollamaTimeoutMs,
    liveChain,
  };
}
