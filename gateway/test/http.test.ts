import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, randomUUID } from "crypto";
import request from "supertest";
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
    expect(page.text).toContain("OpenAI-compatible Gateway");
  });

  it("gates Responses and does not retain the old Chat Completions route", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const unauthenticated = await request(app)
      .post("/openai/v1/responses")
      .send({ model: "qwen", input: "hi" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe("invalid_api_key");

    const signup = await request(app).post("/signup").send({});
    const oldRoute = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${signup.body.api_key}`)
      .send({ model: "qwen", messages: [{ role: "user", content: "hi" }] });
    expect(oldRoute.status).toBe(404);
  });

  it("signup, account, and model listing keep their contracts", async () => {
    const fetchFn = (async (url: unknown) => new Response(
      JSON.stringify(String(url).includes("/suppliers") ? SUPPLIERS : []), { status: 200 },
    )) as unknown as typeof globalThis.fetch;
    const app = createApp(makeDeps(fetchFn));
    const signup = await request(app).post("/signup").send({ label: "test" });
    expect(signup.status).toBe(201);
    const key = signup.body.api_key as string;
    const account = await request(app).get("/account").set("authorization", `Bearer ${key}`);
    expect(account.status).toBe(200);
    expect(account.body.spend.request_count).toBe(0);
    const models = await request(app).get("/openai/v1/models").set("authorization", `Bearer ${key}`);
    expect(models.body.data.map((model: { id: string }) => model.id)).toContain("qwen");
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
  turns: Array<() => Response>,
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
      messageCalls.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
      const reply = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      return reply();
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

  it("restores the encrypted canonical transcript for close after memory loss", async () => {
    const script = scriptedDemoFetch([
      () => supplierStream(textResponse("persisted")),
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow, context } = setupDemo(deps);
    const endChat = vi.fn(async (opts: { transcript: unknown[] }) => ({
      settleMode: "full" as const,
      acceptedRef: { txHash: "dd".repeat(32), index: 0 },
      receipt: { prompt_tokens: 3, completion_tokens: 2 },
      receiptSignature: "signature",
      transcript: opts.transcript,
    }));
    const mutableSdk = context.sdk as unknown as { endChat: unknown };
    mutableSdk.endChat = endChat;
    const app = createApp(deps);
    const opened = await request(app).post("/openai/v1/chat/sessions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi" });
    await request(app).post(`/openai/v1/chat/sessions/${opened.body.id}/messages`)
      .set("authorization", `Bearer ${rawKey}`)
      .send({ input: "remember this" });
    transcripts.delete(opened.body.id);

    const closed = await request(app).post(`/openai/v1/chat/sessions/${opened.body.id}/close`)
      .set("authorization", `Bearer ${rawKey}`)
      .send({});
    expect(closed.status).toBe(200);
    expect(endChat.mock.calls[0][0].transcript).toHaveLength(2);
    const session = deps.store.getSession(opened.body.id);
    expect(session?.transcript_ct).toBeNull();
    expect(deps.store.listUsage(keyRow.id, 10).some((row) => row.kind === "chat_session")).toBe(true);
  });

  it("does not settle or reuse a checkpoint interrupted during an unseen turn", async () => {
    const script = scriptedDemoFetch([
      () => supplierStream(textResponse("first")),
      () => supplierStream(textResponse("fresh")),
    ]);
    const deps = makeDeps(script.fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey, keyRow, context, startChat } = setupDemo(deps);
    const endChat = vi.fn().mockRejectedValue(new Error("unexpected supplier Submit"));
    const mutableSdk = context.sdk as unknown as { endChat: unknown };
    mutableSdk.endChat = endChat;
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
    const closed = await request(app).post(`/openai/v1/chat/sessions/${session.id}/close`)
      .set("authorization", `Bearer ${rawKey}`).send({});
    expect(closed.status).toBe(500);
    expect(endChat).not.toHaveBeenCalled();
    release(supplierStream(textResponse("unseen")));
    expect((await pending).status).toBe(500);
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

  it("keeps Vector session turns Responses-shaped for JSON and streams", async () => {
    const { fetchFn, messageCalls } = scriptedDemoFetch([
      () => supplierStream(textResponse("session-json")),
      () => supplierStream(textResponse("session-stream")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN);
    const { rawKey } = setupDemo(deps);
    const app = createApp(deps);
    const opened = await request(app).post("/openai/v1/chat/sessions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi" });
    expect(opened.status).toBe(200);

    const json = await request(app)
      .post(`/openai/v1/chat/sessions/${opened.body.id}/messages`)
      .set("authorization", `Bearer ${rawKey}`)
      .send({ input: "hello", stream: false });
    expect(json.status).toBe(200);
    expect(json.body.object).toBe("response");
    expect(json.body.output[0].content[0].text).toBe("session-json");

    const streamed = await request(app)
      .post(`/openai/v1/chat/sessions/${opened.body.id}/messages`)
      .set("authorization", `Bearer ${rawKey}`)
      .send({ input: "again", stream: true });
    const events = streamEvents(streamed.text);
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(events.map((event) => event.sequence_number))
      .toEqual(events.map((_, index) => index));
    expect(streamed.text).not.toContain("[DONE]");
    expect(messageCalls.map((call) => call.input)).toHaveLength(2);
  });

  it("keeps ticket close and idle janitor accounting at zero cost", async () => {
    const { fetchFn, endCalls } = scriptedDemoFetch([
      () => supplierStream(textResponse("ticket")),
      () => supplierStream(textResponse("idle")),
    ]);
    const deps = makeDeps(fetchFn, 1000, FUNDED_CHAIN, "ticket");
    const { rawKey, keyRow, context } = setupDemo(deps);
    const endChat = vi.fn(async (opts: { escrowRef: { txHash: string; index: number } }) => ({
      settleMode: "ticket" as const,
      escrowRef: opts.escrowRef,
    }));
    const mutableSdk = context.sdk as unknown as { endChat: unknown };
    mutableSdk.endChat = endChat;
    const app = createApp(deps);

    await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "one" });
    const firstSession = deps.store.listOpenSessionsByKey(keyRow.id)[0];
    const closed = await request(app)
      .post(`/openai/v1/chat/sessions/${firstSession.id}/close`)
      .set("authorization", `Bearer ${rawKey}`)
      .send({});
    expect(closed.body.settle_mode).toBe("ticket");
    expect(endChat).toHaveBeenCalledTimes(1);

    await request(app).post("/openai/v1/responses")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", input: "two" });
    await sweepIdleDemoSessions(deps, Date.now() + deps.config.demoSessionIdleMs + 1);
    expect(endCalls).toHaveLength(1);
    const billed = deps.store.listUsage(keyRow.id, 10)
      .filter((usage) => usage.kind === "chat_session");
    expect(billed).toHaveLength(2);
    expect(billed.every((usage) => usage.cost_lovelace === "0")).toBe(true);
  });
});
