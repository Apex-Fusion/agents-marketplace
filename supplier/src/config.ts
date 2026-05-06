/**
 * supplier/src/config.ts — Load and validate supplier configuration from env.
 *
 * loadConfig(env) is a pure function (takes a Record<string, string> rather than
 * reading process.env directly) so tests can inject fake environments.
 *
 * Required env vars:
 *   SUPPLIER_PRIV_KEY_HEX  — 64-char hex Ed25519 private key
 *   OGMIOS_URL             — ws:// or wss:// URL
 *   ADVERT_REF             — "<64hex>#<int>" OutputReference to the supplier's advert UTxO
 *   NETWORK_ID             — "0" (testnet) or "1" (mainnet)
 *
 * Required for CAPABILITY_KIND="chat" (default):
 *   OLLAMA_URL             — http:// URL for local Ollama
 *
 * Required for CAPABILITY_KIND="tts":
 *   PIPER_URL              — http(s):// URL for the openedai-speech-min PiperTTS host
 *
 * Optional:
 *   CAPABILITY_KIND        — "chat" (default) or "tts". Selects which upstream
 *                            adapter is loaded and which HTTP route is mounted.
 *                            The route handler still validates the on-chain
 *                            advert's capability_id; this env just decides
 *                            which dispatch lives in the process.
 *   PORT                   — listen port (default 8080)
 *   OLLAMA_TIMEOUT_MS      — ollama request timeout in ms (default 120_000)
 *   PIPER_TIMEOUT_MS       — piper request timeout in ms (default 120_000)
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

/** Capability the supplier is configured to serve. */
export type CapabilityKind = "chat" | "tts";

export interface SupplierConfig {
  supplierPrivKeyHex: string;
  ogmiosUrl: string;
  /** Empty string when capabilityKind="tts". */
  ollamaUrl: string;
  /** Empty string when capabilityKind="chat". */
  piperUrl: string;
  advertRef: AdvertRef;
  networkId: 0 | 1;
  port: number;
  ollamaTimeoutMs: number;
  piperTimeoutMs: number;
  capabilityKind: CapabilityKind;
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

  // CAPABILITY_KIND drives whether OLLAMA_URL or PIPER_URL is required.
  // Default to "chat" so existing chat suppliers keep booting unchanged.
  const capKindStr = env.CAPABILITY_KIND ?? "chat";
  if (capKindStr !== "chat" && capKindStr !== "tts") {
    throw new Error('loadConfig: CAPABILITY_KIND must be "chat" or "tts"');
  }
  const capabilityKind: CapabilityKind = capKindStr;

  // Per-capability upstream URL — the OTHER capability's URL becomes
  // optional/unused. The route handler also validates the on-chain advert's
  // capability_id, so a misconfiguration here can't trick a TTS supplier into
  // serving chat traffic; this gate just keeps the process boot honest.
  let ollamaUrl = "";
  let piperUrl = "";
  if (capabilityKind === "chat") {
    ollamaUrl = requireField(env, "OLLAMA_URL");
    piperUrl = env.PIPER_URL ?? "";
  } else {
    piperUrl = requireField(env, "PIPER_URL");
    ollamaUrl = env.OLLAMA_URL ?? "";
  }

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

  const piperTimeoutStr = env.PIPER_TIMEOUT_MS;
  let piperTimeoutMs = 120_000;
  if (piperTimeoutStr !== undefined && piperTimeoutStr !== "") {
    if (!POS_INT_RE.test(piperTimeoutStr)) {
      throw new Error("loadConfig: PIPER_TIMEOUT_MS must be a positive integer");
    }
    piperTimeoutMs = Number(piperTimeoutStr);
  }

  // LIVE_CHAIN: only the literal "1" opts in to live-chain mode. Any other
  // value (including "true", "yes", "TRUE", "", undefined) keeps the supplier
  // in safe read-only mode. Real submissions require explicit opt-in.
  const liveChain = env.LIVE_CHAIN === "1";

  return {
    supplierPrivKeyHex,
    ogmiosUrl,
    ollamaUrl,
    piperUrl,
    advertRef,
    networkId,
    port,
    ollamaTimeoutMs,
    piperTimeoutMs,
    capabilityKind,
    liveChain,
  };
}
