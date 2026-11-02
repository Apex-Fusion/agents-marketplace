// Plutus Data: the data model of inline datums. Decoding accepts every CBOR form that the ledger
// accepts for Plutus Data (constructor tags 121-127, 1280-1400 and 102; bignum tags 2 and 3;
// definite and indefinite lists and byte strings; maps). Equality compares the data, not the bytes,
// so two encodings of the same value are equal (Part 1 Section 7.2, "differs, as Plutus Data").
// The encoder writes the form that the Plutus ledger libraries write: indefinite non-empty lists,
// byte strings in chunks of at most 64 bytes, and the shortest integer heads.

import { CborMap, CborTag, decodeCbor, type CborValue } from "./cbor.js";

export type PlutusData =
  | { readonly type: "constr"; readonly index: bigint; readonly fields: readonly PlutusData[] }
  | { readonly type: "map"; readonly entries: ReadonlyArray<readonly [PlutusData, PlutusData]> }
  | { readonly type: "list"; readonly items: readonly PlutusData[] }
  | { readonly type: "int"; readonly value: bigint }
  | { readonly type: "bytes"; readonly value: Uint8Array };

export const pdConstr = (index: number | bigint, fields: readonly PlutusData[]): PlutusData => ({ type: "constr", index: BigInt(index), fields });
export const pdList = (items: readonly PlutusData[]): PlutusData => ({ type: "list", items });
export const pdMap = (entries: ReadonlyArray<readonly [PlutusData, PlutusData]>): PlutusData => ({ type: "map", entries });
export const pdInt = (value: number | bigint): PlutusData => ({ type: "int", value: BigInt(value) });
export const pdBytes = (value: Uint8Array | string): PlutusData => ({
  type: "bytes",
  value: typeof value === "string" ? hexToBytes(value) : value,
});

const HEX = /^(?:[0-9a-fA-F]{2})*$/;

export function hexToBytes(hex: string): Uint8Array {
  if (!HEX.test(hex)) throw new Error("not a hexadecimal byte string");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");

function fromCbor(value: CborValue): PlutusData {
  if (typeof value === "bigint") return { type: "int", value };
  if (value instanceof Uint8Array) return { type: "bytes", value };
  if (Array.isArray(value)) return { type: "list", items: value.map(fromCbor) };
  if (value instanceof CborMap) return { type: "map", entries: value.entries.map(([k, v]) => [fromCbor(k), fromCbor(v)] as const) };
  if (value instanceof CborTag) {
    const { tag, value: inner } = value;
    if (tag >= 121n && tag <= 127n && Array.isArray(inner)) return { type: "constr", index: tag - 121n, fields: inner.map(fromCbor) };
    if (tag >= 1280n && tag <= 1400n && Array.isArray(inner)) return { type: "constr", index: tag - 1280n + 7n, fields: inner.map(fromCbor) };
    if (tag === 102n && Array.isArray(inner) && inner.length === 2) {
      const [index, fields] = inner;
      if (typeof index === "bigint" && index >= 0n && Array.isArray(fields)) return { type: "constr", index, fields: fields.map(fromCbor) };
    }
    if ((tag === 2n || tag === 3n) && inner instanceof Uint8Array) {
      let n = 0n;
      for (const b of inner) n = (n << 8n) | BigInt(b);
      return { type: "int", value: tag === 2n ? n : -1n - n };
    }
    throw new Error(`Plutus Data: unsupported CBOR tag ${tag}`);
  }
  throw new Error("Plutus Data: CBOR item is not Plutus Data");
}

export function decodePlutusData(bytes: Uint8Array): PlutusData {
  return fromCbor(decodeCbor(bytes));
}

export function plutusDataFromHex(hex: string): PlutusData {
  return decodePlutusData(hexToBytes(hex));
}

export function plutusDataEqual(a: PlutusData, b: PlutusData): boolean {
  switch (a.type) {
    case "int":
      return b.type === "int" && a.value === b.value;
    case "bytes":
      return b.type === "bytes" && Buffer.compare(a.value, b.value) === 0;
    case "list":
      return b.type === "list" && a.items.length === b.items.length && a.items.every((x, i) => plutusDataEqual(x, b.items[i]!));
    case "map":
      return (
        b.type === "map" &&
        a.entries.length === b.entries.length &&
        a.entries.every(([k, v], i) => plutusDataEqual(k, b.entries[i]![0]) && plutusDataEqual(v, b.entries[i]![1]))
      );
    case "constr":
      return (
        b.type === "constr" &&
        a.index === b.index &&
        a.fields.length === b.fields.length &&
        a.fields.every((x, i) => plutusDataEqual(x, b.fields[i]!))
      );
  }
}

// ── encoding ────────────────────────────────────────────────────────────────

function head(major: number, arg: bigint, out: number[]): void {
  const m = major << 5;
  if (arg < 24n) out.push(m | Number(arg));
  else if (arg < 0x100n) out.push(m | 24, Number(arg));
  else if (arg < 0x10000n) out.push(m | 25, Number(arg >> 8n), Number(arg & 0xffn));
  else if (arg < 0x100000000n) out.push(m | 26, ...bigEndian(arg, 4));
  else out.push(m | 27, ...bigEndian(arg, 8));
}

function bigEndian(n: bigint, length: number): number[] {
  const out: number[] = new Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function byteString(bytes: Uint8Array, out: number[]): void {
  if (bytes.length <= 64) {
    head(2, BigInt(bytes.length), out);
    out.push(...bytes);
    return;
  }
  out.push(0x5f);
  for (let i = 0; i < bytes.length; i += 64) {
    const chunk = bytes.subarray(i, i + 64);
    head(2, BigInt(chunk.length), out);
    out.push(...chunk);
  }
  out.push(0xff);
}

function items(list: readonly PlutusData[], out: number[]): void {
  if (list.length === 0) {
    out.push(0x80);
    return;
  }
  out.push(0x9f);
  for (const x of list) write(x, out);
  out.push(0xff);
}

const U64 = 1n << 64n;

function write(data: PlutusData, out: number[]): void {
  switch (data.type) {
    case "int": {
      const v = data.value;
      if (v >= 0n && v < U64) return head(0, v, out);
      if (v < 0n && -1n - v < U64) return head(1, -1n - v, out);
      const n = v >= 0n ? v : -1n - v;
      const hex = n.toString(16);
      head(6, v >= 0n ? 2n : 3n, out);
      return byteString(hexToBytes(hex.length % 2 ? `0${hex}` : hex), out);
    }
    case "bytes":
      return byteString(data.value, out);
    case "list":
      return items(data.items, out);
    case "map":
      head(5, BigInt(data.entries.length), out);
      for (const [k, v] of data.entries) {
        write(k, out);
        write(v, out);
      }
      return;
    case "constr": {
      const i = data.index;
      if (i >= 0n && i <= 6n) head(6, 121n + i, out);
      else if (i >= 7n && i <= 127n) head(6, 1280n + i - 7n, out);
      else {
        head(6, 102n, out);
        out.push(0x82);
        write({ type: "int", value: i }, out);
      }
      return items(data.fields, out);
    }
  }
}

export function encodePlutusData(data: PlutusData): Uint8Array {
  const out: number[] = [];
  write(data, out);
  return Uint8Array.from(out);
}
