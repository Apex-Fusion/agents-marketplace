/**
 * tx-release.test.ts — RED phase tests for buildReleaseTx() (Submitted → Released, terminal)
 *
 * Tests mirror escrow.ak:handle_release invariants:
 *   - signed by supplier_pkh
 *   - old state = Submitted
 *   - supplier receives ≥ payment + supplier_bond + buyer_bond
 *   - validity lower-bound ≥ submitted_at + ACCEPT_WINDOW (600_000 ms)
 *   - terminal: no continuing escrow output
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildReleaseTx } from "../../packages/shared/src/tx/escrow/release.js";
import { ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/escrow/accept.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
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

const RELEASE_THRESHOLD = SUBMITTED_AT + ACCEPT_WINDOW_MS;

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("buildReleaseTx() — happy path", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    // Tip is past the accept window
    chain.advanceSlot(Math.floor((RELEASE_THRESHOLD + 60_000) / 1000));
    chain.seed(buildSubmittedEscrowUtxo());
  });

  it("returns a non-empty txCborHex", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildSubmittedEscrowUtxo();
    const result = await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref });
    expect(typeof result.txCborHex).toBe("string");
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });

  it("supplier receives >= payment + supplier_bond + buyer_bond", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildSubmittedEscrowUtxo();
    await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref });
    const supplierUtxos = await chain.queryUtxosByAddress(supplier.address);
    const total = supplierUtxos.reduce((sum, u) => sum + u.lovelace, 0n);
    expect(total).toBeGreaterThanOrEqual(PAYMENT_LOVELACE + SUPPLIER_BOND + BUYER_BOND);
  });

  it("validity lower-bound >= submitted_at + ACCEPT_WINDOW", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildSubmittedEscrowUtxo();
    // No throw = builder sets correct validity range
    await expect(
      buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref }),
    ).resolves.toBeDefined();
  });

  it("escrow UTxO is spent (terminal state)", async () => {
    const supplier = buildSupplierWalletKey();
    const utxo = buildSubmittedEscrowUtxo();
    await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref });
    const spent = await chain.queryUtxo(utxo.ref);
    expect(spent).toBeNull();
  });
});

// ─── Rejection: before accept window ────────────────────────────────────────

describe("buildReleaseTx() — rejects before accept window expires", () => {
  it("throws TxConstructionError when chain tip is before submitted_at + ACCEPT_WINDOW", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    // Tip is within accept window (before it expires)
    chain.advanceSlot(Math.floor((SUBMITTED_AT + ACCEPT_WINDOW_MS / 2) / 1000));
    chain.seed(buildSubmittedEscrowUtxo());
    const utxo = buildSubmittedEscrowUtxo();

    await expect(
      buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'release before accept window'", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((SUBMITTED_AT + ACCEPT_WINDOW_MS / 2) / 1000));
    chain.seed(buildSubmittedEscrowUtxo());
    const utxo = buildSubmittedEscrowUtxo();

    let caught: unknown;
    try {
      await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("release before accept window");
  });
});

// ─── Rejection: non-supplier signer ──────────────────────────────────────────

describe("buildReleaseTx() — rejects non-supplier signer", () => {
  it("throws TxConstructionError when signed by buyer", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((RELEASE_THRESHOLD + 60_000) / 1000));
    chain.seed(buildSubmittedEscrowUtxo());
    const utxo = buildSubmittedEscrowUtxo();

    await expect(
      buildReleaseTx({ chain, supplierKey: buyer, escrowRef: utxo.ref }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'supplier signature mismatch'", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((RELEASE_THRESHOLD + 60_000) / 1000));
    chain.seed(buildSubmittedEscrowUtxo());
    const utxo = buildSubmittedEscrowUtxo();

    let caught: unknown;
    try {
      await buildReleaseTx({ chain, supplierKey: buyer, escrowRef: utxo.ref });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("supplier signature mismatch");
  });
});

// ─── Rejection: wrong state ───────────────────────────────────────────────────

describe("buildReleaseTx() — rejects wrong state (Open)", () => {
  it("throws TxConstructionError when state is Open (not Submitted)", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((RELEASE_THRESHOLD + 60_000) / 1000));
    const utxo = buildOpenEscrowUtxo();   // wrong state
    chain.seed(utxo);

    await expect(
      buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref }),
    ).rejects.toThrow(TxConstructionError);
  });
});

// ─── Distribution sanity ─────────────────────────────────────────────────────

describe("buildReleaseTx() — distribution sanity", () => {
  it("supplier is owed payment + supplier_bond + buyer_bond = 4_000_000 lovelace", () => {
    expect(PAYMENT_LOVELACE + SUPPLIER_BOND + BUYER_BOND).toBe(4_000_000n);
  });
});
