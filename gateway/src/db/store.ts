/**
 * gateway/src/db/store.ts — synchronous SQLite store (mirrors buyer/src/db/archive.ts).
 *
 * better-sqlite3 + WAL + prepared statements. Low write volume (≤1 row per
 * request) so synchronous is fine and simpler than async.
 */

import { mkdirSync } from "fs";
import { join, resolve } from "path";
import Database from "better-sqlite3";
import type { Database as BetterDatabase } from "better-sqlite3";
import { CREATE_TABLES_SQL } from "./schema.js";

export interface ApiKeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  label: string | null;
  wallet_pkh: string;
  deposit_address: string;
  enc_priv_nonce: string;
  enc_priv_ct: string;
  enc_priv_tag: string;
  master_key_version: number;
  created_at: number;
  disabled: number;
}

export interface UsageRow {
  id: string;
  key_id: string;
  created_at: number;
  kind: string;
  model: string | null;
  capability_id: string | null;
  supplier_pkh: string | null;
  escrow_ref: string | null;
  cost_lovelace: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  status: string;
  failure_reason: string | null;
}

export interface SessionRow {
  id: string;
  key_id: string;
  escrow_ref: string;
  session_nonce: string;
  supplier_base_url: string;
  supplier_pkh: string;
  model: string;
  price_lovelace: string;
  state: string;
  opened_at: number;
  closed_at: number | null;
}

export class GatewayStore {
  private readonly db: BetterDatabase;

  private readonly sInsertKey;
  private readonly sGetKeyByHash;
  private readonly sGetKeyById;
  private readonly sListKeys;
  private readonly sListAllKeys;
  private readonly sUpdateKeyEncryption;
  private readonly sInsertUsage;
  private readonly sSumCost;
  private readonly sCountByKey;
  private readonly sListUsage;
  private readonly sInsertSession;
  private readonly sGetSession;
  private readonly sSetSessionState;
  private readonly sListOpenSessions;

  constructor(dbDir: string) {
    const dir = resolve(dbDir);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "gateway.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CREATE_TABLES_SQL);

    this.sInsertKey = this.db.prepare(`
      INSERT INTO api_keys (
        id, key_hash, key_prefix, label, wallet_pkh, deposit_address,
        enc_priv_nonce, enc_priv_ct, enc_priv_tag, master_key_version, created_at, disabled
      ) VALUES (
        @id, @key_hash, @key_prefix, @label, @wallet_pkh, @deposit_address,
        @enc_priv_nonce, @enc_priv_ct, @enc_priv_tag, @master_key_version, @created_at, 0
      )
    `);
    this.sGetKeyByHash = this.db.prepare(`SELECT * FROM api_keys WHERE key_hash = @key_hash`);
    this.sGetKeyById = this.db.prepare(`SELECT * FROM api_keys WHERE id = @id`);
    this.sListKeys = this.db.prepare(`SELECT * FROM api_keys WHERE disabled = 0`);
    this.sListAllKeys = this.db.prepare(`SELECT * FROM api_keys`);
    this.sUpdateKeyEncryption = this.db.prepare(`
      UPDATE api_keys SET enc_priv_nonce = @enc_priv_nonce, enc_priv_ct = @enc_priv_ct,
        enc_priv_tag = @enc_priv_tag, master_key_version = @master_key_version WHERE id = @id
    `);

    this.sInsertUsage = this.db.prepare(`
      INSERT INTO usage (
        id, key_id, created_at, kind, model, capability_id, supplier_pkh, escrow_ref,
        cost_lovelace, prompt_tokens, completion_tokens, status, failure_reason
      ) VALUES (
        @id, @key_id, @created_at, @kind, @model, @capability_id, @supplier_pkh, @escrow_ref,
        @cost_lovelace, @prompt_tokens, @completion_tokens, @status, @failure_reason
      )
    `);
    this.sSumCost = this.db.prepare(`
      SELECT COALESCE(SUM(CAST(cost_lovelace AS INTEGER)), 0) AS total
      FROM usage WHERE key_id = @key_id AND status = 'completed'
    `);
    this.sCountByKey = this.db.prepare(`SELECT COUNT(*) AS n FROM usage WHERE key_id = @key_id`);
    this.sListUsage = this.db.prepare(`
      SELECT * FROM usage WHERE key_id = @key_id ORDER BY created_at DESC LIMIT @limit
    `);

    this.sInsertSession = this.db.prepare(`
      INSERT INTO sessions (
        id, key_id, escrow_ref, session_nonce, supplier_base_url, supplier_pkh,
        model, price_lovelace, state, opened_at, closed_at
      ) VALUES (
        @id, @key_id, @escrow_ref, @session_nonce, @supplier_base_url, @supplier_pkh,
        @model, @price_lovelace, @state, @opened_at, NULL
      )
    `);
    this.sGetSession = this.db.prepare(`SELECT * FROM sessions WHERE id = @id`);
    this.sSetSessionState = this.db.prepare(`
      UPDATE sessions SET state = @state, closed_at = @closed_at WHERE id = @id
    `);
    this.sListOpenSessions = this.db.prepare(`SELECT * FROM sessions WHERE state = 'open'`);
  }

  insertKey(row: Omit<ApiKeyRow, "disabled">): void {
    this.sInsertKey.run({ ...row, label: row.label ?? null });
  }

  getKeyByHash(keyHash: string): ApiKeyRow | undefined {
    return this.sGetKeyByHash.get({ key_hash: keyHash }) as ApiKeyRow | undefined;
  }

  getKeyById(id: string): ApiKeyRow | undefined {
    return this.sGetKeyById.get({ id }) as ApiKeyRow | undefined;
  }

  listKeys(): ApiKeyRow[] {
    return this.sListKeys.all() as ApiKeyRow[];
  }

  listAllKeys(): ApiKeyRow[] {
    return this.sListAllKeys.all() as ApiKeyRow[];
  }

  updateKeyEncryption(
    id: string,
    enc: { enc_priv_nonce: string; enc_priv_ct: string; enc_priv_tag: string; master_key_version: number },
  ): void {
    this.sUpdateKeyEncryption.run({ id, ...enc });
  }

  insertUsage(row: UsageRow): void {
    this.sInsertUsage.run(row);
  }

  sumCostLovelace(keyId: string): bigint {
    const r = this.sSumCost.get({ key_id: keyId }) as { total: number } | undefined;
    return BigInt(r?.total ?? 0);
  }

  countUsage(keyId: string): number {
    const r = this.sCountByKey.get({ key_id: keyId }) as { n: number } | undefined;
    return r?.n ?? 0;
  }

  listUsage(keyId: string, limit: number): UsageRow[] {
    return this.sListUsage.all({ key_id: keyId, limit }) as UsageRow[];
  }

  insertSession(row: Omit<SessionRow, "closed_at">): void {
    this.sInsertSession.run(row);
  }

  getSession(id: string): SessionRow | undefined {
    return this.sGetSession.get({ id }) as SessionRow | undefined;
  }

  setSessionState(id: string, state: string, closedAt: number | null): void {
    this.sSetSessionState.run({ id, state, closed_at: closedAt });
  }

  listOpenSessions(): SessionRow[] {
    return this.sListOpenSessions.all() as SessionRow[];
  }
}
