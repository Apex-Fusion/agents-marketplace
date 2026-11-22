/**
 * receipt-build-sign-verify.test.ts — packages/shared/src/receipt/ (build, sign, verify)
 *
 * Covers:
 *   A. buildReceipt()      — one refusal for each check, and the two forms of the escrow_ref index
 *   B. verifyReceipt()     — a signature from signReceipt() passes; a changed receipt or signature fails
 *   C. receiptResultHash() — depends on the receipt and on the signature
 *
 * The 9-field receipt (agent_did), the exact form of the result hash and verifyEscrowReceipt()
 * are in receipt-agent-did.test.ts.
 */

import { describe, it, expect } from "vitest";
import { buildReceipt, type BuildReceiptParams } from "../../packages/shared/src/receipt/build.js";
import { signReceipt, receiptResultHash, type SignedReceipt } from "../../packages/shared/src/receipt/sign.js";
import { verifyReceipt } from "../../packages/shared/src/receipt/verify.js";
import {
  SUPPLIER_PRIVATE_KEY_HEX,
  SUPPLIER_PUB_KEY_HEX,
  SUPPLIER_PKH,
} from "../fixtures/supplier-side/wallet-keys.js";

// ─── Fixture data ──────────────────────────────────────────────────────────

const VALID_PROMPT_HASH = "a".repeat(64);
const VALID_RESPONSE_HASH = "b".repeat(64);
const VALID_ESCROW_TX_HASH = "f".repeat(64);
const VALID_ESCROW_REF = `${VALID_ESCROW_TX_HASH}#0`;
const VALID_MODEL = "qwen2.5:0.5b";

function validReceiptParams(): BuildReceiptParams {
  return {
    prompt_hash: VALID_PROMPT_HASH,
    response_hash: VALID_RESPONSE_HASH,
    model: VALID_MODEL,
    prompt_tokens: 12,
    completion_tokens: 48,
    wallclock_ms: 3200,
    supplier_pkh: SUPPLIER_PKH,
    escrow_ref: VALID_ESCROW_REF,
  };
}

// ─── A. buildReceipt ────────────────────────────────────────────────────────

describe("buildReceipt()", () => {
  it.each<[string, Partial<BuildReceiptParams>, RegExp]>([
    ["an empty supplier_pkh", { supplier_pkh: "" }, /^buildReceipt: supplier_pkh /],
    ["a prompt_hash shorter than 32 bytes (< 64 hex chars)", { prompt_hash: "a".repeat(60) }, /^buildReceipt: prompt_hash /],
    ["a response_hash that is not hex", { response_hash: "z".repeat(64) }, /^buildReceipt: response_hash /],
    ["an escrow_ref with no hash separator", { escrow_ref: "not-valid-ref" }, /^buildReceipt: escrow_ref /],
  ])("throws on %s", (_case, change, message) => {
    expect(() => buildReceipt({ ...validReceiptParams(), ...change })).toThrow(message);
  });

  it.each([0, 3])("accepts index %i in escrow_ref", (index) => {
    const escrowRef = `${"0".repeat(64)}#${index}`;
    expect(buildReceipt({ ...validReceiptParams(), escrow_ref: escrowRef }).escrow_ref).toBe(escrowRef);
  });
});

// ─── B. verifyReceipt ───────────────────────────────────────────────────────

describe("verifyReceipt()", () => {
  const signed = signReceipt(buildReceipt(validReceiptParams()), SUPPLIER_PRIVATE_KEY_HEX);

  it("returns true for a correctly signed receipt using the matching public key", () => {
    expect(verifyReceipt(signed, SUPPLIER_PUB_KEY_HEX)).toBe(true);
  });

  // The signature covers every field of the receipt in the same way: one text field and one number field.
  it.each<[string, (signed: SignedReceipt) => SignedReceipt]>([
    ["a text field is tampered", (s) => ({ ...s, receipt: { ...s.receipt, response_hash: "0".repeat(64) } })],
    ["a number field is tampered", (s) => ({ ...s, receipt: { ...s.receipt, prompt_tokens: 9999 } })],
    ["the signature is all zeros", (s) => ({ ...s, signature: "0".repeat(128) })],
  ])("returns false when %s", (_case, change) => {
    expect(verifyReceipt(change(signed), SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });
});

// ─── C. receiptResultHash ───────────────────────────────────────────────────

describe("receiptResultHash()", () => {
  it("changes when receipt field changes", () => {
    const r1 = buildReceipt(validReceiptParams());
    const r2 = buildReceipt({ ...validReceiptParams(), wallclock_ms: 9999 });
    const signed1 = signReceipt(r1, SUPPLIER_PRIVATE_KEY_HEX);
    const signed2 = signReceipt(r2, SUPPLIER_PRIVATE_KEY_HEX);
    expect(receiptResultHash(signed1)).not.toBe(receiptResultHash(signed2));
  });

  it("changes when signature changes (different key)", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed1 = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    // Simulate a different key by constructing a different-looking signature
    const altSigned = { receipt: signed1.receipt, signature: "1" + signed1.signature.slice(1) };
    // Hash must differ because canonical({receipt, signature}) includes signature
    expect(receiptResultHash(signed1)).not.toBe(receiptResultHash(altSigned));
  });
});
