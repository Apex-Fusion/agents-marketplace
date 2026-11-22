/**
 * Tests buildClaimTx() on the mock chain (Open -> Claimed).
 * The cases follow escrow.ak handle_claim: the supplier signs, the old state is Open, the tip is before deliver_by,
 * and the continuing output keeps the value and every datum field except the state.
 */

import { describe, it, expect } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildClaimTx } from "../../packages/shared/src/tx/escrow/claim.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import {
  buildOpenEscrowUtxo,
  buildClaimedEscrowUtxo,
  DELIVER_BY,
  TOTAL_LOCKED,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

const open = buildOpenEscrowUtxo();
const BEFORE_DELIVER_BY_MS = -100_000;
const AFTER_DELIVER_BY_MS = 100_000;

/** A mock chain with `escrow` and a tip `fromDeliverByMs` after deliver_by (negative: before it). The mock chain reads slot x 1000 as the time. */
function chainAt(fromDeliverByMs: number, escrow: Utxo = open): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor((DELIVER_BY + fromDeliverByMs) / 1000));
  chain.seed(escrow);
  return chain;
}

/** Claims the Open escrow as its supplier. Returns the chain and the continuing output. */
async function claimOpen(): Promise<{ chain: MockChainProvider; output: Utxo }> {
  const chain = chainAt(BEFORE_DELIVER_BY_MS);
  const result = await buildClaimTx({ chain, supplierKey: buildSupplierWalletKey(), escrowRef: open.ref });
  const output = await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 });
  if (output === null) throw new Error("Claim wrote no continuing output");
  return { chain, output };
}

describe("buildClaimTx()", () => {
  it("writes a continuing output with state Claimed and spends the escrow input", async () => {
    const { chain, output } = await claimOpen();
    expect(decodeEscrowDatum(output.datumHex!).state).toBe("Claimed");
    expect(await chain.queryUtxo(open.ref)).toBeNull();
  });

  it("keeps the locked value at the escrow address", async () => {
    const { output } = await claimOpen();
    expect(output.lovelace).toBe(TOTAL_LOCKED);
    expect(output.address).toBe(open.address);
  });

  it("keeps every datum field except the state", async () => {
    const { output } = await claimOpen();
    expect(decodeEscrowDatum(output.datumHex!)).toEqual({ ...decodeEscrowDatum(open.datumHex!), state: "Claimed" });
  });

  it("refuses a signer that is not the supplier", async () => {
    await expect(
      buildClaimTx({ chain: chainAt(BEFORE_DELIVER_BY_MS), supplierKey: buildBuyerWalletKey(), escrowRef: open.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "supplier signature mismatch" });
  });

  it("refuses a tip past deliver_by", async () => {
    await expect(
      buildClaimTx({ chain: chainAt(AFTER_DELIVER_BY_MS), supplierKey: buildSupplierWalletKey(), escrowRef: open.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "claim after deliver_by" });
  });

  it("refuses an escrow that is already Claimed", async () => {
    const claimed = buildClaimedEscrowUtxo();
    await expect(
      buildClaimTx({ chain: chainAt(BEFORE_DELIVER_BY_MS, claimed), supplierKey: buildSupplierWalletKey(), escrowRef: claimed.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "wrong state" });
  });
});
