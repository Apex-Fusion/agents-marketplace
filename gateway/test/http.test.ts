import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, randomUUID } from "crypto";
import request from "supertest";
import Database from "better-sqlite3";
import { rmSync } from "fs";
import { createResponse, responseEvents, type ResponseObject } from "@marketplace/shared/responses";
import { createApp } from "../src/server.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import { genPrivKeyHex, deriveWalletKey } from "../src/wallet.js";
import { seal } from "../src/crypto/seal.js";
import { hashApiKey } from "../src/middleware/apiKeyAuth.js";
import { completeStoredResponse, insertPendingResponse } from "../src/openai/responseStore.js";
import { sweepIdleDemoSessions } from "../src/openai/demoChat.js";
import { streamSupplierTurn } from "../src/openai/sessions.js";
import { transcripts, dropSessionState } from "../src/openai/transcripts.js";
import type { GatewayConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";

vi.mock("../src/onchain/settle.js", async (importOriginal) => {
  const actual = await importOriginal();
  if (typeof actual !== "object" || actual === null) throw new Error("settlement module did not load");
  return {
    ...actual,
    resolveSubmittedRef: vi.fn(async () => ({ txHash: "e".repeat(64), index: 0 })),
    acceptAndConfirm: vi.fn(async () => "f".repeat(64)),
  };
});

const MASTER = "ab".repeat(32);
const SUPPLIERS = [
  {
    utxo_ref: "aa".repeat(32) + "#0", supplier_pkh: "a".repeat(56),
    capability_id: "llm.text.generate.v1", model: "qwen", max_output_tokens: 256,
    max_processing_ms: 30_000, price_lovelace: "1000000", supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000", endpoint_url: "http://sup", advert_status: "Active", status: "free",
  },
  {
    utxo_ref: "bb".repeat(32) + "#0", supplier_pkh: "b".repeat(56),
    capability_id: "llm.chat.v1", model: "kimi", max_output_tokens: 256,
    max_processing_ms: 30_000, price_lovelace: "1000000", supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000", endpoint_url: "http://sup", advert_status: "Active", status: "free",
  },
];

function makeDeps(
  fetchFn?: typeof globalThis.fetch,
  demoIpMax = 1000,
  chainOverride?: GatewayDeps["chain"],
  chatSettleMode: "full" | "ticket" = "full",
): GatewayDeps {
  const dbDir = join(tmpdir(), `gw-test-${randomUUID()}`);
  const store = new GatewayStore(dbDir);
  const config: GatewayConfig = {
    masterKeyHex: MASTER, indexerUrl: "http://ix", ogmiosUrl: "http://og", networkId: 0,
    liveChain: true, port: 0, dbDir, signupRate: { max: 1000, windowMs: 60_000 },
    keyRate: { max: 1000, windowMs: 60_000 }, demoIpRate: { max: demoIpMax, windowMs: 60_000 },
    sweeperIntervalMs: 60_000, demoSessionIdleMs: 180_000, chatSettleMode,
    walletHealthIntervalMs: 600_000, sdkRegistryMax: 100,
    ocrCapabilityId: "ocr.page.extract.chandra-ocr-2.v1", corsOrigins: [],
  };
  const chain = chainOverride ??
    ({ queryUtxosByAddress: async () => [] } as unknown as GatewayDeps["chain"]);
  const registry = new SdkRegistry({
    chain, indexerUrl: config.indexerUrl, networkId: config.networkId,
    masterKeyHex: config.masterKeyHex, max: config.sdkRegistryMax,
  });
  const defaultFetch = (async () => new Response("[]", { status: 200 })) as unknown as typeof globalThis.fetch;
  return { config, store, chain, registry, fetchFn: fetchFn ?? defaultFetch };
}

function addDemoKey(deps: GatewayDeps): string {
  const rawKey = `vk_test_${randomBytes(24).toString("hex")}`;
  const privateKey = genPrivKeyHex();
  const wallet = deriveWalletKey(privateKey, 0);
  const encrypted = seal(privateKey, MASTER);
  deps.store.insertKey({
    id: randomUUID(),
    key_hash: hashApiKey(rawKey),
    key_prefix: rawKey.slice(0, 12),
    label: "shared-demo",
    wallet_pkh: wallet.pubKeyHash,
    deposit_address: wallet.address,
    enc_priv_nonce: encrypted.nonce,
    enc_priv_ct: encrypted.ct,
    enc_priv_tag: encrypted.tag,
    master_key_version: 1,
    created_at: Date.now(),
    demo: 1,
  });
  return rawKey;
}

describe("gateway HTTP", () => {
  it("serves health and UI", async () => {
    const app = createApp(makeDeps());
    expect((await request(app).get("/healthz")).body).toEqual({ ok: true });
    const page = await request(app).get("/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
  });

  it("gates OpenAI generation routes", async () => {
    const app = createApp(makeDeps());
    const responses = await request(app)
      .post("/openai/v1/responses")
      .send({ model: "qwen", input: "hi" });
    expect(responses.status).toBe(401);
    expect(responses.body.error.code).toBe("invalid_api_key");

    const chat = await request(app)
      .post("/openai/v1/chat/completions")
      .send({ model: "qwen", messages: [{ role: "user", content: "hi" }] });
    expect(chat.status).toBe(401);
    expect(chat.body.error.code).toBe("invalid_api_key");
  });

  it("signup, account, and model listing keep their contracts", async () => {
    const fetchFn = (async (url: unknown) => new Response(
      JSON.stringify(String(url).includes("/suppliers") ? SUPPLIERS : []), { status: 200 },
    )) as unknown as typeof globalThis.fetch;
    const deps = makeDeps(fetchFn);
    const app = createApp(deps);
    const signup = await request(app).post("/signup").send({ label: "test" });
    expect(signup.status).toBe(201);
    const key = signup.body.api_key as string;
    const account = await request(app).get("/account").set("authorization", `Bearer ${key}`);
    expect(account.status).toBe(200);
    expect(account.body.spend.request_count).toBe(0);
    const normalModels = await request(app).get("/openai/v1/models").set("authorization", `Bearer ${key}`);
    expect(normalModels.body.data.map((model: { id: string }) => model.id)).toEqual(["qwen"]);

    const demoKey = addDemoKey(deps);
    const demoModels = await request(app).get("/openai/v1/models").set("authorization", `Bearer ${demoKey}`);
    expect(demoModels.body.data.map((model: { id: string }) => model.id)).toEqual(["kimi"]);
  });

  it("restricts the key inventory to the operator token, not customer or demo keys", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    try {
      expect((await request(app).get("/internal/api-keys")).status).toBe(503);
      deps.config.adminToken = "operator-token-".repeat(4);
      const signup = await request(app).post("/signup").send({ label: "customer" });
      const demoKey = addDemoKey(deps);

      expect((await request(app).get("/internal/api-keys")).status).toBe(401);
      for (const token of [signup.body.api_key, demoKey, "wrong-token-".repeat(4)]) {
        const response = await request(app).get("/internal/api-keys")
          .set("authorization", `Bearer ${token}`);
        expect(response.status).toBe(401);
        expect(response.body).not.toHaveProperty("keys");
      }
      const allowed = await request(app).get("/internal/api-keys")
        .set("authorization", `Bearer ${deps.config.adminToken}`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.keys.map((key: { label: string }) => key.label).sort())
        .toEqual(["customer", "shared-demo"]);
    } finally {
      deps.store["db"].close();
      rmSync(deps.config.dbDir, { recursive: true, force: true });
    }
  });

  it("lists disabled wallets without secrets and distinguishes a balance failure from zero", async () => {
    let failedAddress = "";
    const chain = {
      queryUtxosByAddress: async (address: string) => {
        if (address === failedAddress) throw new Error("private chain connection details");
        return [7_000_000n, 2_123_456n].map((lovelace) => ({ lovelace }));
      },
    } as unknown as GatewayDeps["chain"];
    const deps = makeDeps(undefined, 1000, chain);
    deps.config.adminToken = "operator-token-".repeat(4);
    const app = createApp(deps);
    try {
      const disabled = await request(app).post("/signup").send({ label: "disabled wallet" });
      const failed = await request(app).post("/signup").send({ label: "unavailable wallet" });
      failedAddress = failed.body.deposit_address;
      const demoKey = addDemoKey(deps);
      const db = new Database(join(deps.config.dbDir, "gateway.db"));
      try {
        db.prepare("UPDATE api_keys SET disabled = 1 WHERE key_hash = ?")
          .run(hashApiKey(disabled.body.api_key));
        db.prepare("UPDATE api_keys SET created_at = 1 WHERE label = 'disabled wallet'").run();
      } finally {
        db.close();
      }

      const response = await request(app).get("/internal/api-keys")
        .set("authorization", `Bearer ${deps.config.adminToken}`);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body.keys).toHaveLength(3);
      expect(response.body.keys.at(-1)).toMatchObject({
        key_prefix: disabled.body.key_prefix,
        label: "disabled wallet",
        disabled: true,
        balance_lovelace: "9123456",
        balance_error: null,
      });
      expect(response.body.keys.find((key: { demo: boolean }) => key.demo)).toMatchObject({
        key_prefix: demoKey.slice(0, 12),
        balance_lovelace: "9123456",
      });
      expect(response.body.keys.find((key: { label: string }) => key.label === "unavailable wallet"))
        .toMatchObject({ balance_lovelace: null, balance_error: expect.any(String) });
      for (const rawKey of [disabled.body.api_key, failed.body.api_key, demoKey]) {
        expect(response.text).not.toContain(rawKey);
      }
      for (const key of response.body.keys) {
        expect(Object.keys(key).sort()).toEqual([
          "balance_error", "balance_lovelace", "created_at", "demo", "deposit_address",
          "disabled", "id", "key_prefix", "label",
        ]);
      }
      expect(response.text).not.toContain("private chain connection details");
    } finally {
      deps.store["db"].close();
      rmSync(deps.config.dbDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported generation controls before routing or funds", async () => {
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const app = createApp(makeDeps(fetchFn));
    const signup = await request(app).post("/signup").send({});
    const response = await request(app)
      .post("/openai/v1/responses")
      .set("authorization", `Bearer ${signup.body.api_key}`)
      .send({ model: "qwen", input: "hi", tools: [{ type: "web_search_preview" }] });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    expect(fetches).toBe(0);
  });

  it("GET and DELETE stored Responses are owner-scoped and delete descendants", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const signupA = await request(app).post("/signup").send({});
    const signupB = await request(app).post("/signup").send({});
    const keyA = signupA.body.api_key as string;
    const keyB = signupB.body.api_key as string;
    const owner = deps.store.getKeyByHash(hashApiKey(keyA))!;
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "secret" }] }] as const;
    const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }] as const;
    for (const [id, parent] of [["resp_parent", undefined], ["resp_child", "resp_parent"]] as const) {
      insertPendingResponse(deps, { id, keyId: owner.id, model: "qwen", previousResponseId: parent, request: { input: [...input] } });
      completeStoredResponse(deps, {
        id, keyId: owner.id,
        response: createResponse({ id, model: "qwen", output: [...output] }),
      });
    }

    const foreign = await request(app).get("/openai/v1/responses/resp_parent").set("authorization", `Bearer ${keyB}`);
    const missing = await request(app).get("/openai/v1/responses/does-not-exist").set("authorization", `Bearer ${keyB}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    const foreignContinuation = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${keyB}`)
      .send({ model: "qwen", previous_response_id: "resp_parent", input: "more" });
    const missingContinuation = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${keyB}`)
      .send({ model: "qwen", previous_response_id: "does-not-exist", input: "more" });
    expect(foreignContinuation.status).toBe(404);
    expect(foreignContinuation.body).toEqual(missingContinuation.body);
    const owned = await request(app).get("/openai/v1/responses/resp_parent").set("authorization", `Bearer ${keyA}`);
    expect(owned.status).toBe(200);
    const wrongModel = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${keyA}`)
      .send({ model: "other", previous_response_id: "resp_parent", input: "more" });
    expect(wrongModel.status).toBe(400);
    expect(wrongModel.body.error.code).toBe("model_mismatch");
    const orphanOutput = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${keyA}`)
      .send({
        model: "qwen",
        previous_response_id: "resp_parent",
        input: [{ type: "function_call_output", call_id: "unknown", output: "x" }],
      });
    expect(orphanOutput.status).toBe(400);
    expect(orphanOutput.body.error.code).toBe("invalid_function_call_output");
    expect(owned.body.output).toEqual(output);
    const deleted = await request(app).delete("/openai/v1/responses/resp_parent").set("authorization", `Bearer ${keyA}`);
    expect(deleted.body).toEqual({ id: "resp_parent", object: "response.deleted", deleted: true });
    expect(deps.store.getResponse("resp_child")).toBeUndefined();
  });

  it("keeps demo account restrictions and per-IP limits", async () => {
    const deps = makeDeps(undefined, 1);
    const demoKey = addDemoKey(deps);
    const app = createApp(deps);
    const account = await request(app).get("/account").set("authorization", `Bearer ${demoKey}`);
    expect(account.body.deposit_address).toBeNull();
    const withdraw = await request(app).post("/account/withdraw").set("authorization", `Bearer ${demoKey}`).send({});
    expect(withdraw.status).toBe(403);
    await request(app).post("/openai/v1/responses").set("authorization", `Bearer ${demoKey}`).send({ model: "bad", input: "x" });
    const limited = await request(app).post("/openai/v1/responses").set("authorization", `Bearer ${demoKey}`).send({ model: "bad", input: "x" });
    expect(limited.status).toBe(429);
  });
});

const FUNDED_CHAIN = {
  queryUtxosByAddress: async () => [{
    ref: { txHash: "ff".repeat(32), index: 0 },
    address: "a",
    lovelace: 20_000_000n,
    assets: {},
    datumHex: null,
    scriptRef: null,
  }],
} as unknown as GatewayDeps["chain"];

function supplierStream(response: ResponseObject): Response {
  const body = responseEvents(response)
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textResponse(text: string, id = `resp_supplier_${text}`): ResponseObject {
  return createResponse({
    id,
    model: "kimi",
    output: [{
      id: `msg_${text}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
}

function scriptedDemoFetch(
  turns: Array<(request: Record<string, unknown>) => Response>,
  suppliers: () => unknown[] = () => SUPPLIERS,
  capability: () => Record<string, unknown> = () => ({
    inference_api: "responses",
    upstream_api: "responses",
  }),
) {
  const messageCalls: Array<Record<string, unknown>> = [];
  const endCalls: string[] = [];
  let turn = 0;
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/v1/chat/message")) {
      const requestBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      messageCalls.push(requestBody);
      const reply = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      return reply(requestBody);
    }
    if (target.includes("/v1/chat/end")) {
      endCalls.push(new Headers(init?.headers).get("X-Escrow-Ref") ?? "");
      return new Response(JSON.stringify({ status: "submitted" }), { status: 200 });
    }
    if (target.includes("/suppliers")) {
      return new Response(JSON.stringify(suppliers()), { status: 200 });
    }
    if (target.endsWith("/capability")) {
      return new Response(JSON.stringify(capability()), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, messageCalls, endCalls };
}

function setupDemo(deps: GatewayDeps) {
  const rawKey = addDemoKey(deps);
  const keyRow = deps.store.getKeyByHash(hashApiKey(rawKey))!;
  const context = deps.registry.getContext(keyRow);
  const startChat = vi.fn(async () => ({
    escrowRef: { txHash: randomBytes(32).toString("hex"), index: 0 },
    sessionNonce: randomUUID(),
    supplierBaseUrl: "http://sup",
    settleMode: deps.config.chatSettleMode,
  }));
  const mutableSdk = context.sdk as unknown as { startChat: unknown };
  mutableSdk.startChat = startChat;
  return { rawKey, keyRow, context, startChat };
}

function streamEvents(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe("gateway demo Responses", () => {
  it("preserves function calls and reuses only the exact stored session head", async () => {
    const functionCall = {
      id: "fc_1",
      type: "function_call" as const,
      call_id: "call_1",
      name: "get_time",
      arguments: "{\"zone\":\"UTC\"}",
      status: "completed",
    };
    const { fetchFn, messageCalls } = scriptedDemoFetch([
      () => supplierStream(createResponse({
        id: "supplier-call",
        model: "kimi",
        output: [functionCall],
      })),
      () => supplierStream(textResponse("It is 15:00")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow, startChat } = setupDemo(deps);
    const app = createApp(deps);

    const first = await request(app)
      .post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        input: "What time is it?",
        instructions: "Use tools for the first turn.",
        tools: [{
          type: "function",
          name: "get_time",
          parameters: { type: "object" },
        }],
      });
    expect(first.status).toBe(200);
    expect(first.body.output).toEqual([functionCall]);
    const storedSession = deps.store.listOpenSessionsByKey(keyRow.id)[0];
    transcripts.delete(storedSession.id);

    const second = await request(app)
      .post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        previous_response_id: first.body.id,
        input: [{ type: "function_call_output", call_id: "call_1", output: "15:00" }],
        instructions: "Answer only the current tool result.",
        tools: [{
          type: "function",
          name: "get_time",
          parameters: { type: "object" },
        }],
      });
    expect(second.status).toBe(200);
    expect(second.body.previous_response_id).toBe(first.body.id);
    expect(second.body.output[0].content[0].text).toBe("It is 15:00");
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(messageCalls[0].input).toHaveLength(1);
    expect(messageCalls[1].input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "15:00" },
    ]);
    expect(messageCalls[1].instructions).toBe("Answer only the current tool result.");
  });

  it("replays opaque reasoning bytes in order after session state is lost", async () => {
    const reasoning = {
      id: "rs_1",
      type: "reasoning" as const,
      status: "completed",
      summary: [{ type: "summary_text", text: "kept" }],
      encrypted_content: "opaque-provider-bytes",
    };
    const { fetchFn, messageCalls } = scriptedDemoFetch([
      () => supplierStream(createResponse({
        id: "supplier-reasoning",
        model: "kimi",
        output: [
          reasoning,
          {
            id: "msg_reasoned",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "answer", annotations: [] }],
          },
        ],
      })),
      () => supplierStream(textResponse("continued")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow, startChat } = setupDemo(deps);
    const app = createApp(deps);
    const first = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        input: "reason about this",
        include: ["reasoning.encrypted_content"],
      });
    expect(first.body.output[0]).toEqual(reasoning);
    const firstSession = deps.store.listOpenSessionsByKey(keyRow.id)[0];
    deps.store.setSessionState(firstSession.id, "closed", Date.now());
    transcripts.delete(firstSession.id);

    const continued = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        previous_response_id: first.body.id,
        input: "continue",
        include: ["reasoning.encrypted_content"],
      });
    expect(continued.status).toBe(200);
    expect(startChat).toHaveBeenCalledTimes(2);
    const replay = messageCalls[1].input;
    if (!Array.isArray(replay)) throw new Error("expected replay input array");
    expect(replay).toHaveLength(4);
    expect(replay[1]).toEqual(reasoning);
  });

  it("opens a fork and replays the exact typed chain when the parent is no longer the head", async () => {
    const { fetchFn, messageCalls } = scriptedDemoFetch([
      () => supplierStream(textResponse("parent")),
      () => supplierStream(textResponse("child-a")),
      () => supplierStream(textResponse("child-b")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, startChat } = setupDemo(deps);
    const app = createApp(deps);

    const parent = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "root" });
    const childA = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", previous_response_id: parent.body.id, input: "branch A" });
    const childB = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", previous_response_id: parent.body.id, input: "branch B" });

    expect(childA.status).toBe(200);
    expect(childB.status).toBe(200);
    expect(startChat).toHaveBeenCalledTimes(2);
    expect(messageCalls[1].input).toHaveLength(1);
    const replayInput = messageCalls[2].input;
    if (!Array.isArray(replayInput)) throw new Error("expected replay input array");
    expect(replayInput.map((item) =>
      typeof item === "object" && item !== null && "type" in item ? item.type : undefined))
      .toEqual(["message", "message", "message"]);
  });

  it("reopens a supplier-lost session, replays the chain, and records its cost once", async () => {
    const { fetchFn, messageCalls } = scriptedDemoFetch([
      () => supplierStream(textResponse("first")),
      () => new Response("gone", { status: 404 }),
      () => supplierStream(textResponse("recovered")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow, startChat } = setupDemo(deps);
    const app = createApp(deps);
    const first = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "hello" });
    const recovered = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", previous_response_id: first.body.id, input: "continue" });

    expect(recovered.status).toBe(200);
    expect(recovered.body.output[0].content[0].text).toBe("recovered");
    expect(startChat).toHaveBeenCalledTimes(2);
    expect(messageCalls[2].input).toHaveLength(3);
    expect(deps.store.listUsage(keyRow.id, 10)
      .filter((usage) => usage.kind === "chat_session" && usage.cost_lovelace === "1000000"))
      .toHaveLength(1);
  });

  it("does not persist store:false responses or leave them as a reusable session head", async () => {
    const { fetchFn } = scriptedDemoFetch([
      () => supplierStream(textResponse("private")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow } = setupDemo(deps);
    const app = createApp(deps);
    const response = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "secret", store: false });
    expect(response.status).toBe(200);
    expect(deps.store.getResponse(response.body.id)).toBeUndefined();
    expect(deps.store.listOpenSessionsByKey(keyRow.id)[0].head_response_id).toBeNull();

    const get = await request(app).get(`/openai/v1/responses/${response.body.id}`)
      .set("authorization", `Bearer ${rawKey}`);
    const continuation = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", previous_response_id: response.body.id, input: "more" });
    expect(get.status).toBe(404);
    expect(continuation.status).toBe(404);
  });


  it("allows structured output on a managed Chat Completions supplier", async () => {
    const schema = {
      type: "object",
      properties: { token: { type: "string", enum: ["ZQX-7741"] } },
      required: ["token"],
      additionalProperties: false,
    };
    const script = scriptedDemoFetch(
      [() => supplierStream(textResponse('{"token":"ZQX-7741"}'))],
      () => SUPPLIERS,
      () => ({ inference_api: "responses", upstream_api: "chat-completions", reasoning_disabled: false }),
    );
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const app = createApp(deps);
    const response = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi", input: "Describe the weather.",
        text: { format: { type: "json_schema", name: "t", strict: true, schema } },
      });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.output[0].content[0].text)).toEqual({ token: "ZQX-7741" });
    const chat = await request(app).post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi", messages: [{ role: "user", content: "Describe the weather." }],
        response_format: { type: "json_schema", json_schema: { name: "t", strict: true, schema } },
      });
    expect(chat.status).toBe(200);
    expect(JSON.parse(chat.body.choices[0].message.content)).toEqual({ token: "ZQX-7741" });
  });

  it("checks replayed reasoning compatibility before funding a replacement session", async () => {
    let native = true;
    const reasoning = {
      type: "reasoning" as const,
      id: "reasoning_1",
      encrypted_content: "opaque",
      summary: [],
    };
    const script = scriptedDemoFetch([
      () => supplierStream(createResponse({
        id: "supplier_reasoning",
        model: "kimi",
        output: [reasoning],
      })),
    ], undefined, () => ({
      inference_api: "responses",
      upstream_api: native ? "responses" : "chat-completions",
    }));
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow, startChat } = setupDemo(deps);
    const app = createApp(deps);
    const first = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "reason" });
    const priorSession = deps.store.listOpenSessionsByKey(keyRow.id)[0];
    deps.store.setSessionState(priorSession.id, "closed", Date.now());
    transcripts.delete(priorSession.id);
    native = false;

    const continued = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", previous_response_id: first.body.id, input: "continue" });
    expect(continued.status).toBe(400);
    expect(continued.body.error.code).toBe("unsupported_parameter");
    expect(startChat).toHaveBeenCalledTimes(1);
  });

  it("honors an exact supplier pin instead of reusing another supplier", async () => {
    const supplierB = { ...SUPPLIERS[1], supplier_pkh: "b".repeat(56) };
    const supplierC = {
      ...SUPPLIERS[1],
      utxo_ref: "cc".repeat(32) + "#0",
      supplier_pkh: "c".repeat(56),
    };
    const script = scriptedDemoFetch([
      () => supplierStream(textResponse("from-b")),
      () => supplierStream(textResponse("from-c")),
    ], () => [supplierB, supplierC]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow, startChat } = setupDemo(deps);
    const app = createApp(deps);
    const first = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "first", x_vector: { supplier_pkh: supplierB.supplier_pkh } });
    const second = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        previous_response_id: first.body.id,
        input: "second",
        x_vector: { supplier_pkh: supplierC.supplier_pkh },
      });
    expect(second.status).toBe(200);
    expect(startChat).toHaveBeenCalledTimes(2);
    expect(deps.store.listOpenSessionsByKey(keyRow.id)
      .some((session) => session.supplier_pkh === supplierC.supplier_pkh)).toBe(true);
  });

  it("continues a stored incomplete terminal response on the same session", async () => {
    const incomplete = createResponse({
      id: "supplier_incomplete",
      model: "kimi",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: textResponse("partial").output,
    });
    const script = scriptedDemoFetch([
      () => supplierStream(incomplete),
      () => supplierStream(textResponse("finished")),
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, startChat } = setupDemo(deps);
    const app = createApp(deps);
    const first = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "start", max_output_tokens: 1 });
    expect(first.body.status).toBe("incomplete");
    const second = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", previous_response_id: first.body.id, input: "continue" });
    expect(second.status).toBe(200);
    expect(second.body.output[0].content[0].text).toBe("finished");
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(script.messageCalls[1].input).toHaveLength(1);
  });

  it("invalidates and does not reuse a checkpoint closed during an unseen turn", async () => {
    const script = scriptedDemoFetch([
      () => supplierStream(textResponse("first")),
      () => supplierStream(textResponse("fresh")),
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow, startChat } = setupDemo(deps);
    const app = createApp(deps);
    const first = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "first" });
    expect(first.status).toBe(200);
    const session = deps.store.listOpenSessionsByKey(keyRow.id)[0];
    let started!: () => void;
    let release!: (response: Response) => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    const heldResponse = new Promise<Response>(resolve => { release = resolve; });
    deps.fetchFn = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/v1/chat/message")) {
        started();
        return heldResponse;
      }
      return script.fetchFn(url as string, init);
    }) as typeof fetch;
    const pending = request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", previous_response_id: first.body.id, input: "unseen" })
      .then(response => response);
    await dispatched;
    dropSessionState(session.id); // Simulate losing process-local state during the turn.
    await sweepIdleDemoSessions(deps, Date.now() + deps.config.demoSessionIdleMs + 1);
    expect(deps.store.getSession(session.id)?.state).toBe("closed");
    release(supplierStream(textResponse("unseen")));
    expect((await pending).status).toBe(500);
    expect(deps.store.getSession(session.id)?.state).toBe("invalid");
    deps.fetchFn = script.fetchFn;
    const recovered = await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", previous_response_id: first.body.id, input: "new branch" });
    expect(recovered.status).toBe(200);
    expect(startChat).toHaveBeenCalledTimes(2);
  });

  it("aborts an over-budget turn and makes the uncertain session unusable", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = (async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })) as unknown as typeof globalThis.fetch;
      const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
      const { keyRow } = setupDemo(deps);
      const encrypted = seal("[]", MASTER);
      deps.store.insertSession({
        id: "timeout-session",
        key_id: keyRow.id,
        escrow_ref: `${"ee".repeat(32)}#0`,
        session_nonce: "nonce",
        supplier_base_url: "http://sup",
        supplier_pkh: "b".repeat(56),
        model: "kimi",
        price_lovelace: "1",
        state: "open",
        opened_at: Date.now(),
        max_output_tokens: 100,
        max_processing_ms: 1,
        transcript_nonce: encrypted.nonce,
        transcript_ct: encrypted.ct,
        transcript_tag: encrypted.tag,
      });
      const session = deps.store.getSession("timeout-session");
      if (!session) throw new Error("test session was not stored");
      const turn = streamSupplierTurn(deps, session, {
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "slow" }],
        }],
      }).then(
        () => "completed",
        () => "failed",
      );
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await turn).toBe("failed");
      const invalid = deps.store.getSession("timeout-session");
      expect(invalid?.state).toBe("invalid");
      expect(invalid?.transcript_ct).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps routing and wallet failures as HTTP errors and emits typed in-band stream failures", async () => {
    const lowChain = {
      queryUtxosByAddress: async () => [{
        ref: { txHash: "ff".repeat(32), index: 0 },
        address: "a",
        lovelace: 5_000_000n,
        assets: {},
        datumHex: null,
        scriptRef: null,
      }],
    } as unknown as GatewayDeps["chain"];
    const lowScript = scriptedDemoFetch([]);
    const lowDeps = makeDeps(lowScript.fetchFn, 1000, lowChain);
    const lowKey = setupDemo(lowDeps).rawKey;
    const low = await request(createApp(lowDeps)).post("/openai/v1/responses")
      .set("authorization", `Bearer ${lowKey}`)
      .send({ model: "kimi", input: "hello", stream: true });
    expect(low.status).toBe(402);
    expect(low.headers["content-type"]).toMatch(/application\/json/);

    const failedScript = scriptedDemoFetch([
      () => new Response("supplier broke", { status: 500 }),
    ]);
    const failedDeps = makeDeps(failedScript.fetchFn, 1000, FUNDED_CHAIN);
    const failedKey = setupDemo(failedDeps).rawKey;
    const failed = await request(createApp(failedDeps)).post("/openai/v1/responses")
      .set("authorization", `Bearer ${failedKey}`)
      .send({ model: "kimi", input: "hello", stream: true });
    expect(failed.status).toBe(200);
    expect(failed.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = streamEvents(failed.text);
    expect(events.map((event) => event.type)).toEqual(["error", "response.failed"]);
    expect(events.map((event) => event.sequence_number)).toEqual([0, 1]);
  });

  it("relays semantic stream events with one monotonic terminal and no legacy sentinel", async () => {
    const { fetchFn } = scriptedDemoFetch([
      () => supplierStream(textResponse("streamed")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const response = await request(createApp(deps)).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "hello", stream: true });
    const events = streamEvents(response.text);
    expect(response.status).toBe(200);
    expect(events.map((event) => event.sequence_number))
      .toEqual(events.map((_, index) => index));
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    expect(events.some((event) => event.type === "response.output_text.delta")).toBe(true);
    expect(response.text).not.toContain("[DONE]");
    const terminal = events.at(-1)!;
    const terminalResponse = terminal.response;
    if (typeof terminalResponse !== "object" || terminalResponse === null ||
        !("id" in terminalResponse)) throw new Error("terminal response has no id");
    expect(terminalResponse.id).toMatch(/^resp_/);
  });

  it("keeps ticket-mode idle janitor accounting at zero cost", async () => {
    const { fetchFn, endCalls } = scriptedDemoFetch([
      () => supplierStream(textResponse("ticket")),
      () => supplierStream(textResponse("idle")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN, "ticket");
    const { rawKey, keyRow } = setupDemo(deps);
    const app = createApp(deps);

    await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "one" });
    await sweepIdleDemoSessions(deps, Date.now() + deps.config.demoSessionIdleMs + 1);

    await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "two" });
    await sweepIdleDemoSessions(deps, Date.now() + deps.config.demoSessionIdleMs + 1);
    expect(endCalls).toHaveLength(2);
    const billed = deps.store.listUsage(keyRow.id, 10)
      .filter((usage) => usage.kind === "chat_session");
    expect(billed).toHaveLength(2);
    expect(billed.every((usage) => usage.cost_lovelace === "0")).toBe(true);
  });
});

function supplierEventStream(events: Array<Record<string, unknown>>): Response {
  const body = events
    .map((event, sequence_number) =>
      `event: ${String(event.type)}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chatStreamData(text: string): {
  chunks: Array<Record<string, unknown>>;
  doneCount: number;
} {
  const data = text.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  return {
    chunks: data.filter((value) => value !== "[DONE]")
      .map((value) => JSON.parse(value) as Record<string, unknown>),
    doneCount: data.filter((value) => value === "[DONE]").length,
  };
}

describe("POST /openai/v1/chat/completions", () => {
  it("round-trips function calls and tool outputs through standard messages", async () => {
    const toolCall = {
      id: "fc_weather",
      type: "function_call" as const,
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"city\":\"Paris\"}",
      status: "completed",
    };
    const script = scriptedDemoFetch([
      () => supplierStream(createResponse({
        id: "resp_tool",
        model: "kimi",
        output: [toolCall],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      })),
      (requestBody) => {
        const input = requestBody.input;
        const hasCall = Array.isArray(input) && input.some((item) =>
          typeof item === "object" && item !== null &&
          "type" in item && item.type === "function_call" &&
          "call_id" in item && item.call_id === "call_weather");
        const hasOutput = Array.isArray(input) && input.some((item) =>
          typeof item === "object" && item !== null &&
          "type" in item && item.type === "function_call_output" &&
          "call_id" in item && item.call_id === "call_weather" &&
          "output" in item && item.output === "18 C");
        return hasCall && hasOutput
          ? supplierStream(textResponse("It is 18 C"))
          : new Response("tool history was not preserved", { status: 422 });
      },
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const app = createApp(deps);

    const first = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [{ role: "user", content: "What is the weather?" }],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        }],
      });
    expect(first.status).toBe(200);
    expect(first.body.id).toMatch(/^chatcmpl-/);
    expect(first.body.object).toBe("chat.completion");
    expect(first.body.choices[0].finish_reason).toBe("tool_calls");
    expect(first.body.choices[0].message.role).toBe("assistant");
    expect(first.body.choices[0].message.content).toBeNull();
    expect(first.body.choices[0].message.tool_calls).toEqual([{
      id: "call_weather",
      type: "function",
      function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
    }]);
    expect(first.body.usage).toMatchObject({
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
    });

    const second = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_weather",
              type: "function",
              function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
            }],
          },
          { role: "tool", tool_call_id: "call_weather", content: "18 C" },
        ],
      });
    expect(second.status).toBe(200);
    expect(second.body.choices[0]).toMatchObject({
      finish_reason: "stop",
      message: { role: "assistant", content: "It is 18 C" },
    });
  });

  it("preserves fragmented multi-tool stream indices and emits usage before one DONE", async () => {
    const firstCall = {
      id: "fc_first",
      type: "function_call" as const,
      call_id: "call_first",
      name: "first_tool",
      arguments: "{\"city\":\"Paris\"}",
      status: "completed",
    };
    const secondCall = {
      id: "fc_second",
      type: "function_call" as const,
      call_id: "call_second",
      name: "second_tool",
      arguments: "{\"count\":2}",
      status: "completed",
    };
    const terminal = createResponse({
      id: "resp_fragmented",
      model: "kimi",
      output: [firstCall, secondCall],
      usage: { input_tokens: 9, output_tokens: 7, total_tokens: 16 },
    });
    const initial = {
      ...terminal,
      status: "in_progress",
      output: [],
      usage: null,
    };
    const script = scriptedDemoFetch([
      () => supplierEventStream([
        { type: "response.created", response: initial },
        { type: "response.in_progress", response: initial },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...firstCall, arguments: "", status: "in_progress" },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...secondCall, arguments: "", status: "in_progress" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: firstCall.id,
          output_index: 0,
          delta: "{\"city\":\"",
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: secondCall.id,
          output_index: 1,
          delta: "{\"count\":",
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: firstCall.id,
          output_index: 0,
          delta: "Paris\"}",
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: secondCall.id,
          output_index: 1,
          delta: "2}",
        },
        {
          type: "response.function_call_arguments.done",
          item_id: firstCall.id,
          output_index: 0,
          name: firstCall.name,
          arguments: firstCall.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: secondCall.id,
          output_index: 1,
          name: secondCall.name,
          arguments: secondCall.arguments,
        },
        { type: "response.output_item.done", output_index: 0, item: firstCall },
        { type: "response.output_item.done", output_index: 1, item: secondCall },
        { type: "response.completed", response: terminal },
      ]),
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const response = await request(createApp(deps))
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [{ role: "user", content: "Use both tools" }],
        stream: true,
        stream_options: { include_usage: true },
        tools: [
          {
            type: "function",
            function: { name: "first_tool", parameters: { type: "object" } },
          },
          {
            type: "function",
            function: { name: "second_tool", parameters: { type: "object" } },
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/event-stream/);
    const { chunks, doneCount } = chatStreamData(response.text);
    expect(doneCount).toBe(1);
    expect(response.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(chunks[0].id).toMatch(/^chatcmpl-/);
    expect(new Set(chunks.map((chunk) => chunk.created)).size).toBe(1);
    expect(chunks.every((chunk) =>
      chunk.object === "chat.completion.chunk" && chunk.model === "kimi")).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => chunk.usage === null)).toBe(true);

    const assembled = new Map<number, { id?: string; name?: string; arguments: string }>();
    for (const chunk of chunks) {
      const choices = chunk.choices;
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const delta = choices[0]?.delta;
      if (typeof delta !== "object" || delta === null || !("tool_calls" in delta) ||
          !Array.isArray(delta.tool_calls)) continue;
      for (const call of delta.tool_calls) {
        if (typeof call !== "object" || call === null || !("index" in call) ||
            typeof call.index !== "number") continue;
        const current = assembled.get(call.index) ?? { arguments: "" };
        if ("id" in call && typeof call.id === "string") current.id = call.id;
        if ("function" in call && typeof call.function === "object" && call.function !== null) {
          if ("name" in call.function && typeof call.function.name === "string") {
            current.name = call.function.name;
          }
          if ("arguments" in call.function && typeof call.function.arguments === "string") {
            current.arguments += call.function.arguments;
          }
        }
        assembled.set(call.index, current);
      }
    }
    expect([...assembled.entries()]).toEqual([
      [0, { id: "call_first", name: "first_tool", arguments: "{\"city\":\"Paris\"}" }],
      [1, { id: "call_second", name: "second_tool", arguments: "{\"count\":2}" }],
    ]);

    const terminalChunk = chunks.find((chunk) =>
      Array.isArray(chunk.choices) && chunk.choices[0]?.finish_reason !== null &&
      chunk.choices[0]?.finish_reason !== undefined);
    expect(terminalChunk?.choices).toMatchObject([{ index: 0, finish_reason: "tool_calls" }]);
    const usageChunk = chunks.at(-1);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toMatchObject({
      prompt_tokens: 9,
      completion_tokens: 7,
      total_tokens: 16,
    });
  });

  it("renders refusal and length terminals without fabricating assistant text", async () => {
    const refusal = createResponse({
      id: "resp_refusal",
      model: "kimi",
      output: [{
        id: "msg_refusal",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "I cannot help with that." }],
      }],
    });
    const incomplete = createResponse({
      id: "resp_incomplete_chat",
      model: "kimi",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{
        id: "msg_partial",
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [{ type: "output_text", text: "Partial answer", annotations: [] }],
      }],
    });
    const script = scriptedDemoFetch([
      () => supplierStream(refusal),
      () => supplierStream(incomplete),
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const app = createApp(deps);

    const refused = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", messages: [{ role: "user", content: "Unsafe request" }] });
    expect(refused.status).toBe(200);
    expect(refused.body.choices[0]).toMatchObject({
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: null,
        refusal: "I cannot help with that.",
      },
    });

    const truncated = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [{ role: "user", content: "Give a long answer" }],
        max_completion_tokens: 1,
      });
    expect(truncated.status).toBe(200);
    expect(truncated.body.choices[0]).toMatchObject({
      finish_reason: "length",
      message: { role: "assistant", content: "Partial answer" },
    });
  });

  it("uses one-shot routing and records paid Chat usage for a normal key", async () => {
    const alternate = {
      ...SUPPLIERS[0],
      utxo_ref: `${"cc".repeat(32)}#0`,
      supplier_pkh: "c".repeat(56),
      price_lovelace: "2000000",
    };
    const paidSuppliers = [alternate, ...SUPPLIERS];
    const fetchFn = (async (url: unknown) => {
      if (String(url).includes("/suppliers")) {
        return new Response(JSON.stringify(paidSuppliers), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
    const app = createApp(deps);
    const signup = await request(app).post("/signup").send({ label: "paid-chat" });
    const rawKey = signup.body.api_key as string;
    const keyRow = deps.store.getKeyByHash(hashApiKey(rawKey))!;
    const ctx = deps.registry.getContext(keyRow);
    const escrowRef = { txHash: "d".repeat(64), index: 0 };
    const submitPrompt = vi.fn(async () => ({
      result: createResponse({
        id: "resp_paid",
        model: "qwen",
        output: [{
          id: "msg_paid",
          type: "message" as const,
          role: "assistant" as const,
          status: "completed",
          content: [{ type: "output_text" as const, text: "Paid answer", annotations: [] }],
        }],
        usage: { input_tokens: 6, output_tokens: 3, total_tokens: 9 },
      }),
      receipt: {
        prompt_hash: "1".repeat(64),
        response_hash: "2".repeat(64),
        model: "qwen",
        prompt_tokens: 6,
        completion_tokens: 3,
        wallclock_ms: 10,
        supplier_pkh: "a".repeat(56),
        escrow_ref: `${escrowRef.txHash}#${escrowRef.index}`,
      },
      receiptSignature: "supplier-signature",
      escrowRef,
    }));
    const mutableSdk = ctx.sdk as unknown as { submitPrompt: typeof submitPrompt };
    mutableSdk.submitPrompt = submitPrompt;

    const completion = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "qwen",
        messages: [{ role: "user", content: "Paid request" }],
        x_vector: { supplier_pkh: "a".repeat(56) },
      });
    expect(completion.status).toBe(200);
    expect(completion.body.choices[0]).toMatchObject({
      finish_reason: "stop",
      message: { role: "assistant", content: "Paid answer" },
    });
    expect(completion.body.x_vector).toMatchObject({
      escrow_ref: `${escrowRef.txHash}#${escrowRef.index}`,
      receipt: {
        model: "qwen",
        supplier_pkh: "a".repeat(56),
      },
    });

    const account = await request(app).get("/account")
      .set("authorization", `Bearer ${rawKey}`);
    expect(account.body.spend).toEqual({
      total_cost_lovelace: "1000000",
      request_count: 1,
    });
    expect(account.body.recent_usage[0]).toMatchObject({
      kind: "completion",
      model: "qwen",
      status: "completed",
      cost_lovelace: "1000000",
      escrow_ref: `${escrowRef.txHash}#${escrowRef.index}`,
    });
  });

  it("emits one in-band error and no success terminal after streaming commits", async () => {
    const script = scriptedDemoFetch([
      () => new Response("supplier broke", { status: 500 }),
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const response = await request(createApp(deps))
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/event-stream/);
    const { chunks, doneCount } = chatStreamData(response.text);
    const errorFrames = chunks.filter((chunk) => "error" in chunk);
    expect(errorFrames).toHaveLength(1);
    expect(errorFrames[0].error).toEqual(expect.objectContaining({
      type: "server_error",
      code: expect.any(String),
      param: null,
    }));
    expect(doneCount).toBe(0);
    expect(chunks.some((chunk) =>
      Array.isArray(chunk.choices) &&
      chunk.choices.some((choice) => choice.finish_reason !== null))).toBe(false);
  });

  it("accepts explicit text format and nullable defaults on a Chat Completions supplier", async () => {
    const script = scriptedDemoFetch(
      [() => supplierStream(textResponse("Plain text answer"))],
      () => SUPPLIERS,
      () => ({ inference_api: "responses", upstream_api: "chat-completions", reasoning_disabled: false }),
    );
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const response = await request(createApp(deps))
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [{ role: "user", content: "Hello" }],
        response_format: { type: "text" },
        n: null,
        store: null,
        stream: null,
        stream_options: null,
      });
    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe("Plain text answer");
  });

  it("rejects a changed function identity in the terminal stream", async () => {
    const announced = {
      type: "function_call" as const, id: "fc_one", call_id: "call_one",
      name: "first_tool", arguments: "",
    };
    const terminal = createResponse({
      id: "resp_changed_tool",
      model: "kimi",
      output: [{ ...announced, name: "second_tool", arguments: "{}" }],
    });
    const script = scriptedDemoFetch([() => supplierEventStream([
      { type: "response.output_item.added", output_index: 0, item: announced },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
      { type: "response.completed", response: terminal },
    ])]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const response = await request(createApp(deps))
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [{ role: "user", content: "Choose a tool" }],
        tools: [
          { type: "function", function: { name: "first_tool" } },
          { type: "function", function: { name: "second_tool" } },
        ],
        stream: true,
      });
    const { chunks, doneCount } = chatStreamData(response.text);
    expect(response.status).toBe(200);
    expect(chunks.filter((chunk) => "error" in chunk)).toHaveLength(1);
    expect(doneCount).toBe(0);
    expect(chunks.some((chunk) =>
      Array.isArray(chunk.choices) &&
      chunk.choices.some((choice) => choice.finish_reason !== null))).toBe(false);
  });

  it("rejects unsupported Chat controls before opening an escrow", async () => {
    const script = scriptedDemoFetch([
      () => supplierStream(textResponse("must not execute")),
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, startChat } = setupDemo(deps);
    const app = createApp(deps);

    const multipleChoices = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [{ role: "user", content: "hello" }],
        n: 2,
      });
    expect(multipleChoices.status).toBe(400);
    expect(typeof multipleChoices.body.error?.code).toBe("string");

    const stored = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({
        model: "kimi",
        messages: [{ role: "user", content: "hello" }],
        store: true,
      });
    expect(stored.status).toBe(400);
    expect(typeof stored.body.error?.code).toBe("string");
    expect(startChat).not.toHaveBeenCalled();
    expect(script.messageCalls).toHaveLength(0);
  });
});
