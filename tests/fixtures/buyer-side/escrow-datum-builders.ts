/**
 * Buyer-side EscrowDatum fixture builder — M0-B RED phase
 *
 * Constructs EscrowDatum INDEPENDENTLY from the spec (ARCHITECTURE.md §4.2).
 * MUST NOT import from supplier-side builders or any shared fixture helper.
 *
 * Golden file authority: THIS file (buyer-side) is the golden source for
 * tests/fixtures/golden/escrow-datum-open.hex
 *
 * EscrowDatum on-chain encoding (14 fields in Constr0 tag 121):
 *   0:  buyer_pkh              — bytes (28)
 *   1:  supplier_pkh           — bytes (28)
 *   2:  advert_ref             — Constr0[txHash:bytes(32), index:int]
 *   3:  capability_id          — bytes (UTF-8)
 *   4:  request_spec_hash      — bytes (32)
 *   5:  prompt_hash            — bytes (32)
 *   6:  payment_lovelace       — bigint
 *   7:  buyer_bond_lovelace    — bigint
 *   8:  supplier_bond_lovelace — bigint
 *   9:  deliver_by             — int (POSIX ms)
 *   10: posted_at              — int (POSIX ms)
 *   11: submitted_at           — Option: Constr1([]) = None | Constr0([int]) = Some
 *   12: result_receipt_hash    — Option: Constr1([]) = None | Constr0([bytes]) = Some
 *   13: state                  — Constr tag: Open=121, Claimed=122, Submitted=123,
 *                                Accepted=124, Reclaimed=125, Released=126
 */

import { Tag } from "cbor-x";
import { readFileSync, writeFileSync } from "fs";
import type { EscrowDatum } from "../../../packages/shared/src/cbor/types.js";
// NOTE: Shared low-level CBOR encoder. Does NOT violate fixture isolation —
// see comment in advert-datum-builders.ts (same rationale).
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

// Option encoding: None = Constr1 (tag 122, []), Some(x) = Constr0 (tag 121, [x])
function optionNone(): Tag {
  return plutusTag(122, []);
}

function optionSome(value: unknown): Tag {
  return plutusTag(121, [value]);
}

// EscrowState constructor tags (Open=121, Claimed=122, ..., Released=126)
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
const DELIVER_BY = 1745500060000; // posted_at + max_processing_ms + network_buffer
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
 * encodeSampleEscrowDatumHex — CBOR-encodes the Open sample datum directly
 * using cbor-x. This is the golden reference; encodeEscrowDatum must match it.
 */
export function encodeSampleEscrowDatumHex(): string {
  const datum = buildSampleEscrowDatum();

  // Plutus integers must be CBOR major type 0/1; `number` values that exceed
  // u32 (e.g. POSIX-ms timestamps) get encoded as float64 by cbor-x and are
  // rejected by CML.PlutusData.from_cbor_hex. Coerce all integer fields to
  // BigInt so they emit as canonical major-type-0 ints. Matches the same
  // fix in packages/shared/src/cbor/EscrowDatum.ts.
  const cborDatum = plutusTag(121, [
    hexToBytes(datum.buyer_pkh),
    hexToBytes(datum.supplier_pkh),
    // advert_ref as OutputReference = Constr0[txHash:bytes, index:int]
    plutusTag(121, [hexToBytes(datum.advert_ref.txHash), BigInt(datum.advert_ref.index)]),
    utf8Bytes(datum.capability_id),
    hexToBytes(datum.request_spec_hash),
    hexToBytes(datum.prompt_hash),
    datum.payment_lovelace,
    datum.buyer_bond_lovelace,
    datum.supplier_bond_lovelace,
    BigInt(datum.deliver_by),
    BigInt(datum.posted_at),
    // submitted_at: None
    optionNone(),
    // result_receipt_hash: None
    optionNone(),
    // state: Open = tag 121
    plutusTag(STATE_TAGS[datum.state], []),
  ]);

  return bytesToHex(encodePlutus(cborDatum));
}

export function writeGoldenEscrowDatum(goldenPath: string): void {
  const hex = encodeSampleEscrowDatumHex();
  writeFileSync(goldenPath, hex + "\n", "utf8");
}

export function readGoldenEscrowDatum(goldenPath: string): string {
  return readFileSync(goldenPath, "utf8").trim();
}
