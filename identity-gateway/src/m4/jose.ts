// JOSE for the M4 services, with node:crypto only:
// - base64url without padding (RFC 4648 Section 5, as RFC 7515 Section 2 uses it), decoded strictly;
// - JWS Compact Serialization (RFC 7515 Sections 3.1, 5.2 and 7.1);
// - JWK thumbprints (RFC 7638 Section 3; OKP members per RFC 8037 Section 2);
// - the accepted algorithms: EdDSA with Ed25519 (RFC 8037 Section 3.1), its fully specified name
//   Ed25519 (RFC 9864 Section 2.2, which deprecates EdDSA), and ES256 (RFC 7518 Section 3.4).

import { ECDH, createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

export class JoseError extends Error {}

/** A key type that the gateway verifies: Ed25519, or P-256 (compressed points in records). */
export type KeyKind = "Ed25519" | "P256";

/** Longest JWS that the gateway parses. */
export const MAX_JWS_LENGTH = 16_384;

const B64URL = /^[A-Za-z0-9_-]*$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function b64url(data: Uint8Array | string): string {
  return (typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)).toString("base64url");
}

/** Strict base64url: the alphabet of RFC 4648 Section 5, no padding, and the canonical encoding of its bytes. */
export function fromB64url(text: string, what: string): Buffer {
  if (!B64URL.test(text) || text.length % 4 === 1) throw new JoseError(`${what} is not base64url`);
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) throw new JoseError(`${what} is not canonical base64url`);
  return bytes;
}

function jsonObject(bytes: Buffer, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new JoseError(`${what} is not UTF-8 JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new JoseError(`${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

export interface Jws {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  /** ASCII(BASE64URL(header) || "." || BASE64URL(payload)). */
  readonly signingInput: Buffer;
  readonly signature: Buffer;
}

export const has = (object: Record<string, unknown>, name: string): boolean => Object.prototype.hasOwnProperty.call(object, name);

/**
 * Parses a JWS in compact serialisation whose payload is a JSON object (a JWT claims set). A header
 * with `crit` or `b64` is refused: the gateway understands no JWS extension (RFC 7515 Section
 * 4.1.11, RFC 7797 Section 6).
 */
export function parseJws(compact: unknown): Jws {
  if (typeof compact !== "string" || compact.length === 0) throw new JoseError("the token is missing");
  if (compact.length > MAX_JWS_LENGTH) throw new JoseError("the token is too long");
  const parts = compact.split(".");
  if (parts.length !== 3) throw new JoseError("the token is not a JWS in compact serialisation");
  const [h, p, s] = parts as [string, string, string];
  const header = jsonObject(fromB64url(h, "the JWS header"), "the JWS header");
  if (has(header, "crit") || has(header, "b64")) throw new JoseError("the JWS header names an extension that the gateway does not support");
  const payload = jsonObject(fromB64url(p, "the JWS payload"), "the JWS payload");
  const signature = fromB64url(s, "the JWS signature");
  return { header, payload, signingInput: Buffer.from(`${h}.${p}`, "ascii"), signature };
}

/** The key type of a JWS `alg` value; null for any algorithm that the gateway does not accept. */
export function algKeyKind(alg: unknown): KeyKind | null {
  if (alg === "EdDSA" || alg === "Ed25519") return "Ed25519";
  if (alg === "ES256") return "P256";
  return null;
}

/** Verifies the JWS signature with a key of the given type. Never throws. */
export function verifyJws(jws: Jws, kind: KeyKind, key: KeyObject): boolean {
  if (jws.signature.length !== 64) return false;
  try {
    return kind === "Ed25519"
      ? verify(null, jws.signingInput, key, jws.signature)
      : verify("sha256", jws.signingInput, { key, dsaEncoding: "ieee-p1363" }, jws.signature);
  } catch {
    return false;
  }
}

export interface Signer {
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** A JWS in compact serialisation over the JSON of `payload`. */
export async function signJws(header: Record<string, unknown>, payload: unknown, signer: Signer): Promise<string> {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(await signer.sign(Buffer.from(signingInput, "ascii")))}`;
}

/** The public members of an accepted JWK. */
export type PublicJwk = { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string } | { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string };

export interface JwkKey {
  readonly jwk: PublicJwk;
  readonly kind: KeyKind;
  readonly key: KeyObject;
  /** The key bytes as a record stores them, hex: 32 bytes (Ed25519) or the compressed point (P-256). */
  readonly publicKey: string;
}

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];

/** A public Ed25519 (OKP) or P-256 (EC) JWK. Refuses other key types and any private key member. */
export function publicJwkKey(value: unknown): JwkKey {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new JoseError("the JWK is not a JSON object");
  const jwk = value as Record<string, unknown>;
  if (PRIVATE_MEMBERS.some((m) => has(jwk, m))) throw new JoseError("the JWK contains private key material");
  const coordinate = (name: "x" | "y"): string => {
    const text = jwk[name];
    if (typeof text !== "string" || fromB64url(text, `the JWK member ${name}`).length !== 32) throw new JoseError(`the JWK member ${name} is not 32 bytes`);
    return text;
  };
  let members: PublicJwk;
  let kind: KeyKind;
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    members = { kty: "OKP", crv: "Ed25519", x: coordinate("x") };
    kind = "Ed25519";
  } else if (jwk.kty === "EC" && jwk.crv === "P-256") {
    members = { kty: "EC", crv: "P-256", x: coordinate("x"), y: coordinate("y") };
    kind = "P256";
  } else {
    throw new JoseError("the JWK is not an Ed25519 (OKP) or P-256 (EC) public key");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: { ...members }, format: "jwk" });
  } catch {
    throw new JoseError("the JWK is not a valid public key");
  }
  const x = Buffer.from(members.x, "base64url");
  const publicKey =
    members.kty === "OKP" ? x.toString("hex") : Buffer.concat([Buffer.from([Buffer.from(members.y, "base64url")[31]! & 1 ? 0x03 : 0x02]), x]).toString("hex");
  return { jwk: members, kind, key, publicKey };
}

/** RFC 7638 SHA-256 JWK thumbprint, base64url: the required members in lexicographic order. */
export function jwkThumbprint(jwk: PublicJwk): string {
  const json = jwk.kty === "OKP" ? `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}` : `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash("sha256").update(json).digest("base64url");
}

/** The public key object of a record key: Ed25519 (32 bytes) or P-256 (33-byte compressed point), hex. */
export function recordKeyObject(kind: KeyKind, publicKeyHex: string): KeyObject {
  const bytes = Buffer.from(publicKeyHex, "hex");
  if (kind === "Ed25519") {
    if (bytes.length !== 32) throw new JoseError("an Ed25519 key is 32 bytes");
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" });
  }
  if (bytes.length !== 33) throw new JoseError("a P-256 record key is a 33-byte compressed point");
  const point = ECDH.convertKey(bytes, "prime256v1", undefined, undefined, "uncompressed") as Buffer;
  return createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
}
