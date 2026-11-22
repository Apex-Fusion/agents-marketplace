// Golden CBOR fixtures of the Aiken types (contracts/identity-marketplace/fixtures/cbor-fixtures.json,
// written by the contracts with cbor.serialise). Every distinct fixture must decode as Plutus Data and
// re-encode byte for byte; the identity and legacy datums must also survive the typed codecs of
// this package. IDENTITY_CBOR_FIXTURES overrides the path. The file must exist: the first case fails
// when it does not, so that a moved folder or a copy without contracts/ never skips the suite.

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
const present = existsSync(path);
const file: { fixtures: Record<string, Fixture> } = present ? JSON.parse(readFileSync(path, "utf8")) : { fixtures: {} };
const all = Object.entries(file.fixtures);

// The 44 fixtures hold 33 distinct byte strings, and each one runs once. 22 rows have at most 5 bytes (11 distinct strings): a bare
// constructor. Four of them stay: the first and the last tag of the compact range (121 and 127), and two tags of the range from 1280
// (1280 and 1284). The bigger fixtures hold the other tags in context. tests/unit/cbor-identity-aiken-fixtures.test.ts runs every row.
const TAG_EDGES = ["d87980", "d87f80", "d9050080", "d9050480"];
const seen = new Set<string>();
const fixtures = all.filter(([, fixture]) => {
  if (seen.has(fixture.cbor)) return false;
  seen.add(fixture.cbor);
  return fixture.cbor.length > 10 || TAG_EDGES.includes(fixture.cbor);
});
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");

describe(`golden CBOR fixtures (${path})`, () => {
  test("finds the fixture file", () => {
    expect(present, `missing ${path}; set IDENTITY_CBOR_FIXTURES to its path`).toBe(true);
    expect(all.length, `no fixture in ${path}`).toBeGreaterThan(0);
  });

  test.each(fixtures)("%s: Plutus Data decode and encode give the same bytes", (_name, fixture) => {
    expect(hex(encodePlutusData(decodePlutusData(bytes(fixture.cbor))))).toBe(fixture.cbor);
  });

  const identity = fixtures.filter(([, f]) => f.type.endsWith("types.IdentityDatum"));
  const legacy = fixtures.filter(([, f]) => f.type.endsWith("types.LegacyDatum"));

  test.each(identity)("%s: IdentityDatum decode and encode give the same bytes", (_name, fixture) => {
    expect(hex(encodeIdentityDatum(decodeIdentityDatum(bytes(fixture.cbor))))).toBe(fixture.cbor);
  });

  test.each(legacy)("%s: LegacyDatum decode and encode give the same bytes", (_name, fixture) => {
    expect(hex(encodeLegacyDatum(decodeLegacyDatum(bytes(fixture.cbor))))).toBe(fixture.cbor);
  });
});
