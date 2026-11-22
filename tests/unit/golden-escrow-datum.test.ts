/**
 * Golden file of the EscrowDatum codec (ARCHITECTURE.md §7.2: no same source of truth).
 * The buyer-side builder wrote the golden file. Two other encoders must give the same bytes:
 * the supplier-side builder (cbor-x, no codec) and `encodeEscrowDatum`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { buildSampleEscrowDatum as buyerBuildSample } from "../fixtures/buyer-side/escrow-datum-builders.js";
import { encodeSampleEscrowDatumHex as supplierEncode } from "../fixtures/supplier-side/escrow-datum-builders.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";

const golden = readFileSync(new URL("../fixtures/golden/escrow-datum-open.hex", import.meta.url), "utf8").trim();

describe("EscrowDatum golden", () => {
  it("supplier-side CBOR encoding matches the golden hex", () => {
    expect(supplierEncode()).toBe(golden);
  });

  it("encodeEscrowDatum output matches the golden hex", () => {
    expect(encodeEscrowDatum(buyerBuildSample())).toBe(golden);
  });
});
