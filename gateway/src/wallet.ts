/**
 * gateway/src/wallet.ts — per-user wallet key derivation.
 *
 * Copied from buyer/src/index.ts:24-64 (deriveWalletKey + ed25519 sha512 hook)
 * so the gateway does not have to import the buyer entrypoint (which boots an
 * Express server). genPrivKeyHex mints a fresh custodial wallet at signup.
 */

import { createHash, randomBytes } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import type { WalletKey } from "@marketplace/shared/tx";

// Wire ed25519 sha512 hook (idempotent — same as buyer/src/index.ts + receipt/sign.ts).
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

/** Mint a fresh 32-byte Ed25519 private key as 64-char hex. */
export function genPrivKeyHex(): string {
  return bytesToHex(new Uint8Array(randomBytes(32)));
}

export function deriveWalletKey(privHex: string, networkId: 0 | 1): WalletKey {
  const priv = hexToBytes(privHex);
  const pub = ed.getPublicKey(priv);
  const pubHex = bytesToHex(pub);
  const pkh = blake2b(pub, { dkLen: 28 });
  const pkhHex = bytesToHex(pkh);
  const header = networkId === 0 ? 0x60 : 0x61;
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(pkh, 1);
  const words = bech32.toWords(payload);
  const hrp = networkId === 0 ? "addr_test" : "addr";
  const addr = bech32.encode(hrp, words, 1023);
  return {
    pubKeyHash: pkhHex,
    pubKeyHex: pubHex,
    privateKeyHex: privHex,
    address: addr,
  };
}
