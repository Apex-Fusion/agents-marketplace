/**
 * api-key-disabled.test.ts — a disabled API key gets no access.
 *
 * Security path: the operator stops a key with one update of the `disabled` column. makeApiKeyAuth reads the row at each request,
 * so the key must stop at the next request, and the answer must not tell a disabled key from a key that no row holds.
 * A small app with a real store runs the middleware. The first request is the accepted control: the same key before the update.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayStore } from "../src/db/store.js";
import { hashApiKey, makeApiKeyAuth, requireKey } from "../src/middleware/apiKeyAuth.js";

const dbDirs: string[] = [];
const stores: GatewayStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store["db"].close();
  for (const dir of dbDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("makeApiKeyAuth", () => {
  it("refuses a disabled key at the next request, with the answer for an unknown key", async () => {
    const dbDir = join(tmpdir(), `gw-key-disabled-${randomUUID()}`);
    dbDirs.push(dbDir);
    const store = new GatewayStore(dbDir);
    stores.push(store);
    const apiKey = `vk_test_${randomUUID().replaceAll("-", "")}`;
    const id = randomUUID();
    // The check never opens the sealed key or reads the wallet columns, so they hold placeholders.
    store.insertKey({
      id,
      key_hash: hashApiKey(apiKey),
      key_prefix: apiKey.slice(0, 12),
      label: "customer",
      wallet_pkh: "11".repeat(28),
      deposit_address: "no address",
      enc_priv_nonce: "00",
      enc_priv_ct: "00",
      enc_priv_tag: "00",
      master_key_version: 1,
      created_at: Date.now(),
    });
    const reached: string[] = [];
    const app = express();
    app.get("/probe", makeApiKeyAuth(store), (req, res) => {
      reached.push(requireKey(req).id);
      res.json({ keyId: requireKey(req).id });
    });
    const probe = (key: string) => request(app).get("/probe").set("authorization", `Bearer ${key}`);

    const accepted = await probe(apiKey);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ keyId: id });

    const db = new Database(join(dbDir, "gateway.db"));
    try {
      db.prepare("UPDATE api_keys SET disabled = 1 WHERE id = ?").run(id);
    } finally {
      db.close();
    }

    const disabled = await probe(apiKey);
    expect(disabled.status).toBe(401);
    expect(disabled.body).toEqual({
      error: { message: "invalid API key", type: "authentication_error", code: "invalid_api_key", param: null },
    });
    const unknown = await probe(`vk_test_${"0".repeat(48)}`);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(disabled.body);
    expect(reached).toEqual([id]); // only the control reached the handler
  });
});
