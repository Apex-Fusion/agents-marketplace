/**
 * New escrow and advert layouts (Part 2 §6.1, §6.2), escrow and advert
 * redeemers, and the Plutus Address codec used by the escrow refund.
 */

import { readFileSync } from "node:fs";
import { bech32 } from "bech32";
import { describe, expect, it } from "vitest";
import {
  decodeAdvertRedeemer, decodeAnyAdvertDatum, decodeAnyEscrowDatum, decodeEscrowDatum, decodeEscrowRedeemer,
  decodeIdentityAdvertDatum, decodeIdentityEscrowDatum, decodePlutusAddress, decodePlutusDataHex, encodeAdvertDatum,
  encodeAdvertRedeemer, encodeEscrowDatum, encodeEscrowRedeemer, encodeIdentityAdvertDatum, encodeIdentityEscrowDatum,
  encodePlutusAddress, encodePlutusDataHex, identityEscrowDatumToData, plutusAddressFromBech32, plutusAddressToBech32,
  vaultDatumFromData, vaultDatumToData, type AdvertRedeemer, type EscrowRedeemer, type IdentityAdvertDatum,
  type IdentityEscrowDatum, type PlutusAddress, type PlutusData,
} from "../../packages/shared/src/cbor/index.js";
import { buildSampleAdvertDatum } from "../fixtures/buyer-side/advert-datum-builders.js";
import { buildSampleEscrowDatum } from "../fixtures/buyer-side/escrow-datum-builders.js";

const AGENT_ID = "d7".repeat(32);
const VAULT_HASH = "d8".repeat(28);
const RECEIPT_HASH = "d6".repeat(32);
const LEGACY_REGISTRY_ADDRESS = "addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42";
const LEGACY_REGISTRY_HASH = "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01";
const LEGACY_ESCROW_ADDRESS = "addr1wxqsaczee4upnn50n9dwgw9mkph77yqp0d9p0y5ul9c6jysrv9dl5";
const LEGACY_ESCROW_HASH = "810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912";
const WALLET = "addr1q8pyltzvw2vvp29g95ndr6tukpzyc7qtaxq8f400c2kuq83t63ar50qelzpf59teke4kuythtxzgx6mxtv75l79xryvqhagm80";
// CIP-19 test vectors.
const CIP19_POINTER = "addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k";
const CIP19_PAYMENT_KEY = "9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e";

const VAULT_ADDRESS: PlutusAddress = { paymentCredential: { type: "Script", hash: VAULT_HASH }, stakeCredential: null };

function escrow(refund: IdentityEscrowDatum["refund"] = null): IdentityEscrowDatum {
  return { ...buildSampleEscrowDatum(), agent_id: AGENT_ID, refund };
}

function advert(): IdentityAdvertDatum {
  return { ...buildSampleAdvertDatum(), agent_id: AGENT_ID };
}

function fieldsOf(hex: string): PlutusData[] {
  const data = decodePlutusDataHex(hex);
  if (data.kind !== "constr" || data.index !== 0n) throw new Error("expected Constr 0");
  return data.fields;
}

const b = (hex: string): PlutusData => ({ kind: "bytes", hex });
const c = (index: number, ...fields: PlutusData[]): PlutusData => ({ kind: "constr", index: BigInt(index), fields });

describe("Plutus Address codec", () => {
  it("reads the legacy registry and escrow addresses as enterprise script addresses", () => {
    expect(plutusAddressFromBech32(LEGACY_REGISTRY_ADDRESS)).toEqual({ paymentCredential: { type: "Script", hash: LEGACY_REGISTRY_HASH }, stakeCredential: null });
    expect(plutusAddressFromBech32(LEGACY_ESCROW_ADDRESS)).toEqual({ paymentCredential: { type: "Script", hash: LEGACY_ESCROW_HASH }, stakeCredential: null });
    expect(plutusAddressToBech32(plutusAddressFromBech32(LEGACY_REGISTRY_ADDRESS), 1)).toBe(LEGACY_REGISTRY_ADDRESS);
    expect(encodePlutusAddress(plutusAddressFromBech32(LEGACY_REGISTRY_ADDRESS))).toBe(`d8799fd87a9f581c${LEGACY_REGISTRY_HASH}ffd87a80ff`);
  });

  it("round-trips base, enterprise key and pointer addresses on both networks", () => {
    const base = plutusAddressFromBech32(WALLET);
    expect(base.paymentCredential.type).toBe("VerificationKey");
    expect(base.stakeCredential).toMatchObject({ type: "Inline", credential: { type: "VerificationKey" } });
    expect(plutusAddressToBech32(base, 1)).toBe(WALLET);
    expect(encodePlutusAddress(base)).toMatch(/^d8799fd8799f581c[0-9a-f]{56}ffd8799fd8799fd8799f581c[0-9a-f]{56}ffffffff$/);

    const testnet = plutusAddressToBech32({ paymentCredential: { type: "VerificationKey", hash: "ab".repeat(28) }, stakeCredential: null }, 0);
    expect(testnet.startsWith("addr_test1v")).toBe(true);
    expect(plutusAddressFromBech32(testnet)).toEqual({ paymentCredential: { type: "VerificationKey", hash: "ab".repeat(28) }, stakeCredential: null });

    const pointer = plutusAddressFromBech32(CIP19_POINTER);
    expect(pointer).toEqual({
      paymentCredential: { type: "VerificationKey", hash: CIP19_PAYMENT_KEY },
      stakeCredential: { type: "Pointer", slotNumber: 2498243n, transactionIndex: 27n, certificateIndex: 3n },
    });
    expect(plutusAddressToBech32(pointer, 1)).toBe(CIP19_POINTER);
    expect(encodePlutusAddress(pointer)).toBe(`d8799fd8799f581c${CIP19_PAYMENT_KEY}ffd8799fd87a9f1a00261ec3181b03ffffff`);
    expect(decodePlutusAddress(encodePlutusAddress(pointer))).toEqual(pointer);
  });

  it("rejects addresses without a Plutus Address form or with a wrong prefix", () => {
    expect(() => plutusAddressFromBech32("stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw")).toThrow(/address type 14 has no Plutus Address form/);
    expect(() => plutusAddressFromBech32("Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi")).toThrow(/plutusAddressFromBech32/);
    const mainnetBytesTestnetPrefix = bech32.encode("addr_test", bech32.toWords(Uint8Array.from([0x71, ...Buffer.from(VAULT_HASH, "hex")])), 1023);
    expect(() => plutusAddressFromBech32(mainnetBytesTestnetPrefix)).toThrow(/prefix addr_test does not match network id 1/);
    expect(() => plutusAddressToBech32(VAULT_ADDRESS, 2 as 0)).toThrow(/network id must be 0 or 1/);
    expect(() => decodePlutusAddress(`d8799fd87b9f581c${VAULT_HASH}ffd87a80ff`)).toThrow(/paymentCredential: unknown constructor 2/);
    expect(() => encodePlutusAddress({ paymentCredential: { type: "Script", hash: "d8" }, stakeCredential: null })).toThrow(/paymentCredential\.hash: expected 28 bytes, got 1/);
  });
});

describe("IdentityEscrowDatum codec", () => {
  it("keeps the 14 legacy fields in the legacy order, then agent_id and refund", () => {
    const legacy = fieldsOf(encodeEscrowDatum(buildSampleEscrowDatum()));
    const identity = fieldsOf(encodeIdentityEscrowDatum(escrow()));
    expect(identity).toHaveLength(16);
    expect(identity.slice(0, 14)).toEqual(legacy);
    expect(identity[14]).toEqual(b(AGENT_ID));
    expect(identity[15]).toEqual(c(1));
  });

  it("writes canonical bytes for the new fields", () => {
    expect(encodeIdentityEscrowDatum(escrow()).endsWith(`d879805820${AGENT_ID}d87a80ff`)).toBe(true);
    const refund = { address: VAULT_ADDRESS, datum: vaultDatumToData({ type: "Returned", owner: { type: "PrincipalKey", hash: "c1".repeat(28), organisation: null } }) };
    expect(encodeIdentityEscrowDatum(escrow(refund)).endsWith(
      `5820${AGENT_ID}d8799fd8799fd8799fd87a9f581c${VAULT_HASH}ffd87a80ffd8799fd87a9fd8799f581c${"c1".repeat(28)}d87a80ffffffffffff`,
    )).toBe(true);
  });

  it.each([
    ["no refund", null],
    ["a vault refund with a Returned datum", { address: VAULT_ADDRESS, datum: vaultDatumToData({ type: "Returned", owner: { type: "Agent", id: AGENT_ID } }) }],
    ["a refund to a base address without datum", { address: plutusAddressFromBech32(WALLET), datum: null }],
    ["a refund to a pointer address with any datum", {
      address: plutusAddressFromBech32(CIP19_POINTER),
      datum: { kind: "map", entries: [[{ kind: "int", value: -1n }, { kind: "list", items: [b("ff".repeat(70))] }]] } as PlutusData,
    }],
  ])("round-trips %s", (_name, refund) => {
    const datum = { ...escrow(refund), state: "Submitted" as const, submitted_at: 1_793_579_400_000, result_receipt_hash: RECEIPT_HASH };
    const hex = encodeIdentityEscrowDatum(datum);
    expect(decodeIdentityEscrowDatum(hex)).toEqual(datum);
    expect(encodeIdentityEscrowDatum(decodeIdentityEscrowDatum(hex))).toBe(hex);
  });

  it("reads the vault datum of a refund", () => {
    const owner = { type: "Agent" as const, id: AGENT_ID };
    const decoded = decodeIdentityEscrowDatum(encodeIdentityEscrowDatum(escrow({ address: VAULT_ADDRESS, datum: vaultDatumToData({ type: "Returned", owner }) })));
    expect(vaultDatumFromData(decoded.refund!.datum!)).toEqual({ type: "Returned", owner });
  });

  function mutated(edit: (fields: PlutusData[]) => void): string {
    const data = identityEscrowDatumToData(escrow());
    if (data.kind !== "constr") throw new Error("escrow datum must be a constructor");
    edit(data.fields);
    return encodePlutusDataHex(data);
  }

  it.each([
    ["the legacy layout", encodeEscrowDatum(buildSampleEscrowDatum()), /expected 16 fields, got 14/],
    ["a 31-byte agent_id", mutated((f) => { f[14] = b("d7".repeat(31)); }), /agent_id: expected 32 bytes, got 31/],
    ["a 27-byte buyer key hash", mutated((f) => { f[0] = b("aa".repeat(27)); }), /buyer_pkh: expected 28 bytes, got 27/],
    ["a capability that is not UTF-8", mutated((f) => { f[3] = b("ff"); }), /capability_id: bytes are not valid UTF-8/],
    ["state constructor 6", mutated((f) => { f[13] = c(6); }), /state: unknown constructor 6 \(expected 0\.\.5\)/],
    ["a 31-byte receipt hash", mutated((f) => { f[12] = c(0, b("d6".repeat(31))); }), /result_receipt_hash: expected 32 bytes, got 31/],
    ["a refund with one field", mutated((f) => { f[15] = c(0, c(0, encodeAddressData())); }), /refund: expected 2 fields, got 1/],
    ["a refund stake credential constructor 2", mutated((f) => { f[15] = c(0, c(0, c(0, c(1, b(VAULT_HASH)), c(0, c(2))), c(1))); }), /refund\.address\.stakeCredential: unknown constructor 2/],
  ])("rejects %s", (_name, hex, error) => {
    expect(() => decodeIdentityEscrowDatum(hex)).toThrow(error);
  });

  it("refuses to encode a datum without agent_id or with an unpaired surrogate", () => {
    const { agent_id: _drop, ...withoutAgent } = escrow();
    expect(() => encodeIdentityEscrowDatum(withoutAgent as IdentityEscrowDatum)).toThrow(/agent_id: expected a hex string, got undefined/);
    expect(() => encodeIdentityEscrowDatum({ ...escrow(), capability_id: "\ud800" })).toThrow(/capability_id: string contains an unpaired surrogate/);
    expect(() => encodeIdentityEscrowDatum({ ...escrow(), refund: undefined } as unknown as IdentityEscrowDatum)).toThrow(/refund: expected a value or null/);
  });

  it("reads both layouts during the drain", () => {
    const legacyHex = readFileSync(new URL("../fixtures/golden/escrow-datum-open.hex", import.meta.url), "utf8").trim();
    expect(decodeAnyEscrowDatum(legacyHex)).toEqual({ layout: "legacy", datum: decodeEscrowDatum(legacyHex) });
    expect(decodeAnyEscrowDatum(encodeIdentityEscrowDatum(escrow()))).toEqual({ layout: "identity", datum: escrow() });
    expect(() => decodeAnyEscrowDatum(mutated((f) => { f.pop(); }))).toThrow(/decodeAnyEscrowDatum: expected a constructor with 14 \(legacy\) or 16 \(identity\) fields/);
    expect(() => decodeAnyEscrowDatum("00")).toThrow(/14 \(legacy\) or 16 \(identity\)/);
  });
});

function encodeAddressData(): PlutusData {
  return decodePlutusDataHex(encodePlutusAddress(VAULT_ADDRESS));
}

describe("EscrowRedeemer codec", () => {
  it.each<[EscrowRedeemer, string]>([
    [{ type: "Claim" }, "d87980"],
    [{ type: "Submit", receipt_hash: RECEIPT_HASH }, `d87a9f5820${RECEIPT_HASH}ff`],
    [{ type: "Accept" }, "d87b80"],
    [{ type: "Reclaim" }, "d87c80"],
    [{ type: "Release" }, "d87d80"],
    [{ type: "RefundRevoked" }, "d87e80"],
  ])("%j", (value, hex) => {
    expect(encodeEscrowRedeemer(value)).toBe(hex);
    expect(decodeEscrowRedeemer(hex)).toEqual(value);
  });

  it("rejects unknown constructors and malformed Submit payloads", () => {
    expect(() => decodeEscrowRedeemer("d87f80")).toThrow(/decodeEscrowRedeemer: unknown constructor 6 \(expected 0\.\.5\)/);
    expect(() => decodeEscrowRedeemer("d87a80")).toThrow(/expected 1 fields, got 0/);
    expect(() => decodeEscrowRedeemer(`d87a9f581f${"d6".repeat(31)}ff`)).toThrow(/receipt_hash: expected 32 bytes, got 31/);
    expect(() => decodeEscrowRedeemer("d8799f00ff")).toThrow(/expected 0 fields, got 1/);
    expect(() => encodeEscrowRedeemer({ type: "Submit", receipt_hash: "d6" })).toThrow(/receipt_hash: expected 32 bytes, got 1/);
  });
});

describe("IdentityAdvertDatum codec", () => {
  it("keeps the 13 legacy fields and adds agent_id as field 13", () => {
    const legacy = fieldsOf(encodeAdvertDatum(buildSampleAdvertDatum()));
    const identity = fieldsOf(encodeIdentityAdvertDatum(advert()));
    expect(identity).toHaveLength(14);
    expect(identity.slice(0, 13)).toEqual(legacy);
    expect(identity[13]).toEqual(b(AGENT_ID));
    expect(encodeIdentityAdvertDatum(advert()).endsWith(`d879805820${AGENT_ID}ff`)).toBe(true);
  });

  it("round-trips and reads both layouts", () => {
    const hex = encodeIdentityAdvertDatum({ ...advert(), status: "Retired" });
    expect(decodeIdentityAdvertDatum(hex)).toEqual({ ...advert(), status: "Retired" });
    const legacyHex = readFileSync(new URL("../fixtures/golden/advert-datum-sample.hex", import.meta.url), "utf8").trim();
    expect(decodeAnyAdvertDatum(legacyHex).layout).toBe("legacy");
    expect(decodeAnyAdvertDatum(hex)).toEqual({ layout: "identity", datum: { ...advert(), status: "Retired" } });
  });

  it("rejects malformed adverts", () => {
    const data = decodePlutusDataHex(encodeIdentityAdvertDatum(advert()));
    if (data.kind !== "constr") throw new Error("advert datum must be a constructor");
    const withField = (index: number, value: PlutusData) => encodePlutusDataHex({ ...data, fields: data.fields.map((f, i) => (i === index ? value : f)) });
    expect(() => decodeIdentityAdvertDatum(withField(13, b("d7".repeat(33))))).toThrow(/agent_id: expected 32 bytes, got 33/);
    expect(() => decodeIdentityAdvertDatum(withField(10, b("aa".repeat(31))))).toThrow(/detail_hash: expected 32 bytes, got 31/);
    expect(() => decodeIdentityAdvertDatum(withField(12, c(2)))).toThrow(/status: unknown constructor 2 \(expected 0\.\.1\)/);
    expect(() => decodeIdentityAdvertDatum(encodeAdvertDatum(buildSampleAdvertDatum()))).toThrow(/expected 14 fields, got 13/);
    expect(() => encodeIdentityAdvertDatum({ ...advert(), agent_id: "d7" })).toThrow(/agent_id: expected 32 bytes, got 1/);
  });
});

describe("AdvertRedeemer codec", () => {
  it.each<[AdvertRedeemer, string]>([
    [{ type: "PostAdvert" }, "d87980"], [{ type: "UpdateAdvert" }, "d87a80"], [{ type: "RetireAdvert" }, "d87b80"],
  ])("%j", (value, hex) => {
    expect(encodeAdvertRedeemer(value)).toBe(hex);
    expect(decodeAdvertRedeemer(hex)).toEqual(value);
  });

  it("rejects other constructors", () => {
    expect(() => decodeAdvertRedeemer("d87c80")).toThrow(/decodeAdvertRedeemer: unknown constructor 3 \(expected 0\.\.2\)/);
  });
});
