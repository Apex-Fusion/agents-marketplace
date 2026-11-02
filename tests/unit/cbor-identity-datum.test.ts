/**
 * Identity record (Part 1 §5), legacy record and identity redeemer (Part 2 §3.1) codecs.
 */

import { describe, expect, it } from "vitest";
import {
  decodeIdentityDatum, decodeIdentityMint, decodeIdentitySpend, decodeLegacyDatum, encodeIdentityDatum,
  encodeIdentityMint, encodeIdentitySpend, encodeLegacyDatum, encodePlutusDataHex, identityDatumFromData,
  identityDatumToData, legacyDatumToData, type IdentityDatum, type IdentityMint, type IdentitySpend,
  type LegacyDatum, type PlutusData, type Status,
} from "../../packages/shared/src/cbor/index.js";
import { keyHash, MAX_TIME_MS, utf8FromHex, utf8ToHex } from "../../packages/shared/src/identity/index.js";

const CONTROLLER = "11".repeat(32);
const ED_KEY = "22".repeat(32);
const P256_KEY = `02${"33".repeat(32)}`;
const POP = "44".repeat(64);
const PKH = "aa".repeat(28);
const M1 = "bb".repeat(28);
const PARENT = "cc".repeat(32);
const SUCCESSOR = "dd".repeat(32);
const NEW_CONTROLLER = "ee".repeat(32);
const T0 = 1_760_000_000_000;

function sample(status: Status = { type: "Active" }): IdentityDatum {
  return {
    controller: CONTROLLER,
    keys: [
      { keyType: "Ed25519", key: ED_KEY, purposes: 27, pop: null },
      { keyType: "P256", key: P256_KEY, purposes: 3, pop: POP },
    ],
    parties: [
      { role: "Accountable", signer: { type: "KeyHash", hash: PKH }, organisation: utf8ToHex("did:web:example.org"), notBefore: 0, notAfter: null, rights: 3, removalAfter: null },
      { role: "Responsible", signer: { type: "Script", hash: M1 }, organisation: null, notBefore: T0, notAfter: MAX_TIME_MS, rights: 1, removalAfter: T0 + 1 },
      { role: "Guardian", signer: { type: "ControllerSet" }, organisation: null, notBefore: T0, notAfter: T0 + 10, rights: 4, removalAfter: null },
    ],
    guardianThreshold: 1,
    pendingRecovery: { newController: NEW_CONTROLLER, effectiveAfter: T0 + 7 },
    lineage: { type: "Subagent", parent: PARENT, parentEpoch: 3, depth: 2 },
    subagentEpoch: 5,
    name: utf8ToHex("Agent é"),
    description: utf8ToHex("x".repeat(200)),
    framework: utf8ToHex("claude-code"),
    endpoint: "",
    capabilities: [utf8ToHex("document-extraction"), utf8ToHex("llm.text.generate.v1")],
    createdAt: T0,
    status,
  };
}

const MINIMAL: IdentityDatum = {
  controller: CONTROLLER, keys: [], parties: [], guardianThreshold: 0, pendingRecovery: null, lineage: { type: "Root" },
  subagentEpoch: 0, name: "61", description: "", framework: "", endpoint: "", capabilities: [], createdAt: 1, status: { type: "Active" },
};
const MINIMAL_HEX = `d8799f5820${CONTROLLER}808000d87a80d8798000416140404080` + "01d87980ff";

const STATUSES: Status[] = [
  { type: "Active" },
  {
    type: "Suspended",
    holds: [
      { by: { type: "ControllerSet" }, reason: 6, since: T0, until: T0 + 1000 },
      { by: { type: "Script", hash: M1 }, reason: 64, since: T0, until: T0 + 2000 },
      { by: { type: "KeyHash", hash: PKH }, reason: 68, since: T0 + 1, until: MAX_TIME_MS },
    ],
  },
  { type: "Revoked", by: { type: "KeyHash", hash: PKH }, reason: 1, at: T0 + 5, invalidFrom: T0, successor: null },
  { type: "Revoked", by: { type: "ControllerSet" }, reason: 4, at: T0 + 5, invalidFrom: null, successor: SUCCESSOR },
  { type: "Retired", at: T0 + 9, successor: SUCCESSOR },
  { type: "Retired", at: 0, successor: null },
];

/** Encode the datum, let `edit` change its 14 Plutus Data fields, and return the hex. */
function mutated(edit: (fields: PlutusData[]) => void, datum: IdentityDatum = sample()): string {
  const data = identityDatumToData(datum);
  if (data.kind !== "constr") throw new Error("identity datum must be a constructor");
  edit(data.fields);
  return encodePlutusDataHex(data);
}

const b = (hex: string): PlutusData => ({ kind: "bytes", hex });
const i = (value: bigint | number): PlutusData => ({ kind: "int", value: BigInt(value) });
const c = (index: number, ...fields: PlutusData[]): PlutusData => ({ kind: "constr", index: BigInt(index), fields });
const l = (...items: PlutusData[]): PlutusData => ({ kind: "list", items });

describe("IdentityDatum codec", () => {
  it("writes the Part 1 §5 field order with canonical Plutus Data bytes", () => {
    expect(encodeIdentityDatum(MINIMAL)).toBe(MINIMAL_HEX);
    expect(decodeIdentityDatum(MINIMAL_HEX)).toEqual(MINIMAL);
  });

  it("writes keys, signers, parties, lineage and recovery with the Part 1 §5 constructors", () => {
    const hex = encodeIdentityDatum(sample());
    // Key { Ed25519, key, 27, None } and Key { P256, key, 3, Some(pop) }
    expect(hex).toContain(`9fd8799fd879805820${ED_KEY}181bd87a80ffd8799fd87a805821${P256_KEY}03d8799f5840${POP}ffffff`);
    // Party { Accountable, KeyHash, Some(org), 0, None, 3, None }
    expect(hex).toContain(`d8799fd87980d8799f581c${PKH}ffd8799f53${utf8ToHex("did:web:example.org")}ff00d87a8003d87a80ff`);
    // Signer Script = Constr 1, ControllerSet = Constr 2; role Guardian = Constr 4
    expect(hex).toContain(`d8799fd87a80d87a9f581c${M1}ff`);
    expect(hex).toContain("d8799fd87d80d87b80d87a80");
    // pending recovery Some { new_controller, effective_after }, lineage Subagent { parent, 3, 2 }, epoch 5
    expect(hex).toContain(`d8799fd8799f5820${NEW_CONTROLLER}1b${(T0 + 7).toString(16).padStart(16, "0")}ffffd87a9f5820${PARENT}0302ff05`);
    // description of 200 bytes is chunked
    expect(hex).toContain(`5f5840${"78".repeat(64)}5840`);
  });

  it.each(STATUSES.map((status) => [status.type, status] as const))("round-trips status %s", (_name, status) => {
    const datum = sample(status);
    const hex = encodeIdentityDatum(datum);
    expect(decodeIdentityDatum(hex)).toEqual(datum);
    expect(encodeIdentityDatum(decodeIdentityDatum(hex))).toBe(hex);
  });

  it("writes the status constructors 0..3", () => {
    expect(encodeIdentityDatum(sample(STATUSES[1]!))).toContain(`d87a9f9fd8799fd87b8006`);
    expect(encodeIdentityDatum(sample(STATUSES[2]!))).toMatch(new RegExp(`d87b9fd8799f581c${PKH}ff011b[0-9a-f]{16}d8799f1b[0-9a-f]{16}ffd87a80ffff$`));
    expect(encodeIdentityDatum(sample(STATUSES[4]!))).toMatch(new RegExp(`d87c9f1b[0-9a-f]{16}d8799f5820${SUCCESSOR}ffffff$`));
    expect(encodeIdentityDatum(sample(STATUSES[5]!))).toMatch(/d87c9f00d87a80ffff$/);
  });

  it("round-trips the Root lineage, no recovery and text that is not UTF-8", () => {
    const datum = { ...sample(), lineage: { type: "Root" } as const, pendingRecovery: null, name: "ff00", capabilities: [] };
    expect(decodeIdentityDatum(encodeIdentityDatum(datum))).toEqual(datum);
    expect(utf8FromHex(decodeIdentityDatum(encodeIdentityDatum(datum)).name)).toBeNull();
  });

  it("decodes through identityDatumFromData and lowercases hex input", () => {
    const datum = { ...sample(), controller: CONTROLLER.toUpperCase() };
    expect(identityDatumFromData(identityDatumToData(datum)).controller).toBe(CONTROLLER);
  });

  it.each([
    ["13 fields", mutated((f) => { f.pop(); }), /expected 14 fields, got 13/],
    ["15 fields", mutated((f) => { f.push(i(0)); }), /expected 14 fields, got 15/],
    ["a 31-byte controller", mutated((f) => { f[0] = b("11".repeat(31)); }), /controller: expected 32 bytes, got 31/],
    ["a list where bytes belong", mutated((f) => { f[7] = l(); }), /name: expected bytes, got list/],
    ["a negative threshold", mutated((f) => { f[3] = i(-1); }), /guardianThreshold: integer -1 is outside \[0, 9223372036854775807\]/],
    ["a threshold of 2^63", mutated((f) => { f[3] = i(1n << 63n); }), /guardianThreshold: integer 9223372036854775808 is outside/],
    ["an epoch above the safe range", mutated((f) => { f[6] = i(1n << 60n); }), /subagentEpoch: integer 1152921504606846976 is outside the safe integer range/],
    ["a time after year 9999", mutated((f) => { f[12] = i(MAX_TIME_MS + 1); }), /createdAt: integer 253402300800000 is outside \[0, 253402300799999\]/],
    ["status constructor 4", mutated((f) => { f[13] = c(4); }), /status: unknown constructor 4 \(expected 0\.\.3\)/],
    ["Active with a field", mutated((f) => { f[13] = c(0, i(1)); }), /status: expected 0 fields, got 1/],
    ["Some with two fields", mutated((f) => { f[4] = c(0, i(1), i(2)); }), /pendingRecovery: expected 1 fields, got 2/],
    ["Option constructor 2", mutated((f) => { f[4] = c(2); }), /pendingRecovery: unknown constructor 2/],
    ["a subagent depth that is bytes", mutated((f) => { f[5] = c(1, b(PARENT), i(0), b("01")); }), /lineage\.depth: expected an integer, got bytes/],
    ["an Ed25519 key with a pop", mutated((f) => { f[1] = l(c(0, c(0), b(ED_KEY), i(1), c(0, b(POP)))); }), /keys\[0\]\.pop: an Ed25519 key has no pop/],
    ["a P256 key without a pop", mutated((f) => { f[1] = l(c(0, c(1), b(P256_KEY), i(1), c(1))); }), /keys\[0\]\.pop: a P256 key needs a 64-byte pop/],
    ["a 32-byte P256 key", mutated((f) => { f[1] = l(c(0, c(1), b(ED_KEY), i(1), c(0, b(POP)))); }), /keys\[0\]\.key: expected 33 bytes, got 32/],
    ["a 63-byte pop", mutated((f) => { f[1] = l(c(0, c(1), b(P256_KEY), i(1), c(0, b("44".repeat(63))))); }), /keys\[0\]\.pop: expected 64 bytes, got 63/],
    ["key type 2", mutated((f) => { f[1] = l(c(0, c(2), b(ED_KEY), i(1), c(1))); }), /keys\[0\]\.keyType: unknown constructor 2/],
    ["signer constructor 3", mutated((f) => { f[2] = l(c(0, c(0), c(3), c(1), i(0), c(1), i(0), c(1))); }), /parties\[0\]\.signer: unknown constructor 3/],
    ["a 27-byte key hash", mutated((f) => { f[2] = l(c(0, c(0), c(0, b("aa".repeat(27))), c(1), i(0), c(1), i(0), c(1))); }), /parties\[0\]\.signer\.hash: expected 28 bytes, got 27/],
    ["role 5", mutated((f) => { f[2] = l(c(0, c(5), c(2), c(1), i(0), c(1), i(0), c(1))); }), /parties\[0\]\.role: unknown constructor 5/],
    ["a party with 6 fields", mutated((f) => { f[2] = l(c(0, c(0), c(2), c(1), i(0), c(1), i(0))); }), /parties\[0\]: expected 7 fields, got 6/],
    ["a hold with a negative time", mutated((f) => { f[13] = c(1, l(c(0, c(2), i(6), i(-1), i(5)))); }), /status\.holds\[0\]\.since: integer -1 is outside/],
    ["a 31-byte successor", mutated((f) => { f[13] = c(3, i(0), c(0, b("dd".repeat(31)))); }), /status\.successor: expected 32 bytes, got 31/],
    ["a top-level Constr 1", (() => { const d = identityDatumToData(MINIMAL); return encodePlutusDataHex(c(1, ...(d.kind === "constr" ? d.fields : []))); })(), /expected constructor 0, got constructor 1/],
  ])("rejects %s", (_name, hex, error) => {
    expect(() => decodeIdentityDatum(hex)).toThrow(error);
    expect(() => decodeIdentityDatum(hex)).toThrow(/^decodeIdentityDatum: /);
  });

  it("rejects malformed CBOR and trailing bytes", () => {
    expect(() => decodeIdentityDatum("")).toThrow(/decodeIdentityDatum: malformed CBOR/);
    expect(() => decodeIdentityDatum(`${MINIMAL_HEX}00`)).toThrow(/malformed CBOR: trailing bytes/);
    expect(() => decodeIdentityDatum(MINIMAL_HEX.replace("4161", "6161"))).toThrow(/malformed CBOR: text string/);
    expect(() => decodeIdentityDatum("d8799f")).toThrow(/malformed CBOR: unexpected end/);
  });

  it.each([
    ["a short controller", { controller: "11" }, /encodeIdentityDatum: controller: expected 32 bytes, got 1/],
    ["a non-hex name", { name: "Agent" }, /name: expected an even-length hex string/],
    ["a fractional time", { createdAt: 1.5 }, /createdAt: expected a safe integer number/],
    ["a negative threshold", { guardianThreshold: -1 }, /guardianThreshold: integer -1 is outside/],
    ["an undefined option", { pendingRecovery: undefined }, /pendingRecovery: expected a value or null, got undefined/],
    ["an unknown status", { status: { type: "Gone" } }, /status: unknown type "Gone"/],
    ["an unknown lineage", { lineage: { type: "Child" } }, /lineage: unknown type "Child"/],
    ["an unknown role", { parties: [{ ...sample().parties[0]!, role: "Boss" }] }, /parties\[0\]\.role: unknown value "Boss"/],
    ["an Ed25519 key with a pop", { keys: [{ keyType: "Ed25519", key: ED_KEY, purposes: 1, pop: POP }] }, /keys\[0\]\.pop: an Ed25519 key has no pop/],
    ["a P256 key without a pop", { keys: [{ keyType: "P256", key: P256_KEY, purposes: 1, pop: null }] }, /keys\[0\]\.pop: a P256 key needs a 64-byte pop/],
    ["capabilities that are not a list", { capabilities: "00" }, /capabilities: expected an array/],
    ["a bigint time", { createdAt: 1n }, /createdAt: expected a safe integer number/],
  ])("refuses to encode %s", (_name, change, error) => {
    expect(() => encodeIdentityDatum({ ...sample(), ...change } as unknown as IdentityDatum)).toThrow(error);
  });
});

// Mainnet legacy record 4c2047…545e (identity-gateway/test/fixtures.ts, REAL_DATUM).
const REAL_LEGACY_DATUM =
  "d8799fd8799f581cc24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01eff52476f7665726e616e636550726f706f7365725f5840416e616c797a6573206f6e2d636861696e206d65747269637320616e64207375626d69747320676f7665726e616e63652070726f706f73616c7320746f20696d583070726f766520566563746f722070726f746f636f6c20706172616d657465727320616e64206f7065726174696f6e732eff9f4a676f7665726e616e636549616e616c79746963735070726f706f73616c2d77726974696e67ff4b636c617564652d636f6465401b0000019d92f3c0afff";
const REAL_OWNER_KEY = "edca77f5418b21bb7bf540bd056a238e38575fc26c4aa677a36df6bf305d9e9c";
const REAL_OWNER_HASH = "c24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01e";

describe("LegacyDatum codec", () => {
  it("decodes a mainnet legacy record and re-encodes the same bytes", () => {
    const datum = decodeLegacyDatum(REAL_LEGACY_DATUM);
    expect(datum.owner).toEqual({ type: "VerificationKey", hash: REAL_OWNER_HASH });
    expect(keyHash(REAL_OWNER_KEY)).toBe(REAL_OWNER_HASH);
    expect(utf8FromHex(datum.name)).toBe("GovernanceProposer");
    expect(utf8FromHex(datum.description)).toBe(
      "Analyzes on-chain metrics and submits governance proposals to improve Vector protocol parameters and operations.",
    );
    expect(datum.capabilities.map(utf8FromHex)).toEqual(["governance", "analytics", "proposal-writing"]);
    expect(utf8FromHex(datum.framework)).toBe("claude-code");
    expect(datum.endpoint).toBe("");
    expect(datum.registeredAt).toBe(0x19d92f3c0afn);
    expect(encodeLegacyDatum(datum)).toBe(REAL_LEGACY_DATUM);
  });

  it("round-trips a script owner and any registered_at integer", () => {
    const datum: LegacyDatum = {
      owner: { type: "Script", hash: M1 }, name: "ff", description: "", capabilities: ["00", ""], framework: "", endpoint: "68",
      registeredAt: -(1n << 80n),
    };
    const hex = encodeLegacyDatum(datum);
    expect(hex.startsWith(`d8799fd87a9f581c${M1}ff41ff`)).toBe(true);
    expect(decodeLegacyDatum(hex)).toEqual(datum);
  });

  it("rejects other layouts", () => {
    const data = legacyDatumToData(decodeLegacyDatum(REAL_LEGACY_DATUM));
    if (data.kind !== "constr") throw new Error("legacy datum must be a constructor");
    expect(() => decodeLegacyDatum(encodePlutusDataHex({ ...data, fields: data.fields.slice(0, 6) }))).toThrow(/decodeLegacyDatum: expected 7 fields, got 6/);
    expect(() => decodeLegacyDatum(encodePlutusDataHex({ ...data, fields: [c(0, b("aa".repeat(27))), ...data.fields.slice(1)] })))
      .toThrow(/owner\.hash: expected 28 bytes, got 27/);
    expect(() => decodeLegacyDatum(encodePlutusDataHex({ ...data, fields: [c(2, b(PKH)), ...data.fields.slice(1)] })))
      .toThrow(/owner: unknown constructor 2 \(expected 0\.\.1\)/);
    expect(() => decodeLegacyDatum(MINIMAL_HEX)).toThrow(/expected 7 fields, got 14/);
  });
});

const SEED_TX = "00".repeat(32);
const NODE_A = "0a".repeat(32);
const NODE_B = "0b".repeat(32);

describe("identity redeemer codecs (Part 2 §3.1)", () => {
  it.each<[string, IdentityMint, string]>([
    ["Register", { type: "Register", seed: { txHash: SEED_TX, index: 0 } }, `d8799fd8799f5820${SEED_TX}00ffff`],
    ["Register index 24", { type: "Register", seed: { txHash: "ab".repeat(32), index: 24 } }, `d8799fd8799f5820${"ab".repeat(32)}1818ffff`],
    ["Adopt []", { type: "Adopt", proof: [] }, "d87a9f80ff"],
    ["Adopt [a, b]", { type: "Adopt", proof: [NODE_A, NODE_B] }, `d87a9f9f5820${NODE_A}5820${NODE_B}ffff`],
  ])("IdentityMint %s", (_name, value, hex) => {
    expect(encodeIdentityMint(value)).toBe(hex);
    expect(decodeIdentityMint(hex)).toEqual(value);
  });

  it.each<[IdentitySpend, string]>([
    [{ type: "Update" }, "d87980"],
    [{ type: "ChangeController" }, "d87a80"],
    [{ type: "Suspend", actor: { type: "ByController" } }, "d87b9fd87980ff"],
    [{ type: "Suspend", actor: { type: "ByParty", index: 2 } }, "d87b9fd87a9f02ffff"],
    [{ type: "Unsuspend", author: { type: "ControllerSet" } }, "d87c9fd87b80ff"],
    [{ type: "Unsuspend", author: { type: "KeyHash", hash: PKH } }, `d87c9fd8799f581c${PKH}ffff`],
    [{ type: "Unsuspend", author: { type: "Script", hash: M1 } }, `d87c9fd87a9f581c${M1}ffff`],
    [{ type: "Revoke", actor: { type: "ByController" } }, "d87d9fd87980ff"],
    [{ type: "Revoke", actor: { type: "ByParty", index: 7 } }, "d87d9fd87a9f07ffff"],
    [{ type: "Retire" }, "d87e80"],
    [{ type: "Reclaim" }, "d87f80"],
    [{ type: "SetSuccessor" }, "d9050080"],
    [{ type: "BumpEpoch" }, "d9050180"],
    [{ type: "RecoverInit", guardians: [0, 1] }, "d905029f9f0001ffff"],
    [{ type: "RecoverCancel", guardians: [] }, "d905039f80ff"],
    [{ type: "RecoverFinalize" }, "d9050480"],
  ])("IdentitySpend %j", (value, hex) => {
    expect(encodeIdentitySpend(value)).toBe(hex);
    expect(decodeIdentitySpend(hex)).toEqual(value);
  });

  it.each([
    ["IdentitySpend constructor 12", () => decodeIdentitySpend("d9050580"), /decodeIdentitySpend: unknown constructor 12 \(expected 0\.\.11\)/],
    ["Update with a field", () => decodeIdentitySpend("d8799f00ff"), /expected 0 fields, got 1/],
    ["Suspend without its actor", () => decodeIdentitySpend("d87b80"), /expected 1 fields, got 0/],
    ["ByParty with bytes", () => decodeIdentitySpend("d87b9fd87a9f4100ffff"), /actor\.index: expected an integer, got bytes/],
    ["a 31-byte proof node", () => decodeIdentityMint(`d87a9f9f581f${"0a".repeat(31)}ffff`), /proof\[0\]: expected 32 bytes, got 31/],
    ["a negative seed index", () => decodeIdentityMint(`d8799fd8799f5820${SEED_TX}20ffff`), /seed\.index: integer -1 is outside/],
    ["a 31-byte seed transaction", () => decodeIdentityMint(`d8799fd8799f581f${"00".repeat(31)}00ffff`), /seed\.txHash: expected 32 bytes, got 31/],
    ["IdentityMint constructor 2", () => decodeIdentityMint("d87b80"), /unknown constructor 2 \(expected 0\.\.1\)/],
    ["an unknown spend type", () => encodeIdentitySpend({ type: "Explode" } as unknown as IdentitySpend), /encodeIdentitySpend: unknown type "Explode"/],
    ["a fractional party index", () => encodeIdentitySpend({ type: "Revoke", actor: { type: "ByParty", index: 1.5 } }), /actor\.index: expected a safe integer number/],
    ["guardians that are not a list", () => encodeIdentitySpend({ type: "RecoverInit", guardians: 1 } as unknown as IdentitySpend), /guardians: expected an array/],
    ["a short proof node", () => encodeIdentityMint({ type: "Adopt", proof: ["0a"] }), /proof\[0\]: expected 32 bytes, got 1/],
  ])("rejects %s", (_name, run, error) => {
    expect(run).toThrow(error);
  });
});
