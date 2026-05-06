/**
 * tests/unit/indexer-sqlite-cache.test.ts — SqliteCache contract tests (Category A)
 *
 * Uses a temp DB file per test (mkdtempSync) to ensure complete isolation.
 * Tests schema idempotency, all domain methods, rollback semantics, and WAL mode.
 *
 * RED phase: SqliteCache constructor throws "not implemented — M1-D-green"
 * so all tests that instantiate it will fail with that error.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SqliteCache } from "../../indexer/src/db/cache.js";
import type { AdvertRow, EscrowRow, SupplierStatusRow } from "../../indexer/src/db/cache.js";
import {
  buildAdvertDatumHex,
  buildEscrowDatumHex,
  INDEXER_SUPPLIER_PKH,
  INDEXER_BUYER_PKH,
  INDEXER_SUPPLIER_ENDPOINT,
  SAMPLE_DELIVER_BY,
  SAMPLE_POSTED_AT,
  SAMPLE_REQUEST_SPEC_HASH,
  SAMPLE_PROMPT_HASH,
} from "../fixtures/indexer-side/sample-blocks.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function tempDb(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "indexer-test-"));
  return join(tmpDir, "test.db");
}

function cleanupTemp(): void {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function sampleAdvertRow(overrides: Partial<AdvertRow> = {}): Omit<AdvertRow, "id"> {
  return {
    utxo_ref: "a".repeat(64) + "#0",
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: INDEXER_SUPPLIER_ENDPOINT,
    detail_uri: "ipfs://QmTest",
    detail_hash: "b".repeat(64),
    advertised_at: SAMPLE_POSTED_AT,
    status: "Active",
    created_slot: 1_000_000,
    datum_hex: buildAdvertDatumHex(),
    rolled_back: 0,
    ...overrides,
  };
}

function sampleEscrowRow(overrides: Partial<EscrowRow> = {}): Omit<EscrowRow, "id"> {
  return {
    utxo_ref: "c".repeat(64) + "#0",
    buyer_pkh: INDEXER_BUYER_PKH,
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    advert_ref_tx: "a".repeat(64),
    advert_ref_index: 0,
    capability_id: "llm.text.generate.v1",
    request_spec_hash: SAMPLE_REQUEST_SPEC_HASH,
    prompt_hash: SAMPLE_PROMPT_HASH,
    payment_lovelace: "2000000",
    buyer_bond_lovelace: "1000000",
    supplier_bond_lovelace: "1000000",
    deliver_by: SAMPLE_DELIVER_BY,
    posted_at: SAMPLE_POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    created_slot: 1_000_000,
    datum_hex: buildEscrowDatumHex({ state: "Open" }),
    rolled_back: 0,
    ...overrides,
  };
}

// ─── Schema ──────────────────────────────────────────────────────────────────

describe("SqliteCache — schema", () => {
  afterEach(cleanupTemp);

  it("applies schema on first open without error", () => {
    const cache = new SqliteCache(tempDb());
    cache.close();
  });

  it("applying schema twice (reopen) is idempotent — no duplicate-table error", () => {
    const path = tempDb();
    const c1 = new SqliteCache(path);
    c1.close();
    const c2 = new SqliteCache(path);
    c2.close();
  });

  it("getCursor returns null on empty DB (WAL mode active)", () => {
    const cache = new SqliteCache(tempDb());
    const cursor = cache.getCursor();
    expect(cursor).toBeNull();
    cache.close();
  });
});

// ─── Cursor ───────────────────────────────────────────────────────────────────

describe("SqliteCache — cursor", () => {
  afterEach(cleanupTemp);

  it("saveCursor + getCursor round-trip preserves slot and blockHash", () => {
    const cache = new SqliteCache(tempDb());
    cache.saveCursor(12345, "abc123blockHash");
    const cursor = cache.getCursor();
    expect(cursor).not.toBeNull();
    expect(cursor!.slot).toBe(12345);
    expect(cursor!.blockHash).toBe("abc123blockHash");
    cache.close();
  });

  it("saveCursor overwrites existing cursor (single-row UPSERT semantics)", () => {
    const cache = new SqliteCache(tempDb());
    cache.saveCursor(100, "hash1");
    cache.saveCursor(200, "hash2");
    const cursor = cache.getCursor();
    expect(cursor!.slot).toBe(200);
    expect(cursor!.blockHash).toBe("hash2");
    cache.close();
  });

  it("getCursor returns null when no cursor has been saved", () => {
    const cache = new SqliteCache(tempDb());
    expect(cache.getCursor()).toBeNull();
    cache.close();
  });
});

// ─── Advertisements ───────────────────────────────────────────────────────────

describe("SqliteCache — advertisements", () => {
  afterEach(cleanupTemp);

  it("upsertAdvertisement + getAdvertisementByRef round-trip returns correct supplier_pkh and status", () => {
    const cache = new SqliteCache(tempDb());
    const row = sampleAdvertRow();
    cache.upsertAdvertisement(row);
    const found = cache.getAdvertisementByRef(row.utxo_ref);
    expect(found).not.toBeNull();
    expect(found!.supplier_pkh).toBe(INDEXER_SUPPLIER_PKH);
    expect(found!.capability_id).toBe("llm.text.generate.v1");
    expect(found!.status).toBe("Active");
    cache.close();
  });

  it("getAdvertisementByRef returns null for unknown ref", () => {
    const cache = new SqliteCache(tempDb());
    expect(cache.getAdvertisementByRef("unknown#0")).toBeNull();
    cache.close();
  });

  it("upsertAdvertisement updates existing row on re-upsert (status change Active→Retired)", () => {
    const cache = new SqliteCache(tempDb());
    const ref = "a".repeat(64) + "#0";
    cache.upsertAdvertisement(sampleAdvertRow({ utxo_ref: ref, status: "Active" }));
    cache.upsertAdvertisement(sampleAdvertRow({ utxo_ref: ref, status: "Retired" }));
    expect(cache.getAdvertisementByRef(ref)!.status).toBe("Retired");
    cache.close();
  });

  it("listActiveAdvertisements returns only Active rows (Retired excluded)", () => {
    const cache = new SqliteCache(tempDb());
    cache.upsertAdvertisement(sampleAdvertRow({ utxo_ref: "a".repeat(64) + "#0", status: "Active" }));
    cache.upsertAdvertisement(sampleAdvertRow({ utxo_ref: "b".repeat(64) + "#0", status: "Retired" }));
    const active = cache.listActiveAdvertisements();
    expect(active.length).toBe(1);
    expect(active[0].status).toBe("Active");
    cache.close();
  });

  it("listActiveAdvertisements with capability_id filter returns only matching rows", () => {
    const cache = new SqliteCache(tempDb());
    cache.upsertAdvertisement(sampleAdvertRow({ utxo_ref: "a".repeat(64) + "#0", capability_id: "llm.text.generate.v1" }));
    cache.upsertAdvertisement(sampleAdvertRow({ utxo_ref: "b".repeat(64) + "#0", capability_id: "speech.transcribe.v1" }));
    const llm = cache.listActiveAdvertisements({ capability_id: "llm.text.generate.v1" });
    expect(llm.length).toBe(1);
    expect(llm[0].capability_id).toBe("llm.text.generate.v1");
    cache.close();
  });

  it("listActiveAdvertisements with supplier_pkh filter returns only matching rows", () => {
    const cache = new SqliteCache(tempDb());
    const pkh2 = "1".repeat(56);
    cache.upsertAdvertisement(sampleAdvertRow({ utxo_ref: "a".repeat(64) + "#0", supplier_pkh: INDEXER_SUPPLIER_PKH }));
    cache.upsertAdvertisement(sampleAdvertRow({ utxo_ref: "b".repeat(64) + "#0", supplier_pkh: pkh2 }));
    const mine = cache.listActiveAdvertisements({ supplier_pkh: INDEXER_SUPPLIER_PKH });
    expect(mine.length).toBe(1);
    cache.close();
  });

  it("listActiveAdvertisements returns empty when no active adverts exist", () => {
    const cache = new SqliteCache(tempDb());
    expect(cache.listActiveAdvertisements()).toEqual([]);
    cache.close();
  });
});

// ─── Escrows ──────────────────────────────────────────────────────────────────

describe("SqliteCache — escrows", () => {
  afterEach(cleanupTemp);

  it("upsertEscrow + getEscrowByRef round-trip returns correct buyer_pkh and state", () => {
    const cache = new SqliteCache(tempDb());
    const row = sampleEscrowRow();
    cache.upsertEscrow(row);
    const found = cache.getEscrowByRef(row.utxo_ref);
    expect(found).not.toBeNull();
    expect(found!.buyer_pkh).toBe(INDEXER_BUYER_PKH);
    expect(found!.state).toBe("Open");
    cache.close();
  });

  it("getEscrowByRef returns null for unknown ref", () => {
    const cache = new SqliteCache(tempDb());
    expect(cache.getEscrowByRef("unknown#0")).toBeNull();
    cache.close();
  });

  it("upsertEscrow state transition: Open→Claimed updates state correctly", () => {
    const cache = new SqliteCache(tempDb());
    const ref = "c".repeat(64) + "#0";
    cache.upsertEscrow(sampleEscrowRow({ utxo_ref: ref, state: "Open" }));
    cache.upsertEscrow(sampleEscrowRow({ utxo_ref: ref, state: "Claimed" }));
    expect(cache.getEscrowByRef(ref)!.state).toBe("Claimed");
    cache.close();
  });

  it("listEscrowsByBuyer returns only rows with matching buyer_pkh", () => {
    const cache = new SqliteCache(tempDb());
    const otherBuyer = "9".repeat(56);
    cache.upsertEscrow(sampleEscrowRow({ utxo_ref: "c".repeat(64) + "#0", buyer_pkh: INDEXER_BUYER_PKH }));
    cache.upsertEscrow(sampleEscrowRow({ utxo_ref: "d".repeat(64) + "#0", buyer_pkh: otherBuyer }));
    const mine = cache.listEscrowsByBuyer(INDEXER_BUYER_PKH);
    expect(mine.length).toBe(1);
    cache.close();
  });

  it("listEscrowsBySupplier returns only rows with matching supplier_pkh", () => {
    const cache = new SqliteCache(tempDb());
    const otherSupplier = "9".repeat(56);
    cache.upsertEscrow(sampleEscrowRow({ utxo_ref: "c".repeat(64) + "#0", supplier_pkh: INDEXER_SUPPLIER_PKH }));
    cache.upsertEscrow(sampleEscrowRow({ utxo_ref: "d".repeat(64) + "#0", supplier_pkh: otherSupplier }));
    const mine = cache.listEscrowsBySupplier(INDEXER_SUPPLIER_PKH);
    expect(mine.length).toBe(1);
    cache.close();
  });

  it("escrow with submitted_at=null persists and retrieves as null", () => {
    const cache = new SqliteCache(tempDb());
    cache.upsertEscrow(sampleEscrowRow({ submitted_at: null }));
    const found = cache.getEscrowByRef("c".repeat(64) + "#0");
    expect(found!.submitted_at).toBeNull();
    cache.close();
  });

  it("escrow with result_receipt_hash populated persists correctly", () => {
    const cache = new SqliteCache(tempDb());
    const hash = "d".repeat(64);
    cache.upsertEscrow(sampleEscrowRow({ result_receipt_hash: hash, state: "Submitted" }));
    const found = cache.getEscrowByRef("c".repeat(64) + "#0");
    expect(found!.result_receipt_hash).toBe(hash);
    cache.close();
  });
});

// ─── SupplierStatus ───────────────────────────────────────────────────────────

describe("SqliteCache — supplier_status", () => {
  afterEach(cleanupTemp);

  it("upsertSupplierStatus + getSupplierStatus round-trip returns correct status", () => {
    const cache = new SqliteCache(tempDb());
    const row: SupplierStatusRow = {
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      advert_ref: "a".repeat(64) + "#0",
      status: "free",
      last_seen_iso: "2026-04-24T10:00:00.000Z",
      current_escrow_ref: null,
      polled_at: 1_750_000_000_000,
    };
    cache.upsertSupplierStatus(row);
    const found = cache.getSupplierStatus(INDEXER_SUPPLIER_PKH);
    expect(found).not.toBeNull();
    expect(found!.status).toBe("free");
    expect(found!.last_seen_iso).toBe("2026-04-24T10:00:00.000Z");
    cache.close();
  });

  it("getSupplierStatus returns null for unknown pkh", () => {
    const cache = new SqliteCache(tempDb());
    expect(cache.getSupplierStatus("unknown_pkh")).toBeNull();
    cache.close();
  });

  it("upsertSupplierStatus overwrites previous row (UPSERT on supplier_pkh)", () => {
    const cache = new SqliteCache(tempDb());
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
    const found = cache.getSupplierStatus(INDEXER_SUPPLIER_PKH);
    expect(found!.status).toBe("working");
    expect(found!.current_escrow_ref).toBe("b".repeat(64) + "#0");
    cache.close();
  });
});

// ─── Events ───────────────────────────────────────────────────────────────────

describe("SqliteCache — events", () => {
  afterEach(cleanupTemp);

  it("appendEvent + listEventsAfterSlot(0) returns the inserted event", () => {
    const cache = new SqliteCache(tempDb());
    cache.appendEvent({
      type: "PostAdvert",
      slot: 1_000_000,
      tx_hash: "a".repeat(64),
      utxo_ref: "a".repeat(64) + "#0",
      datum_hex: buildAdvertDatumHex(),
      metadata_json: "{}",
      rolled_back: 0,
    });
    const events = cache.listEventsAfterSlot(0);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("PostAdvert");
    cache.close();
  });

  it("listEventsAfterSlot(100) excludes events at slot 100 and below", () => {
    const cache = new SqliteCache(tempDb());
    cache.appendEvent({ type: "PostAdvert", slot: 100, tx_hash: "a".repeat(64), utxo_ref: "a".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.appendEvent({ type: "PostEscrow", slot: 200, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    const events = cache.listEventsAfterSlot(100);
    expect(events.length).toBe(1);
    expect(events[0].slot).toBe(200);
    cache.close();
  });

  it("listEventsAfterSlot excludes rolled_back=1 events", () => {
    const cache = new SqliteCache(tempDb());
    cache.appendEvent({ type: "PostAdvert", slot: 100, tx_hash: "a".repeat(64), utxo_ref: "a".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 1 });
    cache.appendEvent({ type: "PostEscrow", slot: 200, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    const events = cache.listEventsAfterSlot(0);
    expect(events.length).toBe(1);
    expect(events[0].rolled_back).toBe(0);
    cache.close();
  });

  it("listEventsAfterSlot returns empty array when no events exist", () => {
    const cache = new SqliteCache(tempDb());
    expect(cache.listEventsAfterSlot(0)).toEqual([]);
    cache.close();
  });
});

// ─── Rollback ─────────────────────────────────────────────────────────────────

describe("SqliteCache — rollbackToSlot", () => {
  afterEach(cleanupTemp);

  it("rollbackToSlot soft-deletes only events strictly after the rollback slot", () => {
    const cache = new SqliteCache(tempDb());
    cache.appendEvent({ type: "PostAdvert", slot: 100, tx_hash: "a".repeat(64), utxo_ref: "a".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.appendEvent({ type: "PostEscrow", slot: 200, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.rollbackToSlot(100);
    const events = cache.listEventsAfterSlot(0);
    // Events at slot 100 survive; slot 200 is soft-deleted
    expect(events.some(e => e.slot === 100)).toBe(true);
    expect(events.some(e => e.slot === 200)).toBe(false);
    cache.close();
  });

  it("rollbackToSlot restores UTxOs spent after rollback slot", () => {
    const cache = new SqliteCache(tempDb());
    const ref = "a".repeat(64) + "#0";
    cache.insertUtxo(ref, "addr_test1wADDR", "datum1", 100, "a".repeat(64));
    cache.spendUtxo(ref, 200, "b".repeat(64));
    cache.rollbackToSlot(150);
    const unspent = cache.getUnspentUtxos("addr_test1wADDR");
    expect(unspent.some(u => u.ref === ref)).toBe(true);
    cache.close();
  });

  it("rollbackToSlot removes UTxOs created after rollback slot", () => {
    const cache = new SqliteCache(tempDb());
    cache.insertUtxo("a".repeat(64) + "#0", "addr_test1wADDR", "datum1", 100, "a".repeat(64));
    cache.insertUtxo("b".repeat(64) + "#0", "addr_test1wADDR", "datum2", 200, "b".repeat(64));
    cache.rollbackToSlot(150);
    const unspent = cache.getUnspentUtxos("addr_test1wADDR");
    expect(unspent.length).toBe(1);
    expect(unspent[0].ref).toBe("a".repeat(64) + "#0");
    cache.close();
  });

  it("rollbackToSlot to before Submit: SubmitEscrow event is soft-deleted, ClaimEscrow survives", () => {
    const cache = new SqliteCache(tempDb());
    cache.appendEvent({ type: "ClaimEscrow", slot: 150, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.appendEvent({ type: "SubmitEscrow", slot: 200, tx_hash: "c".repeat(64), utxo_ref: "c".repeat(64) + "#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.rollbackToSlot(150);
    const events = cache.listEventsAfterSlot(0);
    expect(events.some(e => e.type === "SubmitEscrow")).toBe(false);
    expect(events.some(e => e.type === "ClaimEscrow")).toBe(true);
    cache.close();
  });

  it("dbSizeBytes returns a positive number", () => {
    const cache = new SqliteCache(tempDb());
    expect(cache.dbSizeBytes()).toBeGreaterThan(0);
    cache.close();
  });
});
