/**
 * Golden cross-validation — EscrowDatum — M0-B RED phase
 *
 * Same discipline as golden-advert-datum.test.ts but for EscrowDatum.
 * Buyer-side and supplier-side builders must independently produce the same
 * CBOR hex. encodeEscrowDatum (codec, M0-C) must also match.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  buildSampleEscrowDatum as buyerBuildSample,
  encodeSampleEscrowDatumHex as buyerEncode,
} from "../fixtures/buyer-side/escrow-datum-builders.js";
import {
  buildSampleEscrowDatum as supplierBuildSample,
  encodeSampleEscrowDatumHex as supplierEncode,
} from "../fixtures/supplier-side/escrow-datum-builders.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";

const GOLDEN_PATH = new URL(
  "../fixtures/golden/escrow-datum-open.hex",
  import.meta.url,
).pathname;

function readGolden(): string {
  return readFileSync(GOLDEN_PATH, "utf8").trim();
}

// ─── Fixture builder cross-validation ────────────────────────────────────────

describe("EscrowDatum golden — fixture builder cross-validation", () => {
  it("buyer-side build produces the same EscrowDatum fields as supplier-side", () => {
    const buyerDatum = buyerBuildSample();
    const supplierDatum = supplierBuildSample();
    expect(buyerDatum).toEqual(supplierDatum);
  });

  it("buyer-side CBOR encoding matches the golden hex", () => {
    const buyerHex = buyerEncode();
    const golden = readGolden();
    expect(buyerHex).toBe(golden);
  });

  it("supplier-side CBOR encoding matches the golden hex", () => {
    const supplierHex = supplierEncode();
    const golden = readGolden();
    expect(supplierHex).toBe(golden);
  });

  it("buyer-side and supplier-side produce identical CBOR hex", () => {
    expect(buyerEncode()).toBe(supplierEncode());
  });
});

// ─── Codec cross-validation (stays RED until M0-C) ───────────────────────────

describe("EscrowDatum golden — codec vs golden (RED until M0-C)", () => {
  it("encodeEscrowDatum output matches the golden hex", () => {
    const datum = buyerBuildSample();
    const golden = readGolden();
    // This MUST fail until Catherine implements encodeEscrowDatum
    const codeHex = encodeEscrowDatum(datum);
    expect(codeHex).toBe(golden);
  });
});
