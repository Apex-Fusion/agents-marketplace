/**
 * Supplier-side sample config fixture (M1-C)
 *
 * Provides a deterministic SupplierConfig for test injection.
 * Built INDEPENDENTLY from buyer-side fixtures. No shared helpers.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupplierConfig } from "../../../supplier/src/config.js";
import { SUPPLIER_PKH, SUPPLIER_PRIVATE_KEY_HEX } from "./wallet-keys.js";

/**
 * The drain marker of every test config: a temp path that no test creates. The default marker, /dev/shm/marketplace-draining, is a
 * host file: a host that holds it would turn each route test into 503 supplier_draining.
 */
export const NO_DRAIN_MARKER = join(tmpdir(), `marketplace-no-drain-marker-${process.pid}`);

/** The advert UTxO that this supplier's config points at. */
export const SAMPLE_ADVERT_TX_HASH = "b".repeat(64);
export const SAMPLE_ADVERT_INDEX = 0;

/** A deterministic valid 64-char hex tx hash for use in escrow refs. */
export const SAMPLE_ESCROW_TX_HASH = "f".repeat(64);

/** Full supplier config used in route handler tests. It sets every field of SupplierConfig, so a new field breaks this one file and not each test. */
export function buildSampleConfig(): SupplierConfig {
  return {
    supplierPrivKeyHex: SUPPLIER_PRIVATE_KEY_HEX,
    ogmiosUrl: "ws://localhost:1337",
    ollamaUrl: "http://localhost:11434",
    llmBackend: "ollama",
    openaiTimeoutMs: 180_000,
    openaiBaseUrl: "",
    openaiApiKey: "",
    openaiUpstreamApi: "responses",
    openaiResponsesUrl: "",
    openaiResponsesStreamOnly: false,
    openaiChatStreamOnly: false,
    openaiReasoningDisabled: false,
    openaiMaxTokens: 0,
    openaiContextTokens: 0,
    openaiSessionPassthrough: false,
    openaiModelOverride: "",
    advertRef: {
      txHash: SAMPLE_ADVERT_TX_HASH,
      index: SAMPLE_ADVERT_INDEX,
    },
    networkId: 0,
    port: 8080,
    ollamaTimeoutMs: 120_000,
    piperUrl: "",
    piperTimeoutMs: 120_000,
    capabilityKind: "chat",
    chatIdleTimeoutMs: 300_000,
    maxChatSessions: 1,
    chatSettleMode: "full",
    ocrUpstream: "openai-vision",
    datalabApiKey: "",
    datalabBaseUrl: "https://www.datalab.to",
    datalabMode: "accurate",
    datalabTimeoutMs: 120_000,
    ocrPromptOverride: "",
    hfModelRevision: "",
    revisionProbeUrl: "",
    revisionProbeMode: "off",
    liveChain: false,
    walletHealthIntervalMs: 0, // 0 turns the periodic wallet check off
    drainMarkerPath: NO_DRAIN_MARKER,
    reseller: null,
  };
}

/** TTS variant: same wallet/chain plumbing, capabilityKind="tts" + Piper URL set. */
export function buildSampleTtsConfig(): SupplierConfig {
  return {
    ...buildSampleConfig(),
    ollamaUrl: "",
    piperUrl: "http://piper.fake",
    capabilityKind: "tts",
  };
}

/** OCR variant: OpenAI-compatible vision upstream, capabilityKind="ocr". */
export function buildSampleOcrConfig(): SupplierConfig {
  return {
    ...buildSampleConfig(),
    ollamaUrl: "",
    openaiBaseUrl: "http://vllm.fake:8000",
    openaiApiKey: "",
    openaiTimeoutMs: 180_000,
    openaiMaxTokens: 0,
    openaiReasoningDisabled: false,
    capabilityKind: "ocr",
  };
}

/** Datalab-hosted OCR variant (OCR_UPSTREAM=datalab). */
export function buildSampleDatalabOcrConfig(): SupplierConfig {
  return {
    ...buildSampleOcrConfig(),
    openaiBaseUrl: "",
    ocrUpstream: "datalab",
    datalabApiKey: "dl-test-key",
    revisionProbeMode: "per_job",
  };
}

/** Env map matching the sample config above, for loadConfig() unit tests. */
export function buildSampleEnv(): Record<string, string> {
  return {
    SUPPLIER_PRIV_KEY_HEX: SUPPLIER_PRIVATE_KEY_HEX,
    OGMIOS_URL: "ws://localhost:1337",
    OLLAMA_URL: "http://localhost:11434",
    ADVERT_REF: `${SAMPLE_ADVERT_TX_HASH}#${SAMPLE_ADVERT_INDEX}`,
    NETWORK_ID: "0",
    PORT: "8080",
    OLLAMA_TIMEOUT_MS: "120000",
    DRAIN_MARKER_PATH: NO_DRAIN_MARKER,
  };
}

/** The pkh embedded in the sample config. */
export { SUPPLIER_PKH };
