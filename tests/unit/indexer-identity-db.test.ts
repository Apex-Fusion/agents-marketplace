/**
 * tests/unit/indexer-identity-db.test.ts — schema migration, resync, rollback and lineage
 * for the identity registry.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteCache, type EscrowUpsert } from "../../indexer/src/db/cache.js";
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from "../../indexer/src/db/schema.js";
import {
  INDEXER_BUYER_PKH,
  INDEXER_SUPPLIER_PKH,
  SAMPLE_DELIVER_BY,
  SAMPLE_POSTED_AT,
  SAMPLE_PROMPT_HASH,
  SAMPLE_REQUEST_SPEC_HASH,
  buildAdvertDatumHex,
  buildEscrowDatumHex,
} from "../fixtures/indexer-side/sample-blocks.js";
import {
  AGENT_ID,
  BUYER_REFUND_ADDRESS,
  IDENTITY_ADDRESS,
  buildIdentityEscrowDatumHex,
} from "../fixtures/indexer-side/identity-blocks.js";

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
  pragma(sql: string, opts?: { simple: boolean }): unknown;
  close(): void;
};
const Database = createRequire(new URL("../../indexer/package.json", import.meta.url))("better-sqlite3") as new (path: string) => Db;

let dir: string;
function tempDb(): string {
  dir = mkdtempSync(join(tmpdir(), "indexer-identity-"));
  return join(dir, "indexer.db");
}

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A database as the indexer wrote it before identity support (schema v1, user_version 0). */
function legacyDatabase(path: string): void {
  const db = new Database(path);
  db.exec(CREATE_TABLES_SQL);
  db.prepare(
    `INSERT INTO advertisements (utxo_ref, supplier_pkh, capability_id, model, max_output_tokens, max_processing_ms,
       price_lovelace, supplier_bond_lovelace, buyer_bond_lovelace, endpoint_url, detail_uri, detail_hash, advertised_at,
       status, created_slot, datum_hex, rolled_back)
     VALUES (?, ?, 'llm.text.generate.v1', 'm', 512, 60000, '2000000', '1000000', '1000000', 'https://s', 'ipfs://x', ?, 1, 'Active', 100, ?, 0)`,
  ).run(`${"a".repeat(64)}#0`, INDEXER_SUPPLIER_PKH, "b".repeat(64), buildAdvertDatumHex());
  db.prepare(
    `INSERT INTO escrows (utxo_ref, buyer_pkh, supplier_pkh, advert_ref_tx, advert_ref_index, capability_id,
       request_spec_hash, prompt_hash, payment_lovelace, buyer_bond_lovelace, supplier_bond_lovelace, deliver_by,
       posted_at, submitted_at, result_receipt_hash, state, created_slot, datum_hex, rolled_back)
     VALUES (?, ?, ?, ?, 0, 'llm.text.generate.v1', ?, ?, '2000000', '1000000', '1000000', 2, 1, NULL, NULL, 'Open', 100, ?, 0)`,
  ).run(`${"c".repeat(64)}#0`, INDEXER_BUYER_PKH, INDEXER_SUPPLIER_PKH, "a".repeat(64), SAMPLE_REQUEST_SPEC_HASH, SAMPLE_PROMPT_HASH, buildEscrowDatumHex());
  db.prepare(`INSERT INTO utxos (ref, address, datum_hex, created_slot, created_tx) VALUES (?, 'addr_test1wESCROW', '00', 100, ?)`)
    .run(`${"c".repeat(64)}#0`, "c".repeat(64));
  db.close();
}

function columns(path: string, table: string): string[] {
  const db = new Database(path);
  const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  db.close();
  return names;
}

describe("schema migration v1 → v2", () => {
  it("adds the identity columns and tables to an existing database and keeps its rows", () => {
    const path = tempDb();
    legacyDatabase(path);
    expect(columns(path, "advertisements")).not.toContain("agent_id");

    const cache = new SqliteCache(path);
    const advert = cache.getAdvertisementByRef(`${"a".repeat(64)}#0`)!;
    expect(advert).toMatchObject({ supplier_pkh: INDEXER_SUPPLIER_PKH, layout: "legacy", agent_id: null, creator_signed: 0 });
    const escrow = cache.getEscrowByRef(`${"c".repeat(64)}#0`)!;
    expect(escrow).toMatchObject({ layout: "legacy", agent_id: null, refund_address: null, refund_datum: null });
    expect(cache.listActiveAdvertisements()).toHaveLength(1);
    cache.close();

    expect(columns(path, "advertisements")).toEqual(expect.arrayContaining(["layout", "agent_id", "creator_signed"]));
    expect(columns(path, "escrows")).toEqual(expect.arrayContaining(["layout", "agent_id", "refund_address", "refund_datum"]));
    expect(columns(path, "utxos")).toContain("agent_id");
    expect(columns(path, "identity_facts")).toContain("invalidated_at");
    expect(columns(path, "meta")).toEqual(["key", "value"]);
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("opening a migrated database again changes nothing", () => {
    const path = tempDb();
    legacyDatabase(path);
    new SqliteCache(path).close();
    const before = columns(path, "escrows");
    new SqliteCache(path).close();
    expect(columns(path, "escrows")).toEqual(before);
  });

  it("refuses a database of a newer schema version", () => {
    const path = tempDb();
    const db = new Database(path);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => new SqliteCache(path)).toThrow(/newer than this indexer/);
  });
});

describe("schema migration → v3 (intersection points)", () => {
  it("adds chain_points to a database from before schema versioning; its cursor is the first point", () => {
    const path = tempDb();
    legacyDatabase(path);
    const old = new Database(path);
    old.prepare(`INSERT INTO cursor (id, slot, block_hash) VALUES (1, 36987164, ?)`).run("a7".repeat(32));
    old.close();

    const cache = new SqliteCache(path);
    expect(cache.getIntersectionPoints()).toEqual([{ slot: 36987164, blockHash: "a7".repeat(32) }]);
    cache.saveCursor(36987170, "a8".repeat(32));
    expect(cache.getIntersectionPoints()).toEqual([
      { slot: 36987170, blockHash: "a8".repeat(32) },
    ]);
    cache.close();

    expect(columns(path, "chain_points")).toEqual(["slot", "block_hash"]);
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    db.close();
  });
});

// ─── Resync ───────────────────────────────────────────────────────────────────

describe("SqliteCache.applyResync", () => {
  const POINT = { slot: 150, blockHash: "9".repeat(64) };

  it("rolls back after the point, moves the cursor to it, and runs once per point", () => {
    const cache = new SqliteCache(":memory:");
    cache.insertUtxo("u1#0", "addr", "00", 100, "u1");
    cache.insertUtxo("u2#0", "addr", "00", 200, "u2");
    cache.appendEvent({ type: "PostAdvert", slot: 200, tx_hash: "u2", utxo_ref: "u2#0", datum_hex: "", metadata_json: "{}", rolled_back: 0 });
    cache.saveCursor(300, "c".repeat(64));

    expect(cache.applyResync(POINT)).toBe(true);
    expect(cache.getCursor()).toEqual({ slot: 150, blockHash: POINT.blockHash });
    expect(cache.getUnspentUtxos("addr").map((u) => u.ref)).toEqual(["u1#0"]);
    expect(cache.listEventsAfterSlot(0)).toEqual([]);

    cache.saveCursor(400, "d".repeat(64));
    expect(cache.applyResync(POINT)).toBe(false);
    expect(cache.getCursor()!.slot).toBe(400);
    cache.close();
  });

  it("does not move a cursor that is at or before the point (or a fresh database)", () => {
    const fresh = new SqliteCache(":memory:");
    expect(fresh.applyResync(POINT)).toBe(false);
    expect(fresh.getCursor()).toBeNull();
    fresh.close();

    const behind = new SqliteCache(":memory:");
    behind.saveCursor(100, "e".repeat(64));
    expect(behind.applyResync(POINT)).toBe(false);
    expect(behind.getCursor()).toEqual({ slot: 100, blockHash: "e".repeat(64) });
    behind.close();
  });

  it("refuses a point whose slot holds another block in the database", () => {
    const cache = new SqliteCache(":memory:");
    cache.saveCursor(150, "8".repeat(64));
    cache.saveCursor(300, "c".repeat(64));
    expect(() => cache.applyResync(POINT)).toThrow(/holds block 8{64} at slot 150/);
    expect(cache.getCursor()).toEqual({ slot: 300, blockHash: "c".repeat(64) });

    const atCursor = new SqliteCache(":memory:");
    atCursor.saveCursor(150, "8".repeat(64));
    expect(() => atCursor.applyResync(POINT)).toThrow(/not on the indexed chain/);
    atCursor.close();
    cache.close();
  });
});

// ─── Rollback and identity records ────────────────────────────────────────────

describe("SqliteCache.rollbackTo — identity records", () => {
  it("returns the agents whose record outputs the rollback removes or restores", () => {
    const cache = new SqliteCache(":memory:", { listing: { identityAddress: IDENTITY_ADDRESS } });
    const other = "7c".repeat(32);
    cache.insertUtxo("r1#0", IDENTITY_ADDRESS, "d87980", 100, "r1", other);
    cache.insertUtxo("r2#0", IDENTITY_ADDRESS, "d87980", 100, "r2", AGENT_ID);
    cache.spendUtxo("r2#0", 200, "r3");
    cache.insertUtxo("r3#0", IDENTITY_ADDRESS, "d87980", 200, "r3", AGENT_ID);
    expect(cache.rollbackTo({ slot: 150, blockHash: "9".repeat(64) })).toEqual([AGENT_ID]);
    expect(cache.getUnspentUtxos(IDENTITY_ADDRESS).map((u) => [u.ref, u.agent_id])).toEqual([
      ["r1#0", other],
      ["r2#0", AGENT_ID],
    ]);
    cache.close();
  });
});

// ─── Lineage with the identity layout ─────────────────────────────────────────

function identityEscrowRow(overrides: Partial<EscrowUpsert> = {}): EscrowUpsert {
  return {
    utxo_ref: `${"1".repeat(64)}#0`,
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
    created_slot: 100,
    datum_hex: buildIdentityEscrowDatumHex(),
    rolled_back: 0,
    layout: "identity",
    agent_id: AGENT_ID,
    refund_address: BUYER_REFUND_ADDRESS,
    refund_datum: null,
    ...overrides,
  };
}

function put(cache: SqliteCache, row: EscrowUpsert, slot: number, tx: string): void {
  cache.upsertEscrow({ ...row, created_slot: slot });
  cache.insertUtxo(row.utxo_ref, "addr_test1wNEWESCROW", row.datum_hex, slot, tx);
}

describe("SqliteCache.getEscrowLineage — identity layout", () => {
  it.each(["Open", "Claimed", "Submitted"])("RefundRevokedEscrow ends a %s new escrow", (state) => {
    const cache = new SqliteCache(":memory:");
    const row = identityEscrowRow({ state });
    put(cache, row, 100, "1".repeat(64));
    cache.spendUtxo(row.utxo_ref, 200, "2".repeat(64));
    cache.appendEvent({
      type: "RefundRevokedEscrow", slot: 200, tx_hash: "2".repeat(64), utxo_ref: row.utxo_ref,
      datum_hex: row.datum_hex, metadata_json: "{}", rolled_back: 0,
    });
    expect(cache.getEscrowLineage(row.utxo_ref)?.terminal).toEqual({ type: "RefundRevokedEscrow", tx_hash: "2".repeat(64) });
    cache.close();
  });

  it("a continuation must keep agent_id and refund", () => {
    const cache = new SqliteCache(":memory:");
    const open = identityEscrowRow();
    put(cache, open, 100, "1".repeat(64));
    cache.spendUtxo(open.utxo_ref, 200, "2".repeat(64));
    put(cache, { ...open, utxo_ref: `${"2".repeat(64)}#0`, state: "Claimed", refund_address: null }, 200, "2".repeat(64));
    put(cache, { ...open, utxo_ref: `${"2".repeat(64)}#1`, state: "Claimed", agent_id: "7c".repeat(32) }, 200, "2".repeat(64));
    // Neither output keeps both immutable fields: no proven continuation.
    expect(cache.getEscrowLineage(open.utxo_ref)?.rows.map((r) => r.utxo_ref)).toEqual([open.utxo_ref]);

    put(cache, { ...open, utxo_ref: `${"2".repeat(64)}#2`, state: "Claimed" }, 200, "2".repeat(64));
    expect(cache.getEscrowLineage(open.utxo_ref)?.rows.map((r) => r.utxo_ref)).toEqual([open.utxo_ref, `${"2".repeat(64)}#2`]);
    cache.close();
  });

  it("RefundRevokedEscrow does not end a legacy escrow", () => {
    const cache = new SqliteCache(":memory:");
    const row = identityEscrowRow({ layout: "legacy", agent_id: null, refund_address: null, datum_hex: buildEscrowDatumHex() });
    put(cache, row, 100, "1".repeat(64));
    cache.spendUtxo(row.utxo_ref, 200, "2".repeat(64));
    cache.appendEvent({
      type: "RefundRevokedEscrow", slot: 200, tx_hash: "2".repeat(64), utxo_ref: row.utxo_ref,
      datum_hex: row.datum_hex, metadata_json: "{}", rolled_back: 0,
    });
    expect(() => cache.getEscrowLineage(row.utxo_ref)).toThrow(/ambiguous escrow lineage/);
    cache.close();
  });
});
