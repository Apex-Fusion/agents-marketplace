/**
 * indexer/src/db/schema.ts — CREATE TABLE statements for the indexer database.
 *
 * Runs on boot if tables are missing. Idempotent (IF NOT EXISTS).
 *
 * Tables:
 *   cursor            — single row tracking chain-sync position
 *   utxos             — all observed UTxOs (created/spent tracking)
 *   events            — all emitted marketplace events (soft-deletable)
 *   advertisements    — decoded AdvertDatum state keyed by utxo_ref
 *   escrows           — decoded EscrowDatum state keyed by utxo_ref
 *   supplier_status   — latest polled /status for each active supplier
 */

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

interface DbLike {
  exec(sql: string): unknown;
}

export function applySchema(db: unknown): void {
  (db as DbLike).exec(CREATE_TABLES_SQL);
}
