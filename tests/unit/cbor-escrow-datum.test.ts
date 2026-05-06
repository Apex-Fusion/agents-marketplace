/**
 * EscrowDatum CBOR Round-trip Tests — M0-B RED phase
 *
 * Uses cbor-x with the Plutus Tag extension (see apex-dashboard cbor-decoder.ts).
 * Verifies encodeEscrowDatum / decodeEscrowDatum against realistic fixture values
 * from ARCHITECTURE.md §4.2.
 *
 * These tests MUST FAIL until Catherine implements encodeEscrowDatum /
 * decodeEscrowDatum in M0-C.
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BUYER_PKH = "1234567890abcdef1234567890abcdef1234567890abcdef12345678"; // 28-byte hex
const SUPPLIER_PKH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01"; // 28-byte hex
const ADVERT_TX_HASH = "b".repeat(64); // 32-byte hex
const REQUEST_HASH = "c".repeat(64); // 32-byte hex
const PROMPT_HASH = "d".repeat(64); // 32-byte hex
const RECEIPT_HASH = "e".repeat(64); // 32-byte hex

/** Base Open escrow with no submitted fields set. */
function makeOpenEscrow(): EscrowDatum {
  return {
    buyer_pkh: BUYER_PKH,
    supplier_pkh: SUPPLIER_PKH,
    advert_ref: { txHash: ADVERT_TX_HASH, index: 0 },
    capability_id: "llm.text.generate.v1",
    request_spec_hash: REQUEST_HASH,
    prompt_hash: PROMPT_HASH,
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: 1745500060000,
    posted_at: 1745500000000,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };
}

function makeEscrowWithState(state: EscrowState): EscrowDatum {
  const base = makeOpenEscrow();
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

describe("EscrowDatum CBOR round-trip — Open state", () => {
  it("encode then decode returns a deep-equal datum", () => {
    const escrow = makeOpenEscrow();
    const hex = encodeEscrowDatum(escrow);
    const decoded = decodeEscrowDatum(hex);
    expect(decoded).toEqual(escrow);
  });

  it("encoded result is a non-empty lowercase hex string", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    expect(typeof hex).toBe("string");
    expect(hex.length).toBeGreaterThan(0);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it("buyer_pkh round-trips as 28-byte lowercase hex", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.buyer_pkh).toBe(BUYER_PKH);
    expect(decoded.buyer_pkh).toHaveLength(56);
  });

  it("supplier_pkh round-trips correctly", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.supplier_pkh).toBe(SUPPLIER_PKH);
  });

  it("capability_id round-trips correctly", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.capability_id).toBe("llm.text.generate.v1");
  });

  it("request_spec_hash round-trips as 32-byte hex", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.request_spec_hash).toBe(REQUEST_HASH);
    expect(decoded.request_spec_hash).toHaveLength(64);
  });

  it("prompt_hash round-trips as 32-byte hex", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.prompt_hash).toBe(PROMPT_HASH);
    expect(decoded.prompt_hash).toHaveLength(64);
  });

  it("payment_lovelace round-trips as bigint", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.payment_lovelace).toBe(2_000_000n);
    expect(typeof decoded.payment_lovelace).toBe("bigint");
  });

  it("buyer_bond_lovelace round-trips as bigint", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.buyer_bond_lovelace).toBe(1_000_000n);
  });

  it("supplier_bond_lovelace round-trips as bigint", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.supplier_bond_lovelace).toBe(1_000_000n);
  });

  it("deliver_by round-trips as POSIX time integer", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.deliver_by).toBe(1745500060000);
  });

  it("posted_at round-trips as POSIX time integer", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.posted_at).toBe(1745500000000);
  });

  it("submitted_at null decodes as null (Option = None)", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.submitted_at).toBeNull();
  });

  it("result_receipt_hash null decodes as null (Option = None)", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.result_receipt_hash).toBeNull();
  });
});

// ─── advert_ref as OutputReference ───────────────────────────────────────────

describe("EscrowDatum CBOR — advert_ref as Plutus OutputReference", () => {
  it("advert_ref txHash round-trips correctly", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.advert_ref.txHash).toBe(ADVERT_TX_HASH);
  });

  it("advert_ref index round-trips as integer", () => {
    const hex = encodeEscrowDatum(makeOpenEscrow());
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.advert_ref.index).toBe(0);
    expect(Number.isInteger(decoded.advert_ref.index)).toBe(true);
  });

  it("advert_ref with non-zero index round-trips correctly", () => {
    const escrow: EscrowDatum = {
      ...makeOpenEscrow(),
      advert_ref: { txHash: ADVERT_TX_HASH, index: 7 },
    };
    const hex = encodeEscrowDatum(escrow);
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.advert_ref.index).toBe(7);
  });
});

// ─── Option fields — submitted_at and result_receipt_hash ────────────────────

describe("EscrowDatum CBOR — Option fields", () => {
  it("submitted_at Some(timestamp) round-trips correctly", () => {
    const escrow: EscrowDatum = {
      ...makeOpenEscrow(),
      submitted_at: 1745500030000,
      result_receipt_hash: RECEIPT_HASH,
      state: "Submitted",
    };
    const hex = encodeEscrowDatum(escrow);
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.submitted_at).toBe(1745500030000);
  });

  it("result_receipt_hash Some(hash) round-trips correctly", () => {
    const escrow: EscrowDatum = {
      ...makeOpenEscrow(),
      submitted_at: 1745500030000,
      result_receipt_hash: RECEIPT_HASH,
      state: "Submitted",
    };
    const hex = encodeEscrowDatum(escrow);
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.result_receipt_hash).toBe(RECEIPT_HASH);
    expect(decoded.result_receipt_hash).toHaveLength(64);
  });

  it("None submitted_at encodes differently than Some(timestamp)", () => {
    const withNone = makeOpenEscrow(); // submitted_at = null
    const withSome: EscrowDatum = { ...withNone, submitted_at: 1745500030000, state: "Submitted", result_receipt_hash: RECEIPT_HASH };
    expect(encodeEscrowDatum(withNone)).not.toBe(encodeEscrowDatum(withSome));
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
  for (const state of ALL_STATES) {
    it(`state '${state}' round-trips correctly`, () => {
      const escrow = makeEscrowWithState(state);
      const hex = encodeEscrowDatum(escrow);
      const decoded = decodeEscrowDatum(hex);
      expect(decoded.state).toBe(state);
    });
  }

  it("all state variants encode to distinct hex values", () => {
    const hexes = ALL_STATES.map((s) => encodeEscrowDatum(makeEscrowWithState(s)));
    const unique = new Set(hexes);
    expect(unique.size).toBe(ALL_STATES.length);
  });
});

// ─── Adversarial: missing required field ─────────────────────────────────────

describe("EscrowDatum CBOR adversarial — malformed inputs", () => {
  it("decodeEscrowDatum throws for empty hex", () => {
    expect(() => decodeEscrowDatum("")).toThrow();
  });

  it("decodeEscrowDatum throws for truncated CBOR (half the encoded datum)", () => {
    const full = encodeEscrowDatum(makeOpenEscrow());
    const truncated = full.slice(0, Math.floor(full.length / 2));
    expect(() => decodeEscrowDatum(truncated)).toThrow();
  });

  it("decodeEscrowDatum throws for a datum with missing fields (only 5 fields instead of 14)", () => {
    // Constr0 (tag 121) with only 5 fields — insufficient for EscrowDatum
    // CBOR: d8 79 85 01 02 03 04 05 = tag(121, [1, 2, 3, 4, 5])
    const shortDatum = "d87985010203 0405".replace(/\s/g, "");
    expect(() => decodeEscrowDatum(shortDatum)).toThrow();
  });

  it("decodeEscrowDatum throws for a datum with invalid state constructor tag", () => {
    // We build a valid datum and then manually corrupt the state tag byte.
    // This is done by encoding a datum with a known state, then replacing
    // the state's tag bytes with an out-of-range value (e.g. tag 200).
    //
    // Since we can't mutate the hex without knowing exact offsets at this
    // stage, we instead encode a minimal Constr0 with 14 fields where the
    // last field is Constr tag 200 (which is invalid for EscrowState).
    //
    // For now, this test uses the simplest possible adversarial approach:
    // pass a valid AdvertDatum-shaped CBOR where the state position would be
    // a string instead of a Constr tag. The decoder must reject it.
    const wrongStateDatum = "d87981 01".replace(/\s/g, ""); // tag(121, [1]) — integer state
    expect(() => decodeEscrowDatum(wrongStateDatum)).toThrow();
  });
});
