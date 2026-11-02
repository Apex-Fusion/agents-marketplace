/**
 * Minimal CBOR writer (RFC 8949) for ledger transactions and Plutus Data.
 *
 * Each function returns the bytes of one data item. Callers compose larger
 * items from these parts, so the byte layout of every transaction stays
 * explicit and reviewable.
 */

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const MAX_UINT64 = (1n << 64n) - 1n;

/** The initial byte and the argument of a data item, in the shortest form. */
function head(major: number, argument: bigint | number): Uint8Array {
  const value = BigInt(argument);
  if (value < 0n || value > MAX_UINT64) {
    throw new RangeError(`CBOR argument out of range: ${value}`);
  }
  const type = major << 5;
  if (value < 24n) return Uint8Array.of(type | Number(value));
  const width = value < 0x100n ? 1 : value < 0x10000n ? 2 : value < 0x100000000n ? 4 : 8;
  const out = new Uint8Array(1 + width);
  out[0] = type | (width === 1 ? 24 : width === 2 ? 25 : width === 4 ? 26 : 27);
  let rest = value;
  for (let i = width; i >= 1; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export const uint = (value: bigint | number): Uint8Array => head(0, value);

/** An integer in [-2^64, 2^64 - 1] (major type 0 or 1). */
export function int(value: bigint | number): Uint8Array {
  const v = BigInt(value);
  return v >= 0n ? head(0, v) : head(1, -1n - v);
}

export const bytes = (value: Uint8Array): Uint8Array => concat([head(2, value.length), value]);

/** An indefinite-length byte string made of definite chunks. */
export const indefiniteBytes = (chunks: readonly Uint8Array[]): Uint8Array =>
  concat([Uint8Array.of(0x5f), ...chunks.map(bytes), Uint8Array.of(0xff)]);

export function text(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return concat([head(3, encoded.length), encoded]);
}

export const array = (items: readonly Uint8Array[]): Uint8Array => concat([head(4, items.length), ...items]);

export const indefiniteArray = (items: readonly Uint8Array[]): Uint8Array =>
  concat([Uint8Array.of(0x9f), ...items, Uint8Array.of(0xff)]);

/** A definite map. The caller gives the entries in the order to write. */
export const map = (entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>): Uint8Array =>
  concat([head(5, entries.length), ...entries.flatMap(([key, value]) => [key, value])]);

export const tag = (number: bigint | number, item: Uint8Array): Uint8Array => concat([head(6, number), item]);

export const TRUE = Uint8Array.of(0xf5);
export const FALSE = Uint8Array.of(0xf4);
export const NULL = Uint8Array.of(0xf6);
