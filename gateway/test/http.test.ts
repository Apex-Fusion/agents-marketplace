import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/server.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import { genPrivKeyHex, deriveWalletKey } from "../src/wallet.js";
import { seal } from "../src/crypto/seal.js";
import { hashApiKey } from "../src/middleware/apiKeyAuth.js";
import type { GatewayConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";

const MASTER = "ab".repeat(32);

const SUPPLIERS = [
  { utxo_ref: "aa".repeat(32) + "#0", supplier_pkh: "s1", capability_id: "llm.text.generate.v1", model: "qwen", max_output_tokens: 256, price_lovelace: "1000000", supplier_bond_lovelace: "1000000", buyer_bond_lovelace: "1000000", endpoint_url: "http://sup", advert_status: "Active", status: "free" },
  { utxo_ref: "bb".repeat(32) + "#0", supplier_pkh: "s2", capability_id: "llm.chat.v1", model: "kimi", max_output_tokens: 256, price_lovelace: "1000000", supplier_bond_lovelace: "1000000", buyer_bond_lovelace: "1000000", endpoint_url: "http://sup", advert_status: "Active", status: "free" },
];

function makeDeps(
  fetchFn?: typeof globalThis.fetch,
  overrides?: { demoIpRate?: { max: number; windowMs: number }; chain?: GatewayDeps["chain"] },
): GatewayDeps {
  const dbDir = join(tmpdir(), `gw-test-${randomUUID()}`);
  const store = new GatewayStore(dbDir);
  const config: GatewayConfig = {
    masterKeyHex: MASTER,
    indexerUrl: "http://ix",
    ogmiosUrl: "http://og",
    networkId: 0,
    liveChain: true,
    port: 0,
    dbDir,
    signupRate: { max: 1000, windowMs: 60_000 },
    keyRate: { max: 1000, windowMs: 60_000 },
    demoIpRate: overrides?.demoIpRate ?? { max: 1000, windowMs: 60_000 },
    sweeperIntervalMs: 60_000,
    walletHealthIntervalMs: 600_000,
    sdkRegistryMax: 100,
    corsOrigins: [],
  };
  const chain = overrides?.chain ?? ({ queryUtxosByAddress: async () => [] } as unknown as GatewayDeps["chain"]);
  const registry = new SdkRegistry({
    chain,
    indexerUrl: config.indexerUrl,
    networkId: config.networkId,
    masterKeyHex: config.masterKeyHex,
    max: config.sdkRegistryMax,
  });
  const defaultFetch = (async () => new Response("[]", { status: 200 })) as unknown as typeof globalThis.fetch;
  return { config, store, chain, registry, fetchFn: fetchFn ?? defaultFetch };
}

describe("gateway HTTP", () => {
  it("GET /healthz", async () => {
    const res = await request(createApp(makeDeps())).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET / serves the UI", async () => {
    const res = await request(createApp(makeDeps())).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("OpenAI-compatible Gateway");
  });

  it("rejects unauthenticated chat completions with OpenAI error shape", async () => {
    const res = await request(createApp(makeDeps()))
      .post("/openai/v1/chat/completions")
      .send({ model: "qwen", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("authentication_error");
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("signup → account roundtrip", async () => {
    const app = createApp(makeDeps());
    const signup = await request(app).post("/signup").send({ label: "test" });
    expect(signup.status).toBe(201);
    expect(signup.body.api_key).toMatch(/^vk_test_[0-9a-f]{48}$/);
    expect(signup.body.deposit_address).toMatch(/^addr_test1/);

    const key = signup.body.api_key as string;
    const acct = await request(app).get("/account").set("authorization", `Bearer ${key}`);
    expect(acct.status).toBe(200);
    expect(acct.body.balance.available_lovelace).toBe("0");
    expect(acct.body.collateral_ok).toBe(false);
    expect(acct.body.spend.request_count).toBe(0);
  });

  it("GET /openai/v1/models lists distinct models", async () => {
    const fetchFn = (async (url: string) =>
      new Response(JSON.stringify(String(url).includes("/suppliers") ? SUPPLIERS : []), { status: 200 })) as unknown as typeof globalThis.fetch;
    const app = createApp(makeDeps(fetchFn));
    const signup = await request(app).post("/signup").send({});
    const key = signup.body.api_key as string;
    const res = await request(app).get("/openai/v1/models").set("authorization", `Bearer ${key}`);
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.data.map((m: { id: string }) => m.id)).toContain("qwen");
  });

  it("rejects tools/functions with 400 before any chain work", async () => {
    const app = createApp(makeDeps());
    const signup = await request(app).post("/signup").send({});
    const key = signup.body.api_key as string;
    const res = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${key}`)
      .send({ model: "qwen", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("unsupported_parameter");
  });
});

// ─── Shared demo key (session-backed completions) ───────────────────────────

const TOOLS = [{ type: "function", function: { name: "get_time", parameters: {} } }];
const TOOL_CALL = { id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } };

/** A funded wallet: covers price+bonds+collateral+fee and has pure-ADA ≥ 5. */
const fundedChain = {
  queryUtxosByAddress: async () => [
    { ref: { txHash: "ff".repeat(32), index: 0 }, address: "a", lovelace: 20_000_000n, assets: {}, datumHex: null, scriptRef: null },
  ],
} as unknown as GatewayDeps["chain"];

function supplierSse(frames: unknown[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function doneFrame(message: Record<string, unknown>, finishReason: string, usage = { prompt_tokens: 3, completion_tokens: 2 }) {
  return { type: "done", message, finish_reason: finishReason, usage };
}

/** fetchFn serving the indexer supplier list and scripted /v1/chat/message responses. */
function demoFetch(messageResponses: Array<() => Response>) {
  const messageCalls: Array<Record<string, unknown>> = [];
  let i = 0;
  const fetchFn = (async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/v1/chat/message")) {
      messageCalls.push(init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {});
      const make = messageResponses[Math.min(i, messageResponses.length - 1)];
      i += 1;
      return make();
    }
    if (u.includes("/suppliers")) return new Response(JSON.stringify(SUPPLIERS), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, messageCalls };
}

/** Insert a demo-flagged key directly (public signup can't mint one) and stub
 * the SDK's chain-touching startChat on the pre-warmed per-key context. */
function setupDemoKey(deps: GatewayDeps) {
  const rawKey = `vk_test_${randomBytes(24).toString("hex")}`;
  const privHex = genPrivKeyHex();
  const walletKey = deriveWalletKey(privHex, 0);
  const sealed = seal(privHex, MASTER);
  deps.store.insertKey({
    id: randomUUID(),
    key_hash: hashApiKey(rawKey),
    key_prefix: rawKey.slice(0, 12),
    label: "shared-demo",
    wallet_pkh: walletKey.pubKeyHash,
    deposit_address: walletKey.address,
    enc_priv_nonce: sealed.nonce,
    enc_priv_ct: sealed.ct,
    enc_priv_tag: sealed.tag,
    master_key_version: 1,
    created_at: Date.now(),
    demo: 1,
  });
  const keyRow = deps.store.getKeyByHash(hashApiKey(rawKey))!;
  const ctx = deps.registry.getContext(keyRow);
  const startChat = vi.fn(async () => ({
    escrowRef: { txHash: randomBytes(32).toString("hex"), index: 0 },
    sessionNonce: "nonce",
    supplierBaseUrl: "http://sup",
  }));
  (ctx.sdk as { startChat: unknown }).startChat = startChat;
  return { rawKey, keyRow, startChat };
}

describe("gateway demo key", () => {
  it("runs a session-backed completion with tools and reuses the session via affinity", async () => {
    const { fetchFn, messageCalls } = demoFetch([
      () => supplierSse([doneFrame({ role: "assistant", content: "", tool_calls: [TOOL_CALL] }, "tool_calls")]),
      () => supplierSse([{ type: "token", value: "It is 3pm" }, doneFrame({ role: "assistant", content: "It is 3pm" }, "stop")]),
    ]);
    const deps = makeDeps(fetchFn, { chain: fundedChain });
    const { rawKey, startChat } = setupDemoKey(deps);
    const app = createApp(deps);

    // Turn 1: model asks for a tool call.
    const history: Array<Record<string, unknown>> = [{ role: "user", content: "what time is it?" }];
    const res1 = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", messages: history, tools: TOOLS });
    expect(res1.status).toBe(200);
    expect(res1.body.choices[0].message.tool_calls).toEqual([TOOL_CALL]);
    expect(res1.body.choices[0].finish_reason).toBe("tool_calls");
    expect(startChat).toHaveBeenCalledTimes(1);
    // First turn replays the full history and forwards tools.
    expect((messageCalls[0].messages as unknown[]).length).toBe(1);
    expect(messageCalls[0].tools).toEqual(TOOLS);

    // Turn 2: client echoes the assistant tool_calls + tool result.
    history.push({ role: "assistant", content: "", tool_calls: [TOOL_CALL] });
    history.push({ role: "tool", content: "3pm", tool_call_id: "call_1" });
    const res2 = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", messages: history, tools: TOOLS });
    expect(res2.status).toBe(200);
    expect(res2.body.choices[0].message.content).toBe("It is 3pm");
    expect(res2.body.choices[0].finish_reason).toBe("stop");
    // Affinity hit: no new session, only the unseen delta is forwarded.
    expect(startChat).toHaveBeenCalledTimes(1);
    const delta = messageCalls[1].messages as Array<{ role: string }>;
    expect(delta).toHaveLength(1);
    expect(delta[0].role).toBe("tool");
  });

  it("streams tool_calls chunks with finish_reason tool_calls", async () => {
    const { fetchFn } = demoFetch([
      () => supplierSse([doneFrame({ role: "assistant", content: "", tool_calls: [TOOL_CALL] }, "tool_calls")]),
    ]);
    const deps = makeDeps(fetchFn, { chain: fundedChain });
    const { rawKey } = setupDemoKey(deps);
    const res = await request(createApp(deps))
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", messages: [{ role: "user", content: "time?" }], tools: TOOLS, stream: true });
    expect(res.status).toBe(200);
    const chunks = res.text
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    const toolChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("get_time");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(res.text).toContain("data: [DONE]");
  });

  it("transparently reopens when the supplier lost the session (idle-close)", async () => {
    const { fetchFn, messageCalls } = demoFetch([
      () => supplierSse([{ type: "token", value: "Hi" }, doneFrame({ role: "assistant", content: "Hi" }, "stop")]),
      () => new Response("not found", { status: 404 }),
      () => supplierSse([{ type: "token", value: "Sure" }, doneFrame({ role: "assistant", content: "Sure" }, "stop")]),
    ]);
    const deps = makeDeps(fetchFn, { chain: fundedChain });
    const { rawKey, startChat } = setupDemoKey(deps);
    const app = createApp(deps);

    const res1 = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", messages: [{ role: "user", content: "hi" }] });
    expect(res1.status).toBe(200);

    // Extended history matches the session, but the supplier 404s the turn →
    // the executor closes the session and reopens, replaying full history.
    const history = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "more please" },
    ];
    const res2 = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", messages: history });
    expect(res2.status).toBe(200);
    expect(res2.body.choices[0].message.content).toBe("Sure");
    expect(startChat).toHaveBeenCalledTimes(2);
    expect((messageCalls[2].messages as unknown[]).length).toBe(3);
    // The dead session's fee was recorded for spend audit.
    const usage = deps.store.listUsage(deps.store.listAllKeys().find((k) => k.demo === 1)!.id, 10);
    expect(usage.some((u) => u.kind === "chat_session" && u.cost_lovelace === "1000000")).toBe(true);
  });

  it("rejects histories that do not end with user/tool before any chain work", async () => {
    const deps = makeDeps(undefined, { chain: fundedChain });
    const { rawKey, startChat } = setupDemoKey(deps);
    const res = await request(createApp(deps))
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ model: "kimi", messages: [{ role: "assistant", content: "hello" }] });
    expect(res.status).toBe(400);
    expect(startChat).not.toHaveBeenCalled();
  });

  it("blocks withdraw and hides the deposit address for demo keys", async () => {
    const deps = makeDeps();
    const { rawKey } = setupDemoKey(deps);
    const app = createApp(deps);

    const wd = await request(app)
      .post("/account/withdraw")
      .set("authorization", `Bearer ${rawKey}`)
      .send({ to_address: "addr_test1abc" });
    expect(wd.status).toBe(403);
    expect(wd.body.error.code).toBe("demo_key_restricted");

    const acct = await request(app).get("/account").set("authorization", `Bearer ${rawKey}`);
    expect(acct.status).toBe(200);
    expect(acct.body.deposit_address).toBeNull();
    expect(acct.body.demo).toBe(true);
  });

  it("lists only chat-capable models for demo keys", async () => {
    const fetchFn = (async (url: unknown) =>
      new Response(JSON.stringify(String(url).includes("/suppliers") ? SUPPLIERS.filter((s) => !String(url).includes("capability_id") || s.capability_id === "llm.chat.v1") : []), { status: 200 })) as unknown as typeof globalThis.fetch;
    const deps = makeDeps(fetchFn);
    const { rawKey } = setupDemoKey(deps);
    const app = createApp(deps);

    const demoModels = await request(app).get("/openai/v1/models").set("authorization", `Bearer ${rawKey}`);
    expect(demoModels.body.data.map((m: { id: string }) => m.id)).toEqual(["kimi"]);

    const signup = await request(app).post("/signup").send({});
    const normalModels = await request(app).get("/openai/v1/models").set("authorization", `Bearer ${signup.body.api_key as string}`);
    expect(normalModels.body.data.map((m: { id: string }) => m.id).sort()).toEqual(["kimi", "qwen"]);
  });

  it("rate-limits demo requests per IP (and not per key)", async () => {
    const deps = makeDeps(undefined, { demoIpRate: { max: 1, windowMs: 60_000 } });
    const { rawKey } = setupDemoKey(deps);
    const app = createApp(deps);

    // Model with no chat suppliers → cheap 404 AFTER passing the limiter.
    const body = { model: "nope", messages: [{ role: "user", content: "hi" }] };
    const first = await request(app).post("/openai/v1/chat/completions").set("authorization", `Bearer ${rawKey}`).send(body);
    expect(first.status).toBe(404);
    const second = await request(app).post("/openai/v1/chat/completions").set("authorization", `Bearer ${rawKey}`).send(body);
    expect(second.status).toBe(429);

    // Non-demo keys are untouched by the demo IP limiter.
    const signup = await request(app).post("/signup").send({});
    const normal = await request(app)
      .post("/openai/v1/chat/completions")
      .set("authorization", `Bearer ${signup.body.api_key as string}`)
      .send(body);
    expect(normal.status).not.toBe(429);
  });
});
