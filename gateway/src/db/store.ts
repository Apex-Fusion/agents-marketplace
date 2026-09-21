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

export class GatewayStore {
  private readonly db: BetterDatabase;
  private readonly sInsertKey: Statement;
  private readonly sGetKeyByHash: Statement;
  private readonly sGetKeyById: Statement;
  private readonly sListKeys: Statement;
  private readonly sListAllKeys: Statement;
  private readonly sUpdateKeyEncryption: Statement;
  private readonly sInsertUsage: Statement;
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


  constructor(dbDir: string) {
    const dir = resolve(dbDir);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "gateway.db"));
    this.db.pragma("journal_mode = WAL");
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
