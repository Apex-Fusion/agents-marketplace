/**
 * rotate-master-key.test.ts — the master-key rotation re-encrypts every sealed value of the gateway database, or none.
 *
 * Key path: GATEWAY_MASTER_KEY seals the private key of every custodial wallet, the stored Responses and the transcripts of open
 * sessions. A run that stops half way would leave values under two keys, and the gateway can use only one key. The CLI promises that a
 * wrong old key or a damaged row leaves the database unchanged. The CLI runs when its module loads, with the arguments in
 * `process.argv`; the database is a real SQLite file.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open as unseal, seal, type Sealed } from "../src/crypto/seal.js";
import { GatewayStore, type ApiKeyRow, type SessionRow, type StoredResponseRow } from "../src/db/store.js";
import { genPrivKeyHex } from "../src/wallet.js";

const OLD = "11".repeat(32);
const NEW = "22".repeat(32);
const WRONG = "33".repeat(32);
const AUTH_FAILED = /unable to authenticate/i;

/** The columns that rotation changes. Every other column must stay as it was. */
const ROTATED_COLUMNS: Record<string, true> = {
  enc_priv_nonce: true, enc_priv_ct: true, enc_priv_tag: true, master_key_version: true,
  input_nonce: true, input_ct: true, input_tag: true,
  response_nonce: true, response_ct: true, response_tag: true,
  transcript_nonce: true, transcript_ct: true, transcript_tag: true,
};

interface Rows {
  api_keys: ApiKeyRow[];
  responses: StoredResponseRow[];
  sessions: SessionRow[];
}

interface World {
  dir: string;
  store: GatewayStore;
  /** What each sealed value holds, by the label of `sealedValues`. */
  plaintexts: Map<string, string>;
}

const stores: GatewayStore[] = [];
const dirs: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined); // the CLI prints one line when it ends
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store["db"].close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withDb<T>(dir: string, run: (db: Database.Database) => T): T {
  const db = new Database(join(dir, "gateway.db"));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function rowsOf(dir: string): Rows {
  return withDb(dir, (db) => ({
    api_keys: db.prepare("SELECT * FROM api_keys ORDER BY id").all() as ApiKeyRow[],
    responses: db.prepare("SELECT * FROM responses ORDER BY id").all() as StoredResponseRow[],
    sessions: db.prepare("SELECT * FROM sessions ORDER BY id").all() as SessionRow[],
  }));
}

/** Each sealed value of the database under a label. A value that a row does not hold has no label. */
function sealedValues(rows: Rows): Map<string, Sealed> {
  const values = new Map<string, Sealed>();
  for (const row of rows.api_keys) {
    values.set(`key ${row.id}`, { nonce: row.enc_priv_nonce, ct: row.enc_priv_ct, tag: row.enc_priv_tag });
  }
  for (const row of rows.responses) {
    values.set(`response ${row.id} input`, { nonce: row.input_nonce, ct: row.input_ct, tag: row.input_tag });
    if (row.response_nonce !== null && row.response_ct !== null && row.response_tag !== null) {
      values.set(`response ${row.id} result`, { nonce: row.response_nonce, ct: row.response_ct, tag: row.response_tag });
    }
  }
  for (const row of rows.sessions) {
    if (row.transcript_nonce !== null && row.transcript_ct !== null && row.transcript_tag !== null) {
      values.set(`session ${row.id} transcript`, { nonce: row.transcript_nonce, ct: row.transcript_ct, tag: row.transcript_tag });
    }
  }
  return values;
}

/** The rows without the columns that rotation changes. */
function unrotated(rows: Rows): Array<Array<Record<string, unknown>>> {
  return [rows.api_keys, rows.responses, rows.sessions].map((table) =>
    table.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !Object.hasOwn(ROTATED_COLUMNS, column)))));
}

/**
 * A database as a gateway on the old master key leaves it: two keys (one disabled), a finished and an unfinished stored Response,
 * an open session with a transcript, and a closed session (the store clears its transcript).
 */
function makeWorld(): World {
  const dir = join(tmpdir(), `gw-rotate-${randomUUID()}`);
  dirs.push(dir);
  const store = new GatewayStore(dir);
  stores.push(store);
  const plaintexts = new Map<string, string>();
  const sealed = (label: string, plaintext: string): Sealed => {
    plaintexts.set(label, plaintext);
    return seal(plaintext, OLD);
  };

  for (const id of ["key-active", "key-disabled"]) {
    const key = sealed(`key ${id}`, genPrivKeyHex());
    store.insertKey({
      id,
      key_hash: `hash of ${id}`,
      key_prefix: id.slice(0, 12),
      label: id,
      wallet_pkh: "11".repeat(28),
      deposit_address: "no address",
      enc_priv_nonce: key.nonce,
      enc_priv_ct: key.ct,
      enc_priv_tag: key.tag,
      master_key_version: 1,
      created_at: 1,
    });
  }
  withDb(dir, (db) => db.prepare("UPDATE api_keys SET disabled = 1 WHERE id = 'key-disabled'").run());

  for (const id of ["resp-done", "resp-pending"]) {
    const input = sealed(`response ${id} input`, JSON.stringify([{ type: "message", role: "user", content: `question of ${id}` }]));
    store.insertResponse({
      id,
      key_id: "key-active",
      model: "qwen",
      previous_response_id: null,
      session_id: null,
      status: "in_progress",
      stored: 1,
      created_at: 1,
      expires_at: Number.MAX_SAFE_INTEGER,
      input_nonce: input.nonce,
      input_ct: input.ct,
      input_tag: input.tag,
    });
  }
  const result = sealed("response resp-done result", JSON.stringify({ id: "resp-done", status: "completed", output: [] }));
  store.completeResponse("resp-done", "key-active", {
    status: "completed",
    session_id: null,
    completed_at: 2,
    response_nonce: result.nonce,
    response_ct: result.ct,
    response_tag: result.tag,
  });

  for (const id of ["sess-open", "sess-closed"]) {
    const transcript = sealed(`session ${id} transcript`, JSON.stringify([{ type: "message", role: "user", content: `talk of ${id}` }]));
    store.insertSession({
      id,
      key_id: "key-active",
      escrow_ref: `${"aa".repeat(32)}#0`,
      session_nonce: "bb".repeat(8),
      supplier_base_url: "http://supplier.invalid",
      supplier_pkh: "cc".repeat(28),
      model: "qwen",
      price_lovelace: "1000000",
      state: "open",
      opened_at: 1,
      transcript_nonce: transcript.nonce,
      transcript_ct: transcript.ct,
      transcript_tag: transcript.tag,
    });
  }
  store.setSessionState("sess-closed", "closed", 3);
  plaintexts.delete("session sess-closed transcript");
  return { dir, store, plaintexts };
}

/**
 * Run the CLI as `tsx src/cli/rotate-master-key.ts --old OLD --new NEW --db DIR` does. The promise rejects with the error that the CLI
 * throws. A static import cannot give each run its own arguments: the CLI runs main() when its module loads and exports nothing.
 * So each run clears the module registry and loads the module again.
 */
async function runRotation(args: { old: string; new: string; db: string }): Promise<void> {
  vi.resetModules();
  const argv = process.argv;
  process.argv = ["node", "rotate-master-key.ts", "--old", args.old, "--new", args.new, "--db", args.db];
  try {
    await import("../src/cli/rotate-master-key.js");
  } finally {
    process.argv = argv;
  }
}

/** Change the last hex digit of a column, so that the sealed value fails its tag check. */
function flipLastDigit(db: Database.Database, table: string, column: string, id: string): void {
  const row = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id) as { value: string };
  const changed = row.value.replace(/.$/, (digit) => (digit === "0" ? "1" : "0"));
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(changed, id);
}

describe("the master-key rotation CLI", () => {
  it("re-encrypts every key, stored Response and open session transcript, and the old key opens none of them (the accepted control)", async () => {
    const world = makeWorld();
    const before = rowsOf(world.dir);

    await runRotation({ old: OLD, new: NEW, db: world.dir });

    const after = rowsOf(world.dir);
    const values = sealedValues(after);
    expect([...values.keys()].sort()).toEqual([...world.plaintexts.keys()].sort());
    for (const [label, plaintext] of world.plaintexts) {
      expect(unseal(values.get(label)!, NEW), label).toBe(plaintext);
      expect(() => unseal(values.get(label)!, OLD), label).toThrow(AUTH_FAILED);
    }
    expect(after.api_keys.map((row) => row.master_key_version)).toEqual([2, 2]);
    expect(unrotated(after)).toEqual(unrotated(before)); // the disabled flag, the unfinished Response and the closed session stay as they were
  });

  const REFUSED: Array<{ name: string; old?: string; damage?: (db: Database.Database) => void; error: RegExp }> = [
    { name: "a wrong old key", old: WRONG, error: AUTH_FAILED },
    {
      name: "a stored Response with a damaged input",
      damage: (db) => flipLastDigit(db, "responses", "input_ct", "resp-done"),
      error: AUTH_FAILED,
    },
    {
      name: "a stored Response whose result lacks its ciphertext",
      damage: (db) => db.prepare("UPDATE responses SET response_ct = NULL WHERE id = 'resp-done'").run(),
      error: /response resp-done has incomplete response encryption fields/,
    },
    {
      // The CLI reads the sessions last: the keys and the Responses are already encrypted in memory when it fails.
      name: "an open session with a damaged transcript",
      damage: (db) => flipLastDigit(db, "sessions", "transcript_ct", "sess-open"),
      error: AUTH_FAILED,
    },
    {
      name: "an open session whose transcript lacks its ciphertext",
      damage: (db) => db.prepare("UPDATE sessions SET transcript_ct = NULL WHERE id = 'sess-open'").run(),
      error: /active session sess-open has incomplete transcript encryption fields/,
    },
  ];

  it.each(REFUSED)("stops and leaves the database unchanged for $name", async ({ old, damage, error }) => {
    const world = makeWorld();
    withDb(world.dir, (db) => damage?.(db));
    const before = rowsOf(world.dir);

    await expect(runRotation({ old: old ?? OLD, new: NEW, db: world.dir })).rejects.toThrow(error);

    expect(rowsOf(world.dir)).toEqual(before);
  });
});

describe("GatewayStore.rotateEncryption", () => {
  it("rolls back every update when one update fails", () => {
    const world = makeWorld();
    const before = rowsOf(world.dir);
    const keyUpdates = world.store.listAllKeys().map((row) => ({
      id: row.id, enc_priv_nonce: "00", enc_priv_ct: "00", enc_priv_tag: "00", master_key_version: 2,
    }));
    // The column `input_nonce` refuses null: the update of the Response fails after the updates of the keys.
    const refused = { id: "resp-done", input_nonce: null as unknown as string, input_ct: "00", input_tag: "00", response_nonce: null, response_ct: null, response_tag: null };

    expect(() => world.store.rotateEncryption(keyUpdates, [refused], [])).toThrow(/NOT NULL constraint failed: responses.input_nonce/);

    expect(rowsOf(world.dir)).toEqual(before);
  });
});
