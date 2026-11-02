/**
 * Plutus Data values and their CBOR encoding.
 *
 * The encoding is the layout of the ledger and of the `serialiseData`
 * builtin: an empty list is a definite array, a non-empty list (also the
 * fields of a constructor) is an indefinite array, and a byte string longer
 * than 64 bytes is split into 64-byte chunks.
 */
import * as cbor from "./cbor.js";

export type Data = bigint | Uint8Array | readonly Data[] | Constr | DataMap;

export interface Constr {
  readonly constr: number;
  readonly fields: readonly Data[];
}

export interface DataMap {
  readonly map: ReadonlyArray<readonly [Data, Data]>;
}

export const constr = (index: number, ...fields: Data[]): Constr => ({ constr: index, fields });
export const dataMap = (entries: ReadonlyArray<readonly [Data, Data]>): DataMap => ({ map: entries });

/** Aiken `Option`: `Some` is constructor 0, `None` is constructor 1. */
export const some = (value: Data): Constr => constr(0, value);
export const none: Constr = constr(1);

/** Aiken `Bool`: `False` is constructor 0, `True` is constructor 1. */
export const bool = (value: boolean): Constr => constr(value ? 1 : 0);

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const CHUNK = 64;
const TWO_POW_64 = 1n << 64n;

function encodeBytes(value: Uint8Array): Uint8Array {
  if (value.length <= CHUNK) return cbor.bytes(value);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < value.length; offset += CHUNK) {
    chunks.push(value.subarray(offset, offset + CHUNK));
  }
  return cbor.indefiniteBytes(chunks);
}

function bigEndian(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function encodeInteger(value: bigint): Uint8Array {
  if (value >= -TWO_POW_64 && value < TWO_POW_64) return cbor.int(value);
  // RFC 8949 bignums: tag 2 holds n, tag 3 holds -1 - n.
  return value >= 0n
    ? cbor.tag(2, encodeBytes(bigEndian(value)))
    : cbor.tag(3, encodeBytes(bigEndian(-1n - value)));
}

function encodeList(items: readonly Data[]): Uint8Array {
  return items.length === 0 ? cbor.array([]) : cbor.indefiniteArray(items.map(encodeData));
}

/** `Array.isArray` does not narrow a union with a readonly array type. */
const isList = (value: Data): value is readonly Data[] => Array.isArray(value);

export function encodeData(value: Data): Uint8Array {
  if (typeof value === "bigint") return encodeInteger(value);
  if (value instanceof Uint8Array) return encodeBytes(value);
  if (isList(value)) return encodeList(value);
  if ("constr" in value) {
    const { constr: index, fields } = value;
    if (!Number.isInteger(index) || index < 0) throw new RangeError(`Bad constructor index: ${index}`);
    if (index < 7) return cbor.tag(121 + index, encodeList(fields));
    if (index < 128) return cbor.tag(1280 + index - 7, encodeList(fields));
    return cbor.tag(102, cbor.array([cbor.uint(index), encodeList(fields)]));
  }
  return cbor.map(value.map.map(([key, item]) => [encodeData(key), encodeData(item)] as const));
}
