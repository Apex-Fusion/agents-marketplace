/**
 * Buyer-side wallet key fixtures — M1-E green
 *
 * Constructs a deterministic test key pair for the BUYER role.
 * Derived INDEPENDENTLY from the spec using a fixed seed.
 * MUST NOT import from supplier-side fixtures or any shared wallet helper.
 *
 * Seed (fixed, documented here for reproducibility):
 *   priv = sha256("buyer-test-seed-m1b") (32 bytes)
 *   pub  = ed.getPublicKey(priv)
 *   pkh  = blake2b224(pub) (28 bytes)
 *   addr = bech32.encode("addr_test", 0x60 || pkh)
 */

import type { WalletKey } from "../../../packages/shared/src/tx/types.js";

/**
 * BUYER_PRIVATE_KEY_HEX — 32-byte Ed25519 private key (test fixture only).
 *
 * SPEC FIX 2026-04-25: previously 31 bytes (62 hex chars) — corrected to a
 * valid 32-byte Ed25519 key derived deterministically from
 * sha256("buyer-test-seed-m1b"). pub/pkh/address were re-derived to maintain
 * the priv → pub → pkh → bech32 chain per ARCHITECTURE.md §9 #7.
 */
export const BUYER_PRIVATE_KEY_HEX =
  "90787d55b2be1ea57e633d5cc85b1dad2e49603bdbc24e40d0928fca8e92f424";

/**
 * BUYER_PUB_KEY_HEX — 32-byte Ed25519 public key corresponding to private key.
 *
 * SPEC FIX 2026-04-25: re-derived from BUYER_PRIVATE_KEY_HEX via
 * @noble/ed25519.getPublicKey().
 */
export const BUYER_PUB_KEY_HEX =
  "6e2902cf80ab89e44701470ce41c044a9bbffe3d8af15af2009cc9c6c805271a";

/**
 * BUYER_PKH — 28-byte blake2b-224(pubKey) as lowercase hex.
 *
 * SPEC FIX 2026-04-25: re-derived from BUYER_PUB_KEY_HEX via
 * blake2b(pub, { dkLen: 28 }).
 */
export const BUYER_PKH = "f79cd20a58306c2277cfced6924befbd0f68c95e2187830d707b20b5";

/**
 * BUYER_ADDRESS_TESTNET — bech32 payment address for the buyer on testnet (networkId=0).
 *
 * SPEC FIX 2026-04-25: canonical CIP-0019 enterprise address derived from
 * BUYER_PKH using `bech32(0x60 || pkh, "addr_test")`.
 */
export const BUYER_ADDRESS_TESTNET =
  "addr_test1vrmee5s2tqcxcgnhel8ddyjta77s76xftcsc0qcdwpajpdgjdd5nn";

/**
 * buyerWalletKey — the full WalletKey for the buyer test identity.
 */
export function buildBuyerWalletKey(): WalletKey {
  return {
    pubKeyHash: BUYER_PKH,
    pubKeyHex: BUYER_PUB_KEY_HEX,
    privateKeyHex: BUYER_PRIVATE_KEY_HEX,
    address: BUYER_ADDRESS_TESTNET,
  };
}
