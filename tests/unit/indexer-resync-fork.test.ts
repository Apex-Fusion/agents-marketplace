/**
 * tests/unit/indexer-resync-fork.test.ts — rollback correctness after a fork.
 *
 * Blocks A and B are on the current chain. Block C' was on a branch that a
 * fork orphaned; block C replaced it. The database indexed A, B and C'
 * (legacy contracts only, as the indexer runs before the identity
 * deployment). A resync from B (RESYNC_FROM_SLOT / RESYNC_FROM_BLOCK_HASH),
 * or a chain-sync RollBackward to B, must remove all state of C' before C
 * is applied: adverts, escrows, supplier status, events and UTxOs.
 */

import { describe, it, expect } from "vitest";

import { SqliteCache, type SupplierStatusRow } from "../../indexer/src/db/cache.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import type { IndexerBlock } from "../../indexer/src/follower/types.js";
import { MockChainSyncSource, type MockChainEvent } from "./__helpers__/MockChainSyncSource.js";
import {
  ADVERT_SCRIPT_ADDRESS,
  ESCROW_SCRIPT_ADDRESS,
  INDEXER_SUPPLIER_PKH,
  buildClaimEscrowTx,
  buildMockBlock,
  buildPostAdvertTx,
  buildPostEscrowTx,
  buildRetireAdvertTx,
  buildSubmitEscrowTx,
  type MockTx,
} from "../fixtures/indexer-side/sample-blocks.js";

const ADDRESSES = { advertAddress: ADVERT_SCRIPT_ADDRESS, escrowAddress: ESCROW_SCRIPT_ADDRESS };
const OTHER_SUPPLIER = "ee".repeat(28);

/** Transaction id `nn…` (64 hex). */
const txId = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);

const ADVERT_1 = txId(0x11); // A: PostAdvert
const ESCROW_1 = txId(0x12); // A: PostEscrow
const CLAIM_1 = txId(0x21); // B: ClaimEscrow of escrow 1
const ADVERT_2 = txId(0x22); // B: PostAdvert
const RETIRE_1 = txId(0x31); // C': RetireAdvert of advert 1
const ADVERT_3 = txId(0x32); // C': PostAdvert by another supplier
const SUBMIT_1 = txId(0x33); // C': SubmitEscrow of escrow 1
const ESCROW_3 = txId(0x34); // C': PostEscrow
const ADVERT_4 = txId(0x41); // C: PostAdvert

const A = { slot: 100, blockHash: "a".repeat(64) };
const B = { slot: 200, blockHash: "b".repeat(64) };
const C_ORPHANED = { slot: 300, blockHash: "c".repeat(64) };
const C = { slot: 310, blockHash: "d".repeat(64) };

function block(point: { slot: number; blockHash: string }, transactions: MockTx[]): MockChainEvent {
  return { kind: "block", block: buildMockBlock({ slot: point.slot, id: point.blockHash, transactions }) as IndexerBlock };
}

const BLOCK_A = block(A, [buildPostAdvertTx({ txId: ADVERT_1 }), buildPostEscrowTx({ txId: ESCROW_1 })]);
const BLOCK_B = block(B, [
  buildClaimEscrowTx({ txId: CLAIM_1, spentRef: { txId: ESCROW_1, index: 0 } }),
  buildPostAdvertTx({ txId: ADVERT_2 }),
]);
const BLOCK_C_ORPHANED = block(C_ORPHANED, [
  buildRetireAdvertTx({ txId: RETIRE_1, spentRef: { txId: ADVERT_1, index: 0 } }),
  buildPostAdvertTx({ txId: ADVERT_3, advertDatumOpts: { supplierPkh: OTHER_SUPPLIER } }),
  buildSubmitEscrowTx({ txId: SUBMIT_1, spentRef: { txId: CLAIM_1, index: 0 } }),
  buildPostEscrowTx({ txId: ESCROW_3 }),
]);
const BLOCK_C = block(C, [buildPostAdvertTx({ txId: ADVERT_4 })]);

function status(supplierPkh: string, advertRef: string): SupplierStatusRow {
  return {
    supplier_pkh: supplierPkh,
    advert_ref: advertRef,
    status: "free",
    last_seen_iso: "2026-10-31T18:52:44.000Z",
    current_escrow_ref: null,
    polled_at: 1,
  };
}

/** Index A, B and C', and let the status poller see the advert of C'. */
async function indexOrphanedBranch(): Promise<{ cache: SqliteCache; source: MockChainSyncSource; worker: ChainSyncWorker }> {
  const cache = new SqliteCache(":memory:");
  const source = new MockChainSyncSource([BLOCK_A, BLOCK_B, BLOCK_C_ORPHANED]);
  const worker = new ChainSyncWorker({ source, cache, addresses: ADDRESSES, networkId: 0 });
  await worker.start();
  cache.upsertSupplierStatus(status(INDEXER_SUPPLIER_PKH, `${ADVERT_2}#0`));
  cache.upsertSupplierStatus(status(OTHER_SUPPLIER, `${ADVERT_3}#0`));

  // C' is in the database.
  expect(cache.getAdvertisementByRef(`${ADVERT_1}#0`)?.status).toBe("Retired");
  expect(cache.getAdvertisementByRef(`${ADVERT_3}#0`)).not.toBeNull();
  expect(cache.getEscrowByRef(`${SUBMIT_1}#0`)?.state).toBe("Submitted");
  expect(cache.getEscrowByRef(`${ESCROW_3}#0`)).not.toBeNull();
  expect(cache.getCursor()).toEqual(C_ORPHANED);
  return { cache, source, worker };
}

function expectNoStateOfOrphanedBlock(cache: SqliteCache): void {
  // C' retired advert 1: the advert is Active again.
  expect(cache.getAdvertisementByRef(`${ADVERT_1}#0`)?.status).toBe("Active");
  // C' posted advert 3 and escrow 3 and submitted escrow 1: none of it stays.
  expect(cache.getAdvertisementByRef(`${ADVERT_3}#0`)).toBeNull();
  expect(cache.getEscrowByRef(`${ESCROW_3}#0`)).toBeNull();
  expect(cache.getEscrowByRef(`${SUBMIT_1}#0`)).toBeNull();
  expect(cache.getSupplierStatus(OTHER_SUPPLIER)).toBeNull();
  expect(cache.getSupplierStatus(INDEXER_SUPPLIER_PKH)?.advert_ref).toBe(`${ADVERT_2}#0`);

  // Escrow 1 is Claimed again, and its Claimed output is unspent.
  const lineage = cache.getEscrowLineage(`${ESCROW_1}#0`)!;
  expect(lineage.rows.map((r) => [r.utxo_ref, r.state, r.spent_tx])).toEqual([
    [`${ESCROW_1}#0`, "Open", CLAIM_1],
    [`${CLAIM_1}#0`, "Claimed", null],
  ]);
  expect(lineage.terminal).toBeNull();

  // Only the events of A, B and C stay.
  expect(cache.listEventsAfterSlot(0).map((e) => [e.slot, e.type, e.tx_hash])).toEqual([
    [A.slot, "PostAdvert", ADVERT_1],
    [A.slot, "PostEscrow", ESCROW_1],
    [B.slot, "ClaimEscrow", CLAIM_1],
    [B.slot, "PostAdvert", ADVERT_2],
    [C.slot, "PostAdvert", ADVERT_4],
  ]);
  expect(cache.listActiveAdvertisements().map((a) => a.utxo_ref)).toEqual([
    `${ADVERT_4}#0`,
    `${ADVERT_2}#0`,
    `${ADVERT_1}#0`,
  ]);
  expect(cache.getUnspentUtxos(ADVERT_SCRIPT_ADDRESS).map((u) => u.ref).sort()).toEqual(
    [ADVERT_1, ADVERT_2, ADVERT_4].map((tx) => `${tx}#0`).sort(),
  );
  expect(cache.getUnspentUtxos(ESCROW_SCRIPT_ADDRESS).map((u) => u.ref)).toEqual([`${CLAIM_1}#0`]);

  // The cursor and the intersection points follow the current chain.
  expect(cache.getCursor()).toEqual(C);
  expect(cache.getIntersectionPoints()).toEqual([C, B, A]);
}

describe("resync after a fork (A, B and C' indexed; C replaced C')", () => {
  it("RESYNC_FROM_* = B removes all state of C'; applying C leaves no state from C'", async () => {
    const old = await indexOrphanedBranch();
    old.worker.stop();
    const cache = old.cache;

    // The new indexer starts with RESYNC_FROM_SLOT=200 and RESYNC_FROM_BLOCK_HASH=b…b.
    expect(cache.applyResync(B)).toBe(true);
    expect(cache.getCursor()).toEqual(B);
    expect(cache.getAdvertisementByRef(`${ADVERT_3}#0`)).toBeNull();

    // It asks the node from B. Ogmios rolls back to B first, then sends C.
    const source = new MockChainSyncSource([{ kind: "rollback", point: { slot: B.slot, id: B.blockHash } }, BLOCK_C]);
    const worker = new ChainSyncWorker({ source, cache, addresses: ADDRESSES, networkId: 0 });
    await worker.start();
    expect(source.startPoints).toEqual([{ slot: B.slot, id: B.blockHash }, { slot: A.slot, id: A.blockHash }]);

    expectNoStateOfOrphanedBlock(cache);
    expect(cache.applyResync(B)).toBe(false); // once per point
    cache.close();
  });

  it("a chain-sync RollBackward to B removes all state of C'; applying C leaves no state from C'", async () => {
    const { cache, source } = await indexOrphanedBranch();

    source.pushEvent({ kind: "rollback", point: { slot: B.slot, id: B.blockHash } });
    expect(cache.getCursor()).toEqual(B);
    source.pushEvent(BLOCK_C);

    expectNoStateOfOrphanedBlock(cache);
    cache.close();
  });
});
