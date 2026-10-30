import { describe, expect, test } from "vitest";
import { decodeCbor } from "../src/resolve/cbor.js";
import { vkeyHash } from "../src/resolve/controller-key.js";
import { parseDid } from "../src/resolve/did.js";
import { canonicalize } from "../src/resolve/jcs.js";
import { decodeLegacyOwner } from "../src/resolve/legacy-datum.js";
import { base58btc, ed25519Multikey } from "../src/resolve/multikey.js";
import { ASSET, OWNER_HASH, OWNER_KEY, OWNER_MULTIKEY, POLICY, REAL_DATUM, datumFor } from "./fixtures.js";

describe("parseDid", () => {
  test("legacy form: asset name as vector-id, canonical ID without the policy", () => {
    expect(parseDid(`did:vector:agent:${POLICY}:${ASSET}`)).toEqual({
      did: `did:vector:agent:${POLICY}:${ASSET}`,
      network: "mainnet",
      vectorId: ASSET,
      legacyPolicyId: POLICY,
      canonicalId: `did:vector:${ASSET}`,
    });
  });
  test("canonical and testnet forms", () => {
    expect(parseDid(`did:vector:${ASSET}`)).toMatchObject({ network: "mainnet", vectorId: ASSET, legacyPolicyId: null, canonicalId: `did:vector:${ASSET}` });
    expect(parseDid(`did:vector:testnet:${ASSET}`)).toMatchObject({ network: "testnet", canonicalId: `did:vector:testnet:${ASSET}` });
  });
});

describe("JCS (RFC 8785)", () => {
  test("the RFC 8785 Section 3.2.2 example", () => {
    const input = String.raw`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
      "literals": [null, true, false]
    }`;
    expect(canonicalize(JSON.parse(input))).toBe(String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`);
  });
  test("members sort by UTF-16 code units (RFC 8785 Section 3.2.3)", () => {
    const input = { "\u20ac": 1, "\r": 2, "\ufb33": 3, "1": 4, "\ud83d\ude00": 5, "\u0080": 6, "\u00f6": 7 };
    // Compared as text: JSON.parse would move the integer-like key "1" first again.
    expect(canonicalize(input)).toBe('{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}');
  });
  test("numbers use the ECMAScript serialisation", () => {
    expect(canonicalize([0, -0, 5e-324, 1.7976931348623157e308, 9007199254740992, 1e21, 1e-7, 0.000001])).toBe(
      "[0,0,5e-324,1.7976931348623157e+308,9007199254740992,1e+21,1e-7,0.000001]",
    );
  });
  test("strings are not normalised; undefined members are dropped; non-JSON values are refused", () => {
    expect(canonicalize({ a: "e\u0301", b: undefined })).toBe('{"a":"e\u0301"}');
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize("\ud800")).toThrow();
    expect(() => canonicalize(1n)).toThrow();
  });
});

describe("base58btc and Multikey", () => {
  // Bitcoin Core base58_encode_decode.json vectors.
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["61", "2g"],
    ["626262", "a3gV"],
    ["636363", "aPEr"],
    ["73696d706c792061206c6f6e6720737472696e67", "2cFupjhnEsSn59qHXstmK2ffpLv2"],
    ["00eb15231dfceb60925886b67d065299925915aeb172c06647", "1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L"],
    ["516b6fcd0f", "ABnLTmg"],
    ["bf4f89001e670274dd", "3SEo3LWLoPntC"],
    ["572e4794", "3EFU7m"],
    ["ecac89cad93923c02321", "EJDM8drfXA6uyA"],
    ["10c8511e", "Rt5zm"],
    ["00000000000000000000", "1111111111"],
  ];
  test.each(vectors)("base58btc(%s) = %s", (hex, encoded) => {
    expect(base58btc(Buffer.from(hex, "hex"))).toBe(encoded);
  });
  test("Ed25519 Multikey: 0xed01 header, base58btc, z prefix", () => {
    expect(ed25519Multikey(Buffer.from(OWNER_KEY, "hex"))).toBe(OWNER_MULTIKEY);
    expect(OWNER_MULTIKEY.startsWith("z6Mk")).toBe(true);
    expect(() => ed25519Multikey(new Uint8Array(31))).toThrow();
  });
});

describe("generation-1 datum", () => {
  test("the mainnet datum (with an indefinite-length chunked byte string) yields the owner key hash", () => {
    expect(decodeLegacyOwner(REAL_DATUM)).toEqual({ kind: "key", hash: OWNER_HASH });
    expect(decodeLegacyOwner(datumFor(OWNER_HASH, true))).toEqual({ kind: "script", hash: OWNER_HASH });
  });
  test("malformed datums are refused", () => {
    expect(() => decodeLegacyOwner("d87980")).toThrow(/7 fields/);
    expect(() => decodeLegacyOwner(REAL_DATUM.slice(0, -2))).toThrow();
    expect(() => decodeLegacyOwner(`${REAL_DATUM}00`)).toThrow(/trailing/);
    expect(() => decodeLegacyOwner("zz")).toThrow(/hex/);
    expect(() => decodeLegacyOwner(REAL_DATUM.replace("581cc24f", "581bc24f"))).toThrow();
  });
  test("CBOR integers, text and maps", () => {
    expect(decodeCbor(Buffer.from("1b0000019d92f3c0af", "hex"))).toBe(1776286941359n);
    expect(decodeCbor(Buffer.from("20", "hex"))).toBe(-1n);
    expect(decodeCbor(Buffer.from("6161", "hex"))).toBe("a");
    expect(decodeCbor(Buffer.from("a10102", "hex"))).toMatchObject({ entries: [[1n, 2n]] });
  });
  test("the verification key hash is blake2b-224 of the public key", () => {
    expect(vkeyHash(OWNER_KEY)).toBe(OWNER_HASH);
  });
});
