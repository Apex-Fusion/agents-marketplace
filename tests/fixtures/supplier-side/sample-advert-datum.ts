/**
 * sample-advert-datum.ts — CLI-test fixture for M1-F-3.
 *
 * Constructs AdvertDatum constants for use in cli-post-advert-flow and
 * cli-post-advert-cli tests. Built INDEPENDENTLY from buyer-side fixtures
 * and from advert-datum-builders.ts (no shared imports from those files).
 * "No same source of truth" discipline: ARCHITECTURE.md §7.2.
 *
 * Supplier PKH must match the wallet key returned by buildSupplierWalletKey()
 * so that runPostAdvert signature-mismatch checks can be exercised.
 */

import type { AdvertDatum } from "../../../packages/shared/src/cbor/types.js";
import { SUPPLIER_PKH, SUPPLIER_PRIVATE_KEY_HEX } from "./wallet-keys.js";

// ─── M1-F-3 CLI constants ────────────────────────────────────────────────────

export const CLI_ADVERT_CAPABILITY_ID = "llm.text.generate.v1";
export const CLI_ADVERT_MODEL = "qwen2.5:0.5b";
export const CLI_ADVERT_MAX_OUTPUT_TOKENS = 512;
export const CLI_ADVERT_MAX_PROCESSING_MS = 60_000;
export const CLI_ADVERT_PRICE_LOVELACE = 2_000_000n;
export const CLI_ADVERT_SUPPLIER_BOND_LOVELACE = 1_000_000n;
export const CLI_ADVERT_BUYER_BOND_LOVELACE = 1_000_000n;
export const CLI_ADVERT_ENDPOINT_URL =
  "https://mp-supplier.vector.testnet.apexfusion.org";
export const CLI_ADVERT_DETAIL_URI = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

/**
 * 32-byte sha256("") in hex — used as the "empty detail_hash" default.
 * Computed independently: sha256 of an empty byte string.
 */
export const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const CLI_ADVERT_DETAIL_HASH = SHA256_EMPTY;

/**
 * A mock POSIX timestamp (ms) for advertised_at.
 * Chosen to be compatible with a mock slot = 0 (mockSlotToWallclockMs(0) = 0),
 * so tests that advance the slot to match this ts can call advanceSlot(0).
 * For tests needing ±5min validity, use VALID_TIP_SLOT.
 */
export const CLI_ADVERT_ADVERTISED_AT_MS = 0;

/**
 * Tip slot whose mockSlotToWallclockMs is exactly CLI_ADVERT_ADVERTISED_AT_MS.
 * MockChainProvider.advanceSlot(VALID_TIP_SLOT) gives slot 0 → wallclock 0ms.
 */
export const VALID_TIP_SLOT = 0;

/**
 * buildCliAdvertDatum — returns the baseline AdvertDatum for CLI tests.
 * supplier_pkh matches buildSupplierWalletKey().pubKeyHash so the signer
 * check in runPostAdvert (and buildPostAdvertTx) passes by default.
 */
export function buildCliAdvertDatum(
  overrides?: Partial<AdvertDatum>,
): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER_PKH,
    capability_id: CLI_ADVERT_CAPABILITY_ID,
    model: CLI_ADVERT_MODEL,
    max_output_tokens: CLI_ADVERT_MAX_OUTPUT_TOKENS,
    max_processing_ms: CLI_ADVERT_MAX_PROCESSING_MS,
    price_lovelace: CLI_ADVERT_PRICE_LOVELACE,
    supplier_bond_lovelace: CLI_ADVERT_SUPPLIER_BOND_LOVELACE,
    buyer_bond_lovelace: CLI_ADVERT_BUYER_BOND_LOVELACE,
    endpoint_url: CLI_ADVERT_ENDPOINT_URL,
    detail_uri: CLI_ADVERT_DETAIL_URI,
    detail_hash: CLI_ADVERT_DETAIL_HASH,
    advertised_at: CLI_ADVERT_ADVERTISED_AT_MS,
    status: "Active",
    ...overrides,
  };
}

/**
 * buildCliEnv — a complete, valid env map for parseCliArgs tests.
 *
 * Uses the same values as buildCliAdvertDatum() above, plus SUPPLIER_PRIV_KEY_HEX
 * from the supplier wallet fixture.
 */
export function buildCliEnv(): Record<string, string> {
  return {
    SUPPLIER_PRIV_KEY_HEX: SUPPLIER_PRIVATE_KEY_HEX,
    OGMIOS_URL: "https://ogmios.vector.testnet.apexfusion.org",
    NETWORK_ID: "0",
    ADVERT_CAPABILITY_ID: CLI_ADVERT_CAPABILITY_ID,
    ADVERT_MODEL: CLI_ADVERT_MODEL,
    ADVERT_MAX_OUTPUT_TOKENS: String(CLI_ADVERT_MAX_OUTPUT_TOKENS),
    ADVERT_MAX_PROCESSING_MS: String(CLI_ADVERT_MAX_PROCESSING_MS),
    ADVERT_PRICE_LOVELACE: String(CLI_ADVERT_PRICE_LOVELACE),
    ADVERT_SUPPLIER_BOND_LOVELACE: String(CLI_ADVERT_SUPPLIER_BOND_LOVELACE),
    ADVERT_BUYER_BOND_LOVELACE: String(CLI_ADVERT_BUYER_BOND_LOVELACE),
    ADVERT_ENDPOINT_URL: CLI_ADVERT_ENDPOINT_URL,
    ADVERT_DETAIL_URI: CLI_ADVERT_DETAIL_URI,
    ADVERT_DETAIL_HASH: CLI_ADVERT_DETAIL_HASH,
  };
}
