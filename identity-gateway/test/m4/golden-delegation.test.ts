// Golden CBOR fixtures of the delegation types (contracts/identity-marketplace/fixtures/cbor-fixtures.json,
// written by the contracts with cbor.serialise): the gateway's delegation codec decodes them and
// encodes them back byte for byte. The vault fixtures carry the shared Delegator type (both
// constructors). IDENTITY_CBOR_FIXTURES overrides the path. Without the file, the suite fails.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { decodePlutusData, encodePlutusData } from "../../src/codec/plutus-data.js";
import { decodeDelegationDatum, delegatorFromData, delegatorToData, encodeDelegationDatum } from "../../src/m4/delegation-datum.js";

interface Fixture {
  type: string;
  cbor: string;
}

const path =
  process.env.IDENTITY_CBOR_FIXTURES ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts/identity-marketplace/fixtures/cbor-fixtures.json");
// `fixtures/generate.mjs` writes the file, so its shape is fixed and a cast is enough.
const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { fixtures: Record<string, Fixture> }) : null;
const fixtures = file === null ? null : file.fixtures;
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");
const filled = (byte: string, length: number) => byte.repeat(length);
const utf8Hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

/** The fixture `name`. A fixture that the file lacks fails the test: it never falls back to another value. */
function fixture(name: string): Fixture {
  const found = fixtures?.[name];
  if (!found) throw new Error(`fixture ${name} is missing from ${path}`);
  return found;
}

test("finds the fixture file", () => {
  expect(fixtures, `missing ${path}; set IDENTITY_CBOR_FIXTURES to its path`).not.toBeNull();
});

describe.skipIf(fixtures === null)(`golden delegation fixtures (${path})`, () => {
  const delegationDatums = Object.entries(fixtures ?? {}).filter(([, f]) => f.type.endsWith("types.DelegationDatum"));
  const vaultDatums = Object.entries(fixtures ?? {}).filter(([, f]) => f.type.endsWith("types.VaultDatum"));

  test.each(delegationDatums)("%s: DelegationDatum decode and encode give the same bytes", (_name, entry) => {
    expect(hex(encodeDelegationDatum(decodeDelegationDatum(bytes(entry.cbor))))).toBe(entry.cbor);
  });

  test("delegation_datum decodes to the values of lib/identity_marketplace/cbor_fixtures.ak", () => {
    const t0 = 1_793_577_600_000;
    expect(decodeDelegationDatum(bytes(fixture("delegation_datum").cbor))).toEqual({
      delegator: { type: "Agent", id: filled("b1", 32) },
      parent: filled("b2", 32),
      delegate: filled("b3", 32),
      delegateKey: filled("b4", 28),
      actions: [utf8Hex("marketplace.hire.v1"), utf8Hex("ocr.*")],
      resources: [utf8Hex("script:0123456789abcdef0123456789abcdef0123456789abcdef01234567")],
      notBefore: t0,
      notAfter: t0 + 90 * 86_400_000,
      depth: 2,
      remaining: 1,
      purpose: filled("b5", 32),
      value: { perTx: 10_000_000n, total: 100_000_000n, periodMs: 86_400_000 },
    });
  });

  test.each(vaultDatums)("%s: the Delegator in the vault datum decodes and encodes back to the same data", (_name, entry) => {
    const data = decodePlutusData(bytes(entry.cbor));
    if (data.type !== "constr") throw new Error("a vault datum is a constructor");
    const owner = data.fields[0]!;
    expect(hex(encodePlutusData(delegatorToData(delegatorFromData(owner))))).toBe(hex(encodePlutusData(owner)));
  });

  test("vault_datum_live holds a principal key with an organisation", () => {
    const data = decodePlutusData(bytes(fixture("vault_datum_live").cbor));
    if (data.type !== "constr") throw new Error("a vault datum is a constructor");
    expect(delegatorFromData(data.fields[0]!)).toEqual({ type: "PrincipalKey", hash: filled("c1", 28), organisation: utf8Hex("example.org") });
  });

  test("a datum with another layout is refused", () => {
    expect(() => decodeDelegationDatum(bytes(fixture("delegation_mint_undelegate").cbor))).toThrow(/delegation datum/);
    expect(() => decodeDelegationDatum(bytes("d87980"))).toThrow(/constructor 0 has 0 fields/);
  });
});
