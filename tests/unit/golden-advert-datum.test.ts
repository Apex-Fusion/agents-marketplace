/**
 * Golden cross-validation — AdvertDatum — M0-B RED phase
 *
 * Tests the "no same source of truth" discipline (ARCHITECTURE.md §7.2):
 *   - Buyer-side builder independently encodes the sample datum
 *   - Supplier-side builder independently encodes the same datum
 *   - Both must match the golden file produced by buyer-side
 *   - encodeAdvertDatum (Catherine's codec) must ALSO match
 *
 * These tests use the fixture builders directly (cbor-x, no codec dependency)
 * so builder-vs-golden tests pass once the builders are correct.
 * The codec-vs-golden test is the one that stays RED until M0-C.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildSampleAdvertDatum as buyerBuildSample,
  encodeSampleAdvertDatumHex as buyerEncode,
} from "../fixtures/buyer-side/advert-datum-builders.js";
import {
  buildSampleAdvertDatum as supplierBuildSample,
  encodeSampleAdvertDatumHex as supplierEncode,
} from "../fixtures/supplier-side/advert-datum-builders.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";

const GOLDEN_PATH = new URL(
  "../fixtures/golden/advert-datum-sample.hex",
  import.meta.url,
).pathname;

function readGolden(): string {
  return readFileSync(GOLDEN_PATH, "utf8").trim();
}

// ─── Fixture builder cross-validation ────────────────────────────────────────

describe("AdvertDatum golden — fixture builder cross-validation", () => {
  it("buyer-side build produces the same AdvertDatum fields as supplier-side", () => {
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

describe("AdvertDatum golden — codec vs golden (RED until M0-C)", () => {
  it("encodeAdvertDatum output matches the golden hex", () => {
    const datum = buyerBuildSample();
    const golden = readGolden();
    // This MUST fail until Catherine implements encodeAdvertDatum
    const codeHex = encodeAdvertDatum(datum);
    expect(codeHex).toBe(golden);
  });
});
