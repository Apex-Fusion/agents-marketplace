// Golden CBOR fixtures of the delegation types (contracts/identity-marketplace/fixtures/cbor-fixtures.json,
// written by the contracts with cbor.serialise): the gateway's delegation codec decodes them and
// encodes them back byte for byte. The vault fixtures carry the shared Delegator type (both
// constructors). IDENTITY_CBOR_FIXTURES overrides the path; the suite is skipped only without the file.

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
const fixtures: Record<string, Fixture> = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { fixtures: Record<string, Fixture> }).fixtures : {};
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");
const filled = (byte: string, length: number) => byte.repeat(length);
const utf8Hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

describe.skipIf(Object.keys(fixtures).length === 0)(`golden delegation fixtures (${path})`, () => {
  const delegationDatums = Object.entries(fixtures).filter(([, f]) => f.type.endsWith("types.DelegationDatum"));
  const vaultDatums = Object.entries(fixtures).filter(([, f]) => f.type.endsWith("types.VaultDatum"));

  test("the file has delegation and vault datum fixtures", () => {
    expect(delegationDatums.map(([name]) => name)).toContain("delegation_datum");
    expect(vaultDatums.length).toBeGreaterThan(0);
  });

  test.each(delegationDatums)("%s: DelegationDatum decode and encode give the same bytes", (_name, fixture) => {
    expect(hex(encodeDelegationDatum(decodeDelegationDatum(bytes(fixture.cbor))))).toBe(fixture.cbor);
  });

  test("delegation_datum decodes to the values of lib/identity_marketplace/cbor_fixtures.ak", () => {
    const t0 = 1_793_577_600_000;
    expect(decodeDelegationDatum(bytes(fixtures.delegation_datum!.cbor))).toEqual({
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

  test.each(vaultDatums)("%s: the Delegator in the vault datum decodes and encodes back to the same data", (_name, fixture) => {
    const data = decodePlutusData(bytes(fixture.cbor));
    if (data.type !== "constr") throw new Error("a vault datum is a constructor");
    const owner = data.fields[0]!;
    expect(hex(encodePlutusData(delegatorToData(delegatorFromData(owner))))).toBe(hex(encodePlutusData(owner)));
  });

  test("vault_datum_live holds a principal key with an organisation", () => {
    const data = decodePlutusData(bytes(fixtures.vault_datum_live!.cbor));
    if (data.type !== "constr") throw new Error("a vault datum is a constructor");
    expect(delegatorFromData(data.fields[0]!)).toEqual({ type: "PrincipalKey", hash: filled("c1", 28), organisation: utf8Hex("example.org") });
  });

  test("a datum with another layout is refused", () => {
    expect(() => decodeDelegationDatum(bytes(fixtures.delegation_mint_undelegate?.cbor ?? "d87a80"))).toThrow(/delegation datum/);
    expect(() => decodeDelegationDatum(bytes("d87980"))).toThrow(/constructor 0 has 0 fields/);
  });
});
