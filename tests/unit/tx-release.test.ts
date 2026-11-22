/**
 * Tests buildReleaseTx() on the mock chain (Submitted -> Released, terminal).
 * The cases follow escrow.ak handle_release: the supplier signs, the old state is Submitted, the tip is at or past
 * submitted_at + ACCEPT_WINDOW, the supplier gets payment + both bonds, and no escrow output is left.
 */

import { describe, it, expect } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildReleaseTx } from "../../packages/shared/src/tx/escrow/release.js";
import { ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/escrow/accept.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import {
  buildSubmittedEscrowUtxo,
  buildOpenEscrowUtxo,
  SUBMITTED_AT,
  PAYMENT_LOVELACE,
  BUYER_BOND,
  SUPPLIER_BOND,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

const submitted = buildSubmittedEscrowUtxo();
const TIP_INSIDE_WINDOW_MS = SUBMITTED_AT + ACCEPT_WINDOW_MS / 2;
const TIP_PAST_WINDOW_MS = SUBMITTED_AT + ACCEPT_WINDOW_MS + 60_000;

/** A mock chain with `escrow` and the tip at `tipMs` (the mock chain reads slot x 1000 as the time). */
function chainAt(tipMs: number, escrow: Utxo = submitted): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor(tipMs / 1000));
  chain.seed(escrow);
  return chain;
}

describe("buildReleaseTx()", () => {
  it("pays the supplier at least payment + supplier_bond + buyer_bond", async () => {
    const chain = chainAt(TIP_PAST_WINDOW_MS);
    const supplier = buildSupplierWalletKey();
    await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: submitted.ref });
    const supplierUtxos = await chain.queryUtxosByAddress(supplier.address);
    const total = supplierUtxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    expect(total).toBeGreaterThanOrEqual(PAYMENT_LOVELACE + SUPPLIER_BOND + BUYER_BOND);
  });

  it("spends the escrow UTxO (terminal state)", async () => {
    const chain = chainAt(TIP_PAST_WINDOW_MS);
    await buildReleaseTx({ chain, supplierKey: buildSupplierWalletKey(), escrowRef: submitted.ref });
    expect(await chain.queryUtxo(submitted.ref)).toBeNull();
  });

  it("refuses a tip before submitted_at + ACCEPT_WINDOW", async () => {
    await expect(
      buildReleaseTx({ chain: chainAt(TIP_INSIDE_WINDOW_MS), supplierKey: buildSupplierWalletKey(), escrowRef: submitted.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "release before accept window" });
  });

  it("refuses a signer that is not the supplier", async () => {
    await expect(
      buildReleaseTx({ chain: chainAt(TIP_PAST_WINDOW_MS), supplierKey: buildBuyerWalletKey(), escrowRef: submitted.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "supplier signature mismatch" });
  });

  it("refuses an Open escrow (only Submitted can be released)", async () => {
    const open = buildOpenEscrowUtxo();
    await expect(
      buildReleaseTx({ chain: chainAt(TIP_PAST_WINDOW_MS, open), supplierKey: buildSupplierWalletKey(), escrowRef: open.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "wrong state" });
  });
});
