/**
 * Tests buildAcceptTx() on the mock chain (Submitted -> Accepted, terminal).
 * The cases follow escrow.ak handle_accept: the buyer signs, the tip is inside the accept window,
 * the supplier gets payment + supplier_bond, the buyer gets buyer_bond, and no escrow output is left.
 */

import { describe, it, expect } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildAcceptTx, ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/escrow/accept.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildSubmittedEscrowUtxo,
  SUBMITTED_AT,
  PAYMENT_LOVELACE,
  BUYER_BOND,
  SUPPLIER_BOND,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

const escrow = buildSubmittedEscrowUtxo();
const INSIDE_WINDOW_MS = ACCEPT_WINDOW_MS / 2;

/** A mock chain with the Submitted escrow and a tip `afterSubmitMs` after submitted_at (the mock chain reads slot x 1000 as the time). */
function chainAt(afterSubmitMs: number): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor((SUBMITTED_AT + afterSubmitMs) / 1000));
  chain.seed(escrow);
  return chain;
}

async function lovelaceAt(chain: MockChainProvider, address: string): Promise<bigint> {
  const utxos = await chain.queryUtxosByAddress(address);
  return utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
}

describe("buildAcceptTx()", () => {
  it("pays the supplier at least payment + supplier_bond", async () => {
    const chain = chainAt(INSIDE_WINDOW_MS);
    await buildAcceptTx({ chain, buyerKey: buildBuyerWalletKey(), escrowRef: escrow.ref });
    expect(await lovelaceAt(chain, buildSupplierWalletKey().address)).toBeGreaterThanOrEqual(PAYMENT_LOVELACE + SUPPLIER_BOND);
  });

  it("pays the buyer at least buyer_bond", async () => {
    const chain = chainAt(INSIDE_WINDOW_MS);
    const buyer = buildBuyerWalletKey();
    await buildAcceptTx({ chain, buyerKey: buyer, escrowRef: escrow.ref });
    expect(await lovelaceAt(chain, buyer.address)).toBeGreaterThanOrEqual(BUYER_BOND);
  });

  it("spends the escrow and leaves no output at the escrow address (terminal state)", async () => {
    const chain = chainAt(INSIDE_WINDOW_MS);
    await buildAcceptTx({ chain, buyerKey: buildBuyerWalletKey(), escrowRef: escrow.ref });
    expect(await chain.queryUtxosByAddress(escrow.address)).toEqual([]);
  });

  it("refuses a signer that is not the buyer", async () => {
    await expect(
      buildAcceptTx({ chain: chainAt(INSIDE_WINDOW_MS), buyerKey: buildSupplierWalletKey(), escrowRef: escrow.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "buyer signature mismatch" });
  });

  it("refuses a tip past submitted_at + ACCEPT_WINDOW", async () => {
    await expect(
      buildAcceptTx({ chain: chainAt(ACCEPT_WINDOW_MS + 60_000), buyerKey: buildBuyerWalletKey(), escrowRef: escrow.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "accept window expired" });
  });
});
