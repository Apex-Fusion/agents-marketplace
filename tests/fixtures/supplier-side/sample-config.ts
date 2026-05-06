/**
 * Supplier-side sample config fixture — M1-C RED phase
 *
 * Provides a deterministic SupplierConfig for test injection.
 * Built INDEPENDENTLY from buyer-side fixtures. No shared helpers.
 */

import type { SupplierConfig } from "../../../supplier/src/config.js";
import { SUPPLIER_PKH, SUPPLIER_PRIVATE_KEY_HEX } from "./wallet-keys.js";

/** The advert UTxO that this supplier's config points at. */
export const SAMPLE_ADVERT_TX_HASH = "b".repeat(64);
export const SAMPLE_ADVERT_INDEX = 0;

/** A deterministic valid 64-char hex tx hash for use in escrow refs. */
export const SAMPLE_ESCROW_TX_HASH = "f".repeat(64);

/** Full supplier config used in route handler tests. */
export function buildSampleConfig(): SupplierConfig {
  return {
    supplierPrivKeyHex: SUPPLIER_PRIVATE_KEY_HEX,
    ogmiosUrl: "ws://localhost:1337",
    ollamaUrl: "http://localhost:11434",
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
    liveChain: false,
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
  };
}

/** The pkh embedded in the sample config. */
export { SUPPLIER_PKH };
