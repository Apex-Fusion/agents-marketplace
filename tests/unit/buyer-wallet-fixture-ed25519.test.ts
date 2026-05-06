/**
 * buyer-wallet-fixture-ed25519.test.ts — RED phase (M1-E)
 *
 * Asserts that the buyer-side wallet fixture has a valid 32-byte Ed25519 key pair
 * where BUYER_PUB_KEY_HEX is correctly derived from BUYER_PRIVATE_KEY_HEX.
 *
 * Per ARCHITECTURE.md §9 open follow-up #7:
 *   "Buyer-side wallet fixture has invalid Ed25519 priv (62 hex chars / 31 bytes;
 *    tests/fixtures/buyer-side/wallet-keys.ts:32)."
 *
 * These tests FAIL until Catherine applies the same priv → pub → pkh → bech32
 * derivation she used for the supplier in M1-C and adds "// SPEC FIX 2026-04-25"
 * comments to wallet-keys.ts.
 *
 * NOTE: Do NOT edit wallet-keys.ts in M1-E-red. These tests drive Catherine's fix.
 *
 * We use the signReceipt / verifyReceipt round-trip from @marketplace/shared
 * (which already has @noble/ed25519 wired) rather than importing @noble/ed25519
 * directly (the package is a transitive dep, not a root devDep).
 */

import { describe, it, expect } from "vitest";
import { signReceipt } from "../../packages/shared/src/receipt/sign.js";
import { verifyReceipt } from "../../packages/shared/src/receipt/verify.js";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import {
  BUYER_PRIVATE_KEY_HEX,
  BUYER_PUB_KEY_HEX,
  BUYER_PKH,
  BUYER_ADDRESS_TESTNET,
  buildBuyerWalletKey,
} from "../fixtures/buyer-side/wallet-keys.js";

// A minimal receipt for sign/verify round-trip testing.
function makeTestReceipt(escrowRef: string) {
  return buildReceipt({
    prompt_hash: "a".repeat(64),
    response_hash: "b".repeat(64),
    model: "qwen2.5:0.5b",
    prompt_tokens: 4,
    completion_tokens: 4,
    wallclock_ms: 100,
    supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
    escrow_ref: escrowRef,
  });
}

describe("buyer-side wallet fixture — Ed25519 key derivation validity", () => {
  it("BUYER_PRIVATE_KEY_HEX is exactly 64 hex chars (32 bytes)", () => {
    // This test PASSES even on the unfixed fixture IF the value is already 64 chars.
    // The real RED test below validates the priv → pub derivation.
    expect(BUYER_PRIVATE_KEY_HEX).toHaveLength(64);
    expect(BUYER_PRIVATE_KEY_HEX).toMatch(/^[0-9a-fA-F]{64}$/);
  });

  it("BUYER_PUB_KEY_HEX is exactly 64 hex chars (32 bytes)", () => {
    expect(BUYER_PUB_KEY_HEX).toHaveLength(64);
    expect(BUYER_PUB_KEY_HEX).toMatch(/^[0-9a-fA-F]{64}$/);
  });

  /**
   * RED until Catherine fixes the buyer priv key.
   * The buyer private key (BUYER_PRIVATE_KEY_HEX) is currently 64 hex chars
   * but is NOT a valid Ed25519 key — signReceipt will throw because
   * @noble/ed25519 v2 rejects keys whose scalar is not in the valid range,
   * or because the derived public key won't match BUYER_PUB_KEY_HEX.
   *
   * Fix: derive a real Ed25519 key pair using:
   *   priv = sha256("buyer-test-seed-m1b") padded to 32 bytes
   *   pub  = ed.getPublicKey(priv)
   * then update BUYER_PRIVATE_KEY_HEX, BUYER_PUB_KEY_HEX, BUYER_PKH, BUYER_ADDRESS_TESTNET
   * with "// SPEC FIX 2026-04-25" comments.
   */
  it("BUYER_PUB_KEY_HEX corresponds to BUYER_PRIVATE_KEY_HEX (sign/verify round-trip)", () => {
    const escrowRef = "c".repeat(64) + "#0";
    const receipt = makeTestReceipt(escrowRef);
    // signReceipt uses BUYER_PRIVATE_KEY_HEX to sign
    const signed = signReceipt(receipt, BUYER_PRIVATE_KEY_HEX);
    // verifyReceipt uses BUYER_PUB_KEY_HEX — must return true iff priv → pub is valid
    const valid = verifyReceipt(signed, BUYER_PUB_KEY_HEX);
    expect(valid).toBe(true);
  });

  it("BUYER_PKH is 56 hex chars (28 bytes)", () => {
    expect(BUYER_PKH).toHaveLength(56);
    expect(BUYER_PKH).toMatch(/^[0-9a-fA-F]{56}$/);
  });

  it("BUYER_ADDRESS_TESTNET starts with addr_test1", () => {
    expect(BUYER_ADDRESS_TESTNET).toMatch(/^addr_test1/);
  });

  it("buildBuyerWalletKey() returns a WalletKey with all four required fields", () => {
    const key = buildBuyerWalletKey();
    expect(key).toHaveProperty("pubKeyHash");
    expect(key).toHaveProperty("pubKeyHex");
    expect(key).toHaveProperty("privateKeyHex");
    expect(key).toHaveProperty("address");
  });

  it("buyer WalletKey sign/verify round-trip via signReceipt/verifyReceipt", () => {
    const key = buildBuyerWalletKey();
    const escrowRef = "d".repeat(64) + "#0";
    const receipt = makeTestReceipt(escrowRef);
    const signed = signReceipt(receipt, key.privateKeyHex);
    // Must pass iff pubKeyHex is derived from privateKeyHex
    expect(verifyReceipt(signed, key.pubKeyHex)).toBe(true);
  });
});
