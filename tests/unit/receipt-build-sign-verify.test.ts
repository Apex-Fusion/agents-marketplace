/**
 * receipt-build-sign-verify.test.ts — RED phase tests for packages/shared/src/receipt/
 *
 * Covers:
 *   A. buildReceipt() — schema, field validation, adversarial inputs
 *   B. signReceipt()  — Ed25519 signature, output shape
 *   C. verifyReceipt() — correct key passes, tampered field fails
 *   D. receiptResultHash() — deterministic sha256(canonical({receipt, signature}))
 *   E. Round-trip: build → sign → verify → hash
 */

import { describe, it, expect } from "vitest";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import { signReceipt, receiptResultHash } from "../../packages/shared/src/receipt/sign.js";
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

function validReceiptParams() {
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
  it("returns a Receipt with all required fields", () => {
    const receipt = buildReceipt(validReceiptParams());
    expect(receipt.prompt_hash).toBe(VALID_PROMPT_HASH);
    expect(receipt.response_hash).toBe(VALID_RESPONSE_HASH);
    expect(receipt.model).toBe(VALID_MODEL);
    expect(receipt.prompt_tokens).toBe(12);
    expect(receipt.completion_tokens).toBe(48);
    expect(receipt.wallclock_ms).toBe(3200);
    expect(receipt.supplier_pkh).toBe(SUPPLIER_PKH);
    expect(receipt.escrow_ref).toBe(VALID_ESCROW_REF);
  });

  it("escrow_ref is formatted as <64-char-hex>#<int>", () => {
    const receipt = buildReceipt(validReceiptParams());
    expect(receipt.escrow_ref).toMatch(/^[0-9a-fA-F]{64}#\d+$/);
  });

  it("throws on empty supplier_pkh", () => {
    expect(() =>
      buildReceipt({ ...validReceiptParams(), supplier_pkh: "" })
    ).toThrow();
  });

  it("throws on response_hash shorter than 32 bytes (< 64 hex chars)", () => {
    // 30-byte response_hash (60 hex chars)
    expect(() =>
      buildReceipt({ ...validReceiptParams(), response_hash: "b".repeat(60) })
    ).toThrow();
  });

  it("throws on prompt_hash shorter than 32 bytes (< 64 hex chars)", () => {
    expect(() =>
      buildReceipt({ ...validReceiptParams(), prompt_hash: "a".repeat(60) })
    ).toThrow();
  });

  it("throws on missing escrow_ref (empty string)", () => {
    expect(() =>
      buildReceipt({ ...validReceiptParams(), escrow_ref: "" })
    ).toThrow();
  });

  it("throws on malformed escrow_ref (no hash separator)", () => {
    expect(() =>
      buildReceipt({ ...validReceiptParams(), escrow_ref: "not-valid-ref" })
    ).toThrow();
  });

  it("throws on response_hash that is not hex", () => {
    expect(() =>
      buildReceipt({ ...validReceiptParams(), response_hash: "z".repeat(64) })
    ).toThrow();
  });

  it("accepts index 0 in escrow_ref", () => {
    const receipt = buildReceipt({ ...validReceiptParams(), escrow_ref: `${"0".repeat(64)}#0` });
    expect(receipt.escrow_ref).toBe(`${"0".repeat(64)}#0`);
  });

  it("accepts index > 0 in escrow_ref", () => {
    const receipt = buildReceipt({ ...validReceiptParams(), escrow_ref: `${"0".repeat(64)}#3` });
    expect(receipt.escrow_ref).toBe(`${"0".repeat(64)}#3`);
  });
});

// ─── B. signReceipt ─────────────────────────────────────────────────────────

describe("signReceipt()", () => {
  it("returns an object with receipt and signature fields", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    expect(signed.receipt).toEqual(receipt);
    expect(typeof signed.signature).toBe("string");
  });

  it("signature is 64-byte hex (128 chars)", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    expect(signed.signature).toMatch(/^[0-9a-fA-F]{128}$/);
  });

  it("signature is deterministic for the same key and receipt", () => {
    const receipt = buildReceipt(validReceiptParams());
    const sig1 = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX).signature;
    const sig2 = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX).signature;
    // Ed25519 is deterministic (RFC 8032)
    expect(sig1).toBe(sig2);
  });

  it("different receipts produce different signatures", () => {
    const r1 = buildReceipt(validReceiptParams());
    const r2 = buildReceipt({ ...validReceiptParams(), prompt_tokens: 99 });
    const sig1 = signReceipt(r1, SUPPLIER_PRIVATE_KEY_HEX).signature;
    const sig2 = signReceipt(r2, SUPPLIER_PRIVATE_KEY_HEX).signature;
    expect(sig1).not.toBe(sig2);
  });
});

// ─── C. verifyReceipt ───────────────────────────────────────────────────────

describe("verifyReceipt()", () => {
  it("returns true for a correctly signed receipt using the matching public key", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    expect(verifyReceipt(signed, SUPPLIER_PUB_KEY_HEX)).toBe(true);
  });

  it("returns false when prompt_hash is tampered", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    const tampered = {
      receipt: { ...signed.receipt, prompt_hash: "0".repeat(64) },
      signature: signed.signature,
    };
    expect(verifyReceipt(tampered, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });

  it("returns false when response_hash is tampered", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    const tampered = {
      receipt: { ...signed.receipt, response_hash: "0".repeat(64) },
      signature: signed.signature,
    };
    expect(verifyReceipt(tampered, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });

  it("returns false when model is tampered", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    const tampered = {
      receipt: { ...signed.receipt, model: "evil-model" },
      signature: signed.signature,
    };
    expect(verifyReceipt(tampered, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });

  it("returns false when prompt_tokens is tampered", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    const tampered = {
      receipt: { ...signed.receipt, prompt_tokens: 9999 },
      signature: signed.signature,
    };
    expect(verifyReceipt(tampered, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });

  it("returns false when supplier_pkh is tampered", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    const tampered = {
      receipt: { ...signed.receipt, supplier_pkh: "9".repeat(56) },
      signature: signed.signature,
    };
    expect(verifyReceipt(tampered, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });

  it("returns false when escrow_ref is tampered", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    const tampered = {
      receipt: { ...signed.receipt, escrow_ref: `${"0".repeat(64)}#99` },
      signature: signed.signature,
    };
    expect(verifyReceipt(tampered, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });

  it("returns false when signature is all zeros", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    const tampered = { receipt: signed.receipt, signature: "0".repeat(128) };
    expect(verifyReceipt(tampered, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });
});

// ─── D. receiptResultHash ───────────────────────────────────────────────────

describe("receiptResultHash()", () => {
  it("returns a 32-byte (64-char) lowercase hex string", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    const hash = receiptResultHash(signed);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same signed receipt", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
    expect(receiptResultHash(signed)).toBe(receiptResultHash(signed));
  });

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

// ─── E. Round-trip ───────────────────────────────────────────────────────────

describe("receipt round-trip (build → sign → verify → hash)", () => {
  it("full happy path: build receipt, sign, verify true, get on-chain hash", () => {
    const params = validReceiptParams();
    const receipt = buildReceipt(params);
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);

    // Verify signature is valid
    expect(verifyReceipt(signed, SUPPLIER_PUB_KEY_HEX)).toBe(true);

    // result hash is 32-byte hex — suitable for EscrowDatum.result_receipt_hash
    const resultHash = receiptResultHash(signed);
    expect(resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tampered receipt after sign yields verify=false (no forgery)", () => {
    const receipt = buildReceipt(validReceiptParams());
    const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);

    const attacker = {
      receipt: { ...signed.receipt, completion_tokens: 0 },
      signature: signed.signature,
    };
    expect(verifyReceipt(attacker, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });

  it("two distinct prompts produce two distinct result hashes", () => {
    const p1 = buildReceipt(validReceiptParams());
    const p2 = buildReceipt({ ...validReceiptParams(), prompt_hash: "1".repeat(64) });
    const h1 = receiptResultHash(signReceipt(p1, SUPPLIER_PRIVATE_KEY_HEX));
    const h2 = receiptResultHash(signReceipt(p2, SUPPLIER_PRIVATE_KEY_HEX));
    expect(h1).not.toBe(h2);
  });
});
