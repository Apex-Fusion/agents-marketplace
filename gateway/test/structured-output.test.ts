import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import request from "supertest";
import { MockChainProvider } from "@marketplace/shared/chain";
import { buildPostAdvertTx } from "@marketplace/shared/tx";
import { decodeEscrowDatum } from "@marketplace/shared/cbor";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { createApp as createSupplierApp } from "../../supplier/src/server.js";
import { loadConfig as loadSupplierConfig } from "../../supplier/src/config.js";
import { SupplierState } from "../../supplier/src/state.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import { deriveWalletKey, genPrivKeyHex } from "../src/wallet.js";
import type { GatewayDeps } from "../src/deps.js";

const MODEL = "structured-chat-model";
const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, n: { type: "integer" } },
  required: ["ok", "n"],
  additionalProperties: false,
};
const ENFORCED = {
  type: "object",
  properties: { token: { type: "string", enum: ["ZQX-7741"] } },
  required: ["token"],
  additionalProperties: false,
};

// These are the colleague's five requests. No sleeps or widened token limits:
// the indexer deliberately stays "working" after the first upstream request.
const probes = [
  {
    name: "chat plain",
    path: "/chat/completions",
    body: { model: MODEL, messages: [{ role: "user", content: "Say ready." }], max_tokens: 10 },
    expected: "ready",
  },
  {
    name: "chat response_format json_object",
    path: "/chat/completions",
    body: {
      model: MODEL, messages: [{ role: "user", content: 'Return a JSON object {"ok": true, "n": 1}.' }],
      max_tokens: 40, response_format: { type: "json_object" },
    },
    expected: { ok: true, n: 1 },
  },
  {
    name: "chat response_format json_schema strict",
    path: "/chat/completions",
    body: {
      model: MODEL, messages: [{ role: "user", content: "Return ok true and n 1." }], max_tokens: 40,
      response_format: { type: "json_schema", json_schema: { name: "t", strict: true, schema: SCHEMA } },
    },
    expected: { ok: true, n: 1 },
  },
  {
    name: "chat json_schema enforced",
    path: "/chat/completions",
    body: {
      model: MODEL, messages: [{ role: "user", content: "Describe the weather." }], max_tokens: 40,
      response_format: { type: "json_schema", json_schema: { name: "t", strict: true, schema: ENFORCED } },
    },
    expected: { token: "ZQX-7741" },
  },
  {
    name: "responses text.format json_schema translated",
    path: "/responses",
    body: {
      model: MODEL, input: "Return ok true and n 1.", max_output_tokens: 40,
      text: { format: { type: "json_schema", name: "t", strict: true, schema: SCHEMA } },
    },
    expected: { ok: true, n: 1 },
  },
];

describe.sequential("structured output through gateway, SDK, supplier, and Chat upstream", () => {
  const chain = new MockChainProvider();
  const servers: Server[] = [];
  const state = new SupplierState();
  let app: Express;
  let store: GatewayStore;
  let directory: string;
  let apiKey: string;
  let supplierPkh: string;
  let cachedStatus = "free";

  async function listen(serverApp: Express): Promise<string> {
    const server = createServer(serverApp);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  beforeAll(async () => {
    chain.advanceSlot(Math.floor(Date.now() / 1000));
    directory = mkdtempSync(join(tmpdir(), "gateway-structured-"));
    const upstream = express();
    upstream.use(express.json());
    upstream.post("/v1/chat/completions", (req, res) => {
      // A protocol fixture, not a prompt-based JSON fallback. It only honors
      // the two declared grammars and rejects a damaged schema/envelope.
      cachedStatus = "working";
      const format = req.body.response_format;
      let content = "ready";
      if (format?.type === "json_object") {
        content = '{"ok":true,"n":1}';
      } else if (format?.type === "json_schema") {
        const schema = format.json_schema;
        if (schema?.name !== "t" || schema.strict !== true) {
          res.status(400).json({ error: { message: "strict named schema is required" } });
          return;
        }
        if (isDeepStrictEqual(schema.schema, SCHEMA)) content = '{"ok":true,"n":1}';
        else if (isDeepStrictEqual(schema.schema, ENFORCED)) content = '{"token":"ZQX-7741"}';
        else {
          res.status(400).json({ error: { message: "schema does not match the supported grammar" } });
          return;
        }
      } else if (format !== undefined) {
        res.status(400).json({ error: { message: "unsupported response_format envelope" } });
        return;
      }
      res.json({
        id: "chatcmpl-provider", object: "chat.completion", created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    });
    const upstreamUrl = await listen(upstream);
    const supplierKey = deriveWalletKey(genPrivKeyHex(), 0);
    const supplierConfig = loadSupplierConfig({
      SUPPLIER_PRIV_KEY_HEX: supplierKey.privateKeyHex,
      OGMIOS_URL: "http://unused.test",
      ADVERT_REF: `${"a".repeat(64)}#0`,
      NETWORK_ID: "0",
      LLM_BACKEND: "openai",
      OPENAI_UPSTREAM_API: "chat-completions",
      OPENAI_BASE_URL: upstreamUrl,
      OPENAI_TIMEOUT_MS: "5000",
      WALLET_HEALTH_INTERVAL_MS: "0",
    });
    supplierPkh = supplierKey.pubKeyHash;
    const supplierUrl = await listen(createSupplierApp({ chain, state, config: supplierConfig, supplierKey }));
    const advert = {
      supplier_pkh: supplierKey.pubKeyHash, capability_id: "llm.text.generate.v1", model: MODEL,
      max_output_tokens: 256, max_processing_ms: 30000,
      price_lovelace: 200000n, supplier_bond_lovelace: 1000000n, buyer_bond_lovelace: 1000000n,
      endpoint_url: supplierUrl, detail_uri: "",
      detail_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      advertised_at: (await chain.tip()) * 1000, status: "Active" as const,
    };
    const posted = await buildPostAdvertTx({ chain, walletKey: supplierKey, advertDatum: advert, deposit_lovelace: 1000000n });
    supplierConfig.advertRef = posted.advertOutputRef;
    const indexer = express();
    indexer.get("/suppliers", (_req, res) => res.json([{
      ...advert,
      price_lovelace: "200000", supplier_bond_lovelace: "1000000", buyer_bond_lovelace: "1000000",
      utxo_ref: `${posted.expectedTxHash}#0`, advert_status: "Active", status: cachedStatus,
    }]));
    indexer.get("/escrows", async (_req, res) => {
      const utxos = await chain.queryUtxosByAddress(loadBlueprint().escrowScriptAddress(0));
      const rows = utxos.filter(utxo => utxo.datumHex).map(utxo => {
        const datum = decodeEscrowDatum(utxo.datumHex!);
        return {
          utxo_ref: `${utxo.ref.txHash}#${utxo.ref.index}`,
          state: datum.state,
          buyer_pkh: datum.buyer_pkh,
          payment_lovelace: datum.payment_lovelace.toString(),
          buyer_bond_lovelace: datum.buyer_bond_lovelace.toString(),
          supplier_bond_lovelace: datum.supplier_bond_lovelace.toString(),
        };
      });
      res.json(rows);
    });
    const indexerUrl = await listen(indexer);
    const config = loadConfig({
      GATEWAY_MASTER_KEY: randomBytes(32).toString("hex"), INDEXER_URL: indexerUrl,
      LIVE_CHAIN: "1", OGMIOS_URL: "http://unused.test", NETWORK_ID: "0", GATEWAY_DB_DIR: directory,
    });
    store = new GatewayStore(directory);
    // The simulated ledger implements the chain operations exercised here.
    const gatewayChain = chain as unknown as GatewayDeps["chain"];
    const registry = new SdkRegistry({ chain: gatewayChain, indexerUrl, networkId: 0, masterKeyHex: config.masterKeyHex, max: 10 });
    app = createApp({ config, store, chain: gatewayChain, registry, fetchFn: fetch });
    const signup = await request(app).post("/signup").send({ label: "structured-output regression" });
    expect(signup.status).toBe(201);
    apiKey = signup.body.api_key;
    for (const [index, lovelace] of [100000000n, 5000000n].entries()) {
      chain.seed({ ref: { txHash: "b".repeat(64), index }, address: signup.body.deposit_address, lovelace, assets: {}, datumHex: null, scriptRef: null });
    }
  });

  afterAll(async () => {
    await Promise.all(servers.map(server => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
    if (store) {
      // GatewayStore owns SQLite privately; close only this fixture's handle.
      const database: unknown = Reflect.get(store, "db");
      if (!database || typeof database !== "object" || !("close" in database) ||
          typeof database.close !== "function") throw new Error("fixture database has no close method");
      database.close();
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each(probes)("$name", async ({ path, body, expected }) => {
    // The mock ledger does not advance itself. Distinct slots prevent the
    // equivalent Chat and Responses inputs from reusing a spent test tx.
    chain.advanceSlot(1);
    const reply = await request(app).post(`/openai/v1${path}`)
      .set("authorization", `Bearer ${apiKey}`).send(body);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const text = path === "/responses"
      ? reply.body.output.find((item: { type: string }) => item.type === "message").content
        .find((part: { type: string }) => part.type === "output_text").text
      : reply.body.choices[0].message.content;
    if (typeof expected === "string") expect(text).toBe(expected);
    else expect(JSON.parse(text)).toEqual(expected);
    expect(reply.body.x_vector.receipt.supplier_pkh).toBe(supplierPkh);
    const account = await request(app).get("/account").set("authorization", `Bearer ${apiKey}`);
    expect(account.body.balance.locked_in_escrow_lovelace).toBe("0");
  });

  it("names unsupported reasoning fields without locking or charging funds", async () => {
    const before = await request(app).get("/account").set("authorization", `Bearer ${apiKey}`);
    const responses = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${apiKey}`)
      .send({ model: MODEL, input: "Hello", reasoning: { effort: "low" } });
    expect(responses.status).toBe(400);
    expect(responses.body.error).toMatchObject({ code: "unsupported_parameter", param: "reasoning" });
    const chat = await request(app).post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${apiKey}`)
      .send({ model: MODEL, messages: [{ role: "user", content: "Hello" }], reasoning_effort: "low" });
    expect(chat.status).toBe(400);
    expect(chat.body.error).toMatchObject({ code: "unsupported_parameter", param: "reasoning_effort" });
    const after = await request(app).get("/account").set("authorization", `Bearer ${apiKey}`);
    expect(after.body.spend.total_cost_lovelace).toBe(before.body.spend.total_cost_lovelace);
    expect(after.body.balance.locked_in_escrow_lovelace).toBe("0");
  });
});
