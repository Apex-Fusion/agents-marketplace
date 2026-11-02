/**
 * The attestation envelope of Part 2 §4.2: a COSE_Sign1 signature with
 * Ed25519 over the SHA-256 digest of an attestation document.
 *
 * Standards (current versions):
 * - COSE structures and `Sig_structure`: RFC 9052, Section 4.4
 *   (https://www.rfc-editor.org/rfc/rfc9052#section-4.4).
 * - Algorithm -19 (Ed25519): RFC 9864, Section 4.2.1
 *   (https://www.rfc-editor.org/rfc/rfc9864#section-4.2.1).
 * - Header 15 (CWT Claims; iss 1, sub 2, iat 6): RFC 9597, Section 2
 *   (https://www.rfc-editor.org/rfc/rfc9597#section-2), claim keys of RFC 8392.
 * - Headers 258 (payload hash algorithm) and 259 (preimage content type): RFC
 *   9995, Section 3 (https://www.rfc-editor.org/rfc/rfc9995#section-3);
 *   -16 is SHA-256 (RFC 9054, Section 2.1).
 * - Core deterministic encoding of the protected header: RFC 8949, Section
 *   4.2.1 (https://www.rfc-editor.org/rfc/rfc8949#section-4.2.1).
 * - did:key of an Ed25519 key: The did:key Method v0.9, Section 3.1
 *   (https://w3c-ccg.github.io/did-key-spec/); the key URL repeats the
 *   multibase value as fragment.
 */
import { createHash, sign, type KeyObject } from "node:crypto";
import { keyHash, vectorDid } from "@marketplace/shared/identity";
import { multikey } from "../../identity-gateway/src/codec/keys.js";
import * as cbor from "../legacy-registry/harness/cbor.js";

/** The attestation fields that the envelope binds (Part 2 §4). Hex strings are lowercase. */
export interface EnvelopeInput {
  /** Ed25519 public key of the issuer, 32 bytes. */
  readonly issuer: string;
  /** Identifier of the issuer's record, or null for an unregistered issuer. */
  readonly issuerId: string | null;
  /** Identifier of the subject agent. */
  readonly subject: string;
  /** POSIX milliseconds. */
  readonly issuedAt: number;
  /** CoAP Content-Format of the document, or null. */
  readonly format: number | null;
  /** SHA-256 of the document, 32 bytes. */
  readonly digest: string;
}

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** `did:vector:<issuer_id>`, or the did:key of `issuer` when there is no `issuer_id`. */
export function issuerDid(input: EnvelopeInput): string {
  return input.issuerId === null ? `did:key:${multikey("Ed25519", input.issuer)}` : vectorDid(input.issuerId);
}

/** `<issuer DID>#<key hash of issuer>`, or the did:key URL. */
export function keyUrl(input: EnvelopeInput): string {
  return input.issuerId === null ? `${issuerDid(input)}#${multikey("Ed25519", input.issuer)}` : `${issuerDid(input)}#${keyHash(input.issuer)}`;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** A map in RFC 8949 core deterministic encoding: keys sorted by their encoded bytes. */
function deterministicMap(entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>): Uint8Array {
  return cbor.map([...entries].sort((a, b) => compareBytes(a[0], b[0])));
}

/** The CWT claims of header 15: iss, sub and iat (whole seconds, rounded down). */
const claimsOf = (input: EnvelopeInput): ReadonlyArray<readonly [number, string | number]> => [
  [1, issuerDid(input)],
  [2, vectorDid(input.subject)],
  [6, Math.floor(input.issuedAt / 1000)],
];

/** The protected header of §4.2, encoded. */
export function protectedHeader(input: EnvelopeInput): Uint8Array {
  const claims = deterministicMap(
    claimsOf(input).map(([label, value]) => [cbor.uint(label), typeof value === "string" ? cbor.text(value) : cbor.uint(value)] as const),
  );
  const entries: Array<readonly [Uint8Array, Uint8Array]> = [
    [cbor.uint(1), cbor.int(-19)],
    [cbor.uint(4), cbor.bytes(new TextEncoder().encode(keyUrl(input)))],
    [cbor.uint(15), claims],
    [cbor.uint(258), cbor.int(-16)],
  ];
  if (input.format !== null) entries.push([cbor.uint(259), cbor.uint(input.format)]);
  return deterministicMap(entries);
}

/** `Sig_structure = ["Signature1", protected, h'', digest]` (RFC 9052, Section 4.4), encoded. */
export function sigStructure(input: EnvelopeInput): Uint8Array {
  return cbor.array([cbor.text("Signature1"), cbor.bytes(protectedHeader(input)), cbor.bytes(new Uint8Array()), cbor.bytes(Buffer.from(input.digest, "hex"))]);
}

/** `envelope_sig`: the Ed25519 signature (RFC 8032) of the encoded `Sig_structure`. */
export const envelopeSignature = (input: EnvelopeInput, privateKey: KeyObject): Uint8Array =>
  Uint8Array.from(sign(null, sigStructure(input), privateKey));

/** The COSE_Sign1 message (tag 18) with an empty unprotected header and the digest as payload. */
export function coseSign1(input: EnvelopeInput, signature: Uint8Array): Uint8Array {
  return cbor.tag(18, cbor.array([cbor.bytes(protectedHeader(input)), cbor.map([]), cbor.bytes(Buffer.from(input.digest, "hex")), cbor.bytes(signature)]));
}

/** Extended diagnostic notation (RFC 8610, Appendix G) of the protected header. */
export function protectedHeaderDiagnostic(input: EnvelopeInput): string {
  const claims = claimsOf(input)
    .map(([label, value]) => `${label}: ${typeof value === "string" ? JSON.stringify(value) : value}`)
    .join(", ");
  const kid = Buffer.from(keyUrl(input), "utf8").toString("hex");
  const format = input.format === null ? "" : `, 259: ${input.format}`;
  return `{1: -19, 4: h'${kid}', 15: {${claims}}, 258: -16${format}}`;
}

/** Extended diagnostic notation of the `Sig_structure`. */
export const sigStructureDiagnostic = (input: EnvelopeInput): string =>
  `["Signature1", h'${Buffer.from(protectedHeader(input)).toString("hex")}', h'', h'${input.digest}']`;
