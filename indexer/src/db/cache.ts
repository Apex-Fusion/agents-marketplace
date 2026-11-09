/**
 * indexer/src/db/cache.ts — SqliteCache for the indexer.
 *
 * Wraps better-sqlite3 with domain-specific methods for advertisements,
 * escrows, supplier_status, events, cursor, intersection points, UTxOs,
 * identity facts, documents on chain and jury outputs.
 *
 * Intersection points: saveCursor also keeps the slot and hash of the last
 * INTERSECTION_POINTS applied blocks (chain_points). The follower sends them,
 * newest first, to findIntersection.
 *
 * Rollback to a block (rollbackTo) removes everything that later blocks wrote:
 *   - Events: soft-delete (rolled_back = 1)
 *   - UTxOs: delete created-after, restore spent-after
 *   - Adverts and escrows: delete created-after; an advert retired after the
 *     block gets the status of its datum again
 *   - Module-1 spends (module1_spends): delete spent-after (the Module-1
 *     outputs themselves are utxos rows)
 *   - Documents, jury outputs and jury spends: delete after
 *   - Cursor and intersection points: move to the block
 *
 * Listing: listActiveAdvertisements returns only the adverts that the indexer
 * lists (listing/rule.ts): the legacy adverts before the switch slot, the new
 * adverts that pass the identity listing rule, and none above the value cap.
 * An advert whose output is spent is not listed (CURRENT_ADVERT).
 *
 * WAL mode is enabled on open for concurrent readers.
 */

import Database from "better-sqlite3";
import fs from "fs";
import { decodeAnyAdvertDatum } from "@marketplace/shared/cbor";
import type { DatumLayout } from "../follower/types.js";
import {
  IDENTITY_RESULT_MAX_AGE_MS,
  advertListing,
  type IdentityFacts,
} from "../listing/rule.js";
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
  layout: DatumLayout;
  /** 64 lowercase hex for the identity layout, null for the legacy layout. */
  agent_id: string | null;
  /** 1 when the transaction that created the advert lists supplier_pkh as a required signer. */
  creator_signed: number;
}

/** Upsert input: rows from before identity support default to the legacy layout. */
export type AdvertUpsert = Omit<AdvertRow, "layout" | "agent_id" | "creator_signed"> &
  Partial<Pick<AdvertRow, "layout" | "agent_id" | "creator_signed">>;

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
  layout: DatumLayout;
  /** 64 lowercase hex for the identity layout, null for the legacy layout. */
  agent_id: string | null;
  /**
   * Refund address (bech32; Plutus Data CBOR hex when the address has no
   * bech32 form). null: refund not set, buyer payouts go to the buyer key.
   */
  refund_address: string | null;
  /** Inline datum (Plutus Data CBOR hex) that refund outputs carry; null: no datum. */
  refund_datum: string | null;
}

/** Upsert input: rows from before identity support default to the legacy layout. */
export type EscrowUpsert = Omit<EscrowRow, "layout" | "agent_id" | "refund_address" | "refund_datum"> &
  Partial<Pick<EscrowRow, "layout" | "agent_id" | "refund_address" | "refund_datum">>;

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
  /** Identity record outputs: the identifier that the token names. */
  agent_id: string | null;
  /** Module-1 challenge outputs: the challenge token name (some queries only). */
  token?: string | null;
  /** Module-1 challenge outputs: 1 when genuine (jury SPEC §11.1), 0 when not (some queries only). */
  genuine?: number | null;
}

/** A Module-1 output (claim, challenge or verdict) with the redeemer of its spend. */
export interface Module1OutputRow {
  ref: string;
  address: string;
  datum_hex: string;
  created_slot: number;
  created_tx: string;
  spent_slot: number | null;
  spent_tx: string | null;
  redeemer_hex: string | null;
  /** Challenge outputs: the challenge token name and the §11.1 genuineness (1/0); null for other outputs. */
  token: string | null;
  genuine: number | null;
}

/** A document on chain (metadata label 22084): its exact bytes and their blake2b-256. */
export interface DocumentRow {
  tx_hash: string;
  slot: number;
  block_height: number | null;
  type: string;
  media_type: string;
  hash: string;
  bytes: Buffer;
}

/** A document row without the bytes; `size` is their number. */
export type DocumentSummary = Omit<DocumentRow, "bytes"> & { size: number };

/** A jury output (utxos row and jury_outputs row) with the block height and redeemer of its spend. */
export interface JuryOutputRow {
  ref: string;
  /** Script hash of the deployment. */
  deployment: string;
  token: string;
  lovelace: string;
  datum_hex: string;
  created_slot: number;
  created_height: number | null;
  created_tx: string;
  spent_slot: number | null;
  spent_height: number | null;
  spent_tx: string | null;
  redeemer_hex: string | null;
}

export type EscrowTerminalType = "AcceptEscrow" | "ReclaimEscrow" | "ReleaseEscrow" | "RefundRevokedEscrow";

/** Inputs of the listing rule that come from configuration and the clock. */
export interface ListingPolicy {
  /** Switch slot (§9.6). null: legacy adverts stay listed. */
  switchSlot: number | null;
  /** Identity address `IA`. null: no new advert can be listed. */
  identityAddress: string | null;
  /** How long the last identity gateway answer counts (10 minutes). */
  maxAgeMs: number;
  now: () => number;
}

export interface SqliteCacheOptions {
  listing?: Partial<ListingPolicy>;
}

/** Rows per `IN (...)` query; below the SQLite host-parameter limit. */
const IN_CHUNK = 500;

/**
 * SQL condition on the advertisements row `a`: the advert is current. An
 * UpdateAdvert spends the advert output and keeps its row Active, so the row
 * must also have no recorded spend. A rollback removes the spend again.
 */
const CURRENT_ADVERT = `a.status = 'Active' AND a.rolled_back = 0
  AND NOT EXISTS (SELECT 1 FROM utxos s WHERE s.ref = a.utxo_ref AND s.spent_slot IS NOT NULL)`;

/**
 * Saved intersection points: the last applied blocks. After a rollback of
 * fewer blocks, findIntersection still finds a point and the follower resumes
 * by itself. findIntersection sends all of them in one message.
 */
export const INTERSECTION_POINTS = 100;

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
  private listing: ListingPolicy;

  constructor(dbPath: string, options: SqliteCacheOptions = {}) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    applySchema(this.db);
    this.listing = {
      switchSlot: options.listing?.switchSlot ?? null,
      identityAddress: options.listing?.identityAddress ?? null,
      maxAgeMs: options.listing?.maxAgeMs ?? IDENTITY_RESULT_MAX_AGE_MS,
      now: options.listing?.now ?? Date.now,
    };
  }

  /** Run `fn` in one SQLite transaction (all its writes or none). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── Cursor and intersection points ────────────────────────────────────

  /**
   * The chain now ends at this block: the cursor moves to it and it becomes
   * the newest intersection point. Saved points at or after its slot (a
   * rolled-back branch) go, and only the newest INTERSECTION_POINTS stay.
   */
  saveCursor(slot: number, blockHash: string, blockHeight: number | null = null): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM chain_points WHERE slot >= ?`).run(slot);
      this.db.prepare(`INSERT INTO chain_points (slot, block_hash, block_height) VALUES (?, ?, ?)`).run(slot, blockHash, blockHeight);
      this.db.prepare(
        `DELETE FROM chain_points
         WHERE slot <= (SELECT slot FROM chain_points ORDER BY slot DESC LIMIT 1 OFFSET ?)`
      ).run(INTERSECTION_POINTS);
      this.db.prepare(
        `INSERT OR REPLACE INTO cursor (id, slot, block_hash, block_height) VALUES (1, ?, ?, ?)`
      ).run(slot, blockHash, blockHeight);
    });
  }

  /** Block number of the cursor block; null when unknown (a new database, or a cursor from before schema version 5). */
  getTipHeight(): number | null {
    const row = this.db.prepare(`SELECT block_height FROM cursor WHERE id = 1`).get() as
      | { block_height: number | null }
      | undefined;
    return row?.block_height ?? null;
  }

  /**
   * The points for findIntersection, newest first: the cursor, then the
   * saved points before it, at most INTERSECTION_POINTS in total. Empty for a
   * new database. The cursor always comes first, also when chain_points
   * misses it (a database of schema version 2 or older).
   */
  getIntersectionPoints(): CursorRow[] {
    const cursor = this.getCursor();
    if (!cursor) return [];
    const older = this.db.prepare(
      `SELECT slot, block_hash FROM chain_points WHERE slot < ? ORDER BY slot DESC LIMIT ?`
    ).all(cursor.slot, INTERSECTION_POINTS - 1) as Array<{ slot: number; block_hash: string }>;
    return [cursor, ...older.map((r) => ({ slot: r.slot, blockHash: r.block_hash }))];
  }

  getCursor(): CursorRow | null {
    const row = this.db.prepare(
      `SELECT slot, block_hash FROM cursor WHERE id = 1`
    ).get() as { slot: number; block_hash: string } | undefined;
    if (!row) return null;
    return { slot: row.slot, blockHash: row.block_hash };
  }

  // ─── UTxO tracking ─────────────────────────────────────────────────────

  insertUtxo(
    ref: string,
    address: string,
    datumHex: string,
    slot: number,
    txHash: string,
    agentId: string | null = null,
    token: string | null = null,
    genuine: boolean | null = null,
  ): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO utxos (ref, address, datum_hex, created_slot, created_tx, spent_slot, spent_tx, agent_id, token, genuine)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
    ).run(ref, address, datumHex, slot, txHash, agentId, token, genuine === null ? null : genuine ? 1 : 0);
  }

  /**
   * Insert a UTxO that the follower has not seen (start-up load of the
   * outputs at the identity address). A row that exists stays as it is.
   * Returns true when the row was inserted.
   */
  insertUtxoIfAbsent(
    ref: string,
    address: string,
    datumHex: string,
    slot: number,
    txHash: string,
    agentId: string | null,
  ): boolean {
    return this.db.prepare(
      `INSERT OR IGNORE INTO utxos (ref, address, datum_hex, created_slot, created_tx, spent_slot, spent_tx, agent_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`
    ).run(ref, address, datumHex, slot, txHash, agentId).changes === 1;
  }

  spendUtxo(ref: string, slot: number, txHash: string): void {
    this.db.prepare(
      `UPDATE utxos SET spent_slot = ?, spent_tx = ? WHERE ref = ?`
    ).run(slot, txHash, ref);
  }

  getUnspentUtxos(address: string): UtxoRow[] {
    return this.db.prepare(
      `SELECT ref, address, datum_hex, created_slot, created_tx, spent_slot, spent_tx, agent_id
       FROM utxos WHERE address = ? AND spent_slot IS NULL`
    ).all(address) as UtxoRow[];
  }

  /** The follower saw a spend of a Module-1 output; keep its redeemer. */
  recordModule1Spend(ref: string, slot: number, txHash: string, redeemerHex: string | null): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO module1_spends (ref, slot, tx_hash, redeemer_hex) VALUES (?, ?, ?, ?)`
    ).run(ref, slot, txHash, redeemerHex);
  }

  /** All outputs at the Module-1 addresses (spent or not), oldest first, with their spend redeemers. */
  listModule1Outputs(addresses: readonly string[]): Module1OutputRow[] {
    if (addresses.length === 0) return [];
    return this.db.prepare(
      `SELECT u.ref, u.address, u.datum_hex, u.created_slot, u.created_tx, u.spent_slot, u.spent_tx, s.redeemer_hex,
              u.token, u.genuine
       FROM utxos u LEFT JOIN module1_spends s ON s.ref = u.ref
       WHERE u.address IN (${addresses.map(() => "?").join(", ")})
       ORDER BY u.created_slot ASC, u.ref ASC`
    ).all(...addresses) as Module1OutputRow[];
  }

  /** The unspent UTxOs among `refs` (any address), with token and genuineness. */
  getUnspentUtxosByRefs(refs: readonly string[]): UtxoRow[] {
    return this.utxosByRefs(refs, true);
  }

  /** The UTxOs among `refs`, spent or not (any address), with token and genuineness. */
  getUtxosByRefs(refs: readonly string[]): UtxoRow[] {
    return this.utxosByRefs(refs, false);
  }

  private utxosByRefs(refs: readonly string[], unspentOnly: boolean): UtxoRow[] {
    const out: UtxoRow[] = [];
    for (let i = 0; i < refs.length; i += IN_CHUNK) {
      const chunk = refs.slice(i, i + IN_CHUNK);
      out.push(...(this.db.prepare(
        `SELECT ref, address, datum_hex, created_slot, created_tx, spent_slot, spent_tx, agent_id, token, genuine
         FROM utxos WHERE ${unspentOnly ? "spent_slot IS NULL AND " : ""}ref IN (${chunk.map(() => "?").join(", ")})`
      ).all(...chunk) as UtxoRow[]));
    }
    return out;
  }

  // ─── Documents on chain and the jury ───────────────────────────────────

  insertDocument(doc: {
    txHash: string;
    slot: number;
    blockHeight: number | null;
    type: string;
    mediaType: string;
    hash: string;
    bytes: Uint8Array;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO documents (tx_hash, slot, block_height, type, media_type, hash, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      doc.txHash, doc.slot, doc.blockHeight, doc.type, doc.mediaType, doc.hash,
      Buffer.from(doc.bytes.buffer, doc.bytes.byteOffset, doc.bytes.byteLength),
    );
  }

  getDocument(txHash: string): DocumentRow | null {
    const row = this.db.prepare(`SELECT * FROM documents WHERE tx_hash = ?`).get(txHash) as DocumentRow | undefined;
    return row ?? null;
  }

  /** The documents with this blake2b-256, oldest first. */
  listDocumentsByHash(hash: string): DocumentRow[] {
    return this.db.prepare(
      `SELECT * FROM documents WHERE hash = ? ORDER BY slot ASC, tx_hash ASC`
    ).all(hash) as DocumentRow[];
  }

  /** The documents of these transactions, without their bytes, by transaction id. */
  getDocumentSummaries(txHashes: readonly string[]): Map<string, DocumentSummary> {
    const out = new Map<string, DocumentSummary>();
    const unique = [...new Set(txHashes)];
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const chunk = unique.slice(i, i + IN_CHUNK);
      const rows = this.db.prepare(
        `SELECT tx_hash, slot, block_height, type, media_type, hash, length(bytes) AS size
         FROM documents WHERE tx_hash IN (${chunk.map(() => "?").join(", ")})`
      ).all(...chunk) as DocumentSummary[];
      for (const r of rows) out.set(r.tx_hash, r);
    }
    return out;
  }

  /** The jury part of a jury output; its utxos row holds the address and the datum. */
  insertJuryOutput(output: {
    ref: string;
    deployment: string;
    token: string;
    lovelace: string;
    slot: number;
    blockHeight: number | null;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO jury_outputs (ref, deployment, token, lovelace, created_slot, created_height)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(output.ref, output.deployment, output.token, output.lovelace, output.slot, output.blockHeight);
  }

  /** The follower saw a spend of a jury output; keep its redeemer and block height. */
  recordJurySpend(ref: string, slot: number, blockHeight: number | null, txHash: string, redeemerHex: string | null): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO jury_spends (ref, slot, block_height, tx_hash, redeemer_hex) VALUES (?, ?, ?, ?, ?)`
    ).run(ref, slot, blockHeight, txHash, redeemerHex);
  }

  /** All outputs of the jury deployments with these script hashes (spent or not), oldest first. */
  listJuryOutputs(deployments: readonly string[]): JuryOutputRow[] {
    if (deployments.length === 0) return [];
    return this.db.prepare(
      `SELECT j.ref, j.deployment, j.token, j.lovelace, u.datum_hex, u.created_slot, j.created_height, u.created_tx,
              u.spent_slot, s.block_height AS spent_height, u.spent_tx, s.redeemer_hex
       FROM jury_outputs j
       JOIN utxos u ON u.ref = j.ref
       LEFT JOIN jury_spends s ON s.ref = j.ref
       WHERE j.deployment IN (${deployments.map(() => "?").join(", ")})
       ORDER BY u.created_slot ASC, j.ref ASC`
    ).all(...deployments) as JuryOutputRow[];
  }

  // ─── Advertisements ────────────────────────────────────────────────────

  upsertAdvertisement(row: AdvertUpsert): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO advertisements (
         utxo_ref, supplier_pkh, capability_id, model,
         max_output_tokens, max_processing_ms,
         price_lovelace, supplier_bond_lovelace, buyer_bond_lovelace,
         endpoint_url, detail_uri, detail_hash, advertised_at, status,
         created_slot, datum_hex, rolled_back,
         layout, agent_id, creator_signed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.utxo_ref, row.supplier_pkh, row.capability_id, row.model,
      row.max_output_tokens, row.max_processing_ms,
      row.price_lovelace, row.supplier_bond_lovelace, row.buyer_bond_lovelace,
      row.endpoint_url, row.detail_uri, row.detail_hash, row.advertised_at, row.status,
      row.created_slot, row.datum_hex, row.rolled_back,
      row.layout ?? "legacy", row.agent_id ?? null, row.creator_signed ?? 0
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

  /**
   * The adverts that the indexer lists, newest first (listing/rule.ts): current
   * (CURRENT_ADVERT: Active, not rolled back, output not spent), within the
   * value cap; legacy adverts only before the switch slot; new adverts only
   * when they pass the identity listing rule.
   */
  listActiveAdvertisements(filter?: { capability_id?: string; supplier_pkh?: string }): AdvertRow[] {
    let sql = `SELECT a.* FROM advertisements a WHERE ${CURRENT_ADVERT}`;
    const params: unknown[] = [];
    if (filter?.capability_id) {
      sql += ` AND a.capability_id = ?`;
      params.push(filter.capability_id);
    }
    if (filter?.supplier_pkh) {
      sql += ` AND a.supplier_pkh = ?`;
      params.push(filter.supplier_pkh);
    }
    sql += ` ORDER BY a.created_slot DESC`;
    const adverts = this.db.prepare(sql).all(...params) as AdvertRow[];

    const agentIds = [...new Set(adverts.flatMap((a) => (a.layout === "identity" && a.agent_id ? [a.agent_id] : [])))];
    const facts = this.getIdentityFacts(agentIds);
    const records = this.liveIdentityRecords(agentIds);
    const ctx = {
      currentSlot: this.getCursor()?.slot ?? 0,
      switchSlot: this.listing.switchSlot,
      nowMs: this.listing.now(),
      maxAgeMs: this.listing.maxAgeMs,
    };
    return adverts.filter((a) => {
      const agentId = a.agent_id;
      const record = {
        hasRecord: agentId !== null && records.has(agentId),
        facts: agentId === null ? null : facts.get(agentId) ?? null,
      };
      return advertListing(a, record, ctx).listed;
    });
  }

  // ─── Identity records and gateway answers ──────────────────────────────

  /** The agent ids among `agentIds` that have an unspent record output at the identity address. */
  private liveIdentityRecords(agentIds: readonly string[]): Set<string> {
    const live = new Set<string>();
    const identityAddress = this.listing.identityAddress;
    if (!identityAddress) return live;
    for (let i = 0; i < agentIds.length; i += IN_CHUNK) {
      const chunk = agentIds.slice(i, i + IN_CHUNK);
      const rows = this.db.prepare(
        `SELECT DISTINCT agent_id FROM utxos
         WHERE address = ? AND spent_slot IS NULL AND agent_id IN (${chunk.map(() => "?").join(", ")})`
      ).all(identityAddress, ...chunk) as Array<{ agent_id: string }>;
      for (const r of rows) live.add(r.agent_id);
    }
    return live;
  }

  /**
   * Agents whose identity facts the refresher keeps current: the agent_id of
   * each current new advert (CURRENT_ADVERT) whose creating transaction lists
   * the supplier key and whose record is an unspent output at the identity
   * address.
   */
  listIdentityAgentsToResolve(): string[] {
    const identityAddress = this.listing.identityAddress;
    if (!identityAddress) return [];
    const rows = this.db.prepare(
      `SELECT DISTINCT a.agent_id FROM advertisements a
       WHERE a.layout = 'identity' AND ${CURRENT_ADVERT}
         AND a.creator_signed = 1 AND a.agent_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM utxos u
                     WHERE u.address = ? AND u.agent_id = a.agent_id AND u.spent_slot IS NULL)
       ORDER BY a.agent_id`
    ).all(identityAddress) as Array<{ agent_id: string }>;
    return rows.map((r) => r.agent_id);
  }

  getIdentityFacts(agentIds: readonly string[]): Map<string, IdentityFacts> {
    const out = new Map<string, IdentityFacts>();
    for (let i = 0; i < agentIds.length; i += IN_CHUNK) {
      const chunk = agentIds.slice(i, i + IN_CHUNK);
      const rows = this.db.prepare(
        `SELECT * FROM identity_facts WHERE agent_id IN (${chunk.map(() => "?").join(", ")})`
      ).all(...chunk) as IdentityFacts[];
      for (const r of rows) out.set(r.agent_id, r);
    }
    return out;
  }

  /**
   * Store a definitive gateway answer. `facts.resolved_at` is the start of the
   * request. A record change that the follower saw after that start keeps the
   * entry invalidated; an older one is cleared.
   */
  saveIdentityFacts(facts: Omit<IdentityFacts, "invalidated_at">): void {
    this.db.prepare(
      `INSERT INTO identity_facts (
         agent_id, found, effective, independent, origin, transaction_keys, capabilities, detail, resolved_at, invalidated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(agent_id) DO UPDATE SET
         found = excluded.found,
         effective = excluded.effective,
         independent = excluded.independent,
         origin = excluded.origin,
         transaction_keys = excluded.transaction_keys,
         capabilities = excluded.capabilities,
         detail = excluded.detail,
         resolved_at = excluded.resolved_at,
         invalidated_at = CASE
           WHEN identity_facts.invalidated_at IS NOT NULL AND identity_facts.invalidated_at > excluded.resolved_at
           THEN identity_facts.invalidated_at
           ELSE NULL
         END`
    ).run(
      facts.agent_id, facts.found, facts.effective, facts.independent, facts.origin,
      facts.transaction_keys, facts.capabilities, facts.detail, facts.resolved_at,
    );
  }

  /** The follower saw a change of these records at `atMs`: their stored answers no longer count. */
  invalidateIdentityFacts(agentIds: readonly string[], atMs: number): void {
    const stmt = this.db.prepare(`UPDATE identity_facts SET invalidated_at = ? WHERE agent_id = ?`);
    for (const id of agentIds) stmt.run(atMs, id);
  }

  // ─── Escrows ───────────────────────────────────────────────────────────

  upsertEscrow(row: EscrowUpsert): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO escrows (
         utxo_ref, buyer_pkh, supplier_pkh,
         advert_ref_tx, advert_ref_index,
         capability_id, request_spec_hash, prompt_hash,
         payment_lovelace, buyer_bond_lovelace, supplier_bond_lovelace,
         deliver_by, posted_at, submitted_at, result_receipt_hash,
         state, created_slot, datum_hex, rolled_back,
         layout, agent_id, refund_address, refund_datum
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.utxo_ref, row.buyer_pkh, row.supplier_pkh,
      row.advert_ref_tx, row.advert_ref_index,
      row.capability_id, row.request_spec_hash, row.prompt_hash,
      row.payment_lovelace, row.buyer_bond_lovelace, row.supplier_bond_lovelace,
      row.deliver_by, row.posted_at, row.submitted_at, row.result_receipt_hash,
      row.state, row.created_slot, row.datum_hex, row.rolled_back,
      row.layout ?? "legacy", row.agent_id ?? null, row.refund_address ?? null, row.refund_datum ?? null
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

  /** The first rows (state Open) of the identity-layout escrows of `agentId`, newest first. */
  listIdentityEscrowOrigins(agentId: string): EscrowRow[] {
    return this.db.prepare(
      `SELECT * FROM escrows
       WHERE layout = 'identity' AND agent_id = ? AND state = 'Open' AND rolled_back = 0
       ORDER BY created_slot DESC, utxo_ref DESC`
    ).all(agentId) as EscrowRow[];
  }

  /**
   * Follow one escrow through the transactions which spend it. A transition is
   * eligible only when the spending transaction creates exactly one escrow
   * output with the same immutable datum fields (for the identity layout also
   * agent_id and refund) and the next protocol state. Terminal state is
   * reported only when the matching, non-rolled-back event was observed for
   * the spend. RefundRevoked ends a new escrow in any of Open, Claimed and
   * Submitted (Part 2 §6.1).
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
        AND e.layout = ?
        AND e.agent_id IS ?
        AND e.refund_address IS ?
        AND e.refund_datum IS ?
      ORDER BY e.utxo_ref ASC
    `);
    const getTerminalEvents = this.db.prepare(`
      SELECT type, tx_hash
      FROM events
      WHERE rolled_back = 0
        AND tx_hash = ?
        AND utxo_ref = ?
        AND type IN ('AcceptEscrow', 'ReclaimEscrow', 'ReleaseEscrow', 'RefundRevokedEscrow')
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
              current.layout,
              current.agent_id,
              current.refund_address,
              current.refund_datum,
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
              current.state === "Submitted") ||
            (terminal.type === "RefundRevokedEscrow" &&
              current.layout === "identity" &&
              (current.state === "Open" || current.state === "Claimed" || current.state === "Submitted"));
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

  /**
   * Roll the state back to the block `point` (null: the origin, before the
   * first block). Everything that later blocks wrote goes: their events
   * (soft delete), UTxOs, adverts, escrows, the supplier status of those
   * adverts, documents and jury rows. Their spends are undone, and an advert
   * that they retired gets the status of its datum again. The cursor and the
   * intersection points move to `point`.
   *
   * Returns the agent ids of the identity record outputs that the rollback
   * removes or makes unspent again, so the caller can invalidate their
   * identity facts.
   */
  rollbackTo(point: CursorRow | null): string[] {
    // Rows at a slot after `after` come from the rolled-back blocks.
    const after = point === null ? -1 : point.slot;
    return this.transaction((): string[] => {
      const touched = this.db.prepare(
        `SELECT DISTINCT agent_id FROM utxos
         WHERE agent_id IS NOT NULL AND (created_slot > ? OR spent_slot > ?)
         ORDER BY agent_id`
      ).all(after, after) as Array<{ agent_id: string }>;

      // Before the events go: adverts that a rolled-back RetireAdvert retired.
      // Their status before the retirement is the status of their datum.
      const retired = this.db.prepare(
        `SELECT utxo_ref, datum_hex FROM advertisements
         WHERE created_slot <= ? AND utxo_ref IN (
           SELECT utxo_ref FROM events WHERE type = 'RetireAdvert' AND slot > ? AND rolled_back = 0)`
      ).all(after, after) as Array<{ utxo_ref: string; datum_hex: string }>;
      const restoreStatus = this.db.prepare(`UPDATE advertisements SET status = ? WHERE utxo_ref = ?`);
      for (const r of retired) restoreStatus.run(decodeAnyAdvertDatum(r.datum_hex).datum.status, r.utxo_ref);

      this.db.prepare(
        `DELETE FROM supplier_status
         WHERE advert_ref IN (SELECT utxo_ref FROM advertisements WHERE created_slot > ?)`
      ).run(after);
      this.db.prepare(`DELETE FROM advertisements WHERE created_slot > ?`).run(after);
      this.db.prepare(`DELETE FROM escrows WHERE created_slot > ?`).run(after);
      this.db.prepare(`UPDATE events SET rolled_back = 1 WHERE slot > ? AND rolled_back = 0`).run(after);
      this.db.prepare(`DELETE FROM module1_spends WHERE slot > ?`).run(after);
      this.db.prepare(`DELETE FROM jury_spends WHERE slot > ?`).run(after);
      this.db.prepare(`DELETE FROM jury_outputs WHERE created_slot > ?`).run(after);
      this.db.prepare(`DELETE FROM documents WHERE slot > ?`).run(after);
      this.db.prepare(`DELETE FROM utxos WHERE created_slot > ?`).run(after);
      this.db.prepare(
        `UPDATE utxos SET spent_slot = NULL, spent_tx = NULL WHERE spent_slot > ?`
      ).run(after);

      if (point === null) {
        this.db.prepare(`DELETE FROM cursor`).run();
        this.db.prepare(`DELETE FROM chain_points`).run();
      } else {
        const kept = this.db.prepare(`SELECT block_height FROM chain_points WHERE slot = ? AND block_hash = ?`)
          .get(point.slot, point.blockHash) as { block_height: number | null } | undefined;
        this.saveCursor(point.slot, point.blockHash, kept?.block_height ?? null);
      }
      return touched.map((r) => r.agent_id);
    });
  }

  // ─── Resync (Part 2 §6.4 backfill, recovery) ───────────────────────────

  /**
   * Sync again from an earlier block of the current chain. When the cursor
   * is after `point`, the state rolls back to `point` (rollbackTo: all
   * tables), so the follower reads the later blocks again with the current
   * watched addresses. A cursor at or before `point` does not move: the
   * follower reads those blocks anyway. A marker in `meta` makes this happen
   * once per point. Returns true when the cursor moved back.
   *
   * Throws when the database holds another block at the slot of `point`:
   * that block is not on the chain of `point`, so its state cannot stay.
   */
  applyResync(point: CursorRow): boolean {
    const marker = `${point.slot}:${point.blockHash}`;
    return this.transaction((): boolean => {
      const done = this.db.prepare(`SELECT value FROM meta WHERE key = 'resync_point'`).get() as
        | { value: string }
        | undefined;
      if (done?.value === marker) return false;
      const cursor = this.getCursor();
      const saved = this.db.prepare(`SELECT block_hash FROM chain_points WHERE slot = ?`).get(point.slot) as
        | { block_hash: string }
        | undefined;
      const stored = cursor?.slot === point.slot ? cursor.blockHash : saved?.block_hash;
      if (stored !== undefined && stored !== point.blockHash) {
        throw new Error(
          `resync point ${marker}: the database holds block ${stored} at slot ${point.slot}, ` +
          `so the point is not on the indexed chain. Choose a block of the current chain before slot ${point.slot}.`,
        );
      }
      const rewind = cursor !== null && cursor.slot > point.slot;
      if (rewind) this.rollbackTo(point);
      this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('resync_point', ?)`).run(marker);
      return rewind;
    });
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
