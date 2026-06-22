/**
 * gateway/src/crypto/seal.ts — AES-256-GCM sealing for custodial private keys.
 *
 * Each user's wallet private key (64-char hex) is encrypted at rest with the
 * GATEWAY_MASTER_KEY (32 bytes). A fresh 12-byte nonce per row; the 16-byte GCM
 * auth tag is stored alongside. Plaintext is produced only in-memory at request
 * time (open()) and never persisted or logged.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export interface Sealed {
  /** 12-byte GCM nonce, hex. */
  nonce: string;
  /** ciphertext, hex. */
  ct: string;
  /** 16-byte GCM auth tag, hex. */
  tag: string;
}

function masterKeyBuffer(masterKeyHex: string): Buffer {
  const buf = Buffer.from(masterKeyHex, "hex");
  if (buf.length !== 32) {
    throw new Error("seal: master key must decode to exactly 32 bytes");
  }
  return buf;
}

/** Encrypt `plaintext` (e.g. a wallet privKey hex) under the master key. */
export function seal(plaintext: string, masterKeyHex: string): Sealed {
  const key = masterKeyBuffer(masterKeyHex);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce: nonce.toString("hex"), ct: ct.toString("hex"), tag: tag.toString("hex") };
}

/** Decrypt a Sealed blob under the master key. Throws on tamper / wrong key. */
export function open(sealed: Sealed, masterKeyHex: string): string {
  const key = masterKeyBuffer(masterKeyHex);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "hex"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "hex")), decipher.final()]);
  return pt.toString("utf8");
}
