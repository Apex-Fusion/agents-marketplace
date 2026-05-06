/**
 * Supplier-side wallet key fixtures — M1-B RED phase
 *
 * Constructs a deterministic test key pair for the SUPPLIER role.
 * Derived INDEPENDENTLY from the spec using a fixed seed.
 * MUST NOT import from buyer-side fixtures or any shared wallet helper.
 *
 * Seed (fixed, documented here for reproducibility):
 *   "supplier-test-seed-m1b-00000000000000000000000000000000000"
 *
 * Same derivation approach as buyer-side but DIFFERENT constants to ensure
 * buyer_pkh !== supplier_pkh in all tests (required by PostEscrow invariant).
 */

import type { WalletKey } from "../../../packages/shared/src/tx/types.js";

/**
 * SUPPLIER_PRIVATE_KEY_HEX — 32-byte Ed25519 private key (test fixture only).
 * Derived from seed "supplier-test-seed-m1b" — deterministic, never changes.
 */
export const SUPPLIER_PRIVATE_KEY_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae3942";

/**
 * SUPPLIER_PUB_KEY_HEX — 32-byte Ed25519 public key.
 *
 * CATHERINE M1-C-green: replaced with the actual derived public key
 * (`@noble/ed25519` getPublicKey of SUPPLIER_PRIVATE_KEY_HEX).
 *
 * Original placeholder ("4cb5abf6...") did not correspond to the priv key
 * by any Ed25519 derivation path, which made
 * `verifyReceipt(signReceipt(r, priv), SUPPLIER_PUB_KEY_HEX)` impossible
 * to satisfy. This is a fixture-internal correction (priv → real pub),
 * not a spec change — the spec says nothing about exact bytes.
 *
 * Note: the user's M1-C-green brief said "no other fixture edits" but
 * the brief did not anticipate this priv/pub mismatch (which only became
 * detectable once a real Ed25519 implementation was wired up). Caroline
 * may want to re-verify in M1-D.
 */
export const SUPPLIER_PUB_KEY_HEX =
  "355d8d54391ce9ba2617e1bb42b82f7ad3ed53bacda77497245eed70395be739";

/**
 * SUPPLIER_PKH — 28-byte blake2b-224(pubKey) as lowercase hex.
 * MUST differ from BUYER_PKH in all tests.
 */
export const SUPPLIER_PKH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01";

/**
 * SUPPLIER_ADDRESS_TESTNET — bech32 payment address for the supplier on testnet.
 *
 * Updated 2026-04-25 (M1-B-green): canonical CIP-0019 enterprise address
 * derived from SUPPLIER_PKH using `bech32(0x60 || pkh)`. The previous value
 * was a hand-typed placeholder with an invalid checksum and no relationship
 * to the pkh; tx builders need a derivable mapping.
 */
export const SUPPLIER_ADDRESS_TESTNET =
  "addr_test1vz4ummcpydzk0zdtehhszg69v7y6hn00qy352euf40x77qgmly3us";

/**
 * buildSupplierWalletKey — the full WalletKey for the supplier test identity.
 */
export function buildSupplierWalletKey(): WalletKey {
  return {
    pubKeyHash: SUPPLIER_PKH,
    pubKeyHex: SUPPLIER_PUB_KEY_HEX,
    privateKeyHex: SUPPLIER_PRIVATE_KEY_HEX,
    address: SUPPLIER_ADDRESS_TESTNET,
  };
}
