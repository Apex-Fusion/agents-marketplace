import { describe, expect, test } from "vitest";
import { bech32Encode, enterpriseScriptAddress } from "../src/codec/address.js";
import { decodeCbor } from "../src/codec/cbor.js";
import { decodeIdentityDatum, encodeIdentityDatum, type IdentityDatum } from "../src/codec/identity-datum.js";
import { base58btc, keyHash, multikey, p256PopValid } from "../src/codec/keys.js";
import { decodeLegacyDatum, encodeLegacyDatum } from "../src/codec/legacy-datum.js";
import { decodePlutusData, encodePlutusData, pdBytes, pdConstr, pdInt, pdList, pdMap, plutusDataEqual, plutusDataFromHex } from "../src/codec/plutus-data.js";
import { recordText } from "../src/codec/text.js";
import { canonicalize } from "../src/resolve/jcs.js";
import { parseDid } from "../src/resolve/did.js";
import { LEGACY_REGISTRY, registryOf } from "../src/resolve/settings.js";
import { formatTime, parseVersionTime } from "../src/resolve/time.js";
import { p256Key } from "./support/keys.js";
import { KEY_A, LEGACY_OWNER, identityDatum, keySigner, legacyDatum, party, timeAt, utf8 } from "./support/ledger.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

// Mainnet facts: the datum of legacy record 4c2047… (with an indefinite-length chunked byte string)
// and its owner key; the Multikey was computed with @scure/base, independently of src/codec/keys.ts.
const REAL_DATUM =
  "d8799fd8799f581cc24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01eff52476f7665726e616e636550726f706f7365725f5840416e616c797a6573206f6e2d636861696e206d65747269637320616e64207375626d69747320676f7665726e616e63652070726f706f73616c7320746f20696d583070726f766520566563746f722070726f746f636f6c20706172616d657465727320616e64206f7065726174696f6e732eff9f4a676f7665726e616e636549616e616c79746963735070726f706f73616c2d77726974696e67ff4b636c617564652d636f6465401b0000019d92f3c0afff";
const OWNER_KEY = "edca77f5418b21bb7bf540bd056a238e38575fc26c4aa677a36df6bf305d9e9c";
const OWNER_HASH = "c24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01e";
const OWNER_MULTIKEY = "z6MkvTVjXjyHobwwQTTFzv36vkXTTTKdPu8uc8X8giZ82cdq";

describe("Plutus Data", () => {
  test("constructor tags 121-127, 1280-1400 and 102; bignums; maps; equality ignores the encoding", () => {
    expect(hex(encodePlutusData(pdConstr(0, [])))).toBe("d87980");
    expect(hex(encodePlutusData(pdConstr(6, [pdInt(1)])))).toBe("d87f9f01ff");
    expect(hex(encodePlutusData(pdConstr(7, [])))).toBe("d9050080");
    expect(hex(encodePlutusData(pdConstr(127, [])))).toBe("d9057880");
    expect(hex(encodePlutusData(pdConstr(128, [])))).toBe("d86682188080");
    expect(plutusDataFromHex("d86682188080")).toEqual(pdConstr(128, []));
    expect(hex(encodePlutusData(pdInt(2n ** 64n)))).toBe("c249010000000000000000");
    expect(hex(encodePlutusData(pdInt(-(2n ** 64n) - 1n)))).toBe("c349010000000000000000");
    expect(plutusDataFromHex("c249010000000000000000")).toEqual(pdInt(2n ** 64n));
    expect(hex(encodePlutusData(pdInt(-1)))).toBe("20");
    expect(hex(encodePlutusData(pdMap([[pdInt(1), pdBytes("ab")]])))).toBe("a10141ab");
    // Definite and indefinite encodings of the same list are the same data.
    expect(plutusDataEqual(plutusDataFromHex("9f0102ff"), plutusDataFromHex("820102"))).toBe(true);
    expect(plutusDataEqual(plutusDataFromHex("9f0102ff"), plutusDataFromHex("820201"))).toBe(false);
    // A 65-byte string is two chunks (64 + 1) inside an indefinite byte string.
    const long = encodePlutusData(pdBytes("aa".repeat(65)));
    expect(hex(long)).toBe(`5f5840${"aa".repeat(64)}41aaff`);
    expect(decodePlutusData(long)).toEqual(pdBytes("aa".repeat(65)));
    expect(hex(encodePlutusData(pdList([])))).toBe("80");
  });

  test("CBOR that is not Plutus Data is refused", () => {
    for (const bad of ["61", "f5", "f6", "fa3f800000", "d87b61", "c06161"]) expect(() => plutusDataFromHex(bad), bad).toThrow();
    expect(() => plutusDataFromHex("d87980ff")).toThrow(/trailing/);
  });

  test("the CBOR reader: integers, text, maps", () => {
    expect(decodeCbor(fromHex("1b0000019d92f3c0af"))).toBe(1776286941359n);
    expect(decodeCbor(fromHex("20"))).toBe(-1n);
    expect(decodeCbor(fromHex("6161"))).toBe("a");
    expect(decodeCbor(fromHex("a10102"))).toMatchObject({ entries: [[1n, 2n]] });
  });
});

describe("identity datum (Part 1 Section 5)", () => {
  test("encode and decode are inverse for every constructor", () => {
    const p256 = p256Key(70);
    const datums: IdentityDatum[] = [
      identityDatum(),
      identityDatum({
        keys: [
          { keyType: "Ed25519", key: KEY_A, purposes: 27, pop: null },
          { keyType: "P256", key: p256.publicKey, purposes: 3, pop: "44".repeat(64) },
        ],
        parties: [
          party({ organisation: utf8("did:web:example.org"), notAfter: timeAt(5000), removalAfter: timeAt(4000) }),
          party({ role: "Responsible", signer: { type: "ControllerSet" }, rights: 1 }),
          party({ role: "Guardian", signer: { type: "Script", hash: "66".repeat(28) }, rights: 4 }),
        ],
        guardianThreshold: 1,
        pendingRecovery: { newController: "77".repeat(32), effectiveAfter: timeAt(2000) },
        lineage: { type: "Subagent", parent: "88".repeat(32), parentEpoch: 2, depth: 1 },
        status: { type: "Suspended", holds: [{ by: keySigner(KEY_A), reason: 64, since: 1, until: 2 }] },
      }),
      identityDatum({ status: { type: "Revoked", by: { type: "Script", hash: "99".repeat(28) }, reason: 64, at: 5, invalidFrom: 3, successor: "aa".repeat(32) } }),
      identityDatum({ status: { type: "Retired", at: 253_402_300_799_999, successor: null } }),
    ];
    for (const d of datums) expect(decodeIdentityDatum(encodeIdentityDatum(d))).toEqual(d);
  });

  test("layout errors are refused", () => {
    const good = hex(encodeIdentityDatum(identityDatum()));
    expect(() => decodeIdentityDatum(fromHex("d87980"))).toThrow(/14/);
    expect(() => decodeIdentityDatum(fromHex(good.replace(/^d8799f5820/, "d8799f581f")))).toThrow();
    expect(() => decodeIdentityDatum(encodeIdentityDatum(identityDatum({ createdAt: 253_402_300_800_000 })))).toThrow(/range/);
    expect(() => decodeIdentityDatum(encodeIdentityDatum(identityDatum({ keys: [{ keyType: "P256", key: `04${"11".repeat(32)}`, purposes: 1, pop: null }] })))).toThrow(
      /compressed/,
    );
    expect(() => decodeIdentityDatum(encodePlutusData(pdConstr(1, Array.from({ length: 14 }, () => pdInt(0)))))).toThrow();
  });
});

describe("legacy datum", () => {
  test("the mainnet datum decodes; encode and decode are inverse", () => {
    const d = decodeLegacyDatum(fromHex(REAL_DATUM));
    expect(d.owner).toEqual({ kind: "key", hash: OWNER_HASH });
    expect(recordText(d.name)).toBe("GovernanceProposer");
    expect(d.capabilities.map((c) => recordText(c))).toEqual(["governance", "analytics", "proposal-writing"]);
    expect(d.registeredAt).toBe(1776286941359n);
    const sample = legacyDatum(LEGACY_OWNER);
    expect(decodeLegacyDatum(encodeLegacyDatum(sample))).toEqual(sample);
  });

  test("malformed datums are refused", () => {
    expect(() => decodeLegacyDatum(fromHex("d87980"))).toThrow(/7 fields/);
    expect(() => decodeLegacyDatum(fromHex(REAL_DATUM.slice(0, -2)))).toThrow();
    expect(() => decodeLegacyDatum(fromHex(REAL_DATUM.replace("581cc24f", "581bc24f")))).toThrow();
  });
});

describe("keys", () => {
  // Bitcoin Core base58_encode_decode.json vectors.
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["61", "2g"],
    ["626262", "a3gV"],
    ["73696d706c792061206c6f6e6720737472696e67", "2cFupjhnEsSn59qHXstmK2ffpLv2"],
    ["00eb15231dfceb60925886b67d065299925915aeb172c06647", "1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L"],
    ["00000000000000000000", "1111111111"],
  ];
  test.each(vectors)("base58btc(%s) = %s", (input, encoded) => {
    expect(base58btc(fromHex(input))).toBe(encoded);
  });

  test("key hash and Multikey: Ed25519 (0xed01) and P-256 (0x8024)", () => {
    expect(keyHash(OWNER_KEY)).toBe(OWNER_HASH);
    expect(multikey("Ed25519", OWNER_KEY)).toBe(OWNER_MULTIKEY);
    expect(multikey("P256", p256Key(71).publicKey)).toMatch(/^zDn[1-9A-HJ-NP-Za-km-z]{46}$/);
    expect(() => multikey("Ed25519", "00".repeat(31))).toThrow();
    expect(() => multikey("P256", "02".repeat(32))).toThrow();
  });

  test("P-256 proof of possession: r || s over did:vector:<id>#<key hash>, both forms of s", () => {
    const key = p256Key(72);
    const id = "ab".repeat(32);
    expect(p256PopValid(id, key.publicKey, key.pop(id, "low"))).toBe(true);
    expect(p256PopValid(id, key.publicKey, key.pop(id, "high"))).toBe(true);
    expect(p256PopValid("cd".repeat(32), key.publicKey, key.pop(id))).toBe(false);
    expect(p256PopValid(id, key.publicKey, key.sign(`did:vector:${id}`))).toBe(false);
    expect(p256PopValid(id, key.publicKey, null)).toBe(false);
    expect(p256PopValid(id, key.publicKey, "00".repeat(64))).toBe(false);
    expect(p256PopValid(id, key.publicKey, "ff".repeat(64))).toBe(false);
    expect(p256PopValid(id, key.publicKey, key.pop(id).slice(0, 126))).toBe(false);
  });
});

describe("text (Part 1 Section 8.2)", () => {
  test.each([
    ["ascii", "616263", "abc"],
    ["a leading BOM stays", "efbbbf41", "\uFEFFA"],
    ["emoji", "f09f9880", "😀"],
    ["empty", "", ""],
    ["invalid byte", "61ff", null],
    ["overlong", "c0af", null],
    ["encoded surrogate", "eda080", null],
    ["U+FDD0", "efb790", null],
    ["U+FFFF", "efbfbf", null],
    ["U+1FFFE", "f09fbfbe", null],
    ["U+10FFFF", "f48fbfbf", null],
    ["truncated", "e282", null],
  ])("%s", (_name, input, expected) => {
    expect(recordText(fromHex(input))).toBe(expected);
  });
});

describe("addresses and registries", () => {
  test("the legacy address is the enterprise address of the legacy script", () => {
    expect(enterpriseScriptAddress(LEGACY_REGISTRY.policyId)).toBe(LEGACY_REGISTRY.address);
    expect(registryOf(LEGACY_REGISTRY.policyId)).toEqual(LEGACY_REGISTRY);
    expect(() => registryOf(LEGACY_REGISTRY.policyId, "addr1wrongaddress")).toThrow(/enterprise address/);
    expect(() => registryOf("AB".repeat(28))).toThrow(/lowercase/);
    // BIP 173 test vector.
    expect(bech32Encode("a", new Uint8Array())).toBe("a12uel5l");
  });
});

describe("times", () => {
  test("versionTime parsing: real dates only; proleptic Gregorian calendar", () => {
    expect(parseVersionTime("1970-01-01T00:00:00Z")).toBe(0);
    expect(parseVersionTime("2025-08-29T16:40:00Z")).toBe(1_756_485_600_000);
    expect(parseVersionTime("2000-02-29T23:59:59Z")).toBe(Date.UTC(2000, 1, 29, 23, 59, 59));
    expect(parseVersionTime("9999-12-31T23:59:59Z")).toBe(253_402_300_799_000);
    expect(parseVersionTime("0000-01-01T00:00:00Z")).toBe(-62_167_219_200_000);
    expect(parseVersionTime("1900-02-29T00:00:00Z")).toBeNull();
    expect(parseVersionTime("2026-04-31T00:00:00Z")).toBeNull();
  });

  test("output times round milliseconds down", () => {
    expect(formatTime(1_756_485_600_999)).toBe("2025-08-29T16:40:00Z");
    expect(formatTime(253_402_300_799_999)).toBe("9999-12-31T23:59:59Z");
    expect(formatTime(0)).toBe("1970-01-01T00:00:00Z");
  });
});

describe("DID parsing", () => {
  test("forms", () => {
    const id = "ab".repeat(32);
    expect(parseDid(`did:vector:${id}`)).toEqual({ did: `did:vector:${id}`, form: "canonical", vectorId: id, legacyPolicyId: null });
    expect(parseDid(`did:vector:testnet:${id}`)).toMatchObject({ form: "testnet", vectorId: id });
    expect(parseDid(`did:vector:agent:${LEGACY_REGISTRY.policyId}:${id}`)).toMatchObject({ form: "legacy", vectorId: id, legacyPolicyId: LEGACY_REGISTRY.policyId });
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
  test("members sort by UTF-16 code units", () => {
    const input = { "\u20ac": 1, "\r": 2, "\ufb33": 3, "1": 4, "\ud83d\ude00": 5, "\u0080": 6, "\u00f6": 7 };
    expect(canonicalize(input)).toBe('{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}');
  });
  test("strings are not normalised; undefined members are dropped; non-JSON values are refused", () => {
    expect(canonicalize({ a: "e\u0301", b: undefined })).toBe('{"a":"e\u0301"}');
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize("\ud800")).toThrow();
    expect(() => canonicalize(1n)).toThrow();
  });
});
