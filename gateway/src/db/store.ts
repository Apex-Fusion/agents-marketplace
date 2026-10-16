import { mkdirSync } from "fs";
import { join, resolve } from "path";
import Database from "better-sqlite3";
import type { Database as BetterDatabase, Statement } from "better-sqlite3";
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
  demo: number;
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
  last_used_at: number;
  head_response_id: string | null;
  managed_demo: number;
  max_output_tokens: number;
  max_processing_ms: number;
  transcript_nonce: string | null;
  transcript_ct: string | null;
  transcript_tag: string | null;
}

export interface ResponseEncryptionUpdate {
  id: string;
  input_nonce: string;
  input_ct: string;
  input_tag: string;
  response_nonce: string | null;
  response_ct: string | null;
  response_tag: string | null;
}

export interface SessionEncryptionUpdate {
  id: string;
  transcript_nonce: string;
  transcript_ct: string;
  transcript_tag: string;
}

export interface StoredResponseRow {
  id: string;
  key_id: string;
  model: string;
  previous_response_id: string | null;
  session_id: string | null;
  status: string;
  stored: number;
  created_at: number;
  completed_at: number | null;
  expires_at: number;
  input_nonce: string;
  input_ct: string;
  input_tag: string;
  response_nonce: string | null;
  response_ct: string | null;
  response_tag: string | null;
}

export type OneShotJobState =
  | "queued"
  | "reserved"
  | "funding"
  | "running"
  | "submitted"
  | "settling"
  | "recovering"
  | "completed"
  | "failed"
  | "reclaimed";

export interface OneShotJobRow {
  id: string;
  key_id: string;
  owner_id: string;
  model: string;
  state: OneShotJobState;
  created_at: number;
  updated_at: number;
  heartbeat_at: number;
  supplier_pkh: string | null;
  endpoint_url: string | null;
  advert_ref: string | null;
  price_lovelace: string | null;
  max_processing_ms: number | null;
  escrow_ref: string | null;
  submitted_ref: string | null;
  receipt_hash: string | null;
  supplier_job_id: string | null;
  settle_tx_hash: string | null;
  deliver_by: number | null;
  post_valid_until_slot: number | null;
  recovery_slot: number | null;
  error: string | null;
}

export interface PendingWalletTransaction {
  key_id: string;
  tx_hash: string;
  tx_cbor: string;
  created_at: number;
  valid_until_slot: number | null;
}

export interface WalletTransactionOutcome {
  key_id: string;
  tx_hash: string;
  state: "confirmed" | "rejected" | "expired";
  resolved_at: number;
}

const ONE_SHOT_MUTABLE_FIELDS: Partial<Record<keyof OneShotJobRow, true>> = {
  state: true,
  updated_at: true,
  heartbeat_at: true,
  supplier_pkh: true,
  endpoint_url: true,
  advert_ref: true,
  price_lovelace: true,
  max_processing_ms: true,
  escrow_ref: true,
  submitted_ref: true,
  receipt_hash: true,
  supplier_job_id: true,
  settle_tx_hash: true,
  deliver_by: true,
  post_valid_until_slot: true,
  recovery_slot: true,
  error: true,
};

export class GatewayStore {
  private readonly db: BetterDatabase;
  private readonly sInsertKey: Statement;
  private readonly sGetKeyByHash: Statement;
  private readonly sGetKeyById: Statement;
  private readonly sListKeys: Statement;
  private readonly sListAllKeys: Statement;
  private readonly sUpdateKeyEncryption: Statement;
  private readonly sInsertUsage: Statement;
  private readonly sUpsertUsage: Statement;
  private readonly sSumCost: Statement;
  private readonly sCountByKey: Statement;
  private readonly sListUsage: Statement;
  private readonly sInsertSession: Statement;
  private readonly sGetSession: Statement;
  private readonly sSetSessionState: Statement;
  private readonly sListOpenSessions: Statement;
  private readonly sTouchSession: Statement;
  private readonly sSetSessionHead: Statement;
  private readonly sSetSessionTranscript: Statement;
  private readonly sInvalidateSessionHead: Statement;
  private readonly sInsertResponse: Statement;
  private readonly sCompleteResponse: Statement;
  private readonly sGetOwnedResponse: Statement;
  private readonly sGetResponse: Statement;
  private readonly sDeleteResponseTree: Statement;
  private readonly sDeleteExpiredTrees: Statement;
  private readonly sExtendResponseAncestors: Statement;
  private readonly sClearSessionHeadsForTree: Statement;
  private readonly sClearExpiredSessionHeads: Statement;
  private readonly sInsertOneShotJob: Statement;
  private readonly sCountOneShotOutstanding: Statement;
  private readonly sGetOneShotJob: Statement;
  private readonly sListOneShotJobs: Statement;
  private readonly sListOneShotJobsByKey: Statement;
  private readonly sListUnfinishedOneShotJobs: Statement;
  private readonly sCountActiveOneShotJobs: Statement;
  private readonly sReserveOneShotSupplier: Statement;
  private readonly sUpdateOneShotJob: Statement;
  private readonly sHeartbeatOneShotJobs: Statement;
  private readonly sClaimOneShotJob: Statement;
  private readonly sCompleteOneShotJob: Statement;
  private readonly sGetPendingWalletTransaction: Statement;
  private readonly sInsertPendingWalletTransaction: Statement;
  private readonly sClearPendingWalletTransaction: Statement;
  private readonly sGetWalletTransactionOutcome: Statement;
  private readonly sInsertWalletTransactionOutcome: Statement;


  constructor(dbDir: string) {
    const dir = resolve(dbDir);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "gateway.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(CREATE_TABLES_SQL);

    const keyCols = this.db.pragma("table_info(api_keys)") as Array<{ name: string }>;
    if (!keyCols.some((column) => column.name === "demo")) {
      this.db.exec("ALTER TABLE api_keys ADD COLUMN demo INTEGER NOT NULL DEFAULT 0");
    }
    const sessionCols = this.db.pragma("table_info(sessions)") as Array<{ name: string }>;
    if (!sessionCols.some((column) => column.name === "last_used_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0");
    }
    if (!sessionCols.some((column) => column.name === "head_response_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN head_response_id TEXT");
    }
    if (!sessionCols.some((column) => column.name === "managed_demo")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN managed_demo INTEGER NOT NULL DEFAULT 0");
    }
    if (!sessionCols.some((column) => column.name === "max_output_tokens")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 0");
    }
    if (!sessionCols.some((column) => column.name === "max_processing_ms")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN max_processing_ms INTEGER NOT NULL DEFAULT 300000");
    }
    if (!sessionCols.some((column) => column.name === "transcript_nonce")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN transcript_nonce TEXT");
    }
    if (!sessionCols.some((column) => column.name === "transcript_ct")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN transcript_ct TEXT");
    }
    if (!sessionCols.some((column) => column.name === "transcript_tag")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN transcript_tag TEXT");
    }

    this.sInsertKey = this.db.prepare(`INSERT INTO api_keys (
      id, key_hash, key_prefix, label, wallet_pkh, deposit_address,
      enc_priv_nonce, enc_priv_ct, enc_priv_tag, master_key_version, created_at, disabled, demo
    ) VALUES (
      @id, @key_hash, @key_prefix, @label, @wallet_pkh, @deposit_address,
      @enc_priv_nonce, @enc_priv_ct, @enc_priv_tag, @master_key_version, @created_at, 0, @demo
    )`);
    this.sGetKeyByHash = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = @key_hash");
    this.sGetKeyById = this.db.prepare("SELECT * FROM api_keys WHERE id = @id");
    this.sListKeys = this.db.prepare("SELECT * FROM api_keys WHERE disabled = 0");
    this.sListAllKeys = this.db.prepare("SELECT * FROM api_keys");
    this.sUpdateKeyEncryption = this.db.prepare(`UPDATE api_keys SET enc_priv_nonce = @enc_priv_nonce,
      enc_priv_ct = @enc_priv_ct, enc_priv_tag = @enc_priv_tag,
      master_key_version = @master_key_version WHERE id = @id`);

    this.sInsertUsage = this.db.prepare(`INSERT INTO usage (
      id, key_id, created_at, kind, model, capability_id, supplier_pkh, escrow_ref,
      cost_lovelace, prompt_tokens, completion_tokens, status, failure_reason
    ) VALUES (
      @id, @key_id, @created_at, @kind, @model, @capability_id, @supplier_pkh, @escrow_ref,
      @cost_lovelace, @prompt_tokens, @completion_tokens, @status, @failure_reason
    )`);
    this.sUpsertUsage = this.db.prepare(`INSERT INTO usage (
      id, key_id, created_at, kind, model, capability_id, supplier_pkh, escrow_ref,
      cost_lovelace, prompt_tokens, completion_tokens, status, failure_reason
    ) VALUES (
      @id, @key_id, @created_at, @kind, @model, @capability_id, @supplier_pkh, @escrow_ref,
      @cost_lovelace, @prompt_tokens, @completion_tokens, @status, @failure_reason
    ) ON CONFLICT(id) DO UPDATE SET
      key_id = excluded.key_id,
      created_at = excluded.created_at,
      kind = excluded.kind,
      model = excluded.model,
      capability_id = excluded.capability_id,
      supplier_pkh = excluded.supplier_pkh,
      escrow_ref = excluded.escrow_ref,
      cost_lovelace = excluded.cost_lovelace,
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      status = excluded.status,
      failure_reason = excluded.failure_reason`);
    this.sSumCost = this.db.prepare(`SELECT COALESCE(SUM(CAST(cost_lovelace AS INTEGER)), 0) AS total
      FROM usage WHERE key_id = @key_id AND status = 'completed'`);
    this.sCountByKey = this.db.prepare("SELECT COUNT(*) AS n FROM usage WHERE key_id = @key_id");
    this.sListUsage = this.db.prepare("SELECT * FROM usage WHERE key_id = @key_id ORDER BY created_at DESC LIMIT @limit");

    this.sInsertSession = this.db.prepare(`INSERT INTO sessions (
      id, key_id, escrow_ref, session_nonce, supplier_base_url, supplier_pkh,
      model, price_lovelace, state, opened_at, closed_at, last_used_at, head_response_id,
      managed_demo, max_output_tokens, max_processing_ms,
      transcript_nonce, transcript_ct, transcript_tag
    ) VALUES (
      @id, @key_id, @escrow_ref, @session_nonce, @supplier_base_url, @supplier_pkh,
      @model, @price_lovelace, @state, @opened_at, NULL, @opened_at, NULL,
      @managed_demo, @max_output_tokens, @max_processing_ms,
      @transcript_nonce, @transcript_ct, @transcript_tag
    )`);
    this.sGetSession = this.db.prepare("SELECT * FROM sessions WHERE id = @id");
    this.sSetSessionState = this.db.prepare(`UPDATE sessions SET state = @state, closed_at = @closed_at,
      transcript_nonce = CASE WHEN @state = 'open' THEN transcript_nonce ELSE NULL END,
      transcript_ct = CASE WHEN @state = 'open' THEN transcript_ct ELSE NULL END,
      transcript_tag = CASE WHEN @state = 'open' THEN transcript_tag ELSE NULL END
      WHERE id = @id`);
    this.sListOpenSessions = this.db.prepare("SELECT * FROM sessions WHERE state = 'open'");
    this.sTouchSession = this.db.prepare("UPDATE sessions SET last_used_at = @last_used_at WHERE id = @id");
    this.sSetSessionHead = this.db.prepare(`UPDATE sessions SET head_response_id = @head_response_id,
      last_used_at = @last_used_at WHERE id = @id AND state = 'open'`);
    this.sSetSessionTranscript = this.db.prepare(`UPDATE sessions SET transcript_nonce = @transcript_nonce,
      transcript_ct = @transcript_ct, transcript_tag = @transcript_tag, last_used_at = @last_used_at
      WHERE id = @id AND state = 'open'`);
    this.sInvalidateSessionHead = this.db.prepare(`UPDATE sessions SET head_response_id = NULL,
      last_used_at = @last_used_at WHERE id = @id AND state = 'open'`);

    this.sInsertResponse = this.db.prepare(`INSERT INTO responses (
      id, key_id, model, previous_response_id, session_id, status, stored, created_at,
      completed_at, expires_at, input_nonce, input_ct, input_tag, response_nonce, response_ct, response_tag
    ) VALUES (
      @id, @key_id, @model, @previous_response_id, @session_id, @status, @stored, @created_at,
      NULL, @expires_at, @input_nonce, @input_ct, @input_tag, NULL, NULL, NULL
    )`);
    this.sCompleteResponse = this.db.prepare(`UPDATE responses SET status = @status,
      session_id = @session_id, completed_at = @completed_at, response_nonce = @response_nonce,
      response_ct = @response_ct, response_tag = @response_tag
      WHERE id = @id AND key_id = @key_id AND status = 'in_progress'`);
    this.sGetOwnedResponse = this.db.prepare("SELECT * FROM responses WHERE id = @id AND key_id = @key_id");
    this.sGetResponse = this.db.prepare("SELECT * FROM responses WHERE id = @id");
    this.sDeleteResponseTree = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM responses WHERE id = @id AND key_id = @key_id
      UNION ALL SELECT responses.id FROM responses JOIN descendants
        ON responses.previous_response_id = descendants.id WHERE responses.key_id = @key_id
    ) DELETE FROM responses WHERE id IN (SELECT id FROM descendants)`);
    this.sDeleteExpiredTrees = this.db.prepare(`WITH RECURSIVE expired(id) AS (
      SELECT id FROM responses WHERE expires_at <= @now
      UNION ALL SELECT responses.id FROM responses JOIN expired ON responses.previous_response_id = expired.id
    ) DELETE FROM responses WHERE id IN (SELECT id FROM expired)`);
    this.sExtendResponseAncestors = this.db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT id FROM responses WHERE id = @id AND key_id = @key_id
      UNION ALL SELECT responses.previous_response_id FROM responses JOIN ancestors
        ON responses.id = ancestors.id
        WHERE responses.previous_response_id IS NOT NULL AND responses.key_id = @key_id
    ) UPDATE responses SET expires_at = MAX(expires_at, @expires_at)
      WHERE id IN (SELECT id FROM ancestors) AND key_id = @key_id`);
    this.sClearSessionHeadsForTree = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM responses WHERE id = @id AND key_id = @key_id
      UNION ALL SELECT responses.id FROM responses JOIN descendants
        ON responses.previous_response_id = descendants.id WHERE responses.key_id = @key_id
    ) UPDATE sessions SET head_response_id = NULL
      WHERE head_response_id IN (SELECT id FROM descendants)`);
    this.sClearExpiredSessionHeads = this.db.prepare(`WITH RECURSIVE expired(id) AS (
      SELECT id FROM responses WHERE expires_at <= @now
      UNION ALL SELECT responses.id FROM responses JOIN expired ON responses.previous_response_id = expired.id
    ) UPDATE sessions SET head_response_id = NULL WHERE head_response_id IN (SELECT id FROM expired)`);

    this.sInsertOneShotJob = this.db.prepare(`INSERT INTO one_shot_jobs (
      id, key_id, owner_id, model, state, created_at, updated_at, heartbeat_at
    ) VALUES (
      @id, @key_id, @owner_id, @model, 'queued', @created_at, @created_at, @created_at
    )`);
    this.sCountOneShotOutstanding = this.db.prepare(`SELECT COUNT(*) AS n
      FROM one_shot_jobs
      WHERE key_id = @key_id AND state NOT IN ('completed', 'failed', 'reclaimed')`);
    this.sGetOneShotJob = this.db.prepare("SELECT * FROM one_shot_jobs WHERE id = @id");
    this.sListOneShotJobs = this.db.prepare(
      "SELECT * FROM one_shot_jobs ORDER BY created_at, id",
    );
    this.sListOneShotJobsByKey = this.db.prepare(
      "SELECT * FROM one_shot_jobs WHERE key_id = @key_id ORDER BY created_at, id",
    );
    this.sListUnfinishedOneShotJobs = this.db.prepare(`SELECT * FROM one_shot_jobs
      WHERE state NOT IN ('completed', 'failed', 'reclaimed') ORDER BY created_at, id`);
    this.sCountActiveOneShotJobs = this.db.prepare(`SELECT COUNT(*) AS n
      FROM one_shot_jobs
      WHERE key_id = @key_id
        AND state IN ('reserved', 'funding', 'running', 'submitted', 'settling', 'recovering')`);
    this.sReserveOneShotSupplier = this.db.prepare(`UPDATE one_shot_jobs SET
      state = 'reserved',
      updated_at = @now,
      heartbeat_at = @now,
      supplier_pkh = @supplier_pkh,
      endpoint_url = @endpoint_url,
      advert_ref = @advert_ref,
      price_lovelace = @price_lovelace,
      max_processing_ms = @max_processing_ms
      WHERE id = @id AND owner_id = @owner_id AND state = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM one_shot_jobs AS active
          WHERE active.supplier_pkh = @supplier_pkh
            AND active.state IN ('reserved', 'funding', 'running', 'submitted', 'settling', 'recovering')
        )`);
    this.sUpdateOneShotJob = this.db.prepare(`UPDATE one_shot_jobs SET
      state = @state,
      updated_at = @updated_at,
      heartbeat_at = @heartbeat_at,
      supplier_pkh = @supplier_pkh,
      endpoint_url = @endpoint_url,
      advert_ref = @advert_ref,
      price_lovelace = @price_lovelace,
      max_processing_ms = @max_processing_ms,
      escrow_ref = @escrow_ref,
      submitted_ref = @submitted_ref,
      receipt_hash = @receipt_hash,
      supplier_job_id = @supplier_job_id,
      settle_tx_hash = @settle_tx_hash,
      deliver_by = @deliver_by,
      post_valid_until_slot = @post_valid_until_slot,
      recovery_slot = @recovery_slot,
      error = @error
      WHERE id = @id AND owner_id = @owner_id
        AND state NOT IN ('completed', 'failed', 'reclaimed')`);
    this.sHeartbeatOneShotJobs = this.db.prepare(`UPDATE one_shot_jobs
      SET heartbeat_at = @now
      WHERE owner_id = @owner_id AND state NOT IN ('completed', 'failed', 'reclaimed')`);
    this.sClaimOneShotJob = this.db.prepare(`UPDATE one_shot_jobs SET
      owner_id = @new_owner_id, updated_at = @now, heartbeat_at = @now
      WHERE id = @id AND heartbeat_at <= @stale_before
        AND state NOT IN ('completed', 'failed', 'reclaimed')`);
    this.sCompleteOneShotJob = this.db.prepare(`UPDATE one_shot_jobs SET
      state = @state, updated_at = @now, heartbeat_at = @now, error = @error
      WHERE id = @id AND owner_id = @owner_id
        AND state NOT IN ('completed', 'failed', 'reclaimed')`);

    this.sGetPendingWalletTransaction = this.db.prepare(
      "SELECT * FROM pending_wallet_transactions WHERE key_id = @key_id",
    );
    this.sInsertPendingWalletTransaction = this.db.prepare(`INSERT OR IGNORE INTO pending_wallet_transactions (
      key_id, tx_hash, tx_cbor, created_at, valid_until_slot
    ) VALUES (
      @key_id, @tx_hash, @tx_cbor, @created_at, @valid_until_slot
    )`);
    this.sClearPendingWalletTransaction = this.db.prepare(`DELETE FROM pending_wallet_transactions
      WHERE key_id = @key_id AND tx_hash = @tx_hash`);
    this.sGetWalletTransactionOutcome = this.db.prepare(`SELECT *
      FROM wallet_transaction_outcomes WHERE key_id = @key_id AND tx_hash = @tx_hash`);
    this.sInsertWalletTransactionOutcome = this.db.prepare(`INSERT OR IGNORE INTO wallet_transaction_outcomes (
      key_id, tx_hash, state, resolved_at
    ) VALUES (
      @key_id, @tx_hash, @state, @resolved_at
    )`);

  }

  insertOneShotJob(
    row: Pick<OneShotJobRow, "id" | "key_id" | "owner_id" | "model" | "created_at">,
    maxOutstanding = 64,
  ): boolean {
    if (!Number.isSafeInteger(maxOutstanding) || maxOutstanding < 0) {
      throw new RangeError("maxOutstanding must be a non-negative safe integer");
    }
    const insert = this.db.transaction(() => {
      const count = this.sCountOneShotOutstanding.get({ key_id: row.key_id }) as { n: number };
      if (count.n >= maxOutstanding) return false;
      this.sInsertOneShotJob.run(row);
      return true;
    });
    return insert.immediate();
  }

  reserveOneShotSupplier(
    jobId: string,
    ownerId: string,
    candidates: Array<{
      supplierPkh: string;
      endpointUrl: string;
      utxoRef: string;
      priceLovelace: bigint;
      maxProcessingMs: number;
    }>,
    maxActive = 4,
  ): OneShotJobRow | undefined {
    if (candidates.length === 0) return undefined;
    if (!Number.isSafeInteger(maxActive) || maxActive < 0) {
      throw new RangeError("maxActive must be a non-negative safe integer");
    }
    const reserve = this.db.transaction(() => {
      const job = this.sGetOneShotJob.get({ id: jobId }) as OneShotJobRow | undefined;
      if (job?.owner_id !== ownerId || job.state !== "queued") return undefined;

      const active = this.sCountActiveOneShotJobs.get({ key_id: job.key_id }) as { n: number };
      if (active.n >= maxActive) return undefined;

      const now = Date.now();
      for (const candidate of candidates) {
        const result = this.sReserveOneShotSupplier.run({
          id: jobId,
          owner_id: ownerId,
          now,
          supplier_pkh: candidate.supplierPkh,
          endpoint_url: candidate.endpointUrl,
          advert_ref: candidate.utxoRef,
          price_lovelace: candidate.priceLovelace.toString(),
          max_processing_ms: candidate.maxProcessingMs,
        });
        if (result.changes > 0) {
          return this.sGetOneShotJob.get({ id: jobId }) as OneShotJobRow;
        }
      }
      return undefined;
    });
    return reserve.immediate();
  }

  getOneShotJob(id: string): OneShotJobRow | undefined {
    return this.sGetOneShotJob.get({ id }) as OneShotJobRow | undefined;
  }

  listOneShotJobs(keyId?: string): OneShotJobRow[] {
    if (keyId === undefined) return this.sListOneShotJobs.all() as OneShotJobRow[];
    return this.sListOneShotJobsByKey.all({ key_id: keyId }) as OneShotJobRow[];
  }

  listUnfinishedOneShotJobs(): OneShotJobRow[] {
    return this.sListUnfinishedOneShotJobs.all() as OneShotJobRow[];
  }

  updateOneShotJob(id: string, ownerId: string, patch: Partial<OneShotJobRow>): boolean {
    for (const field of Object.keys(patch) as Array<keyof OneShotJobRow>) {
      if (ONE_SHOT_MUTABLE_FIELDS[field] !== true) {
        throw new TypeError(`one-shot job field is immutable: ${field}`);
      }
    }
    const update = this.db.transaction(() => {
      const existing = this.sGetOneShotJob.get({ id }) as OneShotJobRow | undefined;
      if (existing?.owner_id !== ownerId) return false;
      const merged = {
        ...existing,
        ...patch,
        id,
        owner_id: ownerId,
        updated_at: patch.updated_at ?? Date.now(),
      };
      return this.sUpdateOneShotJob.run(merged).changes > 0;
    });
    return update.immediate();
  }

  heartbeatOneShotJobs(ownerId: string, now: number): number {
    return this.sHeartbeatOneShotJobs.run({ owner_id: ownerId, now }).changes;
  }

  claimOneShotJob(id: string, newOwner: string, staleBefore: number): boolean {
    const now = Date.now();
    return this.sClaimOneShotJob.run({
      id,
      new_owner_id: newOwner,
      stale_before: staleBefore,
      now,
    }).changes > 0;
  }

  completeOneShotJob(
    id: string,
    ownerId: string,
    state: "completed" | "failed" | "reclaimed",
    error?: string,
  ): boolean {
    return this.sCompleteOneShotJob.run({
      id,
      owner_id: ownerId,
      state,
      error: error ?? null,
      now: Date.now(),
    }).changes > 0;
  }

  getPendingWalletTransaction(keyId: string): PendingWalletTransaction | undefined {
    return this.sGetPendingWalletTransaction.get({
      key_id: keyId,
    }) as PendingWalletTransaction | undefined;
  }

  putPendingWalletTransaction(row: PendingWalletTransaction): boolean {
    const put = this.db.transaction(() => {
      const inserted = this.sInsertPendingWalletTransaction.run(row);
      if (inserted.changes > 0) return true;
      const existing = this.sGetPendingWalletTransaction.get({
        key_id: row.key_id,
      }) as PendingWalletTransaction | undefined;
      return existing?.tx_hash === row.tx_hash && existing.tx_cbor === row.tx_cbor;
    });
    return put.immediate();
  }

  clearPendingWalletTransaction(keyId: string, txHash: string): boolean {
    return this.sClearPendingWalletTransaction.run({
      key_id: keyId,
      tx_hash: txHash,
    }).changes > 0;
  }

  getWalletTransactionOutcome(
    keyId: string,
    txHash: string,
  ): WalletTransactionOutcome | undefined {
    return this.sGetWalletTransactionOutcome.get({
      key_id: keyId,
      tx_hash: txHash,
    }) as WalletTransactionOutcome | undefined;
  }

  resolvePendingWalletTransaction(
    keyId: string,
    txHash: string,
    state: WalletTransactionOutcome["state"],
  ): boolean {
    const resolvePending = this.db.transaction(() => {
      const params = { key_id: keyId, tx_hash: txHash };
      const outcome = this.sGetWalletTransactionOutcome.get(
        params,
      ) as WalletTransactionOutcome | undefined;
      if (outcome !== undefined) {
        if (outcome.state !== state) return false;
        this.sClearPendingWalletTransaction.run(params);
        return true;
      }

      const pending = this.sGetPendingWalletTransaction.get({
        key_id: keyId,
      }) as PendingWalletTransaction | undefined;
      if (pending?.tx_hash !== txHash) return false;

      this.sInsertWalletTransactionOutcome.run({
        ...params,
        state,
        resolved_at: Date.now(),
      });
      if (this.sClearPendingWalletTransaction.run(params).changes !== 1) {
        throw new Error("pending wallet transaction changed during resolution");
      }
      return true;
    });
    return resolvePending.immediate();
  }

  insertKey(row: Omit<ApiKeyRow, "disabled" | "demo"> & { demo?: number }): void {
    this.sInsertKey.run({ ...row, label: row.label ?? null, demo: row.demo ?? 0 });
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
  updateKeyEncryption(id: string, enc: { enc_priv_nonce: string; enc_priv_ct: string; enc_priv_tag: string; master_key_version: number }): void {
    this.sUpdateKeyEncryption.run({ id, ...enc });
  }

  /** Atomically rotate every encrypted key, active transcript, and stored Response payload. */
  rotateEncryption(
    keyUpdates: Array<{ id: string; enc_priv_nonce: string; enc_priv_ct: string; enc_priv_tag: string; master_key_version: number }>,
    responseUpdates: ResponseEncryptionUpdate[],
    sessionUpdates: SessionEncryptionUpdate[],
  ): void {
    const updateResponse = this.db.prepare(`UPDATE responses SET
      input_nonce = @input_nonce, input_ct = @input_ct, input_tag = @input_tag,
      response_nonce = @response_nonce, response_ct = @response_ct, response_tag = @response_tag
      WHERE id = @id`);
    const updateSession = this.db.prepare(`UPDATE sessions SET transcript_nonce = @transcript_nonce,
      transcript_ct = @transcript_ct, transcript_tag = @transcript_tag WHERE id = @id AND state = 'open'`);
    this.db.transaction(() => {
      for (const update of keyUpdates) this.sUpdateKeyEncryption.run(update);
      for (const update of responseUpdates) updateResponse.run(update);
      for (const update of sessionUpdates) updateSession.run(update);
    })();
  }

  listStoredResponses(): StoredResponseRow[] {
    return this.db.prepare("SELECT * FROM responses").all() as StoredResponseRow[];
  }
  listEncryptedSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE state = 'open'").all() as SessionRow[];
  }
  insertUsage(row: UsageRow): void {
    this.sInsertUsage.run(row);
  }
  upsertUsage(row: UsageRow): void {
    this.sUpsertUsage.run(row);
  }
  sumCostLovelace(keyId: string): bigint {
    const row = this.sSumCost.get({ key_id: keyId }) as { total: number } | undefined;
    return BigInt(row?.total ?? 0);
  }
  countUsage(keyId: string): number {
    const row = this.sCountByKey.get({ key_id: keyId }) as { n: number } | undefined;
    return row?.n ?? 0;
  }
  listUsage(keyId: string, limit: number): UsageRow[] {
    return this.sListUsage.all({ key_id: keyId, limit }) as UsageRow[];
  }
  insertSession(row: Omit<SessionRow,
    "closed_at" | "last_used_at" | "head_response_id" | "managed_demo" |
    "max_output_tokens" | "max_processing_ms" | "transcript_nonce" |
    "transcript_ct" | "transcript_tag"
  > & {
    managed_demo?: number;
    max_output_tokens?: number;
    max_processing_ms?: number;
    transcript_nonce?: string | null;
    transcript_ct?: string | null;
    transcript_tag?: string | null;
  }): void {
    this.sInsertSession.run({
      ...row,
      managed_demo: row.managed_demo ?? 0,
      max_output_tokens: row.max_output_tokens ?? 0,
      max_processing_ms: row.max_processing_ms ?? 300_000,
      transcript_nonce: row.transcript_nonce ?? null,
      transcript_ct: row.transcript_ct ?? null,
      transcript_tag: row.transcript_tag ?? null,
    });
  }
  getSession(id: string): SessionRow | undefined {
    return this.sGetSession.get({ id }) as SessionRow | undefined;
  }
  setSessionState(id: string, state: string, closedAt: number | null): void {
    this.sSetSessionState.run({ id, state, closed_at: closedAt });
  }
  touchSession(id: string, lastUsedAt = Date.now()): void {
    this.sTouchSession.run({ id, last_used_at: lastUsedAt });
  }
  setSessionHead(id: string, responseId: string | null): void {
    this.sSetSessionHead.run({ id, head_response_id: responseId, last_used_at: Date.now() });
  }
  setSessionTranscript(id: string, encrypted: {
    transcript_nonce: string;
    transcript_ct: string;
    transcript_tag: string;
  } | null, sessionHead?: string | null): boolean {
    return this.db.transaction(() => {
      const updated = this.sSetSessionTranscript.run({
        id,
        transcript_nonce: encrypted?.transcript_nonce ?? null,
        transcript_ct: encrypted?.transcript_ct ?? null,
        transcript_tag: encrypted?.transcript_tag ?? null,
        last_used_at: Date.now(),
      });
      if (updated.changes > 0 && sessionHead !== undefined) {
        this.sSetSessionHead.run({
          id,
          head_response_id: sessionHead,
          last_used_at: Date.now(),
        });
      }
      return updated.changes > 0;
    })();
  }
  listRecoverableSessionsByKey(keyId: string): SessionRow[] {
    return this.db.prepare(
      "SELECT * FROM sessions WHERE key_id = @key_id AND state IN ('open', 'invalid')",
    ).all({ key_id: keyId }) as SessionRow[];
  }
  listOpenSessions(): SessionRow[] {
    return this.sListOpenSessions.all() as SessionRow[];
  }
  listOpenSessionsByKey(keyId: string): SessionRow[] {
    return this.listOpenSessions().filter((session) => session.key_id === keyId);
  }
  insertResponse(row: Omit<StoredResponseRow, "completed_at" | "response_nonce" | "response_ct" | "response_tag">): void {
    this.db.transaction(() => {
      this.sInsertResponse.run(row);
      if (row.previous_response_id !== null) {
        this.sExtendResponseAncestors.run({
          id: row.previous_response_id,
          key_id: row.key_id,
          expires_at: row.expires_at,
        });
      }
    })();
  }
  completeResponse(id: string, keyId: string, values: {
    status: string;
    session_id: string | null;
    completed_at: number;
    response_nonce: string;
    response_ct: string;
    response_tag: string;
  }, sessionHead?: string | null): boolean {
    return this.db.transaction(() => {
      const completed = this.sCompleteResponse.run({ id, key_id: keyId, ...values });
      if (values.session_id !== null && sessionHead !== undefined) {
        if (completed.changes > 0) {
          this.sSetSessionHead.run({
            id: values.session_id,
            head_response_id: sessionHead,
            last_used_at: values.completed_at,
          });
        } else {
          this.sInvalidateSessionHead.run({
            id: values.session_id,
            last_used_at: values.completed_at,
          });
        }
      }
      return completed.changes > 0;
    })();
  }
  getOwnedResponse(id: string, keyId: string): StoredResponseRow | undefined {
    return this.sGetOwnedResponse.get({ id, key_id: keyId }) as StoredResponseRow | undefined;
  }
  getResponse(id: string): StoredResponseRow | undefined {
    return this.sGetResponse.get({ id }) as StoredResponseRow | undefined;
  }
  deleteResponseTree(id: string, keyId: string): boolean {
    return this.db.transaction(() => {
      this.sClearSessionHeadsForTree.run({ id, key_id: keyId });
      return this.sDeleteResponseTree.run({ id, key_id: keyId }).changes > 0;
    })();
  }
  deleteExpiredResponses(now = Date.now()): number {
    return this.db.transaction(() => {
      this.sClearExpiredSessionHeads.run({ now });
      return this.sDeleteExpiredTrees.run({ now }).changes;
    })();
  }
}
