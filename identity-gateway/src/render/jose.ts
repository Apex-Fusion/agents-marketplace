// JOSE helpers for record keys: base64url (RFC 7515 Section 2), public JWKs (RFC 7517; OKP keys
// per RFC 8037, EC keys per RFC 7518 Section 6.2) and signature checks for EdDSA (RFC 8037) and
// ES256 (RFC 7518 Section 3.4: r || s, 64 bytes).

import { ECDH, createPublicKey, verify } from "node:crypto";

export type RecordKeyType = "Ed25519" | "P256";

export interface PublicJwk {
  readonly kty: "OKP" | "EC";
  readonly crv: "Ed25519" | "P-256";
  readonly x: string;
  readonly y?: string;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Strict base64url without padding; null for any other text. */
export function fromBase64url(text: string): Buffer | null {
  return BASE64URL.test(text) && text.length % 4 !== 1 ? Buffer.from(text, "base64url") : null;
}

/** The public JWK of a record key: 32 bytes for Ed25519, the 33-byte compressed point for P-256. */
export function publicJwk(keyType: RecordKeyType, keyHex: string): PublicJwk {
  const key = Buffer.from(keyHex, "hex");
  if (keyType === "Ed25519") return { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") };
  const point = ECDH.convertKey(key, "prime256v1", undefined, undefined, "uncompressed") as Buffer;
  return { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") };
}

/** Checks an EdDSA (Ed25519) or ES256 (P-256, r || s) signature over `data`. Never throws. */
export function signatureValid(keyType: RecordKeyType, keyHex: string, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: { ...publicJwk(keyType, keyHex) }, format: "jwk" });
    if (keyType === "Ed25519") return verify(null, data, key, signature);
    return signature.length === 64 && verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}
