/**
 * tests/unit/indexer-sqlite-cache.test.ts — SqliteCache contract tests.
 *
 * Each test uses its own in-memory database. Only the tests that need a file open one: reopening a database, and the size of
 * the database file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AmbiguousEscrowLineageError, SqliteCache } from "../../indexer/src/db/cache.js";
import type { AdvertRow, EscrowRow, SupplierStatusRow } from "../../indexer/src/db/cache.js";
import {
  buildAdvertDatumHex,
  INDEXER_BUYER_PKH,
  INDEXER_SUPPLIER_PKH,
  SAMPLE_POSTED_AT,
} from "../fixtures/indexer-side/sample-blocks.js";
import { makeAdvertRow, makeEscrowRow } from "../fixtures/indexer-side/rows.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const opened: SqliteCache[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const cache of opened.splice(0)) cache.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(path = ":memory:"): SqliteCache {
  const cache = new SqliteCache(path);
  opened.push(cache);
  return cache;
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "indexer-test-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

/** A block point whose hash is derived from the slot. */
function blockAt(slot: number): { slot: number; blockHash: string } {
  return { slot, blockHash: slot.toString(16).padStart(64, "0") };
}

function insertEscrowState(
  cache: SqliteCache,
  row: EscrowRow,
  createdSlot: number,
  createdTx: string,
): void {
  cache.upsertEscrow({ ...row, created_slot: createdSlot });
  cache.insertUtxo(
    row.utxo_ref,
    "addr_test1wESCROW",
    row.datum_hex,
    createdSlot,
    createdTx,
  );
}

// ─── Schema and file ─────────────────────────────────────────────────────────

describe("SqliteCache — database file", () => {
  it("keeps its data when the database is opened again (the schema is applied twice without error)", () => {
    const path = tempDbPath();
    const advert = makeAdvertRow();
    const first = open(path);
    first.saveCursor(12_345, "abc123blockHash");
    first.upsertAdvertisement(advert);
    first.close();

    const second = open(path);

    expect(second.getCursor()).toEqual({ slot: 12_345, blockHash: "abc123blockHash" });
    expect(second.getAdvertisementByRef(advert.utxo_ref)?.supplier_pkh).toBe(INDEXER_SUPPLIER_PKH);
  });

  it("dbSizeBytes is the size of the database file", () => {
    const path = tempDbPath();
    const cache = open(path);
    cache.upsertAdvertisement(makeAdvertRow());

    expect(cache.dbSizeBytes()).toBe(statSync(path).size);
    expect(cache.dbSizeBytes()).toBeGreaterThan(0);
  });
});

// ─── Cursor ───────────────────────────────────────────────────────────────────

describe("SqliteCache — cursor", () => {
  it("has no cursor until one is saved; saveCursor then getCursor returns slot and blockHash", () => {
    const cache = open();
    expect(cache.getCursor()).toBeNull();

    cache.saveCursor(12345, "abc123blockHash");

    expect(cache.getCursor()).toEqual({ slot: 12345, blockHash: "abc123blockHash" });
  });

  it("saveCursor overwrites the existing cursor (single-row UPSERT semantics)", () => {
    const cache = open();
    cache.saveCursor(100, "hash1");
    cache.saveCursor(200, "hash2");

    expect(cache.getCursor()).toEqual({ slot: 200, blockHash: "hash2" });
  });
});

// ─── Advertisements ───────────────────────────────────────────────────────────

describe("SqliteCache — advertisements", () => {
  it("upsertAdvertisement + getAdvertisementByRef round-trip returns the stored row; a row without identity fields gets the legacy defaults", () => {
    const cache = open();
    const { layout: _layout, agent_id: _agent, creator_signed: _signed, ...row } = makeAdvertRow();
    cache.upsertAdvertisement(row);

    expect(cache.getAdvertisementByRef(row.utxo_ref)).toMatchObject({
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      capability_id: "llm.text.generate.v1",
      status: "Active",
      layout: "legacy",
      agent_id: null,
      creator_signed: 0,
    });
  });

  it("getAdvertisementByRef returns null for unknown ref", () => {
    expect(open().getAdvertisementByRef("unknown#0")).toBeNull();
  });

  it("upsertAdvertisement updates existing row on re-upsert (status change Active→Retired)", () => {
    const cache = open();
    const ref = "a".repeat(64) + "#0";
    cache.upsertAdvertisement(makeAdvertRow({ utxo_ref: ref, status: "Active" }));
    cache.upsertAdvertisement(makeAdvertRow({ utxo_ref: ref, status: "Retired" }));

    expect(cache.getAdvertisementByRef(ref)!.status).toBe("Retired");
  });

  it("listActiveAdvertisements returns only Active rows (Retired excluded)", () => {
    const cache = open();
    cache.upsertAdvertisement(makeAdvertRow({ utxo_ref: "a".repeat(64) + "#0", status: "Active" }));
    cache.upsertAdvertisement(makeAdvertRow({ utxo_ref: "b".repeat(64) + "#0", status: "Retired" }));

    const active = cache.listActiveAdvertisements();

    expect(active.map((row) => [row.utxo_ref, row.status])).toEqual([["a".repeat(64) + "#0", "Active"]]);
  });

  it("listActiveAdvertisements with capability_id filter returns only matching rows", () => {
    const cache = open();
    cache.upsertAdvertisement(makeAdvertRow({ utxo_ref: "a".repeat(64) + "#0", capability_id: "llm.text.generate.v1" }));
    cache.upsertAdvertisement(makeAdvertRow({ utxo_ref: "b".repeat(64) + "#0", capability_id: "speech.transcribe.v1" }));

    const llm = cache.listActiveAdvertisements({ capability_id: "llm.text.generate.v1" });

    expect(llm.map((row) => row.capability_id)).toEqual(["llm.text.generate.v1"]);
  });

  it("listActiveAdvertisements with supplier_pkh filter returns only matching rows", () => {
    const cache = open();
    cache.upsertAdvertisement(makeAdvertRow({ utxo_ref: "a".repeat(64) + "#0", supplier_pkh: INDEXER_SUPPLIER_PKH }));
    cache.upsertAdvertisement(makeAdvertRow({ utxo_ref: "b".repeat(64) + "#0", supplier_pkh: "1".repeat(56) }));

    const mine = cache.listActiveAdvertisements({ supplier_pkh: INDEXER_SUPPLIER_PKH });

    expect(mine.map((row) => row.supplier_pkh)).toEqual([INDEXER_SUPPLIER_PKH]);
  });
});

// ─── Escrows ──────────────────────────────────────────────────────────────────

describe("SqliteCache — escrows", () => {
  it.each([
    { name: "Open, with no identity fields: submitted_at and result_receipt_hash are null, the legacy defaults are stored", fields: {}, identityFields: false },
    {
      name: "Submitted: submitted_at and result_receipt_hash are stored",
      fields: { state: "Submitted", submitted_at: SAMPLE_POSTED_AT + 1_000, result_receipt_hash: "d".repeat(64) },
      identityFields: true,
    },
  ])("upsertEscrow + getEscrowByRef round-trip returns every stored column ($name)", ({ fields, identityFields }) => {
    const cache = open();
    const row = makeEscrowRow(fields);
    const { layout: _layout, agent_id: _agent, refund_address: _refund, refund_datum: _datum, ...legacyRow } = row;
    cache.upsertEscrow(identityFields ? row : legacyRow);

    // `row` holds the legacy defaults: the stored row must equal it in every column.
    expect(cache.getEscrowByRef(row.utxo_ref)).toMatchObject(row);
  });

  it("getEscrowByRef returns null for unknown ref", () => {
    expect(open().getEscrowByRef("unknown#0")).toBeNull();
  });

  it("upsertEscrow state transition: Open→Claimed updates state correctly", () => {
    const cache = open();
    const ref = "c".repeat(64) + "#0";
    cache.upsertEscrow(makeEscrowRow({ utxo_ref: ref, state: "Open" }));
    cache.upsertEscrow(makeEscrowRow({ utxo_ref: ref, state: "Claimed" }));

    expect(cache.getEscrowByRef(ref)!.state).toBe("Claimed");
  });

  it("listEscrowsByBuyer returns only rows with matching buyer_pkh", () => {
    const cache = open();
    cache.upsertEscrow(makeEscrowRow({ utxo_ref: "c".repeat(64) + "#0", buyer_pkh: INDEXER_BUYER_PKH }));
    cache.upsertEscrow(makeEscrowRow({ utxo_ref: "d".repeat(64) + "#0", buyer_pkh: "9".repeat(56) }));

    expect(cache.listEscrowsByBuyer(INDEXER_BUYER_PKH).map((row) => row.buyer_pkh)).toEqual([INDEXER_BUYER_PKH]);
  });

  it("listEscrowsBySupplier returns only rows with matching supplier_pkh", () => {
    const cache = open();
    cache.upsertEscrow(makeEscrowRow({ utxo_ref: "c".repeat(64) + "#0", supplier_pkh: INDEXER_SUPPLIER_PKH }));
    cache.upsertEscrow(makeEscrowRow({ utxo_ref: "d".repeat(64) + "#0", supplier_pkh: "9".repeat(56) }));

    expect(cache.listEscrowsBySupplier(INDEXER_SUPPLIER_PKH).map((row) => row.supplier_pkh)).toEqual([INDEXER_SUPPLIER_PKH]);
  });
});

describe("SqliteCache — escrow lineage", () => {
  it("uses spent transactions and immutable identity when same-time escrows transition together", () => {
    const cache = open();
    const openA = `${"1".repeat(64)}#0`;
    const openB = `${"2".repeat(64)}#0`;
    const transitionTx = "3".repeat(64);
    const claimedA = `${transitionTx}#0`;
    const claimedB = `${transitionTx}#1`;
    const rowA = makeEscrowRow({
      utxo_ref: openA,
      prompt_hash: "a".repeat(64),
    });
    const rowB = makeEscrowRow({
      utxo_ref: openB,
      prompt_hash: "b".repeat(64),
    });
    insertEscrowState(cache, rowA, 100, "1".repeat(64));
    insertEscrowState(cache, rowB, 100, "2".repeat(64));
    cache.spendUtxo(openA, 200, transitionTx);
    cache.spendUtxo(openB, 200, transitionTx);
    insertEscrowState(
      cache,
      { ...rowA, utxo_ref: claimedA, state: "Claimed" },
      200,
      transitionTx,
    );
    insertEscrowState(
      cache,
      { ...rowB, utxo_ref: claimedB, state: "Claimed" },
      200,
      transitionTx,
    );

    const lineage = cache.getEscrowLineage(openA);

    expect(lineage?.rows.map((row) => row.utxo_ref)).toEqual([openA, claimedA]);
    expect(lineage?.rows[0].spent_tx).toBe(transitionTx);
  });

  it("fails closed when one spend has multiple matching continuations", () => {
    const cache = open();
    const openRef = `${"4".repeat(64)}#0`;
    const transitionTx = "5".repeat(64);
    const escrow = makeEscrowRow({ utxo_ref: openRef });
    insertEscrowState(cache, escrow, 100, "4".repeat(64));
    cache.spendUtxo(openRef, 200, transitionTx);
    insertEscrowState(
      cache,
      { ...escrow, utxo_ref: `${transitionTx}#0`, state: "Claimed" },
      200,
      transitionTx,
    );
    insertEscrowState(
      cache,
      { ...escrow, utxo_ref: `${transitionTx}#1`, state: "Claimed" },
      200,
      transitionTx,
    );

    expect(() => cache.getEscrowLineage(openRef)).toThrow(AmbiguousEscrowLineageError);
  });

  it("reports an observed terminal spend and rewinds to the last live row on rollback", () => {
    const cache = open();
    const openRef = `${"6".repeat(64)}#0`;
    const claimTx = "7".repeat(64);
    const claimedRef = `${claimTx}#0`;
    const submitTx = "8".repeat(64);
    const submittedRef = `${submitTx}#0`;
    const acceptTx = "9".repeat(64);
    const escrow = makeEscrowRow({ utxo_ref: openRef });
    const claimed = { ...escrow, utxo_ref: claimedRef, state: "Claimed" };
    const submitted = {
      ...escrow,
      utxo_ref: submittedRef,
      state: "Submitted",
      submitted_at: SAMPLE_POSTED_AT + 1_000,
      result_receipt_hash: "e".repeat(64),
    };
    insertEscrowState(cache, escrow, 100, "6".repeat(64));
    cache.spendUtxo(openRef, 200, claimTx);
    insertEscrowState(cache, claimed, 200, claimTx);
    cache.spendUtxo(claimedRef, 300, submitTx);
    insertEscrowState(cache, submitted, 300, submitTx);
    cache.spendUtxo(submittedRef, 400, acceptTx);
    cache.appendEvent({
      type: "AcceptEscrow",
      slot: 400,
      tx_hash: acceptTx,
      utxo_ref: submittedRef,
      datum_hex: submitted.datum_hex,
      metadata_json: "{}",
      rolled_back: 0,
    });

    expect(cache.getEscrowLineage(openRef)?.terminal).toEqual({
      type: "AcceptEscrow",
      tx_hash: acceptTx,
    });

    cache.rollbackTo(blockAt(250));
    const rewound = cache.getEscrowLineage(openRef);
    expect(rewound?.rows.map((row) => row.utxo_ref)).toEqual([openRef, claimedRef]);
    expect(rewound?.rows[1].spent_tx).toBeNull();
    expect(rewound?.terminal).toBeNull();
  });

  it("does not infer a terminal state from a spent output without an event", () => {
    const cache = open();
    const submittedRef = `${"a".repeat(64)}#2`;
    const spendTx = "b".repeat(64);
    const submitted = makeEscrowRow({
      utxo_ref: submittedRef,
      state: "Submitted",
      submitted_at: SAMPLE_POSTED_AT + 1_000,
      result_receipt_hash: "e".repeat(64),
    });
    insertEscrowState(cache, submitted, 100, "a".repeat(64));
    cache.spendUtxo(submittedRef, 200, spendTx);

    const lineage = cache.getEscrowLineage(submittedRef);

    expect(lineage?.rows[0].spent_tx).toBe(spendTx);
    expect(lineage?.terminal).toBeNull();
  });
});

// ─── SupplierStatus ───────────────────────────────────────────────────────────

describe("SqliteCache — supplier_status", () => {
  it("upsertSupplierStatus + getSupplierStatus round-trip returns correct status", () => {
    const cache = open();
    const row: SupplierStatusRow = {
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      advert_ref: "a".repeat(64) + "#0",
      status: "free",
      last_seen_iso: "2026-04-24T10:00:00.000Z",
      current_escrow_ref: null,
      polled_at: 1_750_000_000_000,
    };
    cache.upsertSupplierStatus(row);

    expect(cache.getSupplierStatus(INDEXER_SUPPLIER_PKH)).toMatchObject({
      status: "free",
      last_seen_iso: "2026-04-24T10:00:00.000Z",
    });
  });

  it("getSupplierStatus returns null for unknown pkh", () => {
    expect(open().getSupplierStatus("unknown_pkh")).toBeNull();
  });

  it("upsertSupplierStatus overwrites previous row (UPSERT on supplier_pkh)", () => {
    const cache = open();
    cache.upsertSupplierStatus({
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      advert_ref: "a".repeat(64) + "#0",
      status: "free",
      last_seen_iso: "2026-04-24T10:00:00.000Z",
      current_escrow_ref: null,
      polled_at: 1000,
    });
    cache.upsertSupplierStatus({
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      advert_ref: "a".repeat(64) + "#0",
      status: "working",
      last_seen_iso: "2026-04-24T10:01:00.000Z",
      current_escrow_ref: "b".repeat(64) + "#0",
      polled_at: 2000,
    });

    expect(cache.getSupplierStatus(INDEXER_SUPPLIER_PKH)).toMatchObject({
      status: "working",
      current_escrow_ref: "b".repeat(64) + "#0",
    });
  });
});

// ─── Events ───────────────────────────────────────────────────────────────────

describe("SqliteCache — events", () => {
  it("appendEvent + listEventsAfterSlot(0) returns the inserted event", () => {
    const cache = open();
    cache.appendEvent({
      type: "PostAdvert",
      slot: 1_000_000,
      tx_hash: "a".repeat(64),
      utxo_ref: "a".repeat(64) + "#0",
      datum_hex: buildAdvertDatumHex(),
      metadata_json: "{}",
      rolled_back: 0,
    });

    expect(cache.listEventsAfterSlot(0).map((event) => event.type)).toEqual(["PostAdvert"]);
  });

  it("listEventsAfterSlot(100) excludes events at slot 100 and below", () => {
    const cache = open();
    cache.appendEvent({ type: "PostAdvert", slot: 100, tx_hash: "a".repeat(64), utxo_ref: "a".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.appendEvent({ type: "PostEscrow", slot: 200, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });

    expect(cache.listEventsAfterSlot(100).map((event) => event.slot)).toEqual([200]);
  });

  it("listEventsAfterSlot excludes rolled_back=1 events", () => {
    const cache = open();
    cache.appendEvent({ type: "PostAdvert", slot: 100, tx_hash: "a".repeat(64), utxo_ref: "a".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 1 });
    cache.appendEvent({ type: "PostEscrow", slot: 200, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });

    expect(cache.listEventsAfterSlot(0).map((event) => [event.type, event.rolled_back])).toEqual([["PostEscrow", 0]]);
  });
});

// ─── Rollback ─────────────────────────────────────────────────────────────────

describe("SqliteCache — rollbackTo", () => {
  it("rollbackTo soft-deletes only events strictly after the rollback slot", () => {
    const cache = open();
    cache.appendEvent({ type: "PostAdvert", slot: 100, tx_hash: "a".repeat(64), utxo_ref: "a".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.appendEvent({ type: "PostEscrow", slot: 200, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.rollbackTo(blockAt(100));

    // Events at slot 100 survive; slot 200 is soft-deleted
    expect(cache.listEventsAfterSlot(0).map((event) => event.slot)).toEqual([100]);
  });

  it("rollbackTo restores UTxOs spent after rollback slot", () => {
    const cache = open();
    const ref = "a".repeat(64) + "#0";
    cache.insertUtxo(ref, "addr_test1wADDR", "datum1", 100, "a".repeat(64));
    cache.spendUtxo(ref, 200, "b".repeat(64));
    cache.rollbackTo(blockAt(150));

    expect(cache.getUnspentUtxos("addr_test1wADDR").map((u) => u.ref)).toEqual([ref]);
  });

  it("rollbackTo removes UTxOs created after rollback slot", () => {
    const cache = open();
    cache.insertUtxo("a".repeat(64) + "#0", "addr_test1wADDR", "datum1", 100, "a".repeat(64));
    cache.insertUtxo("b".repeat(64) + "#0", "addr_test1wADDR", "datum2", 200, "b".repeat(64));
    cache.rollbackTo(blockAt(150));

    expect(cache.getUnspentUtxos("addr_test1wADDR").map((u) => u.ref)).toEqual(["a".repeat(64) + "#0"]);
  });

  it("rollbackTo to before Submit: SubmitEscrow event is soft-deleted, ClaimEscrow survives", () => {
    const cache = open();
    cache.appendEvent({ type: "ClaimEscrow", slot: 150, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.appendEvent({ type: "SubmitEscrow", slot: 200, tx_hash: "c".repeat(64), utxo_ref: "c".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.rollbackTo(blockAt(150));

    expect(cache.listEventsAfterSlot(0).map((event) => event.type)).toEqual(["ClaimEscrow"]);
  });

  it("rollbackTo removes the adverts, escrows and supplier status that later blocks wrote", () => {
    const cache = open();
    const otherSupplier = "dd".repeat(28);
    const kept = makeAdvertRow({ utxo_ref: `${"1".repeat(64)}#0`, created_slot: 100 });
    const later = makeAdvertRow({ utxo_ref: `${"2".repeat(64)}#0`, supplier_pkh: otherSupplier, created_slot: 200 });
    cache.upsertAdvertisement(kept);
    cache.upsertAdvertisement(later);
    cache.upsertEscrow(makeEscrowRow({ utxo_ref: `${"3".repeat(64)}#0`, created_slot: 100 }));
    cache.upsertEscrow(makeEscrowRow({ utxo_ref: `${"4".repeat(64)}#0`, created_slot: 200 }));
    const status = (supplierPkh: string, advertRef: string): SupplierStatusRow => ({
      supplier_pkh: supplierPkh, advert_ref: advertRef, status: "free",
      last_seen_iso: "2026-11-01T00:00:00.000Z", current_escrow_ref: null, polled_at: 1,
    });
    cache.upsertSupplierStatus(status(INDEXER_SUPPLIER_PKH, kept.utxo_ref));
    cache.upsertSupplierStatus(status(otherSupplier, later.utxo_ref));

    cache.rollbackTo(blockAt(150));

    expect(cache.getAdvertisementByRef(kept.utxo_ref)).not.toBeNull();
    expect(cache.getAdvertisementByRef(later.utxo_ref)).toBeNull();
    expect(cache.getEscrowByRef(`${"3".repeat(64)}#0`)).not.toBeNull();
    expect(cache.getEscrowByRef(`${"4".repeat(64)}#0`)).toBeNull();
    expect(cache.getSupplierStatus(INDEXER_SUPPLIER_PKH)?.advert_ref).toBe(kept.utxo_ref);
    expect(cache.getSupplierStatus(otherSupplier)).toBeNull();
  });

  it("rollbackTo gives an advert that a later block retired the status of its datum again", () => {
    const cache = open();
    const retire = (advert: AdvertRow, slot: number): void => {
      cache.appendEvent({
        type: "RetireAdvert", slot, tx_hash: slot.toString(16).padStart(64, "0"), utxo_ref: advert.utxo_ref,
        datum_hex: advert.datum_hex, metadata_json: "{}", rolled_back: 0,
      });
      cache.markAdvertisementRetired(advert.utxo_ref);
    };
    const early = makeAdvertRow({ utxo_ref: `${"1".repeat(64)}#0`, created_slot: 100 });
    const late = makeAdvertRow({ utxo_ref: `${"2".repeat(64)}#0`, created_slot: 100 });
    cache.upsertAdvertisement(early);
    cache.upsertAdvertisement(late);
    retire(early, 120);
    retire(late, 200);
    expect(cache.listActiveAdvertisements()).toEqual([]);

    cache.rollbackTo(blockAt(150));

    expect(cache.getAdvertisementByRef(early.utxo_ref)?.status).toBe("Retired");
    expect(cache.getAdvertisementByRef(late.utxo_ref)?.status).toBe("Active");
    expect(cache.listActiveAdvertisements().map((a) => a.utxo_ref)).toEqual([late.utxo_ref]);
  });

  it("rollbackTo moves the cursor and the intersection points to the exact block (slot and hash)", () => {
    const cache = open();
    for (const slot of [100, 200, 300]) cache.saveCursor(slot, blockAt(slot).blockHash);

    cache.rollbackTo(blockAt(200));
    expect(cache.getCursor()).toEqual(blockAt(200));
    expect(cache.getIntersectionPoints()).toEqual([blockAt(200), blockAt(100)]);

    const between = { slot: 150, blockHash: "e".repeat(64) };
    cache.rollbackTo(between);
    expect(cache.getCursor()).toEqual(between);
    expect(cache.getIntersectionPoints()).toEqual([between, blockAt(100)]);
  });

  it("rollbackTo the origin removes all chain data", () => {
    const cache = open();
    const advert = makeAdvertRow({ created_slot: 0 });
    cache.upsertAdvertisement(advert);
    cache.insertUtxo(advert.utxo_ref, "addr_test1wADDR", advert.datum_hex, 0, "a".repeat(64));
    cache.saveCursor(0, blockAt(0).blockHash);

    cache.rollbackTo(null);

    expect(cache.getCursor()).toBeNull();
    expect(cache.getIntersectionPoints()).toEqual([]);
    expect(cache.getUnspentUtxos("addr_test1wADDR")).toEqual([]);
    expect(cache.getAdvertisementByRef(advert.utxo_ref)).toBeNull();
  });
});
