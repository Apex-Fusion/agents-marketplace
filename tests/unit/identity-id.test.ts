/**
 * Identity helpers: identifiers (Part 1 §3.1), DNS-safe form (§3.2), key
 * hashes (§2), DID strings (§3 ABNF), UTF-8 conversion and constants.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { describe, expect, it } from "vitest";
import {
  DAY_MS, DAYS_30_MS, DAYS_366_MS, DAYS_7_MS, DAYS_90_MS, dnsSafe, ED25519_PURPOSES, isVectorId, keyHash, legacyVectorDid,
  MAX_DEPTH, MAX_RANGE_MS, MAX_RECORD_INT, MAX_TIME_MS, P256_PURPOSES, parseVectorDid, PURPOSE_ASSERTION,
  PURPOSE_AUTHENTICATION, PURPOSE_DELEGATION, PURPOSE_TRANSACTION, RIGHT_RECOVER, RIGHT_REVOKE, RIGHT_SUSPEND,
  ROLE_MAX_RIGHTS, serialiseSeed, utf8FromHex, utf8ToHex, vectorDid, vectorDidKeyUrl, vectorIdFromSeed,
} from "../../packages/shared/src/identity/index.js";
import * as sharedRoot from "../../packages/shared/src/index.js";
import { paper2AgentSupplierPkh } from "../../packages/shared/src/paper2agent/index.js";

const ID_A = "a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9";
const ID_B = "3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b";
const LEGACY_POLICY = "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01";
// Mainnet facts (identity-gateway/test/fixtures.ts): the owner key of legacy record 4c2047…545e and its hash.
const OWNER_KEY = "edca77f5418b21bb7bf540bd056a238e38575fc26c4aa677a36df6bf305d9e9c";
const OWNER_HASH = "c24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01e";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("identifier from seed (Part 1 §3.1)", () => {
  it("serialises the seed as Constr 0 [tx_id, output_index] with the shortest index", () => {
    expect(hex(serialiseSeed("00".repeat(32), 0))).toBe(`d8799f5820${"00".repeat(32)}00ff`);
    expect(hex(serialiseSeed("ab".repeat(32), 24))).toBe(`d8799f5820${"ab".repeat(32)}1818ff`);
    expect(hex(serialiseSeed("ab".repeat(32), 65_536))).toBe(`d8799f5820${"ab".repeat(32)}1a00010000ff`);
  });

  it("reproduces the test vectors", () => {
    expect(vectorIdFromSeed("00".repeat(32), 0)).toBe(ID_A);
    expect(vectorIdFromSeed("ab".repeat(32), 24)).toBe(ID_B);
    expect(vectorIdFromSeed("AB".repeat(32), 24)).toBe(ID_B);
  });

  it("rejects invalid seeds", () => {
    expect(() => vectorIdFromSeed("00".repeat(31), 0)).toThrow(/serialiseSeed: seed\.txHash: expected 32 bytes, got 31/);
    expect(() => vectorIdFromSeed("zz".repeat(32), 0)).toThrow(/even-length hex/);
    expect(() => vectorIdFromSeed("00".repeat(32), -1)).toThrow(/seed\.index: integer -1 is outside/);
    expect(() => vectorIdFromSeed("00".repeat(32), 1.5)).toThrow(/seed\.index: expected a safe integer number/);
  });
});

describe("DNS-safe form (Part 1 §3.2)", () => {
  it("reproduces the test vectors", () => {
    expect(dnsSafe(ID_A)).toBe("uls6ej4fr2cpdkhzwdasi3tmxsjtnvyh2q52ipiods34khcf6teq");
    expect(dnsSafe(ID_B)).toBe("hxoqoulsaxoyu5cyq7btuco2bzff2y64uhyvdtxo3lxnubkryuvq");
  });

  it("gives 52 lowercase base32 characters that fit a DNS label", () => {
    for (const id of [ID_A, ID_B, "00".repeat(32), "ff".repeat(32)]) expect(dnsSafe(id)).toMatch(/^[a-z2-7]{52}$/);
    expect(dnsSafe("00".repeat(32))).toBe("a".repeat(52));
    expect(dnsSafe("ff".repeat(32))).toBe(`${"7".repeat(51)}q`);
  });

  it("accepts only identifiers", () => {
    expect(() => dnsSafe(ID_A.toUpperCase())).toThrow(/dnsSafe: identifier must be 64 lowercase hexadecimal characters/);
    expect(() => dnsSafe(ID_A.slice(2))).toThrow(/dnsSafe/);
  });
});

describe("key hash (Part 1 §2)", () => {
  it("is blake2b-224 of the public key bytes", () => {
    expect(keyHash(OWNER_KEY)).toBe(OWNER_HASH);
    expect(keyHash(OWNER_KEY.toUpperCase())).toBe(OWNER_HASH);
    expect(keyHash(OWNER_KEY)).toBe(paper2AgentSupplierPkh(OWNER_KEY));
    const p256 = `03${"5a".repeat(32)}`;
    expect(keyHash(p256)).toBe(hex(blake2b(Buffer.from(p256, "hex"), { dkLen: 28 })));
    expect(keyHash(p256)).toMatch(/^[0-9a-f]{56}$/);
  });

  it("accepts only 32-byte and 33-byte keys", () => {
    expect(() => keyHash("00".repeat(31))).toThrow(/keyHash: public key must have 32 or 33 bytes/);
    expect(() => keyHash("00".repeat(34))).toThrow(/32 or 33 bytes/);
    expect(() => keyHash("0")).toThrow(/keyHash: expected an even-length hex string/);
  });
});

describe("DID strings (Part 1 §3)", () => {
  it("builds the canonical form, the legacy form and key URLs", () => {
    expect(vectorDid(ID_A)).toBe(`did:vector:${ID_A}`);
    expect(legacyVectorDid(LEGACY_POLICY, ID_A)).toBe(`did:vector:agent:${LEGACY_POLICY}:${ID_A}`);
    expect(vectorDidKeyUrl(ID_A, OWNER_KEY)).toBe(`did:vector:${ID_A}#${OWNER_HASH}`);
  });

  it("refuses identifiers and policies that are not lowercase hex", () => {
    expect(() => vectorDid(ID_A.toUpperCase())).toThrow(/vectorDid: identifier must be 64 lowercase/);
    expect(() => vectorDid(`${ID_A}0`)).toThrow(/vectorDid/);
    expect(() => legacyVectorDid(LEGACY_POLICY.toUpperCase(), ID_A)).toThrow(/policy ID must be 56 lowercase/);
    expect(() => legacyVectorDid(LEGACY_POLICY, ID_A.slice(1))).toThrow(/legacyVectorDid: identifier/);
  });

  it("parses the three forms of the ABNF", () => {
    expect(parseVectorDid(`did:vector:${ID_A}`)).toEqual({ form: "canonical", vectorId: ID_A });
    expect(parseVectorDid(`did:vector:agent:${LEGACY_POLICY}:${ID_A}`)).toEqual({ form: "legacy", policyId: LEGACY_POLICY, vectorId: ID_A });
    expect(parseVectorDid(`did:vector:testnet:${ID_A}`)).toEqual({ form: "network", network: "testnet", vectorId: ID_A });
  });

  it.each([
    [`did:vector:${ID_A.toUpperCase()}`],
    [`did:vector:${ID_A.slice(0, 63)}A`],
    [`DID:vector:${ID_A}`],
    [`did:Vector:${ID_A}`],
    [`did:vector:agent:${LEGACY_POLICY.toUpperCase()}:${ID_A}`],
    [`did:vector:agent:${LEGACY_POLICY.slice(2)}:${ID_A}`],
    [`did:vector:Agent:${LEGACY_POLICY}:${ID_A}`],
    [`did:vector:mainnet:${ID_A}`],
    [`did:vector:Testnet:${ID_A}`],
    [`did:vector:${ID_A}#${OWNER_HASH}`],
    [`did:vector:${ID_A}?versionId=1`],
    [`did:vector:${ID_A} `],
    [`did:vector:${ID_A.slice(2)}`],
    [`did:vector:${ID_A}00`],
    ["did:vector:"],
    ["did:web:id.vector.apexfusion.org"],
    [""],
  ])("rejects %s", (did) => {
    expect(parseVectorDid(did)).toBeNull();
  });

  it("rejects values that are not strings", () => {
    expect(parseVectorDid(42 as unknown as string)).toBeNull();
    expect(isVectorId(ID_A)).toBe(true);
    expect(isVectorId(ID_A.toUpperCase())).toBe(false);
    expect(isVectorId(null)).toBe(false);
  });
});

describe("UTF-8 text fields", () => {
  it("converts text to bytes and back", () => {
    expect(utf8ToHex("Agent é")).toBe("4167656e7420c3a9");
    expect(utf8FromHex("4167656e7420c3a9")).toBe("Agent é");
    expect(utf8FromHex("")).toBe("");
    expect(utf8FromHex("efbbbf41")).toBe("\ufeffA");
  });

  it("returns null for bytes that are not valid UTF-8", () => {
    for (const bad of ["ff", "c0af", "eda080", "e282", "f4908080"]) expect(utf8FromHex(bad)).toBeNull();
  });

  it("refuses strings with unpaired surrogates and input that is not hex", () => {
    expect(() => utf8ToHex("a\ud800")).toThrow(/utf8ToHex: string contains an unpaired surrogate/);
    expect(() => utf8ToHex("\udc00")).toThrow(/unpaired surrogate/);
    expect(utf8ToHex("\ud83d\ude00")).toBe("f09f9880");
    expect(() => utf8FromHex("xyz")).toThrow(/utf8FromHex: expected an even-length hex string/);
  });
});

describe("constants", () => {
  it("match Part 1 §5 and Part 2 §3", () => {
    expect([PURPOSE_AUTHENTICATION, PURPOSE_ASSERTION, PURPOSE_TRANSACTION, PURPOSE_DELEGATION]).toEqual([1, 2, 8, 16]);
    expect(ED25519_PURPOSES).toBe(PURPOSE_AUTHENTICATION | PURPOSE_ASSERTION | PURPOSE_TRANSACTION | PURPOSE_DELEGATION);
    expect(P256_PURPOSES).toBe(PURPOSE_AUTHENTICATION | PURPOSE_ASSERTION);
    expect([RIGHT_SUSPEND, RIGHT_REVOKE, RIGHT_RECOVER]).toEqual([1, 2, 4]);
    expect(ROLE_MAX_RIGHTS).toEqual({ Accountable: 3, Responsible: 1, Provider: 1, Distributor: 0, Guardian: 4 });
    expect(MAX_RANGE_MS).toBe(3_600_000);
    expect(MAX_TIME_MS).toBe(Date.UTC(9999, 11, 31, 23, 59, 59, 999));
    expect(MAX_RECORD_INT).toBe(2n ** 63n - 1n);
    expect([DAY_MS, DAYS_7_MS, DAYS_30_MS, DAYS_90_MS, DAYS_366_MS]).toEqual([86_400_000, 604_800_000, 2_592_000_000, 7_776_000_000, 31_622_400_000]);
    expect(MAX_DEPTH).toBe(4);
  });

  it("are exported from the package root", () => {
    expect(sharedRoot.vectorIdFromSeed("00".repeat(32), 0)).toBe(ID_A);
    expect(sharedRoot.MAX_TIME_MS).toBe(MAX_TIME_MS);
  });
});
