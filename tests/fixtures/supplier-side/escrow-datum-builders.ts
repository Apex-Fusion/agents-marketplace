/**
 * Supplier-side EscrowDatum fixture builder — M0-B RED phase
 *
 * Constructs EscrowDatum INDEPENDENTLY from the spec (ARCHITECTURE.md §4.2).
 * MUST NOT import from buyer-side builders or any shared fixture helper.
 *
 * Golden file consumer: Reads tests/fixtures/golden/escrow-datum-open.hex
 * (produced by buyer-side), independently encodes the same datum, and asserts
 * hex equality. Divergence indicates a spec interpretation error.
 */

import { Tag } from "cbor-x";
import { readFileSync } from "fs";
import type { EscrowDatum } from "../../../packages/shared/src/cbor/types.js";
// NOTE: Shared low-level CBOR encoder. Does NOT violate fixture isolation —
// see comment in advert-datum-builders.ts (same rationale).
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

function optionNone(): Tag {
  return plutusTag(122, []);
}

const STATE_TAGS: Record<string, number> = {
  Open: 121,
  Claimed: 122,
  Submitted: 123,
  Accepted: 124,
  Reclaimed: 125,
  Released: 126,
};

// ─── Sample datum values — from ARCHITECTURE.md §4.2 ─────────────────────────

const BUYER_PKH = "1234567890abcdef1234567890abcdef1234567890abcdef12345678";
const SUPPLIER_PKH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01";
const ADVERT_TX_HASH = "b".repeat(64);
const ADVERT_INDEX = 0;
const CAPABILITY_ID = "llm.text.generate.v1";
const REQUEST_SPEC_HASH = "c".repeat(64);
const PROMPT_HASH = "d".repeat(64);
const PAYMENT_LOVELACE = 2_000_000n;
const BUYER_BOND = 1_000_000n;
const SUPPLIER_BOND = 1_000_000n;
const DELIVER_BY = 1745500060000;
const POSTED_AT = 1745500000000;

/**
 * buildSampleEscrowDatum — returns the canonical Open escrow datum.
 * Derived independently from ARCHITECTURE.md §4.2.
 */
export function buildSampleEscrowDatum(): EscrowDatum {
  return {
    buyer_pkh: BUYER_PKH,
    supplier_pkh: SUPPLIER_PKH,
    advert_ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    capability_id: CAPABILITY_ID,
    request_spec_hash: REQUEST_SPEC_HASH,
    prompt_hash: PROMPT_HASH,
    payment_lovelace: PAYMENT_LOVELACE,
    buyer_bond_lovelace: BUYER_BOND,
    supplier_bond_lovelace: SUPPLIER_BOND,
    deliver_by: DELIVER_BY,
    posted_at: POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };
}

/**
 * encodeSampleEscrowDatumHex — CBOR-encodes the Open sample datum directly.
 * Written independently from buyer-side. Both must produce identical hex.
 */
export function encodeSampleEscrowDatumHex(): string {
  const datum = buildSampleEscrowDatum();

  // Plutus integers must be CBOR major type 0/1; `number` values exceeding
  // u32 (POSIX-ms timestamps) emit as float64 by cbor-x and are rejected by
  // CML.PlutusData.from_cbor_hex. Coerce all int fields to BigInt. Matches
  // the same fix in packages/shared/src/cbor/EscrowDatum.ts.
  const cborDatum = plutusTag(121, [
    hexToBytes(datum.buyer_pkh),
    hexToBytes(datum.supplier_pkh),
    plutusTag(121, [hexToBytes(datum.advert_ref.txHash), BigInt(datum.advert_ref.index)]),
    utf8Bytes(datum.capability_id),
    hexToBytes(datum.request_spec_hash),
    hexToBytes(datum.prompt_hash),
    datum.payment_lovelace,
    datum.buyer_bond_lovelace,
    datum.supplier_bond_lovelace,
    BigInt(datum.deliver_by),
    BigInt(datum.posted_at),
    optionNone(),
    optionNone(),
    plutusTag(STATE_TAGS[datum.state], []),
  ]);

  return bytesToHex(encodePlutus(cborDatum));
}

export function readGoldenEscrowDatum(goldenPath: string): string {
  return readFileSync(goldenPath, "utf8").trim();
}
