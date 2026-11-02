// Golden CBOR fixtures of the Aiken types (contracts/identity-marketplace/fixtures/cbor-fixtures.json,
// written by the contracts with cbor.serialise). Every fixture must decode as Plutus Data and
// re-encode byte for byte; the identity and legacy datums must also survive the typed codecs of
// this package. IDENTITY_CBOR_FIXTURES overrides the path. The suite is skipped only while the
// contracts project has not written the file yet.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { decodeIdentityDatum, encodeIdentityDatum } from "../src/codec/identity-datum.js";
import { decodeLegacyDatum, encodeLegacyDatum } from "../src/codec/legacy-datum.js";
import { decodePlutusData, encodePlutusData } from "../src/codec/plutus-data.js";

interface Fixture {
  type: string;
  cbor: string;
  diagnostic: string;
}

const path =
  process.env.IDENTITY_CBOR_FIXTURES ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts/identity-marketplace/fixtures/cbor-fixtures.json");
const fixtures: Array<[string, Fixture]> = existsSync(path)
  ? Object.entries((JSON.parse(readFileSync(path, "utf8")) as { fixtures: Record<string, Fixture> }).fixtures)
  : [];
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");

describe.skipIf(fixtures.length === 0)(`golden CBOR fixtures (${path})`, () => {
  test.each(fixtures)("%s: Plutus Data decode and encode give the same bytes", (_name, fixture) => {
    expect(hex(encodePlutusData(decodePlutusData(bytes(fixture.cbor))))).toBe(fixture.cbor);
  });

  const identity = fixtures.filter(([, f]) => f.type.endsWith("types.IdentityDatum"));
  const legacy = fixtures.filter(([, f]) => f.type.endsWith("types.LegacyDatum"));

  test("the file has identity and legacy datum fixtures", () => {
    expect(identity.length).toBeGreaterThan(0);
    expect(legacy.length).toBeGreaterThan(0);
  });

  test.each(identity)("%s: IdentityDatum decode and encode give the same bytes", (_name, fixture) => {
    expect(hex(encodeIdentityDatum(decodeIdentityDatum(bytes(fixture.cbor))))).toBe(fixture.cbor);
  });

  test.each(legacy)("%s: LegacyDatum decode and encode give the same bytes", (_name, fixture) => {
    expect(hex(encodeLegacyDatum(decodeLegacyDatum(bytes(fixture.cbor))))).toBe(fixture.cbor);
  });
});
