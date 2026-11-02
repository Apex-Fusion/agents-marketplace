// X.509 for the SPIFFE service (Part 2 Section 8.6): certification requests (PKCS #10, RFC 2986),
// the trust domain's signing certificate and X.509-SVIDs (RFC 5280; SPIFFE X509-SVID standard,
// https://github.com/spiffe/spiffe/blob/main/standards/X509-SVID.md). Both certificates are signed
// with ECDSA P-256 / SHA-256 (RFC 5758 Section 3.2) by the gateway's P-256 key.
// - Signing certificate: self-signed, cA = true, keyCertSign only, URI SAN `spiffe://<trust domain>`
//   (X509-SVID Sections 3.2, 4.1 and 4.3), no fixed expiry (RFC 5280 Section 4.1.2.5).
// - X.509-SVID: P-256 key from the request; empty subject and exactly one URI SAN, marked critical
//   (X509-SVID Sections 2 and 3.1); cA = false; digitalSignature only; serverAuth and clientAuth
//   (X509-SVID Section 4.4); lifetime at most 1 hour; `noRevAvail` (RFC 9608 Section 2: OID
//   2.5.29.56, NULL, not critical), so no CRL or OCSP pointers.

import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import type { GatewayKey } from "../keys/gateway-keys.js";
import {
  DerError,
  NO_EXPIRY,
  TAG,
  bitString,
  bitStringBytes,
  boolean,
  children,
  decode,
  decodeOid,
  derNull,
  ecdsaSignatureDer,
  expectTag,
  explicit,
  implicitPrimitive,
  octetString,
  oid,
  sequence,
  set,
  time,
  unsignedInteger,
  utf8String,
} from "./der.js";

export class CsrError extends Error {}

const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  prime256v1: "1.2.840.10045.3.1.7",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  organizationName: "2.5.4.10",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  noRevAvail: "2.5.29.56",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

/** AlgorithmIdentifier ecdsa-with-SHA256, parameters absent (RFC 5758 Section 3.2). */
const ECDSA_SHA256 = sequence(oid(OID.ecdsaWithSha256));

export interface CertificationRequest {
  /** DER SubjectPublicKeyInfo of the requested key. */
  readonly spki: Buffer;
  readonly publicKey: KeyObject;
  /** The requested key as a public JWK. */
  readonly jwk: { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string };
}

/**
 * Parses a PKCS #10 request (RFC 2986 Section 4) for a P-256 key and checks its signature
 * (ecdsa-with-SHA256 by the requested key). The subject and the attributes are not used: the
 * gateway sets every name of the certificate itself.
 */
export function parseCertificationRequest(der: Buffer): CertificationRequest {
  try {
    const request = expectTag(decode(der), TAG.sequence, "CertificationRequest");
    const [info, algorithm, signature, extra] = children(request);
    if (extra !== undefined) throw new CsrError("the request has extra fields");
    const fields = children(expectTag(info, TAG.sequence, "certificationRequestInfo"));
    const version = expectTag(fields[0], TAG.integer, "version");
    if (version.content.length !== 1 || version.content[0] !== 0) throw new CsrError("the request version is not v1 (0)");
    expectTag(fields[1], TAG.sequence, "subject");
    const spki = expectTag(fields[2], TAG.sequence, "subjectPKInfo");
    if (fields[3]?.tag !== 0xa0 || fields.length !== 4) throw new CsrError("the request attributes are missing or malformed");
    const [keyAlgorithm] = children(spki);
    const [keyOid, curveOid, ...more] = children(expectTag(keyAlgorithm, TAG.sequence, "the key algorithm"));
    if (decodeOid(keyOid!) !== OID.ecPublicKey || curveOid === undefined || decodeOid(curveOid) !== OID.prime256v1 || more.length > 0) {
      throw new CsrError("the requested key is not a P-256 key");
    }
    const [signatureOid, ...parameters] = children(expectTag(algorithm, TAG.sequence, "signatureAlgorithm"));
    if (decodeOid(signatureOid!) !== OID.ecdsaWithSha256 || parameters.length > 0) throw new CsrError("the request is not signed with ecdsa-with-SHA256");
    const publicKey = createPublicKey({ key: spki.bytes, format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new CsrError("the requested key is not a P-256 key");
    const signed = verify("sha256", info!.bytes, { key: publicKey, dsaEncoding: "der" }, bitStringBytes(expectTag(signature, TAG.bitString, "signature")));
    if (!signed) throw new CsrError("the request signature does not verify");
    const jwk = publicKey.export({ format: "jwk" });
    return { spki: Buffer.from(spki.bytes), publicKey, jwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } };
  } catch (e) {
    if (e instanceof CsrError) throw e;
    throw new CsrError(e instanceof DerError ? `the request is not valid DER: ${e.message}` : "the request is not a valid PKCS #10 request");
  }
}

/** RFC 5280 Section 4.2.1.2, method 1: SHA-1 of the subjectPublicKey bits. */
function keyIdentifier(spki: Buffer): Buffer {
  const [, key] = children(decode(spki));
  return createHash("sha1").update(bitStringBytes(key!)).digest();
}

const extension = (id: string, critical: boolean, value: Buffer): Buffer => sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));

/** Name with one organizationName attribute. */
const organisationName = (organisation: string): Buffer => sequence(set(sequence(oid(OID.organizationName), utf8String(organisation))));

async function signCertificate(tbs: Buffer, key: GatewayKey): Promise<Buffer> {
  return sequence(tbs, ECDSA_SHA256, bitString(ecdsaSignatureDer(await key.sign(tbs))));
}

export interface SigningCertificate {
  /** DER certificate. */
  readonly der: Buffer;
  readonly subject: Buffer;
  readonly keyId: Buffer;
}

/**
 * The trust domain's signing certificate for the gateway's P-256 key. Its content depends only on
 * the key, the trust domain and `notBeforeMs`; ECDSA makes its signature differ on each build.
 */
export async function signingCertificate(key: GatewayKey, trustDomain: string, notBeforeMs: number): Promise<SigningCertificate> {
  const spki = Buffer.from(key.spki);
  const keyId = keyIdentifier(spki);
  const subject = organisationName(trustDomain);
  const serial = createHash("sha256").update(spki).digest().subarray(0, 16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = sequence(
    explicit(0, unsignedInteger(Uint8Array.of(2))),
    unsignedInteger(serial),
    ECDSA_SHA256,
    subject,
    sequence(time(notBeforeMs), NO_EXPIRY),
    subject,
    spki,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence(boolean(true), unsignedInteger(Uint8Array.of(0)))),
        // keyCertSign (bit 5): one byte 0b00000100, the 2 trailing zero bits unused.
        extension(OID.keyUsage, true, bitString(Uint8Array.of(0x04), 2)),
        extension(OID.subjectKeyIdentifier, false, octetString(keyId)),
        extension(OID.subjectAltName, false, sequence(implicitPrimitive(6, Buffer.from(`spiffe://${trustDomain}`, "ascii")))),
      ),
    ),
  );
  return { der: await signCertificate(tbs, key), subject, keyId };
}

export interface SvidRequest {
  readonly spki: Buffer;
  readonly spiffeId: string;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

/** An X.509-SVID signed by the gateway's P-256 key under `issuer`. */
export async function x509Svid(key: GatewayKey, issuer: SigningCertificate, request: SvidRequest): Promise<Buffer> {
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = sequence(
    explicit(0, unsignedInteger(Uint8Array.of(2))),
    unsignedInteger(serial),
    ECDSA_SHA256,
    issuer.subject,
    sequence(time(request.notBeforeMs), time(request.notAfterMs)),
    sequence(),
    request.spki,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence()),
        // digitalSignature (bit 0): one byte 0b10000000, the 7 trailing zero bits unused.
        extension(OID.keyUsage, true, bitString(Uint8Array.of(0x80), 7)),
        extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth), oid(OID.clientAuth))),
        extension(OID.subjectAltName, true, sequence(implicitPrimitive(6, Buffer.from(request.spiffeId, "ascii")))),
        extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(request.spki))),
        extension(OID.authorityKeyIdentifier, false, sequence(implicitPrimitive(0, issuer.keyId))),
        extension(OID.noRevAvail, false, derNull()),
      ),
    ),
  );
  return signCertificate(tbs, key);
}

/** PEM text of DER bytes (RFC 7468 Section 2). */
export function pem(label: string, der: Uint8Array): string {
  const lines = Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** DER bytes of a PEM block with one of `labels`, or of base64url text; null for anything else. */
export function derFromText(text: string, labels: readonly string[]): Buffer | null {
  const trimmed = text.trim();
  const block = /^-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END \1-----$/.exec(trimmed);
  if (block) return labels.includes(block[1]!) ? Buffer.from(block[2]!.replace(/\s+/g, ""), "base64") : null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return Buffer.from(trimmed, "base64url");
}
