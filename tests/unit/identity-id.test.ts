/**
 * Identity helpers: identifiers (Part 1 §3.1), DNS-safe form (§3.2), key hashes (§2), DID strings
 * (§3 ABNF) and UTF-8 conversion. The published vectors of the identifiers are in
 * tests/identity-vectors/identifiers.test.ts.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { describe, expect, it } from "vitest";
import {
  dnsSafe, isVectorId, keyHash, legacyVectorDid, parseVectorDid, utf8FromHex, utf8ToHex, vectorDid, vectorDidKeyUrl,
  vectorIdFromSeed,
} from "../../packages/shared/src/identity/index.js";
import { paper2AgentSupplierPkh } from "../../packages/shared/src/paper2agent/index.js";

const ID_A = "a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9";
const ID_B = "3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b";
const LEGACY_POLICY = "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01";
// Mainnet facts (identity-gateway/test/fixtures.ts): the owner key of legacy record 4c2047…545e and its hash.
const OWNER_KEY = "edca77f5418b21bb7bf540bd056a238e38575fc26c4aa677a36df6bf305d9e9c";
const OWNER_HASH = "c24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01e";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("identifier from seed (Part 1 §3.1)", () => {
  it("reads the hex of the seed in either case", () => {
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

  // Each row breaks one condition of the ABNF: the method, lowercase hex, the length of the identifier, a DID URL,
  // the length of the policy of a legacy DID, the network of a network DID, and the identifier itself.
  it.each([
    ["another method", "did:web:id.vector.apexfusion.org"],
    ["an uppercase digit in the identifier", `did:vector:${ID_A.toUpperCase()}`],
    ["an identifier of 66 digits", `did:vector:${ID_A}00`],
    ["a fragment (a DID URL)", `did:vector:${ID_A}#${OWNER_HASH}`],
    ["a legacy policy of 54 digits", `did:vector:agent:${LEGACY_POLICY.slice(2)}:${ID_A}`],
    ["a network other than testnet", `did:vector:mainnet:${ID_A}`],
    ["no identifier", "did:vector:"],
  ])("rejects %s", (_name, did) => {
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
