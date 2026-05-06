/**
 * tx-submit.test.ts — RED phase tests for buildSubmitTx() (Claimed → Submitted)
 *
 * Tests mirror escrow.ak:handle_submit invariants:
 *   - signed by supplier_pkh
 *   - old state = Claimed
 *   - new datum: state=Submitted, submitted_at=upper_bound, result_receipt_hash=Some(hash)
 *   - all other fields unchanged
 *   - value preserved
 *   - receipt_hash is exactly 32 bytes
 *   - validity upper-bound ≤ deliver_by
 *
 * Note from escrow.ak: "Validity-range upper bound serves as the canonical submission stamp."
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildSubmitTx } from "../../packages/shared/src/tx/escrow/submit.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import {
  buildClaimedEscrowUtxo,
  buildSubmittedEscrowUtxo,
  DELIVER_BY,
  TOTAL_LOCKED,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

const VALID_RECEIPT_HASH = "e".repeat(64);  // 32 bytes as hex

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("buildSubmitTx() — happy path", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY - 100_000) / 1000));
    chain.seed(buildClaimedEscrowUtxo());
  });

  it("returns a non-empty txCborHex", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildClaimedEscrowUtxo();
    const result = await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH });
    expect(typeof result.txCborHex).toBe("string");
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });

  it("continuing output datum has state = Submitted", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildClaimedEscrowUtxo();
    const result = await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH });
    const newUtxo = await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 });
    const datum = decodeEscrowDatum(newUtxo!.datumHex!);
    expect(datum.state).toBe("Submitted");
  });

  it("continuing output datum has result_receipt_hash = Some(receiptHash)", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildClaimedEscrowUtxo();
    const result = await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH });
    const newUtxo = await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 });
    const datum = decodeEscrowDatum(newUtxo!.datumHex!);
    expect(datum.result_receipt_hash).toBe(VALID_RECEIPT_HASH);
  });

  it("continuing output datum has submitted_at = Some(validityUpperBound)", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildClaimedEscrowUtxo();
    const result = await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH });
    const newUtxo = await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 });
    const datum = decodeEscrowDatum(newUtxo!.datumHex!);
    // submitted_at must be non-null (Some)
    expect(datum.submitted_at).not.toBeNull();
    // and must be ≤ deliver_by
    expect(datum.submitted_at!).toBeLessThanOrEqual(DELIVER_BY);
  });

  it("continuing output datum other fields unchanged from claimed datum", async () => {
    const supplier = buildSupplierWalletKey();
    const claimedUtxo = buildClaimedEscrowUtxo();
    const oldDatum = decodeEscrowDatum(claimedUtxo.datumHex!);
    const result = await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: claimedUtxo.ref, receiptHash: VALID_RECEIPT_HASH });
    const newUtxo = await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 });
    const newDatum = decodeEscrowDatum(newUtxo!.datumHex!);
    // Per escrow.ak:expect_unchanged_modulo_submit
    expect(newDatum.buyer_pkh).toBe(oldDatum.buyer_pkh);
    expect(newDatum.supplier_pkh).toBe(oldDatum.supplier_pkh);
    expect(newDatum.advert_ref.txHash).toBe(oldDatum.advert_ref.txHash);
    expect(newDatum.capability_id).toBe(oldDatum.capability_id);
    expect(newDatum.request_spec_hash).toBe(oldDatum.request_spec_hash);
    expect(newDatum.prompt_hash).toBe(oldDatum.prompt_hash);
    expect(newDatum.payment_lovelace).toBe(oldDatum.payment_lovelace);
    expect(newDatum.deliver_by).toBe(oldDatum.deliver_by);
    expect(newDatum.posted_at).toBe(oldDatum.posted_at);
  });

  it("value is preserved (locked lovelace unchanged)", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildClaimedEscrowUtxo();
    const result = await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH });
    const newUtxo = await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 });
    expect(newUtxo!.lovelace).toBe(TOTAL_LOCKED);
  });
});

// ─── Rejection: double-submit ────────────────────────────────────────────────

describe("buildSubmitTx() — rejects double-submit", () => {
  it("throws TxConstructionError when escrow is already Submitted", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY - 100_000) / 1000));
    const utxo = buildSubmittedEscrowUtxo();  // already Submitted
    chain.seed(utxo);

    await expect(
      buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'double submit'", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY - 100_000) / 1000));
    const utxo = buildSubmittedEscrowUtxo();
    chain.seed(utxo);

    let caught: unknown;
    try {
      await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("double submit");
  });
});

// ─── Rejection: empty receipt hash ───────────────────────────────────────────

describe("buildSubmitTx() — rejects empty/invalid receipt hash", () => {
  it("throws TxConstructionError when receiptHash is empty string", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY - 100_000) / 1000));
    chain.seed(buildClaimedEscrowUtxo());
    const utxo = buildClaimedEscrowUtxo();

    await expect(
      buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: "" }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("throws TxConstructionError when receiptHash is not 32 bytes (too short)", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY - 100_000) / 1000));
    chain.seed(buildClaimedEscrowUtxo());
    const utxo = buildClaimedEscrowUtxo();

    // 4 bytes only — escrow.ak requires exactly 32
    await expect(
      buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: "deadbeef" }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'receipt hash must be 32 bytes'", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY - 100_000) / 1000));
    chain.seed(buildClaimedEscrowUtxo());
    const utxo = buildClaimedEscrowUtxo();

    let caught: unknown;
    try {
      await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: utxo.ref, receiptHash: "deadbeef" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("receipt hash must be 32 bytes");
  });
});

// ─── Rejection: non-supplier signer ──────────────────────────────────────────

describe("buildSubmitTx() — rejects non-supplier signer", () => {
  it("throws TxConstructionError when signed by buyer", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY - 100_000) / 1000));
    chain.seed(buildClaimedEscrowUtxo());
    const utxo = buildClaimedEscrowUtxo();

    await expect(
      buildSubmitTx({ chain, supplierKey: buyer, escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH }),
    ).rejects.toThrow(TxConstructionError);
  });
});
