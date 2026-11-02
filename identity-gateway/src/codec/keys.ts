// Key material (Part 1 Sections 2, 5 and 8.1): key hashes, Multikey encodings and the P-256 proof
// of possession.

import { blake2b } from "@noble/hashes/blake2b";
import { ECDH, createPublicKey, verify } from "node:crypto";

/** Key hash: blake2b_224 of the public key bytes, 56 lowercase hex characters. */
export function keyHash(publicKeyHex: string): string {
  return Buffer.from(blake2b(Buffer.from(publicKeyHex, "hex"), { dkLen: 28 })).toString("hex");
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Base-58 digits, least significant first.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

/** Multicodec headers: ed25519-pub (0xed) and p256-pub (0x1200), as unsigned varints. */
const MULTICODEC = { Ed25519: [0xed, 0x01], P256: [0x80, 0x24] } as const;
const KEY_LENGTH = { Ed25519: 32, P256: 33 } as const;

/** `publicKeyMultibase`: base58btc (prefix z) of the multicodec header and the key bytes. */
export function multikey(keyType: "Ed25519" | "P256", publicKeyHex: string): string {
  const key = Buffer.from(publicKeyHex, "hex");
  if (key.length !== KEY_LENGTH[keyType]) throw new Error(`a ${keyType} public key is ${KEY_LENGTH[keyType]} bytes`);
  return `z${base58btc(Uint8Array.from([...MULTICODEC[keyType], ...key]))}`;
}

/**
 * The `pop` of a P-256 key: an ES256 signature, r || s (32 bytes each, big-endian), by that key over
 * the UTF-8 string `did:vector:<vector-id>#<key hash>`. Both forms of s verify.
 */
export function p256PopValid(vectorId: string, compressedKeyHex: string, popHex: string | null): boolean {
  if (popHex === null || popHex.length !== 128) return false;
  try {
    // Decompression fails for an x coordinate that is not on the curve.
    const point = ECDH.convertKey(Buffer.from(compressedKeyHex, "hex"), "prime256v1", undefined, undefined, "uncompressed");
    if (typeof point === "string") return false;
    const publicKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
      format: "jwk",
    });
    const message = Buffer.from(`did:vector:${vectorId}#${keyHash(compressedKeyHex)}`, "utf8");
    return verify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(popHex, "hex"));
  } catch {
    return false;
  }
}
