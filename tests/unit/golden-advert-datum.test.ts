/**
 * Golden file of the AdvertDatum codec (ARCHITECTURE.md §7.2: no same source of truth).
 * The buyer-side builder wrote the golden file. Two other encoders must give the same bytes:
 * the supplier-side builder (cbor-x, no codec) and `encodeAdvertDatum`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { buildSampleAdvertDatum as buyerBuildSample } from "../fixtures/buyer-side/advert-datum-builders.js";
import { encodeSampleAdvertDatumHex as supplierEncode } from "../fixtures/supplier-side/advert-datum-builders.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";

const golden = readFileSync(new URL("../fixtures/golden/advert-datum-sample.hex", import.meta.url), "utf8").trim();

describe("AdvertDatum golden", () => {
  it("supplier-side CBOR encoding matches the golden hex", () => {
    expect(supplierEncode()).toBe(golden);
  });

  it("encodeAdvertDatum output matches the golden hex", () => {
    expect(encodeAdvertDatum(buyerBuildSample())).toBe(golden);
  });
});
