/**
 * Tests buildReclaimTx() on the mock chain (Open or Claimed -> Reclaimed, terminal).
 * The cases follow escrow.ak handle_reclaim: the buyer signs, the old state is Open or Claimed, the tip is at or past
 * deliver_by, the buyer gets payment + buyer_bond + supplier_bond, and no escrow output is left.
 */

import { describe, it, expect } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildReclaimTx } from "../../packages/shared/src/tx/escrow/reclaim.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildOpenEscrowUtxo,
  buildSubmittedEscrowUtxo,
  DELIVER_BY,
  PAYMENT_LOVELACE,
  BUYER_BOND,
  SUPPLIER_BOND,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

const open = buildOpenEscrowUtxo();
const BEFORE_DELIVER_BY_MS = -60_000;
const AFTER_DELIVER_BY_MS = 60_000;

/** A mock chain with `escrow` and a tip `fromDeliverByMs` after deliver_by (negative: before it). The mock chain reads slot x 1000 as the time. */
function chainAt(fromDeliverByMs: number, escrow: Utxo = open): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor((DELIVER_BY + fromDeliverByMs) / 1000));
  chain.seed(escrow);
  return chain;
}

describe("buildReclaimTx()", () => {
  it("pays the buyer at least payment + buyer_bond + supplier_bond", async () => {
    const chain = chainAt(AFTER_DELIVER_BY_MS);
    const buyer = buildBuyerWalletKey();
    await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: open.ref });
    const buyerUtxos = await chain.queryUtxosByAddress(buyer.address);
    const total = buyerUtxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    expect(total).toBeGreaterThanOrEqual(PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND);
  });

  it("spends the escrow UTxO", async () => {
    const chain = chainAt(AFTER_DELIVER_BY_MS);
    await buildReclaimTx({ chain, buyerKey: buildBuyerWalletKey(), escrowRef: open.ref });
    expect(await chain.queryUtxo(open.ref)).toBeNull();
  });

  it("refuses a tip before deliver_by", async () => {
    await expect(
      buildReclaimTx({ chain: chainAt(BEFORE_DELIVER_BY_MS), buyerKey: buildBuyerWalletKey(), escrowRef: open.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "reclaim before deliver_by" });
  });

  it("refuses a signer that is not the buyer", async () => {
    await expect(
      buildReclaimTx({ chain: chainAt(AFTER_DELIVER_BY_MS), buyerKey: buildSupplierWalletKey(), escrowRef: open.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "buyer signature mismatch" });
  });

  it("refuses a Submitted escrow (only Open and Claimed can be reclaimed)", async () => {
    const submitted = buildSubmittedEscrowUtxo();
    await expect(
      buildReclaimTx({ chain: chainAt(AFTER_DELIVER_BY_MS, submitted), buyerKey: buildBuyerWalletKey(), escrowRef: submitted.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "wrong state" });
  });
});
