/**
 * EscrowDatum CBOR round-trip tests.
 *
 * Uses cbor-x with the Plutus Tag extension (see apex-dashboard cbor-decoder.ts).
 * Verifies encodeEscrowDatum / decodeEscrowDatum against realistic fixture values
 * from ARCHITECTURE.md §4.2.
 *
 * CBOR encoding convention (must match implementation):
 *   EscrowDatum → Plutus Constr0 (tag 121) with 14 fields in declaration order.
 *   Fields:
 *     0:  buyer_pkh            — Uint8Array (28 bytes, raw)
 *     1:  supplier_pkh         — Uint8Array (28 bytes, raw)
 *     2:  advert_ref           — Plutus OutputReference = Constr0[txHash:bytes, index:int]
 *                                i.e. Tag(121, [Uint8Array(32), int])
 *     3:  capability_id        — Uint8Array (UTF-8)
 *     4:  request_spec_hash    — Uint8Array (32 bytes, raw)
 *     5:  prompt_hash          — Uint8Array (32 bytes, raw)
 *     6:  payment_lovelace     — bigint
 *     7:  buyer_bond_lovelace  — bigint
 *     8:  supplier_bond_lovelace — bigint
 *     9:  deliver_by           — number (int, POSIX ms)
 *     10: posted_at            — number (int, POSIX ms)
 *     11: submitted_at         — Option: Tag(122, []) = None; Tag(121, [int]) = Some
 *     12: result_receipt_hash  — Option: Tag(122, []) = None; Tag(121, [bytes]) = Some
 *     13: state                — EscrowState tag:
 *                                  Open=121, Claimed=122, Submitted=123,
 *                                  Accepted=124, Reclaimed=125, Released=126
 *                                each as Tag(stateTag, [])
 *
 * Reference for advert_ref OutputReference shape:
 *   apex-dashboard/server/cbor-decoder.ts:257-260
 *   cbor2.CBORTag(121, [bytes.fromhex(claim_txid), int(claim_idx)])
 */

import { describe, it, expect } from "vitest";
import { encodeEscrowDatum, decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum, EscrowState } from "../../packages/shared/src/cbor/types.js";
import { buildSampleEscrowDatum } from "../fixtures/buyer-side/escrow-datum-builders.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RECEIPT_HASH = "e".repeat(64); // 32-byte hex

function makeEscrowWithState(state: EscrowState): EscrowDatum {
  const base = buildSampleEscrowDatum();
  if (state === "Submitted" || state === "Accepted" || state === "Released") {
    return {
      ...base,
      submitted_at: 1745500030000,
      result_receipt_hash: RECEIPT_HASH,
      state,
    };
  }
  return { ...base, state };
}

// ─── Round-trip tests ─────────────────────────────────────────────────────────

describe("EscrowDatum CBOR round-trip", () => {
  const open = buildSampleEscrowDatum();
  const rows: Array<[string, EscrowDatum]> = [
    ["an Open escrow, both Options None", open],
    ["a non-zero advert_ref index", { ...open, advert_ref: { ...open.advert_ref, index: 7 } }],
    ["both Options Some", { ...open, submitted_at: 1745500030000, result_receipt_hash: RECEIPT_HASH, state: "Submitted" }],
  ];

  it.each(rows)("encode then decode returns a deep-equal datum: %s", (_label, escrow) => {
    const hex = encodeEscrowDatum(escrow);
    const decoded = decodeEscrowDatum(hex);
    expect(decoded).toEqual(escrow);
  });
});

// ─── EscrowState variants ─────────────────────────────────────────────────────

const ALL_STATES: EscrowState[] = [
  "Open",
  "Claimed",
  "Submitted",
  "Accepted",
  "Reclaimed",
  "Released",
];

describe("EscrowDatum CBOR — all 6 EscrowState variants", () => {
  it("each state round-trips correctly", () => {
    for (const state of ALL_STATES) {
      const escrow = makeEscrowWithState(state);
      const hex = encodeEscrowDatum(escrow);
      const decoded = decodeEscrowDatum(hex);
      expect(decoded.state, state).toBe(state);
    }
  });
});

// ─── Adversarial: missing required field ─────────────────────────────────────

describe("EscrowDatum CBOR adversarial — malformed inputs", () => {
  it("decodeEscrowDatum throws for empty hex", () => {
    expect(() => decodeEscrowDatum("")).toThrow();
  });

  it("decodeEscrowDatum throws for truncated CBOR (half the encoded datum)", () => {
    const full = encodeEscrowDatum(buildSampleEscrowDatum());
    const truncated = full.slice(0, Math.floor(full.length / 2));
    expect(() => decodeEscrowDatum(truncated)).toThrow();
  });

  it("decodeEscrowDatum throws for a datum with missing fields (only 5 fields instead of 14)", () => {
    // Constr0 (tag 121) with only 5 fields — insufficient for EscrowDatum
    // CBOR: d8 79 85 01 02 03 04 05 = tag(121, [1, 2, 3, 4, 5])
    const shortDatum = "d87985010203 0405".replace(/\s/g, "");
    expect(() => decodeEscrowDatum(shortDatum)).toThrow();
  });
});
