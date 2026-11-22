/**
 * tx-submit.test.ts: buildSubmitTx() (Claimed → Submitted) on the mock chain, and the deadline on a live provider.
 *
 * The cases mirror the escrow.ak invariants of handle_submit:
 *   - signed by supplier_pkh
 *   - old state = Claimed
 *   - new datum: state=Submitted, submitted_at=upper_bound, result_receipt_hash=Some(hash)
 *   - all other fields unchanged
 *   - value preserved
 *   - receipt_hash is exactly 32 bytes
 *   - validity upper-bound ≤ deliver_by
 *
 * Note from escrow.ak: "Validity-range upper bound serves as the canonical submission stamp."
 * The live Submit transaction is built in the lifecycle case of tx-post-escrow-live.test.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildSubmitTx } from "../../packages/shared/src/tx/escrow/submit.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import {
  buildClaimedEscrowUtxo,
  buildSubmittedEscrowUtxo,
  DELIVER_BY,
  TOTAL_LOCKED,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";
import { legacyLive } from "../fixtures/onchain-tx/legacy-live.js";

const VALID_RECEIPT_HASH = "e".repeat(64);  // 32 bytes as hex

/** A mock chain 100 s before deliver_by, with `utxo` on it. */
function chainWith(utxo = buildClaimedEscrowUtxo()): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor((DELIVER_BY - 100_000) / 1000));
  chain.seed(utxo);
  return chain;
}

async function refusalOf(promise: Promise<unknown>): Promise<TxConstructionError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(TxConstructionError);
  return error as TxConstructionError;
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("buildSubmitTx() — happy path", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = chainWith();
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

  it("journals signed Submit CBOR before broadcast", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildClaimedEscrowUtxo();
    let hookCalled = false;
    const result = await buildSubmitTx({
      chain,
      supplierKey: supplier,
      escrowRef: utxo.ref,
      receiptHash: VALID_RECEIPT_HASH,
      beforeSubmit: async (built) => {
        hookCalled = true;
        expect(
          await chain.queryUtxo({ txHash: built.expectedTxHash, index: 0 }),
        ).toBeNull();
      },
    });
    expect(hookCalled).toBe(true);
    expect(
      await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 }),
    ).not.toBeNull();
  });
});

// ─── Rejections ──────────────────────────────────────────────────────────────

describe("buildSubmitTx() — rejections", () => {
  it("refuses a double submit", async () => {
    const utxo = buildSubmittedEscrowUtxo();  // already Submitted
    const refusal = await refusalOf(
      buildSubmitTx({ chain: chainWith(utxo), supplierKey: buildSupplierWalletKey(), escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH }),
    );
    expect(refusal.reason).toBe("double submit");
  });

  // escrow.ak requires exactly 32 bytes. The builder checks the hash first, so the chain is empty here: a builder that read the
  // chain first would refuse with "escrow ref not on chain".
  it.each([["an empty string", ""], ["4 bytes", "deadbeef"]])("refuses a receipt hash of %s before it reads the chain", async (_name, receiptHash) => {
    const refusal = await refusalOf(
      buildSubmitTx({ chain: new MockChainProvider(), supplierKey: buildSupplierWalletKey(), escrowRef: buildClaimedEscrowUtxo().ref, receiptHash }),
    );
    expect(refusal.reason).toBe("receipt hash must be 32 bytes");
  });

  it("refuses a signer that is not the supplier", async () => {
    const utxo = buildClaimedEscrowUtxo();
    const refusal = await refusalOf(
      buildSubmitTx({ chain: chainWith(), supplierKey: buildBuyerWalletKey(), escrowRef: utxo.ref, receiptHash: VALID_RECEIPT_HASH }),
    );
    expect(refusal.reason).toBe("supplier signature mismatch");
  });
});

// ─── Live backend: the deadline is read from the clock ───────────────────────

describe("buildSubmitTx() [live]", () => {
  const live = legacyLive(Date.UTC(2026, 3, 27, 12, 0, 0));

  it("refuses 'submit after deliver_by' when the clock is past deliver_by, whatever the tip says", async () => {
    const claimed = buildClaimedEscrowUtxo();
    const datum = decodeEscrowDatum(claimed.datumHex!);
    live.ogmios.add({ ...claimed, datumHex: encodeEscrowDatum({ ...datum, deliver_by: Date.now() - 1 }) });

    const refusal = await refusalOf(
      buildSubmitTx({ chain: live.ogmios.chain(), supplierKey: buildSupplierWalletKey(), escrowRef: claimed.ref, receiptHash: VALID_RECEIPT_HASH }),
    );

    expect(refusal.reason).toBe("submit after deliver_by");
  });
});
