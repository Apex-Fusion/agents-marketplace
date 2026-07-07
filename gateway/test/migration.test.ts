/**
 * migration.test.ts — the demo-column migration on pre-existing databases.
 *
 * GatewayStore has no migration framework (pure CREATE TABLE IF NOT EXISTS),
 * so opening a DB created before the `demo` column must ALTER it in place.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { GatewayStore } from "../src/db/store.js";

const LEGACY_API_KEYS_SQL = `
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
`;

function keyRow(id: string) {
  return {
    id,
    key_hash: `hash-${id}`,
    key_prefix: "vk_test_xxxx",
    label: null,
    wallet_pkh: "pkh",
    deposit_address: "addr_test1x",
    enc_priv_nonce: "n",
    enc_priv_ct: "c",
    enc_priv_tag: "t",
    master_key_version: 1,
    created_at: Date.now(),
  };
}

describe("GatewayStore demo-column migration", () => {
  it("adds the demo column to a legacy DB and defaults existing keys to 0", () => {
    const dir = join(tmpdir(), `gw-mig-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const raw = new Database(join(dir, "gateway.db"));
    raw.exec(LEGACY_API_KEYS_SQL);
    raw
      .prepare(
        `INSERT INTO api_keys (id, key_hash, key_prefix, label, wallet_pkh, deposit_address,
         enc_priv_nonce, enc_priv_ct, enc_priv_tag, master_key_version, created_at, disabled)
         VALUES (@id, @key_hash, @key_prefix, @label, @wallet_pkh, @deposit_address,
         @enc_priv_nonce, @enc_priv_ct, @enc_priv_tag, @master_key_version, @created_at, 0)`,
      )
      .run(keyRow("legacy"));
    raw.close();

    const store = new GatewayStore(dir);
    const legacy = store.getKeyByHash("hash-legacy");
    expect(legacy?.demo).toBe(0);

    store.insertKey({ ...keyRow("demo-key"), demo: 1 });
    expect(store.getKeyByHash("hash-demo-key")?.demo).toBe(1);
  });

  it("persists the demo flag on fresh databases (default 0)", () => {
    const dir = join(tmpdir(), `gw-fresh-${randomUUID()}`);
    const store = new GatewayStore(dir);
    store.insertKey(keyRow("plain"));
    expect(store.getKeyByHash("hash-plain")?.demo).toBe(0);
  });
});
