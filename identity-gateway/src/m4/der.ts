// A small DER encoder and strict decoder (ITU-T X.690, 02/2021, Section 10) for the certificate
// structures of RFC 5280 and the certification requests of RFC 2986. Only single-byte tags
// (tag numbers up to 30) and definite lengths in their shortest form.

export class DerError extends Error {}

export const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  sequence: 0x30,
  set: 0x31,
  utcTime: 0x17,
  generalizedTime: 0x18,
} as const;

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

export const sequence = (...items: Uint8Array[]): Buffer => tlv(TAG.sequence, Buffer.concat(items));
export const set = (...items: Uint8Array[]): Buffer => tlv(TAG.set, Buffer.concat(items));
export const octetString = (bytes: Uint8Array): Buffer => tlv(TAG.octetString, bytes);
export const utf8String = (text: string): Buffer => tlv(TAG.utf8String, Buffer.from(text, "utf8"));
export const derNull = (): Buffer => Buffer.from([TAG.null, 0]);
export const boolean = (value: boolean): Buffer => Buffer.from([TAG.boolean, 1, value ? 0xff : 0x00]);
/** A context-specific constructed (EXPLICIT) tag around `inner`. */
export const explicit = (tagNumber: number, inner: Uint8Array): Buffer => tlv(0xa0 | tagNumber, inner);
/** A context-specific primitive (IMPLICIT) tag on raw content. */
export const implicitPrimitive = (tagNumber: number, content: Uint8Array): Buffer => tlv(0x80 | tagNumber, content);

/** INTEGER from an unsigned big-endian magnitude, in the shortest two's-complement form. */
export function unsignedInteger(magnitude: Uint8Array): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const trimmed = Buffer.from(magnitude.subarray(start));
  return tlv(TAG.integer, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  if (arcs.length < 2 || arcs.some((a) => !Number.isSafeInteger(a) || a < 0)) throw new DerError(`invalid OID ${dotted}`);
  const body: number[] = [];
  const push = (arc: number): void => {
    const groups: number[] = [arc & 0x7f];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128)) groups.unshift(0x80 | (n & 0x7f));
    body.push(...groups);
  };
  push(arcs[0]! * 40 + arcs[1]!);
  for (const arc of arcs.slice(2)) push(arc);
  return tlv(TAG.oid, Buffer.from(body));
}

export const bitString = (bytes: Uint8Array, unusedBits = 0): Buffer => tlv(TAG.bitString, Buffer.concat([Buffer.from([unusedBits]), bytes]));

/** RFC 5280 Section 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050; seconds, Z. */
export function time(ms: number): Buffer {
  const iso = new Date(Math.floor(ms / 1000) * 1000).toISOString(); // YYYY-MM-DDTHH:MM:SS.000Z
  const digits = iso.slice(0, 19).replace(/[-T:]/g, "");
  const year = Number(iso.slice(0, 4));
  return year < 2050 ? tlv(TAG.utcTime, Buffer.from(`${digits.slice(2)}Z`, "ascii")) : tlv(TAG.generalizedTime, Buffer.from(`${digits}Z`, "ascii"));
}

/** RFC 5280 Section 4.1.2.5: notAfter of a certificate without a well-defined expiration date. */
export const NO_EXPIRY = tlv(TAG.generalizedTime, Buffer.from("99991231235959Z", "ascii"));

// ── Decoding ──

export interface DerNode {
  readonly tag: number;
  /** The whole element: tag, length and content. */
  readonly bytes: Buffer;
  readonly content: Buffer;
}

/** Decodes the element at `offset`. `exact`: the element must fill the buffer. */
export function decode(buffer: Buffer, offset = 0, exact = true): DerNode {
  if (offset + 2 > buffer.length) throw new DerError("DER: truncated element");
  const tag = buffer[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("DER: multi-byte tags are not supported");
  let length = buffer[offset + 1]!;
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new DerError("DER: indefinite or oversized length");
    if (offset + 2 + count > buffer.length) throw new DerError("DER: truncated length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buffer[offset + 2 + i]!;
    if (length < 0x80 || buffer[offset + 2] === 0) throw new DerError("DER: length not in its shortest form");
    header += count;
  }
  const end = offset + header + length;
  if (end > buffer.length) throw new DerError("DER: truncated content");
  if (exact && (offset !== 0 || end !== buffer.length)) throw new DerError("DER: trailing bytes");
  return { tag, bytes: buffer.subarray(offset, end), content: buffer.subarray(offset + header, end) };
}

/** The elements of a constructed element's content. */
export function children(node: DerNode): DerNode[] {
  if ((node.tag & 0x20) === 0) throw new DerError("DER: not a constructed element");
  const out: DerNode[] = [];
  for (let offset = 0; offset < node.content.length; ) {
    const child = decode(node.content, offset, false);
    out.push(child);
    offset += child.bytes.length;
  }
  return out;
}

export function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (node === undefined || node.tag !== tag) throw new DerError(`DER: ${what} is missing or has the wrong type`);
  return node;
}

export function decodeOid(node: DerNode): string {
  expectTag(node, TAG.oid, "an object identifier");
  const arcs: number[] = [];
  let value = 0;
  for (const byte of node.content) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  if (arcs.length === 0) throw new DerError("DER: empty object identifier");
  const first = arcs[0]!;
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...arcs.slice(1)].join(".");
}

/** BIT STRING content without unused bits. */
export function bitStringBytes(node: DerNode): Buffer {
  expectTag(node, TAG.bitString, "a bit string");
  if (node.content.length === 0 || node.content[0] !== 0) throw new DerError("DER: the bit string has unused bits");
  return node.content.subarray(1);
}

/** ECDSA-Sig-Value (RFC 3279 Section 2.2.3) from the JWS form r || s (32 bytes each). */
export function ecdsaSignatureDer(p1363: Uint8Array): Buffer {
  if (p1363.length !== 64) throw new DerError("an ES256 signature is 64 bytes");
  return sequence(unsignedInteger(p1363.subarray(0, 32)), unsignedInteger(p1363.subarray(32)));
}
