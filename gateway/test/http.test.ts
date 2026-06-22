import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/server.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import type { GatewayConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";

const SUPPLIERS = [
  { utxo_ref: "aa".repeat(32) + "#0", supplier_pkh: "s1", capability_id: "llm.text.generate.v1", model: "qwen", max_output_tokens: 256, price_lovelace: "1000000", supplier_bond_lovelace: "1000000", buyer_bond_lovelace: "1000000", endpoint_url: "http://sup", advert_status: "Active", status: "free" },
];

function makeDeps(fetchFn?: typeof globalThis.fetch): GatewayDeps {
  const dbDir = join(tmpdir(), `gw-test-${randomUUID()}`);
  const store = new GatewayStore(dbDir);
  const config: GatewayConfig = {
    masterKeyHex: "ab".repeat(32),
    indexerUrl: "http://ix",
    ogmiosUrl: "http://og",
    networkId: 0,
    liveChain: true,
    port: 0,
    dbDir,
    signupRate: { max: 1000, windowMs: 60_000 },
    keyRate: { max: 1000, windowMs: 60_000 },
    sweeperIntervalMs: 60_000,
    walletHealthIntervalMs: 600_000,
    sdkRegistryMax: 100,
  };
  const chain = { queryUtxosByAddress: async () => [] } as unknown as GatewayDeps["chain"];
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
