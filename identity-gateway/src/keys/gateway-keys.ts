// The gateway's own keys (Part 2 Section 8.2): one Ed25519 key and one P-256 key, both listed in the
// gateway's record. The Ed25519 key signs agent cards; the P-256 key signs tokens, SVIDs, status
// lists and identity credentials. The private keys are files that only the gateway user can read;
// a file that its group or other users can read or write is refused. There is no fixed rotation.
//
// A key file holds one PEM private key: PKCS#8 ("PRIVATE KEY", RFC 5958) for either key, or SEC1
// ("EC PRIVATE KEY", RFC 5915) for the P-256 key. Public keys are exported as JWKs (RFC 7517; OKP
// members per RFC 8037 Section 2, EC members per RFC 7518 Section 6.2).

import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { keyHash } from "../codec/keys.js";

export type GatewayKeyType = "Ed25519" | "P256";

/** A public key as a JWK with the members of the gateway's JWKS. */
export interface GatewayPublicJwk {
  readonly kty: "OKP" | "EC";
  readonly crv: "Ed25519" | "P-256";
  readonly x: string;
  /** EC keys only. */
  readonly y?: string;
  readonly kid: string;
  readonly alg: "EdDSA" | "ES256";
  readonly use: "sig";
}

export interface GatewayKey {
  readonly keyType: GatewayKeyType;
  /** JWS algorithm: EdDSA (RFC 8037 Section 3.1) or ES256 (RFC 7518 Section 3.4). */
  readonly alg: "EdDSA" | "ES256";
  /** The key's DID URL in the gateway's DID document: `did:vector:<gateway id>#<key hash>`. */
  readonly kid: string;
  /** Public key bytes, hex: 32 bytes (Ed25519) or the 33-byte compressed point (P-256), as in the record. */
  readonly publicKey: string;
  /** blake2b-224 of the public key bytes (Part 1 Section 2): the fragment of the key in the DID document. */
  readonly keyHash: string;
  readonly publicJwk: GatewayPublicJwk;
  /** DER SubjectPublicKeyInfo (RFC 5280 Section 4.1.2.7). */
  readonly spki: Uint8Array;
  /**
   * Signs `data`. Ed25519: the 64-byte signature (RFC 8032). P-256: ECDSA with SHA-256 over `data`,
   * as r || s (32 bytes each, big-endian), the JWS ES256 form.
   */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface GatewayKeys {
  readonly ed25519: GatewayKey;
  readonly p256: GatewayKey;
}

export class KeyFileError extends Error {}

/** Group and other read or write bits. Execute bits do not expose the key. */
const SHARED_ACCESS = 0o066;

/**
 * Reads a PEM private key file. Refuses a file that is not a regular file, or that its group or
 * other users can read or write. Error messages never contain key material.
 */
export function readPrivateKeyFile(path: string): KeyObject {
  let mode: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new KeyFileError(`key file ${path} is not a regular file`);
    mode = stat.mode;
  } catch (e) {
    if (e instanceof KeyFileError) throw e;
    throw new KeyFileError(`key file ${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (mode & SHARED_ACCESS) {
    const octal = (mode & 0o777).toString(8).padStart(3, "0");
    const who = mode & 0o044 ? "readable by its group or by other users" : "writable by its group or by other users";
    throw new KeyFileError(`key file ${path} is ${who} (mode ${octal}); make it readable only by the gateway user, for example chmod 600`);
  }
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (e) {
    throw new KeyFileError(`key file ${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    return createPrivateKey(pem);
  } catch {
    throw new KeyFileError(`key file ${path} does not hold a PEM private key (PKCS#8, or SEC1 for P-256)`);
  }
}

function keyTypeOf(privateKey: KeyObject): GatewayKeyType | null {
  if (privateKey.type !== "private") return null;
  if (privateKey.asymmetricKeyType === "ed25519") return "Ed25519";
  if (privateKey.asymmetricKeyType === "ec" && privateKey.asymmetricKeyDetails?.namedCurve === "prime256v1") return "P256";
  return null;
}

/** A signing key from a private key object. `gatewayId` is the gateway's own identifier (64 hex). */
export function gatewayKey(privateKey: KeyObject, gatewayId: string): GatewayKey {
  if (!/^[0-9a-f]{64}$/.test(gatewayId)) throw new Error("the gateway identifier is 64 lowercase hex characters");
  const keyType = keyTypeOf(privateKey);
  if (keyType === null) throw new KeyFileError("a gateway key is an Ed25519 key or a P-256 key");
  const publicKeyObject = createPublicKey(privateKey);
  const jwk = publicKeyObject.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  let publicKey: string;
  if (keyType === "Ed25519") {
    publicKey = x.toString("hex");
  } else {
    const y = Buffer.from(jwk.y!, "base64url");
    publicKey = Buffer.concat([Buffer.from([y[y.length - 1]! & 1 ? 0x03 : 0x02]), x]).toString("hex");
  }
  const hash = keyHash(publicKey);
  const kid = `did:vector:${gatewayId}#${hash}`;
  const alg = keyType === "Ed25519" ? "EdDSA" : "ES256";
  const publicJwk: GatewayPublicJwk =
    keyType === "Ed25519"
      ? { kty: "OKP", crv: "Ed25519", x: jwk.x!, kid, alg, use: "sig" }
      : { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, kid, alg, use: "sig" };
  const spki = new Uint8Array(publicKeyObject.export({ format: "der", type: "spki" }));
  return {
    keyType,
    alg,
    kid,
    publicKey,
    keyHash: hash,
    publicJwk,
    spki,
    sign: (data) =>
      Promise.resolve(
        new Uint8Array(keyType === "Ed25519" ? sign(null, data, privateKey) : sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" })),
      ),
  };
}

/** Both gateway keys from their files. Each file must hold the key of its type. */
export function loadGatewayKeys(files: { readonly ed25519: string; readonly p256: string }, gatewayId: string): GatewayKeys {
  const ed25519 = readPrivateKeyFile(files.ed25519);
  if (keyTypeOf(ed25519) !== "Ed25519") throw new KeyFileError(`key file ${files.ed25519} does not hold an Ed25519 private key`);
  const p256 = readPrivateKeyFile(files.p256);
  if (keyTypeOf(p256) !== "P256") throw new KeyFileError(`key file ${files.p256} does not hold a P-256 private key`);
  return { ed25519: gatewayKey(ed25519, gatewayId), p256: gatewayKey(p256, gatewayId) };
}
