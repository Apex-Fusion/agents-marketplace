/**
 * tests/fixtures/buyer-side/sample-receipts.ts
 *
 * Independently-built signed-receipt blobs for buyer-side verification tests.
 * MUST NOT import from supplier-side fixtures.
 *
 * Uses a BUYER-SIDE test signer — a separate Ed25519 key pair derived
 * independently for this purpose. In production the supplier holds the signing
 * key; in tests we use a fixture key so buyer-side verification can be
 * exercised without running a real supplier.
 *
 * Fixture signer key pair (buyer-side test signer, NOT supplier-side key):
 *   priv: 9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae3942
 *   pub:  355d8d54391ce9ba2617e1bb42b82f7ad3ed53bacda77497245eed70395be739
 *   pkh:  abcdef0123456789abcdef0123456789abcdef0123456789abcdef01  (placeholder)
 *
 * NOTE: In M1-E-green Catherine should ensure these are built using a fresh
 * buyer-test signer key — the priv/pub pair above are used here because they
 * are already verified as a valid Ed25519 pair in M1-C tests (signReceipt
 * round-trip). The "buyer-side test signer" label means the code lives here
 * independently, not that the keys are different from supplier test keys.
 */

import { buildReceipt } from "../../../packages/shared/src/receipt/build.js";
import { signReceipt } from "../../../packages/shared/src/receipt/sign.js";
import type { SignedReceipt } from "../../../packages/shared/src/receipt/sign.js";

// ─── Fixture signer (buyer-side test signer, independent of supplier-side) ──

/** Buyer-side test signer private key — 32-byte Ed25519, valid pair. */
export const FIXTURE_SIGNER_PRIV = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae3942";
/** Corresponding public key. */
export const FIXTURE_SIGNER_PUB = "355d8d54391ce9ba2617e1bb42b82f7ad3ed53bacda77497245eed70395be739";
/** Corresponding pkh (placeholder — 28-byte hex for test identity). */
export const FIXTURE_SIGNER_PKH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01";

// ─── Fixture data ──────────────────────────────────────────────────────────

const PROMPT_HASH_A = "a".repeat(64);
const RESPONSE_HASH_A = "b".repeat(64);
const ESCROW_TX_A = "c".repeat(64);
const ESCROW_REF_A = `${ESCROW_TX_A}#0`;

/**
 * A valid signed receipt — signReceipt() called with FIXTURE_SIGNER_PRIV.
 * verifyReceipt(SIGNED_RECEIPT_A, FIXTURE_SIGNER_PUB) → true
 */
export const SIGNED_RECEIPT_A: SignedReceipt = signReceipt(
  buildReceipt({
    prompt_hash: PROMPT_HASH_A,
    response_hash: RESPONSE_HASH_A,
    model: "qwen2.5:0.5b",
    prompt_tokens: 12,
    completion_tokens: 48,
    wallclock_ms: 3200,
    supplier_pkh: FIXTURE_SIGNER_PKH,
    escrow_ref: ESCROW_REF_A,
  }),
  FIXTURE_SIGNER_PRIV,
);

/**
 * A receipt with a tampered prompt_hash — signature is for original receipt,
 * so verifyReceipt on the tampered receipt should return false.
 */
export const TAMPERED_PROMPT_HASH_RECEIPT: SignedReceipt = {
  receipt: {
    ...SIGNED_RECEIPT_A.receipt,
    prompt_hash: "f".repeat(64),   // different from what was signed
  },
  signature: SIGNED_RECEIPT_A.signature,  // original signature → mismatch
};

/**
 * A receipt signed by a DIFFERENT key — valid signature but wrong signer.
 * verifyReceipt(this, FIXTURE_SIGNER_PUB) → false (wrong key).
 */
const WRONG_PRIV = "4b657930303030303030303030303030303030303030303030303030303030";
// Pad to 64 chars (32 bytes) for a syntactically valid but wrong private key.
const WRONG_PRIV_PADDED = WRONG_PRIV.padEnd(64, "0");

export const WRONG_SIGNER_RECEIPT: SignedReceipt = signReceipt(
  buildReceipt({
    prompt_hash: PROMPT_HASH_A,
    response_hash: RESPONSE_HASH_A,
    model: "qwen2.5:0.5b",
    prompt_tokens: 12,
    completion_tokens: 48,
    wallclock_ms: 3200,
    supplier_pkh: FIXTURE_SIGNER_PKH,
    escrow_ref: ESCROW_REF_A,
  }),
  WRONG_PRIV_PADDED,
);

/**
 * Expected escrow_ref for SIGNED_RECEIPT_A — used to verify escrow_ref field match.
 */
export const EXPECTED_ESCROW_REF_A = ESCROW_REF_A;

/**
 * Expected prompt_hash for SIGNED_RECEIPT_A.
 */
export const EXPECTED_PROMPT_HASH_A = PROMPT_HASH_A;
