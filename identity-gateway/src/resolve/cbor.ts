// A strict, minimal CBOR (RFC 8949) decoder for Plutus Data: integers, byte and text strings
// (definite and indefinite), arrays, maps, tags and simple values. The whole input must be one item.

export type CborValue = bigint | number | boolean | null | undefined | string | Uint8Array | CborValue[] | CborMap | CborTag;

export class CborTag {
  constructor(
    readonly tag: bigint,
    readonly value: CborValue,
  ) {}
}

export class CborMap {
  constructor(readonly entries: Array<[CborValue, CborValue]>) {}
}

const BREAK = Symbol("break");
const MAX_DEPTH = 256;

class Reader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  done(): boolean {
    return this.pos === this.bytes.length;
  }

  private take(n: number): Uint8Array {
    if (n > this.bytes.length - this.pos) throw new Error("CBOR: unexpected end of input");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  private uint(n: number): bigint {
    let v = 0n;
    for (const b of this.take(n)) v = (v << 8n) | BigInt(b);
    return v;
  }

  /** The argument of a head: its value, or null for the indefinite-length marker. */
  private argument(info: number): bigint | null {
    if (info < 24) return BigInt(info);
    if (info === 24) return this.uint(1);
    if (info === 25) return this.uint(2);
    if (info === 26) return this.uint(4);
    if (info === 27) return this.uint(8);
    if (info === 31) return null;
    throw new Error(`CBOR: reserved additional information ${info}`);
  }

  private length(arg: bigint): number {
    if (arg > BigInt(this.bytes.length - this.pos)) throw new Error("CBOR: length exceeds input");
    return Number(arg);
  }

  item(depth = 0): CborValue | typeof BREAK {
    if (depth > MAX_DEPTH) throw new Error("CBOR: nesting too deep");
    const head = this.take(1)[0]!;
    const major = head >> 5;
    const info = head & 0x1f;
    if (major === 7) return this.simple(info);
    const arg = this.argument(info);
    switch (major) {
      case 0:
        return arg ?? this.fail("indefinite integer");
      case 1:
        return arg === null ? this.fail("indefinite integer") : -1n - arg;
      case 2:
      case 3: {
        const chunks: Uint8Array[] = [];
        if (arg !== null) chunks.push(this.take(this.length(arg)));
        else {
          for (;;) {
            const chunk = this.item(depth + 1);
            if (chunk === BREAK) break;
            if (major === 2 ? !(chunk instanceof Uint8Array) : typeof chunk !== "string") this.fail("bad indefinite string chunk");
            chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array));
          }
        }
        const joined = concat(chunks);
        return major === 2 ? joined : new TextDecoder("utf-8", { fatal: true }).decode(joined);
      }
      case 4: {
        const out: CborValue[] = [];
        if (arg !== null) for (let i = this.length(arg); i > 0; i--) out.push(this.definite(depth));
        else for (let x = this.item(depth + 1); x !== BREAK; x = this.item(depth + 1)) out.push(x);
        return out;
      }
      case 5: {
        const entries: Array<[CborValue, CborValue]> = [];
        if (arg !== null) for (let i = this.length(arg); i > 0; i--) entries.push([this.definite(depth), this.definite(depth)]);
        else for (let k = this.item(depth + 1); k !== BREAK; k = this.item(depth + 1)) entries.push([k, this.definite(depth)]);
        return new CborMap(entries);
      }
      case 6:
        return arg === null ? this.fail("indefinite tag") : new CborTag(arg, this.definite(depth));
      default:
        return this.fail(`major type ${major}`);
    }
  }

  private definite(depth: number): CborValue {
    const x = this.item(depth + 1);
    if (x === BREAK) this.fail("unexpected break");
    return x as CborValue;
  }

  private simple(info: number): CborValue | typeof BREAK {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 25:
        return halfToNumber(Number(this.uint(2)));
      case 26:
        return new DataView(this.take(4).slice().buffer).getFloat32(0);
      case 27:
        return new DataView(this.take(8).slice().buffer).getFloat64(0);
      case 31:
        return BREAK;
      default:
        return this.fail(`simple value ${info}`);
    }
  }

  private fail(what: string): never {
    throw new Error(`CBOR: unsupported or malformed ${what}`);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function halfToNumber(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

export function decodeCbor(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const value = r.item();
  if (value === BREAK) throw new Error("CBOR: unexpected break");
  if (!r.done()) throw new Error("CBOR: trailing bytes after the item");
  return value;
}

/** Plutus Data constructor: tags 121-127 (alternatives 0-6), 1280-1400 (7-127), 102 (general form). */
export function asConstr(value: CborValue): { index: number; fields: CborValue[] } | null {
  if (!(value instanceof CborTag)) return null;
  const t = value.tag;
  if (t >= 121n && t <= 127n && Array.isArray(value.value)) return { index: Number(t - 121n), fields: value.value };
  if (t >= 1280n && t <= 1400n && Array.isArray(value.value)) return { index: Number(t - 1280n) + 7, fields: value.value };
  if (t === 102n && Array.isArray(value.value) && value.value.length === 2) {
    const [index, fields] = value.value;
    if (typeof index === "bigint" && Array.isArray(fields)) return { index: Number(index), fields };
  }
  return null;
}
