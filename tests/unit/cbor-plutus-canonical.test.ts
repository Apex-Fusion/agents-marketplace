/**
 * RED by design — current codec uses cbor-x default Uint8Array encoding,
 * which emits CBOR tag 64 (0xd8 0x40). Plutus validators require bare
 * bytestrings (major type 2, 0x40..0x5f / 0x58 <len> / 0x59 <len:u16>).
 *
 * These tests SHOULD FAIL against the current encoder. They scope the
 * codec fix that must land before Tier-2 (Ogmios EvaluateTx) and Tier-3
 * (real on-chain submit). Do NOT mark .skip — keep this as a live RED
 * signal. When Catherine fixes the codec these go green.
 */

import { describe, it, expect } from "vitest";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildSampleAdvertDatum } from "../fixtures/buyer-side/advert-datum-builders.js";
import { buildSampleEscrowDatum } from "../fixtures/buyer-side/escrow-datum-builders.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the hex CBOR contains CBOR tag 64 (0xd8 0x40) anywhere.
 * cbor-x emits this two-byte prefix for every Uint8Array field by default.
 * Plutus validators reject it — they require bare major-type-2 bytestrings.
 */
function containsTag64(hex: string): boolean {
  return hex.toLowerCase().includes("d840");
}

/**
 * Scan `haystackHex` for `payloadHex` and return the four hex chars (two bytes)
 * immediately before it, or null if not found.
 * Used to inspect the CBOR length header directly preceding a known byte payload.
 *
 * When cbor-x emits tag-64 wrapping, the byte sequence before the payload is:
 *   0xd8 0x40 <bare-header> <payload>
 * so the 4 chars immediately before the payload will be the bare header (e.g. 581c),
 * but the 6 chars before it will include "d840". We check both: that the bare header
 * IS present (format is right) but that d840 does NOT appear in the 6 chars before
 * the payload (no tag-64 wrapper).
 */
function fourCharsBeforePayload(haystackHex: string, payloadHex: string): string | null {
  const lower = haystackHex.toLowerCase();
  const needle = payloadHex.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 4) return null;
  return lower.slice(idx - 4, idx);
}

/**
 * Return the 8 hex chars (4 bytes) immediately before payloadHex in haystackHex.
 * Used to detect whether tag-64 wrapping (d840) precedes the length header.
 */
function eightCharsBeforePayload(haystackHex: string, payloadHex: string): string | null {
  const lower = haystackHex.toLowerCase();
  const needle = payloadHex.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 8) return null;
  return lower.slice(idx - 8, idx);
}

// ─── AdvertDatum — 3 assertions ───────────────────────────────────────────────

describe("encodeAdvertDatum — Plutus bare-bytestring compliance (RED)", () => {
  const sample = buildSampleAdvertDatum();
  // Encode once; all sub-tests share this hex string.
  const hex = encodeAdvertDatum(sample);

  it("hex contains no 'd840' subsequence (tag-64 absent)", () => {
    // FAILS: cbor-x wraps every Uint8Array field in CBOR tag 64 (0xd8 0x40).
    expect(containsTag64(hex)).toBe(false);
  });

  it("supplier_pkh field (28 bytes) has no tag-64 wrapper before its bare header 0x58 0x1c", () => {
    // supplier_pkh payload = sample.supplier_pkh (56 hex chars, 28 bytes).
    // Bare encoding: ...0x58 0x1c <28 bytes>   → 4 chars before payload = "581c"
    // Tag-64 encoding: ...0xd8 0x40 0x58 0x1c <28 bytes>
    //   → 4 chars before payload still "581c" (the bare header is still there)
    //   → but 8 chars before payload = "d840581c" revealing the tag wrapper.
    //
    // We assert the 8-char prefix does NOT start with "d840".
    const pkhHex = sample.supplier_pkh; // 56 hex chars
    const ctx = eightCharsBeforePayload(hex, pkhHex);
    expect(ctx).not.toBeNull();
    // Must NOT have tag-64 (d840) in the 4 bytes immediately before the payload.
    expect(ctx!.startsWith("d840")).toBe(false);
    // AND the bare header must be 581c (28 bytes, 2-byte length prefix form).
    const bareHeader = fourCharsBeforePayload(hex, pkhHex);
    expect(bareHeader).toBe("581c");
  });

  it("capability_id 'llm.text.generate.v1' (20 bytes) has no tag-64 wrapper before its bare header 0x54", () => {
    // 20 bytes → bare 1-byte header 0x54 (0x40 | 20).
    // Tag-64 encoding: 0xd8 0x40 0x54 <20 bytes>
    //   → 2 chars before payload = "54" (correct header is there)
    //   → but 6 chars before payload = "d84054" if tag-64 wraps it.
    //
    // Use scan-based approach: locate UTF-8 hex of the string, check 3 bytes before it.
    const capHex = Buffer.from(sample.capability_id, "utf8").toString("hex"); // 40 hex chars
    const lower = hex.toLowerCase();
    const needle = capHex.toLowerCase();
    const idx = lower.indexOf(needle);
    expect(idx).toBeGreaterThan(5);

    // The byte immediately before the payload must be 0x54 (bare header for 20 bytes).
    const headerByte = lower.slice(idx - 2, idx);
    expect(headerByte).toBe("54");

    // The two bytes before that header must NOT be "d840" (tag-64 prefix).
    const twoBefore = lower.slice(idx - 6, idx - 2);
    expect(twoBefore).not.toBe("d840");
  });
});

// ─── EscrowDatum — 3 assertions ───────────────────────────────────────────────

describe("encodeEscrowDatum — Plutus bare-bytestring compliance (RED)", () => {
  const sample = buildSampleEscrowDatum();
  const hex = encodeEscrowDatum(sample);

  it("hex contains no 'd840' subsequence (tag-64 absent)", () => {
    // FAILS: same root cause as AdvertDatum — cbor-x tag-64 on every Uint8Array.
    expect(containsTag64(hex)).toBe(false);
  });

  it("advert_ref inner txHash (32 bytes) has no tag-64 wrapper before its bare header 0x58 0x20", () => {
    // txHash = "b".repeat(64) = 32 bytes of 0xbb.
    // Bare header: 0x58 0x20 (two-byte length prefix for 32 bytes).
    // Tag-64: 0xd8 0x40 0x58 0x20 <32 bytes> → 8 chars before payload starts "d840".
    const txHashHex = sample.advert_ref.txHash; // 64 hex chars
    const ctx = eightCharsBeforePayload(hex, txHashHex);
    expect(ctx).not.toBeNull();
    expect(ctx!.startsWith("d840")).toBe(false);
    expect(fourCharsBeforePayload(hex, txHashHex)).toBe("5820");
  });

  it("prompt_hash and request_spec_hash (32 bytes each) have no tag-64 wrapper before their bare headers 0x58 0x20", () => {
    // prompt_hash = "d".repeat(64), request_spec_hash = "c".repeat(64).
    // Both are distinct byte patterns so the scan locates each unambiguously.
    for (const [name, fieldHex] of [
      ["prompt_hash", sample.prompt_hash],
      ["request_spec_hash", sample.request_spec_hash],
    ] as const) {
      const ctx = eightCharsBeforePayload(hex, fieldHex);
      expect(ctx, `${name}: payload not found`).not.toBeNull();
      expect(
        ctx!.startsWith("d840"),
        `${name}: tag-64 prefix (d840) must be absent`,
      ).toBe(false);
      const hdr = fourCharsBeforePayload(hex, fieldHex);
      expect(hdr, `${name}: bare header must be 5820`).toBe("5820");
    }
  });
});
