/**
 * Delegation and vault codecs (Part 2 §5.2, §5.3).
 */

import { describe, expect, it } from "vitest";
import {
  decodeDelegationDatum, decodeDelegationMint, decodeVaultDatum, decodeVaultSpend, delegationDatumToData,
  encodeDelegationDatum, encodeDelegationMint, encodePlutusDataHex, encodeVaultDatum, encodeVaultSpend, vaultDatumFromData,
  vaultDatumToData, type DelegationDatum, type DelegationMint, type PlutusData, type VaultDatum, type VaultSpend,
} from "../../packages/shared/src/cbor/index.js";
import { utf8ToHex } from "../../packages/shared/src/identity/index.js";

const AGENT = "b1".repeat(32);
const PARENT = "b2".repeat(32);
const DELEGATE = "b3".repeat(32);
const DELEGATE_KEY = "b4".repeat(28);
const PRINCIPAL = "c1".repeat(28);
const DELEGATION = "c2".repeat(32);
const T0 = 1_793_577_600_000;

function delegation(): DelegationDatum {
  return {
    delegator: { type: "Agent", id: AGENT }, parent: PARENT, delegate: DELEGATE, delegateKey: DELEGATE_KEY,
    actions: [utf8ToHex("marketplace.hire.v1"), utf8ToHex("ocr.*")], resources: [utf8ToHex(`script:${"01".repeat(28)}`)],
    notBefore: T0, notAfter: T0 + 86_400_000, depth: 2, remaining: 1, purpose: "b5".repeat(32),
    value: { perTx: 10_000_000n, total: 100_000_000n, periodMs: 86_400_000 },
  };
}

function mutated(edit: (fields: PlutusData[]) => void): string {
  const data = delegationDatumToData(delegation());
  if (data.kind !== "constr") throw new Error("delegation datum must be a constructor");
  edit(data.fields);
  return encodePlutusDataHex(data);
}

const b = (hex: string): PlutusData => ({ kind: "bytes", hex });
const i = (value: number): PlutusData => ({ kind: "int", value: BigInt(value) });
const c = (index: number, ...fields: PlutusData[]): PlutusData => ({ kind: "constr", index: BigInt(index), fields });

describe("DelegationDatum codec", () => {
  it("writes the §5.2 field order and round-trips", () => {
    const hex = encodeDelegationDatum(delegation());
    expect(hex.startsWith(`d8799fd87a9f5820${AGENT}ffd8799f5820${PARENT}ff5820${DELEGATE}581c${DELEGATE_KEY}9f53`)).toBe(true);
    expect(hex.endsWith(`0201d8799f5820${"b5".repeat(32)}ffd8799fd8799f1a009896801a05f5e1001a05265c00ffffff`)).toBe(true);
    expect(decodeDelegationDatum(hex)).toEqual(delegation());
  });

  it("round-trips a principal delegator without a parent, purpose or value limit", () => {
    const datum: DelegationDatum = {
      ...delegation(), delegator: { type: "PrincipalKey", hash: PRINCIPAL, organisation: utf8ToHex("example.org") },
      parent: null, resources: [], purpose: null, value: null, depth: 1, remaining: 3,
    };
    const hex = encodeDelegationDatum(datum);
    expect(hex.startsWith(`d8799fd8799f581c${PRINCIPAL}d8799f4b${utf8ToHex("example.org")}ffffd87a80`)).toBe(true);
    expect(decodeDelegationDatum(hex)).toEqual(datum);
  });

  it.each([
    ["11 fields", mutated((f) => { f.pop(); }), /expected 12 fields, got 11/],
    ["delegator constructor 2", mutated((f) => { f[0] = c(2, b(AGENT)); }), /delegator: unknown constructor 2 \(expected 0\.\.1\)/],
    ["a 31-byte agent id", mutated((f) => { f[0] = c(1, b("b1".repeat(31))); }), /delegator\.id: expected 32 bytes, got 31/],
    ["a principal without organisation field", mutated((f) => { f[0] = c(0, b(PRINCIPAL)); }), /delegator: expected 2 fields, got 1/],
    ["a 32-byte delegate key", mutated((f) => { f[3] = b("b4".repeat(32)); }), /delegateKey: expected 28 bytes, got 32/],
    ["an action that is an integer", mutated((f) => { f[4] = { kind: "list", items: [i(1)] }; }), /actions\[0\]: expected bytes, got int/],
    ["a value limit with 2 fields", mutated((f) => { f[11] = c(0, c(0, i(1), i(2))); }), /value: expected 3 fields, got 2/],
    ["a 31-byte purpose", mutated((f) => { f[10] = c(0, b("b5".repeat(31))); }), /purpose: expected 32 bytes, got 31/],
  ])("rejects %s", (_name, hex, error) => {
    expect(() => decodeDelegationDatum(hex)).toThrow(error);
  });

  it("refuses to encode malformed values", () => {
    expect(() => encodeDelegationDatum({ ...delegation(), value: { perTx: 1, total: 2n, periodMs: 3 } as unknown as DelegationDatum["value"] }))
      .toThrow(/value\.perTx: expected a bigint/);
    expect(() => encodeDelegationDatum({ ...delegation(), delegator: { type: "Org", id: AGENT } as unknown as DelegationDatum["delegator"] }))
      .toThrow(/delegator: unknown type "Org"/);
    expect(() => encodeDelegationDatum({ ...delegation(), delegateKey: DELEGATE })).toThrow(/delegateKey: expected 28 bytes, got 32/);
  });
});

describe("DelegationMint codec", () => {
  it.each<[DelegationMint, string]>([
    [{ type: "Delegate", seed: { txHash: "f5".repeat(32), index: 300 } }, `d8799fd8799f5820${"f5".repeat(32)}19012cffff`],
    [{ type: "Undelegate" }, "d87a80"],
  ])("%j", (value, hex) => {
    expect(encodeDelegationMint(value)).toBe(hex);
    expect(decodeDelegationMint(hex)).toEqual(value);
  });

  it("rejects unknown constructors", () => {
    expect(() => decodeDelegationMint("d87b80")).toThrow(/decodeDelegationMint: unknown constructor 2/);
  });
});

describe("VaultDatum and VaultSpend codecs", () => {
  const live: VaultDatum = {
    type: "Live", owner: { type: "PrincipalKey", hash: PRINCIPAL, organisation: utf8ToHex("example.org") },
    delegation: DELEGATION, spent: 25_000_000n, periodStart: T0,
  };
  const returned: VaultDatum = { type: "Returned", owner: { type: "Agent", id: AGENT } };

  it("writes Live as Constr 0 and Returned as Constr 1", () => {
    const liveHex = encodeVaultDatum(live);
    expect(liveHex).toBe(
      `d8799fd8799f581c${PRINCIPAL}d8799f4b${utf8ToHex("example.org")}ffff5820${DELEGATION}1a017d78401b${T0.toString(16).padStart(16, "0")}ff`,
    );
    expect(encodeVaultDatum(returned)).toBe(`d87a9fd87a9f5820${AGENT}ffff`);
    expect(decodeVaultDatum(liveHex)).toEqual(live);
    expect(decodeVaultDatum(encodeVaultDatum(returned))).toEqual(returned);
    expect(vaultDatumFromData(vaultDatumToData(returned))).toEqual(returned);
  });

  it("rejects malformed vault datums", () => {
    expect(() => decodeVaultDatum(`d87a9fd87a9f5820${AGENT}ff00ff`)).toThrow(/decodeVaultDatum: expected 1 fields, got 2/);
    expect(() => decodeVaultDatum("d87b80")).toThrow(/unknown constructor 2/);
    expect(() => decodeVaultDatum(`d8799fd87a9f5820${AGENT}ff581c${PRINCIPAL}0000ff`)).toThrow(/delegation: expected 32 bytes, got 28/);
    expect(() => encodeVaultDatum({ ...live, spent: 1 } as unknown as VaultDatum)).toThrow(/spent: expected a bigint/);
  });

  it.each<[VaultSpend, string]>([[{ type: "Pay" }, "d87980"], [{ type: "Close" }, "d87a80"]])("VaultSpend %j", (value, hex) => {
    expect(encodeVaultSpend(value)).toBe(hex);
    expect(decodeVaultSpend(hex)).toEqual(value);
  });

  it("rejects other vault redeemers", () => {
    expect(() => decodeVaultSpend("d87b80")).toThrow(/decodeVaultSpend: unknown constructor 2 \(expected 0\.\.1\)/);
    expect(() => decodeVaultSpend("d8799f00ff")).toThrow(/expected 0 fields, got 1/);
    expect(() => encodeVaultSpend({ type: "Drain" } as unknown as VaultSpend)).toThrow(/encodeVaultSpend: unknown type "Drain"/);
  });
});
