/**
 * AdvertDatum CBOR Round-trip Tests — M0-B RED phase
 *
 * Uses cbor-x with the Plutus Tag extension (see apex-dashboard cbor-decoder.ts).
 * Verifies encodeAdvertDatum / decodeAdvertDatum against realistic fixture values
 * from ARCHITECTURE.md §4.1.
 *
 * These tests MUST FAIL until Catherine implements encodeAdvertDatum /
 * decodeAdvertDatum in M0-C.
 *
 * CBOR encoding convention (must match implementation):
 *   AdvertDatum → Plutus Constr0 (tag 121) with 13 fields in declaration order.
 *   Fields:
 *     0:  supplier_pkh         — Uint8Array (28 bytes, raw)
 *     1:  capability_id        — Uint8Array (UTF-8)
 *     2:  model                — Uint8Array (UTF-8)
 *     3:  max_output_tokens    — number (int)
 *     4:  max_processing_ms    — number (int)
 *     5:  price_lovelace       — bigint
 *     6:  supplier_bond_lovelace — bigint
 *     7:  buyer_bond_lovelace  — bigint
 *     8:  endpoint_url         — Uint8Array (UTF-8)
 *     9:  detail_uri           — Uint8Array (UTF-8)
 *     10: detail_hash          — Uint8Array (32 bytes, raw)
 *     11: advertised_at        — number (int, POSIX ms)
 *     12: status               — Plutus Constr: tag 121 = Active, tag 122 = Retired
 */

import { describe, it, expect } from "vitest";
import { encodeAdvertDatum, decodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Canonical sample AdvertDatum.
 * Values match ARCHITECTURE.md §4.1 and M0-B design decisions:
 *   capability_id = "llm.text.generate.v1", model = "qwen2.5:0.5b"
 *   Bonds: symmetric 1 AP3X = 1_000_000 lovelace each (decision #14)
 */
const SAMPLE_ADVERT: AdvertDatum = {
  supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01", // 28-byte hex
  capability_id: "llm.text.generate.v1",
  model: "qwen2.5:0.5b",
  max_output_tokens: 512,
  max_processing_ms: 60_000,
  price_lovelace: 2_000_000n,
  supplier_bond_lovelace: 1_000_000n,
  buyer_bond_lovelace: 1_000_000n,
  endpoint_url: "https://supplier.example.com/v1",
  detail_uri: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  detail_hash: "a".repeat(64), // 32-byte hex (sha256)
  advertised_at: 1745500000000,
  status: "Active",
};

const SAMPLE_ADVERT_RETIRED: AdvertDatum = {
  ...SAMPLE_ADVERT,
  status: "Retired",
};

// ─── Round-trip tests ─────────────────────────────────────────────────────────

describe("AdvertDatum CBOR round-trip", () => {
  it("encode then decode returns a deep-equal datum", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded).toEqual(SAMPLE_ADVERT);
  });

  it("encoded result is a non-empty hex string", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    expect(typeof hex).toBe("string");
    expect(hex.length).toBeGreaterThan(0);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it("encodes to hex with even length (whole bytes)", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    expect(hex.length % 2).toBe(0);
  });

  it("supplier_pkh round-trips as 28-byte lowercase hex", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.supplier_pkh).toBe("abcdef0123456789abcdef0123456789abcdef0123456789abcdef01");
    expect(decoded.supplier_pkh).toHaveLength(56); // 28 bytes * 2
  });

  it("capability_id round-trips correctly", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.capability_id).toBe("llm.text.generate.v1");
  });

  it("model round-trips correctly", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.model).toBe("qwen2.5:0.5b");
  });

  it("max_output_tokens round-trips as integer", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.max_output_tokens).toBe(512);
    expect(Number.isInteger(decoded.max_output_tokens)).toBe(true);
  });

  it("max_processing_ms round-trips as integer", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.max_processing_ms).toBe(60_000);
  });

  it("price_lovelace round-trips as bigint", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.price_lovelace).toBe(2_000_000n);
    expect(typeof decoded.price_lovelace).toBe("bigint");
  });

  it("supplier_bond_lovelace round-trips as bigint", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.supplier_bond_lovelace).toBe(1_000_000n);
  });

  it("buyer_bond_lovelace round-trips as bigint", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.buyer_bond_lovelace).toBe(1_000_000n);
  });

  it("endpoint_url round-trips correctly", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.endpoint_url).toBe("https://supplier.example.com/v1");
  });

  it("detail_uri round-trips correctly", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.detail_uri).toBe("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
  });

  it("detail_hash round-trips as 32-byte lowercase hex", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.detail_hash).toBe("a".repeat(64));
    expect(decoded.detail_hash).toHaveLength(64); // 32 bytes * 2
  });

  it("advertised_at round-trips as POSIX time integer", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.advertised_at).toBe(1745500000000);
  });

  it("status 'Active' round-trips correctly", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.status).toBe("Active");
  });

  it("status 'Retired' round-trips correctly", () => {
    const hex = encodeAdvertDatum(SAMPLE_ADVERT_RETIRED);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.status).toBe("Retired");
  });

  it("Active and Retired encode to different hex", () => {
    const hexActive = encodeAdvertDatum(SAMPLE_ADVERT);
    const hexRetired = encodeAdvertDatum(SAMPLE_ADVERT_RETIRED);
    expect(hexActive).not.toBe(hexRetired);
  });

  it("encode is deterministic (same input → same hex)", () => {
    const h1 = encodeAdvertDatum(SAMPLE_ADVERT);
    const h2 = encodeAdvertDatum(SAMPLE_ADVERT);
    expect(h1).toBe(h2);
  });

  it("large lovelace value round-trips without precision loss", () => {
    const datum: AdvertDatum = {
      ...SAMPLE_ADVERT,
      price_lovelace: 9_007_199_254_740_993n, // > Number.MAX_SAFE_INTEGER
    };
    const hex = encodeAdvertDatum(datum);
    const decoded = decodeAdvertDatum(hex);
    expect(decoded.price_lovelace).toBe(9_007_199_254_740_993n);
  });
});

// ─── Adversarial: truncated CBOR ─────────────────────────────────────────────

describe("AdvertDatum CBOR adversarial — truncated input", () => {
  it("decodeAdvertDatum throws or returns an error for empty hex", () => {
    expect(() => decodeAdvertDatum("")).toThrow();
  });

  it("decodeAdvertDatum throws for a single-byte truncated CBOR", () => {
    // 0xd8 is the start of a 1-byte CBOR tag but is incomplete alone
    expect(() => decodeAdvertDatum("d8")).toThrow();
  });

  it("decodeAdvertDatum throws for hex truncated mid-datum", () => {
    const full = encodeAdvertDatum(SAMPLE_ADVERT);
    // Cut to first quarter of the full hex
    const truncated = full.slice(0, Math.floor(full.length / 4));
    expect(() => decodeAdvertDatum(truncated)).toThrow();
  });
});

// ─── Adversarial: wrong Plutus constructor tag ────────────────────────────────

describe("AdvertDatum CBOR adversarial — wrong constructor tag", () => {
  it("decodeAdvertDatum throws for a datum with constructor tag 122 instead of 121", () => {
    // Build CBOR with Constr1 (tag 122) instead of Constr0 (tag 121).
    // We use cbor-x directly to construct this adversarial input.
    //
    // Encoding: d8 7a = CBOR tag 122, 87 = array(7), ...
    // Rather than crafting bytes manually, we encode a placeholder integer with
    // a known wrong tag to verify the decoder rejects it.
    //
    // Minimal Constr1 (tag 122) wrapping a single int: d87a81 01
    const wrongTagHex = "d87a8100"; // tag 122, array([0])
    expect(() => decodeAdvertDatum(wrongTagHex)).toThrow();
  });
});

// ─── Adversarial: negative price_lovelace ────────────────────────────────────

describe("AdvertDatum CBOR adversarial — invariant violations", () => {
  /**
   * The spec does not explicitly state whether the codec enforces sign constraints.
   * Design decision: the codec is PERMISSIVE — it round-trips whatever was encoded.
   * Validation of business invariants (price >= 0, bonds > 0, etc.) belongs
   * in a higher-level validation layer, NOT in the CBOR codec itself.
   * This test documents that decision: negative price_lovelace encodes and
   * decodes without error, and the caller is responsible for validation.
   */
  it("negative price_lovelace encodes and decodes (codec is permissive; validation is caller's job)", () => {
    const datum: AdvertDatum = {
      ...SAMPLE_ADVERT,
      price_lovelace: -1n,
    };
    // If this throws, the codec is enforcing invariants — update comment above
    // and remove this test, then add a throws-test instead.
    expect(() => {
      const hex = encodeAdvertDatum(datum);
      const decoded = decodeAdvertDatum(hex);
      expect(decoded.price_lovelace).toBe(-1n);
    }).not.toThrow();
  });
});
