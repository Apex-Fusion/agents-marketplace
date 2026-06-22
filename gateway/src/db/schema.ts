/**
 * gateway/src/db/schema.ts — SQLite schema for the gateway.
 *
 * Three tables:
 *   api_keys — one custodial wallet per key; the wallet priv is AES-GCM sealed
 *              (enc_priv_*). The raw API key is NEVER stored — only sha256(key).
 *   usage    — one row per billable unit (a one-shot completion or a closed chat
 *              session), for /account spend reporting and audit.
 *   sessions — open chat sessions (one escrow per session), for streaming turns
 *              and sweeper recovery of abandoned sessions.
 */

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
  disabled           INTEGER NOT NULL DEFAULT 0
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
  closed_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(key_id, opened_at DESC);
`;
