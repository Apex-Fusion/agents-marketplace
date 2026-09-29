/** SQLite schema for gateway keys, accounting, sessions, and stored Responses. */
export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id                 TEXT PRIMARY KEY,
  key_hash           TEXT NOT NULL UNIQUE,
  key_prefix         TEXT NOT NULL,
  label              TEXT,
  wallet_pkh         TEXT NOT NULL,
  deposit_address    TEXT NOT NULL,
  enc_priv_nonce     TEXT NOT NULL,
  enc_priv_ct        TEXT NOT NULL,
  enc_priv_tag       TEXT NOT NULL,
  master_key_version INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  disabled           INTEGER NOT NULL DEFAULT 0,
  demo               INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS usage (
  id                TEXT PRIMARY KEY,
  key_id            TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  model             TEXT,
  capability_id     TEXT,
  supplier_pkh      TEXT,
  escrow_ref        TEXT,
  cost_lovelace     TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  failure_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage(key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  key_id            TEXT NOT NULL,
  escrow_ref        TEXT NOT NULL,
  session_nonce     TEXT NOT NULL,
  supplier_base_url TEXT NOT NULL,
  supplier_pkh      TEXT NOT NULL,
  model             TEXT NOT NULL,
  price_lovelace    TEXT NOT NULL,
  state             TEXT NOT NULL,
  opened_at         INTEGER NOT NULL,
  closed_at         INTEGER,
  last_used_at      INTEGER NOT NULL DEFAULT 0,
  head_response_id  TEXT,
  managed_demo      INTEGER NOT NULL DEFAULT 0,
  max_output_tokens INTEGER NOT NULL DEFAULT 0,
  max_processing_ms INTEGER NOT NULL DEFAULT 300000,
  transcript_nonce  TEXT,
  transcript_ct     TEXT,
  transcript_tag    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(key_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS responses (
  id                   TEXT PRIMARY KEY,
  key_id               TEXT NOT NULL,
  model                TEXT NOT NULL,
  previous_response_id TEXT,
  session_id           TEXT,
  status               TEXT NOT NULL,
  stored               INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  expires_at           INTEGER NOT NULL,
  input_nonce          TEXT NOT NULL,
  input_ct             TEXT NOT NULL,
  input_tag            TEXT NOT NULL,
  response_nonce       TEXT,
  response_ct          TEXT,
  response_tag         TEXT
);
CREATE INDEX IF NOT EXISTS idx_responses_owner ON responses(key_id, id);
CREATE INDEX IF NOT EXISTS idx_responses_parent ON responses(previous_response_id);
CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_responses_expiry ON responses(expires_at);

CREATE TABLE IF NOT EXISTS one_shot_jobs (
  id                TEXT PRIMARY KEY,
  key_id            TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  model             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
    'queued', 'reserved', 'funding', 'running', 'submitted', 'settling',
    'recovering', 'completed', 'failed', 'reclaimed'
  )),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  heartbeat_at       INTEGER NOT NULL,
  supplier_pkh       TEXT,
  endpoint_url       TEXT,
  advert_ref         TEXT,
  price_lovelace     TEXT,
  max_processing_ms  INTEGER,
  escrow_ref         TEXT,
  submitted_ref      TEXT,
  receipt_hash       TEXT,
  supplier_job_id    TEXT,
  settle_tx_hash     TEXT,
  deliver_by         INTEGER,
  post_valid_until_slot INTEGER,
  recovery_slot      INTEGER,
  error              TEXT
);
CREATE INDEX IF NOT EXISTS idx_one_shot_jobs_key
  ON one_shot_jobs(key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_one_shot_jobs_owner_heartbeat
  ON one_shot_jobs(owner_id, heartbeat_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_shot_jobs_active_supplier
  ON one_shot_jobs(supplier_pkh)
  WHERE supplier_pkh IS NOT NULL
    AND state IN ('reserved', 'funding', 'running', 'submitted', 'settling', 'recovering');

CREATE TABLE IF NOT EXISTS pending_wallet_transactions (
  key_id            TEXT PRIMARY KEY,
  tx_hash           TEXT NOT NULL,
  tx_cbor           TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  valid_until_slot  INTEGER
);

CREATE TABLE IF NOT EXISTS wallet_transaction_outcomes (
  key_id            TEXT NOT NULL,
  tx_hash           TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('confirmed', 'rejected', 'expired')),
  resolved_at       INTEGER NOT NULL,
  PRIMARY KEY (key_id, tx_hash)
);
`;
