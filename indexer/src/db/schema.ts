/**
 * indexer/src/db/schema.ts — schema and migrations for the indexer database.
 *
 * `PRAGMA user_version` holds the schema version. On open, applySchema runs
 * every migration above the stored version in one transaction. Version 1 is
 * the original schema (CREATE TABLE IF NOT EXISTS, so a database that existed
 * before versioning starts at 0 and keeps its rows). CREATE IF NOT EXISTS does
 * not add columns to an existing table, so later versions use ALTER TABLE.
 *
 * Tables:
 *   cursor            — single row tracking chain-sync position
 *   utxos             — all observed UTxOs (created/spent tracking)
 *   events            — all emitted marketplace events (soft-deletable)
 *   advertisements    — decoded AdvertDatum state keyed by utxo_ref
 *   escrows           — decoded EscrowDatum state keyed by utxo_ref
 *   supplier_status   — latest polled /status for each active supplier
 *   identity_facts    — (v2) last identity gateway answer per agent_id
 *   meta              — (v2) key/value markers (resync point)
 *   chain_points      — (v3) slot and hash of the last applied blocks
 *   module1_spends    — (v4) spends of Module-1 dispute outputs, with the redeemer
 *
 * Version 2 (identity registry, Part 2 §6.4):
 *   advertisements: layout ('legacy' | 'identity'), agent_id, creator_signed
 *   escrows:        layout, agent_id, refund_address, refund_datum
 *   utxos:          agent_id (identity record outputs at the identity address)
 *
 * Version 3: chain_points. The follower sends these points with the cursor
 * to findIntersection, so a rollback of the last blocks while it is
 * disconnected resumes by itself. The table starts empty; the cursor is
 * always the first point.
 *
 * Version 4: module1_spends. The Module-1 claim, challenge and verdict outputs
 * are rows of utxos (address = the Module-1 address); this table keeps the
 * spend redeemer of each of them (OracleResolve carries the outcome).
 */

import type Database from "better-sqlite3";

export const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    slot INTEGER NOT NULL,
    block_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS utxos (
    ref TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    datum_hex TEXT NOT NULL,
    created_slot INTEGER NOT NULL,
    created_tx TEXT NOT NULL,
    spent_slot INTEGER,
    spent_tx TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_utxos_address ON utxos(address, spent_slot);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    slot INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    utxo_ref TEXT NOT NULL,
    datum_hex TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    rolled_back INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_events_slot ON events(slot);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_utxo_ref ON events(utxo_ref);

  CREATE TABLE IF NOT EXISTS advertisements (
    utxo_ref TEXT PRIMARY KEY,
    supplier_pkh TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    model TEXT NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    max_processing_ms INTEGER NOT NULL,
    price_lovelace TEXT NOT NULL,
    supplier_bond_lovelace TEXT NOT NULL,
    buyer_bond_lovelace TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    detail_uri TEXT NOT NULL,
    detail_hash TEXT NOT NULL,
    advertised_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_slot INTEGER NOT NULL,
    datum_hex TEXT NOT NULL,
    rolled_back INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_adverts_capability_status ON advertisements(capability_id, status);
  CREATE INDEX IF NOT EXISTS idx_adverts_supplier_status ON advertisements(supplier_pkh, status);

  CREATE TABLE IF NOT EXISTS escrows (
    utxo_ref TEXT PRIMARY KEY,
    buyer_pkh TEXT NOT NULL,
    supplier_pkh TEXT NOT NULL,
    advert_ref_tx TEXT NOT NULL,
    advert_ref_index INTEGER NOT NULL,
    capability_id TEXT NOT NULL,
    request_spec_hash TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    payment_lovelace TEXT NOT NULL,
    buyer_bond_lovelace TEXT NOT NULL,
    supplier_bond_lovelace TEXT NOT NULL,
    deliver_by INTEGER NOT NULL,
    posted_at INTEGER NOT NULL,
    submitted_at INTEGER,
    result_receipt_hash TEXT,
    state TEXT NOT NULL,
    created_slot INTEGER NOT NULL,
    datum_hex TEXT NOT NULL,
    rolled_back INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_escrows_buyer ON escrows(buyer_pkh);
  CREATE INDEX IF NOT EXISTS idx_escrows_supplier ON escrows(supplier_pkh);

  CREATE TABLE IF NOT EXISTS supplier_status (
    supplier_pkh TEXT PRIMARY KEY,
    advert_ref TEXT NOT NULL,
    status TEXT NOT NULL,
    last_seen_iso TEXT NOT NULL,
    current_escrow_ref TEXT,
    polled_at INTEGER NOT NULL
  );
`;

const IDENTITY_SQL = `
  CREATE INDEX IF NOT EXISTS idx_utxos_agent ON utxos(agent_id, spent_slot);
  CREATE INDEX IF NOT EXISTS idx_adverts_agent ON advertisements(agent_id);

  CREATE TABLE IF NOT EXISTS identity_facts (
    agent_id TEXT PRIMARY KEY,
    found INTEGER NOT NULL,
    effective TEXT,
    independent INTEGER NOT NULL DEFAULT 0,
    origin TEXT,
    transaction_keys TEXT NOT NULL DEFAULT '[]',
    capabilities TEXT NOT NULL DEFAULT '[]',
    detail TEXT,
    resolved_at INTEGER NOT NULL,
    invalidated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const CHAIN_POINTS_SQL = `
  CREATE TABLE IF NOT EXISTS chain_points (
    slot INTEGER PRIMARY KEY,
    block_hash TEXT NOT NULL
  );
`;

const MODULE1_SQL = `
  CREATE TABLE IF NOT EXISTS module1_spends (
    ref TEXT PRIMARY KEY,
    slot INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    redeemer_hex TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_module1_spends_slot ON module1_spends(slot);
`;

function addColumn(db: Database.Database, table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

/** MIGRATIONS[n] moves the schema from version n to version n + 1. */
const MIGRATIONS: ReadonlyArray<(db: Database.Database) => void> = [
  (db) => {
    db.exec(CREATE_TABLES_SQL);
  },
  (db) => {
    addColumn(db, "advertisements", "layout", "TEXT NOT NULL DEFAULT 'legacy'");
    addColumn(db, "advertisements", "agent_id", "TEXT");
    addColumn(db, "advertisements", "creator_signed", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "escrows", "layout", "TEXT NOT NULL DEFAULT 'legacy'");
    addColumn(db, "escrows", "agent_id", "TEXT");
    addColumn(db, "escrows", "refund_address", "TEXT");
    addColumn(db, "escrows", "refund_datum", "TEXT");
    addColumn(db, "utxos", "agent_id", "TEXT");
    db.exec(IDENTITY_SQL);
  },
  (db) => {
    db.exec(CHAIN_POINTS_SQL);
  },
  (db) => {
    db.exec(MODULE1_SQL);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function applySchema(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(`applySchema: database schema version ${current} is newer than this indexer (${SCHEMA_VERSION})`);
  }
  db.transaction(() => {
    for (let version = current; version < SCHEMA_VERSION; version++) MIGRATIONS[version]!(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
