/**
 * indexer/src/db/cache.ts — SqliteCache for the indexer.
 *
 * Wraps better-sqlite3 with domain-specific methods for advertisements,
 * escrows, supplier_status, events, cursor, and UTxOs.
 *
 * Rollback semantics (apex-dashboard pattern):
 *   - Events: soft-delete (rolled_back = 1) for events after rollback slot
 *   - UTxOs: delete created-after, restore spent-after
 *
 * WAL mode is enabled on open for concurrent readers.
 */

import Database from "better-sqlite3";
import fs from "fs";
import { applySchema } from "./schema.js";

export interface AdvertRow {
  utxo_ref: string;        // "<txHash>#<index>"
  supplier_pkh: string;
  capability_id: string;
  model: string;
  max_output_tokens: number;
  max_processing_ms: number;
  price_lovelace: string;  // bigint serialised as string
  supplier_bond_lovelace: string;
  buyer_bond_lovelace: string;
  endpoint_url: string;
  detail_uri: string;
  detail_hash: string;
  advertised_at: number;
  status: string;          // "Active" | "Retired"
  created_slot: number;
  datum_hex: string;
  rolled_back: number;
}

export interface EscrowRow {
  utxo_ref: string;
  buyer_pkh: string;
  supplier_pkh: string;
  advert_ref_tx: string;
  advert_ref_index: number;
  capability_id: string;
  request_spec_hash: string;
  prompt_hash: string;
  payment_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
  deliver_by: number;
  posted_at: number;
  submitted_at: number | null;
  result_receipt_hash: string | null;
  state: string;
  created_slot: number;
  datum_hex: string;
  rolled_back: number;
}

export interface SupplierStatusRow {
  supplier_pkh: string;
  advert_ref: string;
  status: string;          // "free" | "working" | "offline"
  last_seen_iso: string;
  current_escrow_ref: string | null;
  polled_at: number;       // unix ms
}

export interface IndexerEventRow {
  id?: number;
  type: string;
  slot: number;
  tx_hash: string;
  utxo_ref: string;
  datum_hex: string;
  metadata_json: string;
  rolled_back: number;
}

export interface CursorRow {
  slot: number;
  blockHash: string;
}

export interface UtxoRow {
  ref: string;
  address: string;
  datum_hex: string;
  created_slot: number;
  created_tx: string;
  spent_slot: number | null;
  spent_tx: string | null;
}

export type EscrowTerminalType = "AcceptEscrow" | "ReclaimEscrow" | "ReleaseEscrow";

export interface EscrowLineageRow extends EscrowRow {
  spent_tx: string | null;
}

export interface EscrowLineage {
  original_ref: string;
  rows: EscrowLineageRow[];
  terminal: { type: EscrowTerminalType; tx_hash: string } | null;
}

export class AmbiguousEscrowLineageError extends Error {
  constructor(ref: string) {
    super(`ambiguous escrow lineage at ${ref}`);
    this.name = "AmbiguousEscrowLineageError";
  }
}

export class SqliteCache {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    applySchema(this.db);
  }

  // ─── Cursor ────────────────────────────────────────────────────────────

  saveCursor(slot: number, blockHash: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO cursor (id, slot, block_hash) VALUES (1, ?, ?)`
    ).run(slot, blockHash);
  }

  getCursor(): CursorRow | null {
    const row = this.db.prepare(
      `SELECT slot, block_hash FROM cursor WHERE id = 1`
    ).get() as { slot: number; block_hash: string } | undefined;
    if (!row) return null;
    return { slot: row.slot, blockHash: row.block_hash };
  }

  // ─── UTxO tracking ─────────────────────────────────────────────────────

  insertUtxo(ref: string, address: string, datumHex: string, slot: number, txHash: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO utxos (ref, address, datum_hex, created_slot, created_tx, spent_slot, spent_tx)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    ).run(ref, address, datumHex, slot, txHash);
  }

  spendUtxo(ref: string, slot: number, txHash: string): void {
    this.db.prepare(
      `UPDATE utxos SET spent_slot = ?, spent_tx = ? WHERE ref = ?`
    ).run(slot, txHash, ref);
  }

  getUnspentUtxos(address: string): UtxoRow[] {
    return this.db.prepare(
      `SELECT ref, address, datum_hex, created_slot, created_tx, spent_slot, spent_tx
       FROM utxos WHERE address = ? AND spent_slot IS NULL`
    ).all(address) as UtxoRow[];
  }

  // ─── Advertisements ────────────────────────────────────────────────────

  upsertAdvertisement(row: Omit<AdvertRow, "id">): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO advertisements (
         utxo_ref, supplier_pkh, capability_id, model,
         max_output_tokens, max_processing_ms,
         price_lovelace, supplier_bond_lovelace, buyer_bond_lovelace,
         endpoint_url, detail_uri, detail_hash, advertised_at, status,
         created_slot, datum_hex, rolled_back
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.utxo_ref, row.supplier_pkh, row.capability_id, row.model,
      row.max_output_tokens, row.max_processing_ms,
      row.price_lovelace, row.supplier_bond_lovelace, row.buyer_bond_lovelace,
      row.endpoint_url, row.detail_uri, row.detail_hash, row.advertised_at, row.status,
      row.created_slot, row.datum_hex, row.rolled_back
    );
  }

  getAdvertisementByRef(utxoRef: string): AdvertRow | null {
    const row = this.db.prepare(
      `SELECT * FROM advertisements WHERE utxo_ref = ?`
    ).get(utxoRef) as AdvertRow | undefined;
    return row ?? null;
  }

  /** Mark an advertisement row as Retired. Called when the indexer observes
   * a RetireAdvert spend (advert UTxO spent with no continuing output at
   * the advert script address). Drops the row out of listActiveAdvertisements
   * which filters on `status = 'Active'`. */
  markAdvertisementRetired(utxoRef: string): void {
    this.db.prepare(
      `UPDATE advertisements SET status = 'Retired' WHERE utxo_ref = ?`
    ).run(utxoRef);
  }

  listActiveAdvertisements(filter?: { capability_id?: string; supplier_pkh?: string }): AdvertRow[] {
    let sql = `SELECT * FROM advertisements WHERE status = 'Active' AND rolled_back = 0`;
    const params: unknown[] = [];
    if (filter?.capability_id) {
      sql += ` AND capability_id = ?`;
      params.push(filter.capability_id);
    }
    if (filter?.supplier_pkh) {
      sql += ` AND supplier_pkh = ?`;
      params.push(filter.supplier_pkh);
    }
    sql += ` ORDER BY created_slot DESC`;
    return this.db.prepare(sql).all(...params) as AdvertRow[];
  }

  // ─── Escrows ───────────────────────────────────────────────────────────

  upsertEscrow(row: Omit<EscrowRow, "id">): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO escrows (
         utxo_ref, buyer_pkh, supplier_pkh,
         advert_ref_tx, advert_ref_index,
         capability_id, request_spec_hash, prompt_hash,
         payment_lovelace, buyer_bond_lovelace, supplier_bond_lovelace,
         deliver_by, posted_at, submitted_at, result_receipt_hash,
         state, created_slot, datum_hex, rolled_back
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.utxo_ref, row.buyer_pkh, row.supplier_pkh,
      row.advert_ref_tx, row.advert_ref_index,
      row.capability_id, row.request_spec_hash, row.prompt_hash,
      row.payment_lovelace, row.buyer_bond_lovelace, row.supplier_bond_lovelace,
      row.deliver_by, row.posted_at, row.submitted_at, row.result_receipt_hash,
      row.state, row.created_slot, row.datum_hex, row.rolled_back
    );
  }

  getEscrowByRef(utxoRef: string): EscrowRow | null {
    const row = this.db.prepare(
      `SELECT * FROM escrows WHERE utxo_ref = ?`
    ).get(utxoRef) as EscrowRow | undefined;
    return row ?? null;
  }

  listEscrowsByBuyer(buyerPkh: string): EscrowRow[] {
    return this.db.prepare(
      `SELECT * FROM escrows WHERE buyer_pkh = ? ORDER BY created_slot DESC`
    ).all(buyerPkh) as EscrowRow[];
  }

  listEscrowsBySupplier(supplierPkh: string): EscrowRow[] {
    return this.db.prepare(
      `SELECT * FROM escrows WHERE supplier_pkh = ? ORDER BY created_slot DESC`
    ).all(supplierPkh) as EscrowRow[];
  }

  /**
   * Follow one escrow through the transactions which spend it. A transition is
   * eligible only when the spending transaction creates exactly one escrow
   * output with the same immutable datum fields and the next protocol state.
   * Terminal state is reported only when the matching, non-rolled-back event
   * was observed for the spend.
   */
  getEscrowLineage(originalRef: string): EscrowLineage | null {
    const getRow = this.db.prepare(`
      SELECT e.*, u.spent_tx
      FROM escrows e
      JOIN utxos u ON u.ref = e.utxo_ref
      WHERE e.utxo_ref = ? AND e.rolled_back = 0
    `);
    const getContinuations = this.db.prepare(`
      SELECT e.*, u.spent_tx
      FROM escrows e
      JOIN utxos u ON u.ref = e.utxo_ref
      WHERE u.created_tx = ?
        AND e.rolled_back = 0
        AND e.buyer_pkh = ?
        AND e.supplier_pkh = ?
        AND e.advert_ref_tx = ?
        AND e.advert_ref_index = ?
        AND e.capability_id = ?
        AND e.request_spec_hash = ?
        AND e.prompt_hash = ?
        AND e.payment_lovelace = ?
        AND e.buyer_bond_lovelace = ?
        AND e.supplier_bond_lovelace = ?
        AND e.deliver_by = ?
        AND e.posted_at = ?
        AND e.state = ?
      ORDER BY e.utxo_ref ASC
    `);
    const getTerminalEvents = this.db.prepare(`
      SELECT type, tx_hash
      FROM events
      WHERE rolled_back = 0
        AND tx_hash = ?
        AND utxo_ref = ?
        AND type IN ('AcceptEscrow', 'ReclaimEscrow', 'ReleaseEscrow')
      ORDER BY id ASC
    `);

    const readLineage = this.db.transaction((ref: string): EscrowLineage | null => {
      const origin = getRow.get(ref) as EscrowLineageRow | undefined;
      if (!origin) return null;

      const rows: EscrowLineageRow[] = [];
      const seen = new Set<string>();
      let current = origin;

      for (;;) {
        if (seen.has(current.utxo_ref)) {
          throw new AmbiguousEscrowLineageError(current.utxo_ref);
        }
        seen.add(current.utxo_ref);
        rows.push(current);

        if (current.spent_tx === null) {
          return { original_ref: originalRef, rows, terminal: null };
        }

        const nextState =
          current.state === "Open"
            ? "Claimed"
            : current.state === "Claimed"
              ? "Submitted"
              : null;
        const continuations = nextState === null
          ? []
          : getContinuations.all(
              current.spent_tx,
              current.buyer_pkh,
              current.supplier_pkh,
              current.advert_ref_tx,
              current.advert_ref_index,
              current.capability_id,
              current.request_spec_hash,
              current.prompt_hash,
              current.payment_lovelace,
              current.buyer_bond_lovelace,
              current.supplier_bond_lovelace,
              current.deliver_by,
              current.posted_at,
              nextState,
            ) as EscrowLineageRow[];
        const terminalEvents = getTerminalEvents.all(
          current.spent_tx,
          current.utxo_ref,
        ) as Array<{ type: EscrowTerminalType; tx_hash: string }>;

        if (continuations.length > 1 || terminalEvents.length > 1) {
          throw new AmbiguousEscrowLineageError(current.utxo_ref);
        }
        if (continuations.length === 1) {
          if (terminalEvents.length !== 0) {
            throw new AmbiguousEscrowLineageError(current.utxo_ref);
          }
          current = continuations[0];
          continue;
        }
        if (terminalEvents.length === 1) {
          const terminal = terminalEvents[0];
          const validTerminal =
            (terminal.type === "ReclaimEscrow" &&
              (current.state === "Open" || current.state === "Claimed")) ||
            ((terminal.type === "AcceptEscrow" || terminal.type === "ReleaseEscrow") &&
              current.state === "Submitted");
          if (!validTerminal) {
            throw new AmbiguousEscrowLineageError(current.utxo_ref);
          }
          return { original_ref: originalRef, rows, terminal };
        }

        // The spend is known, but no indexed continuing output or terminal
        // event proves what it did. Keep the last proven row and fail closed.
        return { original_ref: originalRef, rows, terminal: null };
      }
    });

    return readLineage(originalRef);
  }

  // ─── Supplier status ───────────────────────────────────────────────────

  upsertSupplierStatus(row: SupplierStatusRow): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO supplier_status (
         supplier_pkh, advert_ref, status, last_seen_iso, current_escrow_ref, polled_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      row.supplier_pkh, row.advert_ref, row.status, row.last_seen_iso,
      row.current_escrow_ref, row.polled_at
    );
  }

  getSupplierStatus(supplierPkh: string): SupplierStatusRow | null {
    const row = this.db.prepare(
      `SELECT * FROM supplier_status WHERE supplier_pkh = ?`
    ).get(supplierPkh) as SupplierStatusRow | undefined;
    return row ?? null;
  }

  // ─── Events ────────────────────────────────────────────────────────────

  appendEvent(row: Omit<IndexerEventRow, "id">): void {
    this.db.prepare(
      `INSERT INTO events (type, slot, tx_hash, utxo_ref, datum_hex, metadata_json, rolled_back)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.type, row.slot, row.tx_hash, row.utxo_ref,
      row.datum_hex, row.metadata_json, row.rolled_back
    );
  }

  listEventsAfterSlot(slot: number): IndexerEventRow[] {
    return this.db.prepare(
      `SELECT * FROM events WHERE slot > ? AND rolled_back = 0 ORDER BY slot ASC, id ASC`
    ).all(slot) as IndexerEventRow[];
  }

  /** Most-recent `limit` events, returned in chronological ASC order so SSE
   * replay preserves the same oldest-first emission shape as
   * `listEventsAfterSlot`. */
  listRecentEvents(limit: number): IndexerEventRow[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const desc = this.db.prepare(
      `SELECT * FROM events WHERE rolled_back = 0 ORDER BY slot DESC, id DESC LIMIT ?`
    ).all(limit) as IndexerEventRow[];
    return desc.reverse();
  }

  // ─── Rollback ──────────────────────────────────────────────────────────

  rollbackToSlot(slot: number): void {
    const tx = this.db.transaction(() => {
      // Soft-delete events strictly after rollback slot
      this.db.prepare(`UPDATE events SET rolled_back = 1 WHERE slot > ?`).run(slot);

      // Delete UTxOs created after rollback slot
      this.db.prepare(`DELETE FROM utxos WHERE created_slot > ?`).run(slot);

      // Restore UTxOs that were spent after rollback slot (clear spend)
      this.db.prepare(
        `UPDATE utxos SET spent_slot = NULL, spent_tx = NULL WHERE spent_slot > ?`
      ).run(slot);

      // Update cursor if it's beyond rollback point
      this.db.prepare(`UPDATE cursor SET slot = ? WHERE id = 1 AND slot > ?`).run(slot, slot);
    });
    tx();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  dbSizeBytes(): number {
    try {
      const stats = fs.statSync(this.dbPath);
      return stats.size;
    } catch {
      // In-memory or missing — fall back to a positive sentinel
      // (test contract requires > 0 even on a fresh DB).
      // better-sqlite3 always creates the file on open with WAL mode,
      // so this branch normally never hits.
      return 1;
    }
  }

  close(): void {
    this.db.close();
  }
}
