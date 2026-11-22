/**
 * buyer-sdk-history.test.ts — Marketplace.getTaskHistory() over MemoryTaskHistoryStore: the order, the status
 * and supplier filters, and get() by escrow ref.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { MemoryTaskHistoryStore } from "../../buyer/src/sdk/history.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import {
  ALL_SAMPLE_TASK_RECORDS,
  TASK_COMPLETED,
  TASK_COMPLETED_OTHER_SUPPLIER,
  TASK_FAILED,
  TASK_PENDING,
  TASK_RECLAIMED,
} from "../fixtures/buyer-side/sample-task-records.js";
import type { TaskRecord, TaskStatus } from "../../buyer/src/sdk/types.js";

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
    const history = makeMarketplaceWithStore(store).getTaskHistory();
    const newestFirst = [TASK_PENDING, TASK_FAILED, TASK_COMPLETED_OTHER_SUPPLIER, TASK_COMPLETED, TASK_RECLAIMED];
    expect(history.map(t => t.escrow_ref)).toEqual(newestFirst.map(t => t.escrow_ref));
  });

  // The records that each status filter returns, newest posted_at first.
  const STATUS_FILTERS: Array<[TaskStatus, TaskRecord[]]> = [
    ["completed", [TASK_COMPLETED_OTHER_SUPPLIER, TASK_COMPLETED]],
    ["failed", [TASK_FAILED]],
  ];

  it.each(STATUS_FILTERS)("getTaskHistory({status:'%s'}) returns exactly the tasks with that status", (status, expected) => {
    const history = makeMarketplaceWithStore(store).getTaskHistory({ status });
    expect(history.map(t => t.escrow_ref)).toEqual(expected.map(t => t.escrow_ref));
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
