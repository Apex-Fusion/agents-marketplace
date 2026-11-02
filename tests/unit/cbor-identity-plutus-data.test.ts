/**
 * Canonical Plutus Data encoder and strict decoder (packages/shared/src/cbor/plutus-data.ts).
 *
 * The expected bytes follow Plutus `serialiseData` (= Aiken `cbor.serialise`):
 * shortest integer heads, bignum tags 2/3 outside 64 bits, 64-byte chunks,
 * indefinite arrays for non-empty lists and constructor fields, 0x80 for empty
 * ones, tags 121..127 / 1280..1400 / 102 for constructors.
 */

import { describe, expect, it } from "vitest";
import {
  decodePlutusData, decodePlutusDataHex, encodePlutusData, encodePlutusDataHex, type PlutusData,
} from "../../packages/shared/src/cbor/index.js";

const int = (value: bigint | number): PlutusData => ({ kind: "int", value: BigInt(value) });
const bytes = (hex: string): PlutusData => ({ kind: "bytes", hex });
const list = (...items: PlutusData[]): PlutusData => ({ kind: "list", items });
const constr = (index: number | bigint, ...fields: PlutusData[]): PlutusData => ({ kind: "constr", index: BigInt(index), fields });

describe("encodePlutusData — canonical bytes", () => {
  it.each([
    [0n, "00"], [23n, "17"], [24n, "1818"], [255n, "18ff"], [256n, "190100"], [65535n, "19ffff"],
    [65536n, "1a00010000"], [4294967295n, "1affffffff"], [4294967296n, "1b0000000100000000"],
    [18446744073709551615n, "1bffffffffffffffff"], [18446744073709551616n, "c249010000000000000000"],
    [-1n, "20"], [-24n, "37"], [-25n, "3818"], [-18446744073709551616n, "3bffffffffffffffff"],
    [-18446744073709551617n, "c349010000000000000000"],
  ])("integer %s → %s", (value, hex) => {
    expect(encodePlutusDataHex(int(value))).toBe(hex);
    expect(decodePlutusDataHex(hex)).toEqual(int(value));
  });

  it("writes byte strings up to 64 bytes in one piece and longer ones in 64-byte chunks", () => {
    expect(encodePlutusDataHex(bytes(""))).toBe("40");
    expect(encodePlutusDataHex(bytes("ab".repeat(64)))).toBe(`5840${"ab".repeat(64)}`);
    expect(encodePlutusDataHex(bytes("ab".repeat(65)))).toBe(`5f5840${"ab".repeat(64)}41abff`);
    expect(encodePlutusDataHex(bytes("cd".repeat(130)))).toBe(`5f5840${"cd".repeat(64)}5840${"cd".repeat(64)}42cdcdff`);
    expect(encodePlutusDataHex(bytes("ABcd"))).toBe("42abcd");
  });

  it("uses the empty definite array for empty lists and indefinite arrays otherwise", () => {
    expect(encodePlutusDataHex(list())).toBe("80");
    expect(encodePlutusDataHex(list(int(1), int(2)))).toBe("9f0102ff");
    expect(encodePlutusDataHex(list(list()))).toBe("9f80ff");
  });

  it("writes definite maps in entry order, duplicates included", () => {
    expect(encodePlutusDataHex({ kind: "map", entries: [] })).toBe("a0");
    expect(encodePlutusDataHex({ kind: "map", entries: [[int(2), bytes("aa")], [int(1), list()], [int(2), int(0)]] })).toBe("a30241aa01800200");
  });

  it.each([
    [0, "d87980"], [6, "d87f80"], [7, "d9050080"], [127, "d9057880"], [128, "d86682188080"], [1000, "d866821903e880"],
  ])("constructor %i without fields → %s", (index, hex) => {
    expect(encodePlutusDataHex(constr(index))).toBe(hex);
    expect(decodePlutusDataHex(hex)).toEqual(constr(index));
  });

  it("writes constructor fields as an indefinite array", () => {
    expect(encodePlutusDataHex(constr(0, int(1)))).toBe("d8799f01ff");
    expect(encodePlutusDataHex(constr(8, bytes("00")))).toBe("d905019f4100ff");
    expect(encodePlutusDataHex(constr(200, int(1)))).toBe("d8668218c89f01ff");
  });

  it("serialises an output reference exactly as Part 1 §3.1 shows", () => {
    const ref = (tx: string, index: number) => constr(0, bytes(tx), int(index));
    expect(encodePlutusDataHex(ref("00".repeat(32), 0))).toBe(`d8799f5820${"00".repeat(32)}00ff`);
    expect(encodePlutusDataHex(ref("ab".repeat(32), 24))).toBe(`d8799f5820${"ab".repeat(32)}1818ff`);
  });

  it("round-trips a nested value", () => {
    const value = constr(3, list(constr(0), { kind: "map", entries: [[bytes("01"), constr(9, int(-5))]] }), bytes("ff".repeat(100)), int(1n << 70n));
    expect(decodePlutusData(encodePlutusData(value))).toEqual(value);
  });

  it("rejects malformed values", () => {
    expect(() => encodePlutusData({ kind: "int", value: 1 } as unknown as PlutusData)).toThrow(/bigint/);
    expect(() => encodePlutusData(bytes("abc"))).toThrow(/hex/);
    expect(() => encodePlutusData(bytes("zz"))).toThrow(/hex/);
    expect(() => encodePlutusData({ kind: "constr", index: -1n, fields: [] })).toThrow(/constructor index/);
    expect(() => encodePlutusData({ kind: "constr", index: 1n << 64n, fields: [] })).toThrow(/constructor index/);
    expect(() => encodePlutusData({ kind: "text", text: "a" } as unknown as PlutusData)).toThrow(/unknown Plutus Data kind/);
    expect(() => encodePlutusData({ kind: "map", entries: [[int(1)]] } as unknown as PlutusData)).toThrow(/pair/);
  });
});

describe("decodePlutusData — accepts every ledger form", () => {
  it("reads definite constructor arrays, as the legacy cbor-x codecs write them", () => {
    expect(decodePlutusDataHex("d87983010241aa")).toEqual(constr(0, int(1), int(2), bytes("aa")));
    // The legacy codecs write every integer with an 8-byte head.
    expect(decodePlutusDataHex("d879811b0000000000000005")).toEqual(constr(0, int(5)));
    expect(encodePlutusDataHex(decodePlutusDataHex("d879811b0000000000000005"))).toBe("d8799f05ff");
  });

  it("reads indefinite maps, chunked byte strings, short tag-102 indices and bignums", () => {
    expect(decodePlutusDataHex("bf0102ff")).toEqual({ kind: "map", entries: [[int(1), int(2)]] });
    expect(decodePlutusDataHex("5f41ab42cdefff")).toEqual(bytes("abcdef"));
    expect(decodePlutusDataHex("5fff")).toEqual(bytes(""));
    expect(decodePlutusDataHex("d8668200820102")).toEqual(constr(0, int(1), int(2)));
    expect(decodePlutusDataHex("c24101")).toEqual(int(1));
    expect(decodePlutusDataHex("c34100")).toEqual(int(-1));
    expect(decodePlutusDataHex("c25f4101ff")).toEqual(int(1));
  });
});

describe("decodePlutusData — strict failures", () => {
  it.each([
    ["", /non-empty/],
    ["0", /hex/],
    ["0001", /trailing bytes/],
    ["d87980ff", /trailing bytes/],
    ["6161", /text string/],
    ["f93c00", /simple value or float/],
    ["f6", /simple value or float/],
    ["ff", /simple value or float/],
    ["d84041aa", /tag 64/],
    ["c1820102", /tag 1 /],
    [`5841${"00".repeat(65)}`, /chunks of at most 64 bytes/],
    ["5f5f41aaffff", /not a definite byte string/],
    ["5f01ff", /not a definite byte string/],
    ["d879", /unexpected end/],
    ["9f01", /unexpected end/],
    ["5820aa", /unexpected end/],
    ["1c", /reserved/],
    ["1f", /indefinite length/],
    ["d87901", /no field array/],
    ["d866830001", /definite array of 2/],
    ["d866822080", /unsigned constructor index/],
    ["c201", /must wrap a byte string/],
  ])("rejects %s", (hex, error) => {
    expect(() => decodePlutusDataHex(hex)).toThrow(error);
  });

  it("limits the nesting depth", () => {
    const deep = `${"81".repeat(1001)}00`;
    expect(() => decodePlutusDataHex(deep)).toThrow(/deeper than 1000/);
    expect(decodePlutusDataHex(`${"81".repeat(999)}00`).kind).toBe("list");
  });

  it("rejects input that is not bytes", () => {
    expect(() => decodePlutusData("00" as unknown as Uint8Array)).toThrow(/CBOR bytes/);
  });
});
