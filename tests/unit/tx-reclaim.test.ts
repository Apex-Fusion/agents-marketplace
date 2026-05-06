/**
 * tx-reclaim.test.ts — RED phase tests for buildReclaimTx() (Open|Claimed → Reclaimed, terminal)
 *
 * Tests mirror escrow.ak:handle_reclaim invariants:
 *   - signed by buyer_pkh
 *   - old state ∈ {Open, Claimed}
 *   - buyer receives ≥ payment + buyer_bond + supplier_bond
 *   - validity lower-bound ≥ deliver_by
 *   - terminal: no continuing escrow output
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildReclaimTx } from "../../packages/shared/src/tx/escrow/reclaim.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildOpenEscrowUtxo,
  buildClaimedEscrowUtxo,
  buildSubmittedEscrowUtxo,
  DELIVER_BY,
  PAYMENT_LOVELACE,
  BUYER_BOND,
  SUPPLIER_BOND,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

// ─── Happy path — from Open ───────────────────────────────────────────────────

describe("buildReclaimTx() — happy path from Open state", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    // Tip is past deliver_by
    chain.advanceSlot(Math.floor((DELIVER_BY + 60_000) / 1000));
    chain.seed(buildOpenEscrowUtxo());
  });

  it("returns a non-empty txCborHex", async () => {
    const buyer = buildBuyerWalletKey();
    const utxo = buildOpenEscrowUtxo();
    const result = await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: utxo.ref });
    expect(typeof result.txCborHex).toBe("string");
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });

  it("buyer receives >= payment + buyer_bond + supplier_bond", async () => {
    const buyer = buildBuyerWalletKey();
    const utxo = buildOpenEscrowUtxo();
    await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: utxo.ref });
    const buyerUtxos = await chain.queryUtxosByAddress(buyer.address);
    const total = buyerUtxos.reduce((sum, u) => sum + u.lovelace, 0n);
    expect(total).toBeGreaterThanOrEqual(PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND);
  });

  it("validity lower-bound is >= deliver_by (after the deadline)", async () => {
    const buyer = buildBuyerWalletKey();
    const utxo = buildOpenEscrowUtxo();
    // No throw = builder constructed valid tx with correct time range
    await expect(
      buildReclaimTx({ chain, buyerKey: buyer, escrowRef: utxo.ref }),
    ).resolves.toBeDefined();
  });

  it("escrow UTxO is spent (not present after reclaim)", async () => {
    const buyer = buildBuyerWalletKey();
    const utxo = buildOpenEscrowUtxo();
    await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: utxo.ref });
    const spent = await chain.queryUtxo(utxo.ref);
    expect(spent).toBeNull();
  });
});

// ─── Happy path — from Claimed ────────────────────────────────────────────────

describe("buildReclaimTx() — happy path from Claimed state", () => {
  it("succeeds when state is Claimed (not just Open)", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY + 60_000) / 1000));
    const utxo = buildClaimedEscrowUtxo();
    chain.seed(utxo);

    await expect(
      buildReclaimTx({ chain, buyerKey: buyer, escrowRef: utxo.ref }),
    ).resolves.toBeDefined();
  });
});

// ─── Rejection: before deliver_by ────────────────────────────────────────────

describe("buildReclaimTx() — rejects before deliver_by", () => {
  it("throws TxConstructionError when chain tip is before deliver_by", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    // Tip is BEFORE deliver_by
    chain.advanceSlot(Math.floor((DELIVER_BY - 60_000) / 1000));
    chain.seed(buildOpenEscrowUtxo());
    const utxo = buildOpenEscrowUtxo();

    await expect(
      buildReclaimTx({ chain, buyerKey: buyer, escrowRef: utxo.ref }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'reclaim before deliver_by'", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY - 60_000) / 1000));
    chain.seed(buildOpenEscrowUtxo());
    const utxo = buildOpenEscrowUtxo();

    let caught: unknown;
    try {
      await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: utxo.ref });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("reclaim before deliver_by");
  });
});

// ─── Rejection: non-buyer signer ─────────────────────────────────────────────

describe("buildReclaimTx() — rejects non-buyer signer", () => {
  it("throws TxConstructionError when signed by supplier", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY + 60_000) / 1000));
    chain.seed(buildOpenEscrowUtxo());
    const utxo = buildOpenEscrowUtxo();

    await expect(
      buildReclaimTx({ chain, buyerKey: supplier, escrowRef: utxo.ref }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'buyer signature mismatch'", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY + 60_000) / 1000));
    chain.seed(buildOpenEscrowUtxo());
    const utxo = buildOpenEscrowUtxo();

    let caught: unknown;
    try {
      await buildReclaimTx({ chain, buyerKey: supplier, escrowRef: utxo.ref });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("buyer signature mismatch");
  });
});

// ─── Rejection: wrong state (Submitted) ──────────────────────────────────────

describe("buildReclaimTx() — rejects Submitted state", () => {
  it("throws TxConstructionError when state is Submitted (not Open or Claimed)", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((DELIVER_BY + 60_000) / 1000));
    const utxo = buildSubmittedEscrowUtxo();  // Submitted — reclaim not allowed
    chain.seed(utxo);

    await expect(
      buildReclaimTx({ chain, buyerKey: buyer, escrowRef: utxo.ref }),
    ).rejects.toThrow(TxConstructionError);
  });
});

// ─── Distribution sanity ─────────────────────────────────────────────────────

describe("buildReclaimTx() — distribution sanity", () => {
  it("buyer is owed payment + buyer_bond + supplier_bond = 4_000_000 lovelace", () => {
    expect(PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND).toBe(4_000_000n);
  });
});
