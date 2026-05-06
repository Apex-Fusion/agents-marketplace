/**
 * Buyer-side AdvertDatum fixture builder — M0-B RED phase
 *
 * Constructs AdvertDatum INDEPENDENTLY from the spec (ARCHITECTURE.md §4.1).
 * MUST NOT import from supplier-side builders or any shared fixture helper.
 * This is the "no same source of truth" discipline from ARCHITECTURE.md §7.2.
 *
 * Golden file authority: THIS file is the GOLDEN source.
 *   The encoded hex is written to tests/fixtures/golden/advert-datum-sample.hex
 *   Supplier-side independently encodes the same datum and asserts hex equality.
 *
 * cbor-x Plutus Tag convention (from apex-dashboard cbor-decoder.ts):
 *   new Tag(tagNumber, fieldsArray) — tagNumber in .value, fields in .tag
 *   This is the INVERSE of standard cbor-x but matches Plutus on-chain encoding.
 */

import { Tag } from "cbor-x";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { AdvertDatum } from "../../../packages/shared/src/cbor/types.js";
// NOTE: Importing the shared low-level CBOR encoder is OK and does NOT violate
// the buyer/supplier "no shared source of truth" rule from ARCHITECTURE.md §7.2.
// That rule applies to fixture-builder LOGIC (datum construction); this helper
// is byte-level CBOR machinery (tagUint8Array=false + Plutus Tag extension).
// Both sides must agree at the byte level for hex equality assertions to mean anything.
import { encodePlutus } from "../../../packages/shared/src/cbor/plutus-encoder.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function plutusTag(tagNumber: number, value: unknown): Tag {
  return new (Tag as unknown as new (a: unknown, b: unknown) => Tag)(
    tagNumber,
    value,
  );
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ─── Sample datum values — derived independently from ARCHITECTURE.md §4.1 ──
// These values are canonical for buyer-side tests. They match supplier-side
// ONLY because both sides read the same spec — not because they share code.

const SAMPLE_SUPPLIER_PKH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01";
const SAMPLE_CAPABILITY_ID = "llm.text.generate.v1";
const SAMPLE_MODEL = "qwen2.5:0.5b";
const SAMPLE_MAX_OUTPUT_TOKENS = 512;
const SAMPLE_MAX_PROCESSING_MS = 60_000;
const SAMPLE_PRICE_LOVELACE = 2_000_000n;
const SAMPLE_SUPPLIER_BOND_LOVELACE = 1_000_000n;
const SAMPLE_BUYER_BOND_LOVELACE = 1_000_000n;
const SAMPLE_ENDPOINT_URL = "https://supplier.example.com/v1";
const SAMPLE_DETAIL_URI = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const SAMPLE_DETAIL_HASH = "a".repeat(64); // 32-byte sha256 hex
const SAMPLE_ADVERTISED_AT = 1745500000000;
const SAMPLE_STATUS: "Active" = "Active";

/**
 * buildSampleAdvertDatum — returns the canonical sample AdvertDatum.
 * Derived independently from ARCHITECTURE.md §4.1; shares NO code with supplier-side.
 */
export function buildSampleAdvertDatum(): AdvertDatum {
  return {
    supplier_pkh: SAMPLE_SUPPLIER_PKH,
    capability_id: SAMPLE_CAPABILITY_ID,
    model: SAMPLE_MODEL,
    max_output_tokens: SAMPLE_MAX_OUTPUT_TOKENS,
    max_processing_ms: SAMPLE_MAX_PROCESSING_MS,
    price_lovelace: SAMPLE_PRICE_LOVELACE,
    supplier_bond_lovelace: SAMPLE_SUPPLIER_BOND_LOVELACE,
    buyer_bond_lovelace: SAMPLE_BUYER_BOND_LOVELACE,
    endpoint_url: SAMPLE_ENDPOINT_URL,
    detail_uri: SAMPLE_DETAIL_URI,
    detail_hash: SAMPLE_DETAIL_HASH,
    advertised_at: SAMPLE_ADVERTISED_AT,
    status: SAMPLE_STATUS,
  };
}

/**
 * encodeSampleAdvertDatumHex — CBOR-encodes the sample datum using cbor-x
 * with the Plutus Tag convention.
 *
 * This function encodes the datum DIRECTLY (not via encodeAdvertDatum) to
 * serve as the golden reference. The purpose is cross-validation: if
 * encodeAdvertDatum produces the same hex as this function, Catherine's
 * implementation is correct.
 *
 * Field order per §4.1 (13 fields):
 *   0 supplier_pkh, 1 capability_id, 2 model, 3 max_output_tokens,
 *   4 max_processing_ms, 5 price_lovelace, 6 supplier_bond_lovelace,
 *   7 buyer_bond_lovelace, 8 endpoint_url, 9 detail_uri, 10 detail_hash,
 *   11 advertised_at, 12 status
 */
export function encodeSampleAdvertDatumHex(): string {
  const datum = buildSampleAdvertDatum();

  // Status: Active = Constr0 (tag 121), Retired = Constr1 (tag 122)
  const statusTag =
    datum.status === "Active" ? plutusTag(121, []) : plutusTag(122, []);

  const cborDatum = plutusTag(121, [
    hexToBytes(datum.supplier_pkh),
    utf8Bytes(datum.capability_id),
    utf8Bytes(datum.model),
    datum.max_output_tokens,
    datum.max_processing_ms,
    datum.price_lovelace,
    datum.supplier_bond_lovelace,
    datum.buyer_bond_lovelace,
    utf8Bytes(datum.endpoint_url),
    utf8Bytes(datum.detail_uri),
    hexToBytes(datum.detail_hash),
    datum.advertised_at,
    statusTag,
  ]);

  return bytesToHex(encodePlutus(cborDatum));
}

/**
 * writeGoldenAdvertDatum — writes the golden hex to the golden file.
 * Called once to produce tests/fixtures/golden/advert-datum-sample.hex.
 * The supplier-side test reads this file and independently encodes + asserts equality.
 *
 * This is the BUYER SIDE — it is the golden source authority.
 */
export function writeGoldenAdvertDatum(goldenPath: string): void {
  const hex = encodeSampleAdvertDatumHex();
  writeFileSync(goldenPath, hex + "\n", "utf8");
}

/**
 * readGoldenAdvertDatum — reads the golden hex from file.
 * Supplier-side uses this to load the buyer-side golden reference.
 */
export function readGoldenAdvertDatum(goldenPath: string): string {
  return readFileSync(goldenPath, "utf8").trim();
}
