/**
 * buyer-sdk-history.test.ts — RED phase (M1-E)
 *
 * Category E: SDK — getTaskHistory() + MemoryTaskHistoryStore (~5 tests)
 *
 * All tests FAIL until M1-E-green.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { MemoryTaskHistoryStore } from "../../buyer/src/sdk/history.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import {
  ALL_SAMPLE_TASK_RECORDS,
  TASK_COMPLETED,
  TASK_FAILED,
  TASK_PENDING,
  TASK_COMPLETED_OTHER_SUPPLIER,
} from "../fixtures/buyer-side/sample-task-records.js";

function makeMarketplaceWithStore(store: MemoryTaskHistoryStore): Marketplace {
  return new Marketplace({
    chain: new MockChainProvider(),
    indexerUrl: "http://indexer.test",
    walletKey: buildBuyerWalletKey(),
    networkParams: { networkId: 0 },
    historyStore: store,
  });
}

describe("Marketplace.getTaskHistory() via MemoryTaskHistoryStore", () => {
  let store: MemoryTaskHistoryStore;

  beforeEach(() => {
    store = new MemoryTaskHistoryStore();
    // Pre-populate the store with all sample records in insertion order.
    for (const r of ALL_SAMPLE_TASK_RECORDS) {
      store.save(r);
    }
    // Add the other-supplier record too
    store.save(TASK_COMPLETED_OTHER_SUPPLIER);
  });

  it("returns all records ordered by posted_at descending", () => {
    const mp = makeMarketplaceWithStore(store);
    const history = mp.getTaskHistory();
    expect(history.length).toBeGreaterThanOrEqual(ALL_SAMPLE_TASK_RECORDS.length);
    // Verify descending order
    for (let i = 1; i < history.length; i++) {
      expect(history[i - 1].posted_at).toBeGreaterThanOrEqual(history[i].posted_at);
    }
  });

  it("getTaskHistory({status:'completed'}) returns only completed tasks", () => {
    const mp = makeMarketplaceWithStore(store);
    const completed = mp.getTaskHistory({ status: "completed" });
    expect(completed.every(t => t.status === "completed")).toBe(true);
    // Should include TASK_COMPLETED and TASK_COMPLETED_OTHER_SUPPLIER
    expect(completed.length).toBeGreaterThanOrEqual(2);
  });

  it("getTaskHistory({status:'failed'}) returns only failed tasks", () => {
    const mp = makeMarketplaceWithStore(store);
    const failed = mp.getTaskHistory({ status: "failed" });
    expect(failed.every(t => t.status === "failed")).toBe(true);
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  it("getTaskHistory({supplier: pkh}) returns only tasks for that supplier", () => {
    const mp = makeMarketplaceWithStore(store);
    const targetPkh = TASK_COMPLETED_OTHER_SUPPLIER.supplier_pkh;
    const filtered = mp.getTaskHistory({ supplier: targetPkh });
    expect(filtered.every(t => t.supplier_pkh === targetPkh)).toBe(true);
    expect(filtered.some(t => t.escrow_ref === TASK_COMPLETED_OTHER_SUPPLIER.escrow_ref)).toBe(true);
    // Should NOT include tasks from the main supplier
    expect(filtered.every(t => t.supplier_pkh !== TASK_COMPLETED.supplier_pkh)).toBe(true);
  });

  it("MemoryTaskHistoryStore.get(escrowRef) returns the matching record", () => {
    const result = store.get(TASK_COMPLETED.escrow_ref);
    expect(result).not.toBeNull();
    expect(result?.escrow_ref).toBe(TASK_COMPLETED.escrow_ref);
    expect(result?.status).toBe("completed");
  });
});
