/**
 * Attestation datum and redeemer codecs (Part 2 §4).
 */

import { describe, expect, it } from "vitest";
import {
  attestationDatumToData, decodeAttestationDatum, decodeAttestationMint, decodeAttestationSpend, encodeAttestationDatum,
  encodeAttestationMint, encodeAttestationSpend, encodePlutusDataHex, type AttestationDatum, type AttestationMint,
  type AttestationSpend, type PlutusData,
} from "../../packages/shared/src/cbor/index.js";
import { utf8ToHex } from "../../packages/shared/src/identity/index.js";

const SUBJECT = "a1".repeat(32);
const ISSUER = "a2".repeat(32);
const ISSUER_ID = "a3".repeat(32);
const DIGEST = "a5".repeat(32);
const T0 = 1_793_577_600_000;

function full(): AttestationDatum {
  return {
    subject: SUBJECT, issuer: ISSUER, issuerId: ISSUER_ID, attType: 2, format: 50, profile: "a4".repeat(32), digest: DIGEST,
    locator: utf8ToHex(`https://attestations.example.org/${"x".repeat(80)}.json`), envelopeSig: "a6".repeat(64),
    issuedAt: T0, validFrom: T0, validUntil: T0 + 1000, solicited: true,
    status: { type: "AttRevoked", at: T0 + 10, reason: 5 },
    contested: { uri: utf8ToHex("https://subject.example.org/reply.json"), sha256: "a7".repeat(32) },
    links: [{ rel: 0, target: "a8".repeat(32) }, { rel: 3, target: "a9".repeat(32) }],
  };
}

function minimal(): AttestationDatum {
  return {
    subject: SUBJECT, issuer: ISSUER, issuerId: null, attType: 0, format: null, profile: null, digest: DIGEST, locator: null,
    envelopeSig: null, issuedAt: T0, validFrom: null, validUntil: null, solicited: false, status: { type: "AttActive" },
    contested: null, links: [],
  };
}

function mutated(edit: (fields: PlutusData[]) => void): string {
  const data = attestationDatumToData(full());
  if (data.kind !== "constr") throw new Error("attestation datum must be a constructor");
  edit(data.fields);
  return encodePlutusDataHex(data);
}

const b = (hex: string): PlutusData => ({ kind: "bytes", hex });
const i = (value: number): PlutusData => ({ kind: "int", value: BigInt(value) });
const c = (index: number, ...fields: PlutusData[]): PlutusData => ({ kind: "constr", index: BigInt(index), fields });

describe("AttestationDatum codec", () => {
  it("writes the §4 field order, Bool and Option constructors", () => {
    const hex = encodeAttestationDatum(minimal());
    expect(hex).toBe(
      `d8799f5820${SUBJECT}5820${ISSUER}d87a8000d87a80d87a805820${DIGEST}d87a80d87a801b${T0.toString(16).padStart(16, "0")}` +
      "d87a80d87a80d87980d87980d87a8080ff",
    );
    expect(decodeAttestationDatum(hex)).toEqual(minimal());
  });

  it("round-trips every optional field, a chunked locator, links and a revoked status", () => {
    const hex = encodeAttestationDatum(full());
    expect(hex).toContain("d87a9f1b");
    expect(hex).toContain(`9fd8799f005820${"a8".repeat(32)}ffd8799f035820${"a9".repeat(32)}ffff`);
    expect(hex).toContain("5f5840");
    expect(decodeAttestationDatum(hex)).toEqual(full());
    expect(encodeAttestationDatum(decodeAttestationDatum(hex))).toBe(hex);
  });

  it("accepts integers that §4 does not bound", () => {
    const datum = { ...full(), attType: 99, format: 65_536, status: { type: "AttRevoked" as const, at: -1, reason: 1_000_000 }, validFrom: -5 };
    expect(decodeAttestationDatum(encodeAttestationDatum(datum))).toEqual(datum);
  });

  it.each([
    ["15 fields", mutated((f) => { f.pop(); }), /expected 16 fields, got 15/],
    ["a 31-byte subject", mutated((f) => { f[0] = b("a1".repeat(31)); }), /subject: expected 32 bytes, got 31/],
    ["a 33-byte issuer id", mutated((f) => { f[2] = c(0, b("a3".repeat(33))); }), /issuerId: expected 32 bytes, got 33/],
    ["a 63-byte envelope signature", mutated((f) => { f[8] = c(0, b("a6".repeat(63))); }), /envelopeSig: expected 64 bytes, got 63/],
    ["Bool constructor 2", mutated((f) => { f[12] = c(2); }), /solicited: unknown constructor 2 \(expected 0\.\.1\)/],
    ["True with a field", mutated((f) => { f[12] = c(1, i(1)); }), /solicited: expected 0 fields, got 1/],
    ["status constructor 2", mutated((f) => { f[13] = c(2); }), /status: unknown constructor 2/],
    ["AttRevoked without a reason", mutated((f) => { f[13] = c(1, i(1)); }), /status: expected 2 fields, got 1/],
    ["an anchor hash of 31 bytes", mutated((f) => { f[14] = c(0, c(0, b("00"), b("a7".repeat(31)))); }), /contested\.sha256: expected 32 bytes, got 31/],
    ["a link target of 31 bytes", mutated((f) => { f[15] = { kind: "list", items: [c(0, i(0), b("a8".repeat(31)))] }; }), /links\[0\]\.target: expected 32 bytes, got 31/],
    ["a link that is bytes", mutated((f) => { f[15] = { kind: "list", items: [b("00")] }; }), /links\[0\]: expected constructor 0, got bytes/],
  ])("rejects %s", (_name, hex, error) => {
    expect(() => decodeAttestationDatum(hex)).toThrow(error);
  });

  it("refuses to encode malformed values", () => {
    expect(() => encodeAttestationDatum({ ...full(), solicited: 1 as unknown as boolean })).toThrow(/solicited: expected a boolean/);
    expect(() => encodeAttestationDatum({ ...full(), digest: "a5" })).toThrow(/digest: expected 32 bytes, got 1/);
    expect(() => encodeAttestationDatum({ ...full(), status: { type: "Gone" } as unknown as AttestationDatum["status"] })).toThrow(/status: unknown type "Gone"/);
    expect(() => encodeAttestationDatum({ ...full(), links: [null as unknown as AttestationDatum["links"][number]] })).toThrow(/links\[0\]: expected a link/);
  });
});

describe("attestation redeemer codecs", () => {
  it.each<[AttestationMint, string]>([
    [{ type: "Attest", seed: { txHash: "f4".repeat(32), index: 0 } }, `d8799fd8799f5820${"f4".repeat(32)}00ffff`],
    [{ type: "Burn" }, "d87a80"],
  ])("AttestationMint %j", (value, hex) => {
    expect(encodeAttestationMint(value)).toBe(hex);
    expect(decodeAttestationMint(hex)).toEqual(value);
  });

  it.each<[AttestationSpend, string]>([
    [{ type: "RevokeAtt", reason: 5 }, "d8799f05ff"],
    [{ type: "Contest" }, "d87a80"],
    [{ type: "Withdraw" }, "d87b80"],
  ])("AttestationSpend %j", (value, hex) => {
    expect(encodeAttestationSpend(value)).toBe(hex);
    expect(decodeAttestationSpend(hex)).toEqual(value);
  });

  it("rejects unknown constructors and missing fields", () => {
    expect(() => decodeAttestationSpend("d87c80")).toThrow(/decodeAttestationSpend: unknown constructor 3 \(expected 0\.\.2\)/);
    expect(() => decodeAttestationSpend("d87980")).toThrow(/expected 1 fields, got 0/);
    expect(() => decodeAttestationMint("d87a9f00ff")).toThrow(/expected 0 fields, got 1/);
    expect(() => decodeAttestationMint("d87b80")).toThrow(/unknown constructor 2/);
    expect(() => encodeAttestationSpend({ type: "RevokeAtt", reason: 0.5 })).toThrow(/reason: expected a safe integer number/);
  });
});
