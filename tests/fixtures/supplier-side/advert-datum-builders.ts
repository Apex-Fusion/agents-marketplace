/**
 * Supplier-side AdvertDatum fixture builder — M0-B RED phase
 *
 * Constructs AdvertDatum INDEPENDENTLY from the spec (ARCHITECTURE.md §4.1).
 * MUST NOT import from buyer-side builders or any shared fixture helper.
 * This is the "no same source of truth" discipline from ARCHITECTURE.md §7.2.
 *
 * Golden file consumer: This side reads tests/fixtures/golden/advert-datum-sample.hex
 *   (produced by buyer-side) and independently encodes the same datum to assert hex equality.
 *   If the two sides diverge, there is a spec interpretation error in one of them.
 *
 * cbor-x Plutus Tag convention (from apex-dashboard cbor-decoder.ts):
 *   new Tag(tagNumber, fieldsArray) — tagNumber in .value, fields in .tag
 *   This is the INVERSE of standard cbor-x but matches Plutus on-chain encoding.
 */

import { Tag } from "cbor-x";
import { readFileSync } from "fs";
import type { AdvertDatum } from "../../../packages/shared/src/cbor/types.js";
// NOTE: Shared low-level CBOR encoder. The "no shared source of truth" rule
// (ARCHITECTURE.md §7.2) applies to fixture-builder LOGIC — datum construction
// from spec — not to byte-level CBOR machinery (tagUint8Array=false + Plutus
// Tag extension). Both sides must agree at the byte level or hex equality is
// meaningless.
import { encodePlutus } from "../../../packages/shared/src/cbor/plutus-encoder.js";

// ─── Helpers (no import from buyer-side) ────────────────────────────────────

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
// These values are identical to buyer-side because BOTH derive from the same spec,
// not because they share any code or import.

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
const SAMPLE_DETAIL_HASH = "a".repeat(64);
const SAMPLE_ADVERTISED_AT = 1745500000000;
const SAMPLE_STATUS: "Active" = "Active";

/**
 * buildSampleAdvertDatum — returns the canonical sample AdvertDatum.
 * Derived independently from ARCHITECTURE.md §4.1; shares NO code with buyer-side.
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
 * encodeSampleAdvertDatumHex — CBOR-encodes the sample datum using cbor-x.
 *
 * Field order per §4.1 (13 fields) — written independently from buyer-side.
 * If this produces a different hex than buyer-side, one side has misread the spec.
 */
export function encodeSampleAdvertDatumHex(): string {
  const datum = buildSampleAdvertDatum();

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
 * readGoldenAdvertDatum — reads the buyer-side golden hex from file.
 */
export function readGoldenAdvertDatum(goldenPath: string): string {
  return readFileSync(goldenPath, "utf8").trim();
}
