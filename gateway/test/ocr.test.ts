/**
 * gateway/test/ocr.test.ts — POST /v1/ocr/extract route coverage.
 *
 * Focus: auth gating, demo-key rejection, body validation, capability-based
 * supplier lookup, and the enlarged body limit. The settle path (submitOcr →
 * resolveSubmittedRef → acceptAndConfirm) reuses the one-shot chat plumbing
 * covered by http.test.ts + the SDK suites; end-to-end runs live on testnet.
 */

import { describe, it, expect } from "vitest";
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
const IMG = Buffer.from("page bytes").toString("base64");

function makeDeps(fetchFn?: typeof globalThis.fetch): GatewayDeps {
  const dbDir = join(tmpdir(), `gw-ocr-test-${randomUUID()}`);
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
    demoIpRate: { max: 1000, windowMs: 60_000 },
    sweeperIntervalMs: 60_000,
    demoSessionIdleMs: 180_000,
    chatSettleMode: "full",
    walletHealthIntervalMs: 600_000,
    sdkRegistryMax: 100,
    ocrCapabilityId: "ocr.page.extract.chandra-ocr-2.v1",
    corsOrigins: [],
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

/** Insert a key row (demo or funded) and return the raw bearer token. */
function makeKey(deps: GatewayDeps, demo: 0 | 1): string {
  const rawKey = `vk-${randomBytes(24).toString("hex")}`;
  const privHex = genPrivKeyHex();
  const walletKey = deriveWalletKey(privHex, 0);
  const sealed = seal(privHex, MASTER);
  deps.store.insertKey({
    id: randomUUID(),
    key_hash: hashApiKey(rawKey),
    key_prefix: rawKey.slice(0, 12),
    label: demo ? "demo" : "funded",
    wallet_pkh: walletKey.pubKeyHash,
    deposit_address: walletKey.address,
    enc_priv_nonce: sealed.nonce,
    enc_priv_ct: sealed.ct,
    enc_priv_tag: sealed.tag,
    master_key_version: 1,
    created_at: Date.now(),
    demo,
  });
  return rawKey;
}

function validBody() {
  return { image_b64: IMG, mime: "image/png", output_format: "markdown" };
}

describe("POST /v1/ocr/extract — auth + demo gating", () => {
  it("401 without a bearer key, OpenAI error shape", async () => {
    const res = await request(createApp(makeDeps()))
      .post("/v1/ocr/extract").send(validBody());
    expect(res.status).toBe(401);
    expect(res.body.error?.type).toBe("authentication_error");
  });

  it("403 demo_key_unsupported for demo keys", async () => {
    const deps = makeDeps();
    const rawKey = makeKey(deps, 1);
    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("demo_key_unsupported");
  });
});

describe("POST /v1/ocr/extract — body validation", () => {
  async function post(body: unknown) {
    const deps = makeDeps();
    const rawKey = makeKey(deps, 0);
    return request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(body as object);
  }

  it("400 invalid_image on missing/empty/data-URL image_b64", async () => {
    for (const image_b64 of [undefined, "", `data:image/png;base64,${IMG}`]) {
      const res = await post({ ...validBody(), image_b64 });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("invalid_image");
    }
  });

  it("400 invalid_mime on unsupported mime", async () => {
    const res = await post({ ...validBody(), mime: "image/gif" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("invalid_mime");
  });

  it("400 invalid_output_format on unsupported format", async () => {
    const res = await post({ ...validBody(), output_format: "yaml" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("invalid_output_format");
  });

  it("output_format defaults to markdown (reaches supplier lookup)", async () => {
    const res = await post({ image_b64: IMG, mime: "image/png" });
    // Passes validation, then the empty indexer answer → 404 model_not_found.
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("model_not_found");
  });
});

describe("POST /v1/ocr/extract — supplier lookup + body limit", () => {
  it("404 model_not_found when no supplier advertises the capability", async () => {
    const deps = makeDeps();
    const rawKey = makeKey(deps, 0);
    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("model_not_found");
  });

  it("queries the indexer with the configured ocr capability id", async () => {
    let queried = "";
    const fetchFn = (async (url: unknown) => {
      queried = String(url);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const deps = makeDeps(fetchFn);
    const rawKey = makeKey(deps, 0);
    await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());
    expect(queried).toContain("capability_id=ocr.page.extract.chandra-ocr-2.v1");
  });

  it("accepts a 2MB body (over the 1mb global limit — OCR route has its own parser)", async () => {
    const deps = makeDeps();
    const rawKey = makeKey(deps, 0);
    const big = "A".repeat(2_000_000);
    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ ...validBody(), image_b64: big });
    expect(res.status).not.toBe(413);
    // Valid base64 + no suppliers → 404 model_not_found.
    expect(res.status).toBe(404);
  });

  it("chat completions keep the 1mb ceiling (413 on a 2MB body)", async () => {
    const deps = makeDeps();
    const rawKey = makeKey(deps, 0);
    const big = "A".repeat(2_000_000);
    const res = await request(createApp(deps))
      .post("/openai/v1/chat/completions")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ model: "qwen", messages: [{ role: "user", content: big }] });
    expect(res.status).toBe(413);
  });
});
