/**
 * gateway/test/ocr.test.ts — POST /v1/ocr/extract route coverage.
 *
 * Focus: auth gating, demo-key rejection, body validation, capability-based
 * supplier lookup, and the enlarged body limit. The settle path (submitOcr →
 * resolveSubmittedRef → acceptAndConfirm) reuses the one-shot chat plumbing
 * covered by http.test.ts + the SDK suites; end-to-end runs live on testnet.
 */

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
import { venueAttribution } from "../src/ocr/extract.js";
import type { GatewayConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";

// The one-shot settle step (resolveSubmittedRef → acceptAndConfirm) talks to
// the live indexer + chain; the happy-path route test below only needs to
// prove that a successful submitOcr reaches the response with the
// first-party-brokered disclosure label (I3), so it stubs just those two
// chain-touching steps and keeps every other export real.
vi.mock("../src/onchain/settle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/onchain/settle.js")>();
  return {
    ...actual,
    resolveSubmittedRef: vi.fn(async () => ({ txHash: "e".repeat(64), index: 0 })),
    acceptAndConfirm: vi.fn(async () => "f".repeat(64)),
  };
});

const MASTER = "ab".repeat(32);
const IMG = Buffer.from("page bytes").toString("base64");

/** A funded wallet: covers price+bonds+collateral+fee and has pure-ADA ≥ 5. */
const fundedChain = {
  queryUtxosByAddress: async () => [
    { ref: { txHash: "ff".repeat(32), index: 0 }, address: "a", lovelace: 20_000_000n, assets: {}, datumHex: null, scriptRef: null },
  ],
} as unknown as GatewayDeps["chain"];

const OCR_SUPPLIER = {
  utxo_ref: `${"cc".repeat(32)}#0`,
  supplier_pkh: "s3",
  capability_id: "ocr.page.extract.chandra-ocr-2.v1",
  model: "chandra-ocr-2",
  max_output_tokens: 4096,
  price_lovelace: "200000",
  supplier_bond_lovelace: "1000000",
  buyer_bond_lovelace: "1000000",
  endpoint_url: "http://sup",
  advert_status: "Active",
  status: "free",
};

function makeDeps(fetchFn?: typeof globalThis.fetch, overrides?: { chain?: GatewayDeps["chain"] }): GatewayDeps {
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

// ─── venueAttribution — pure-function header sanitization (I3) ──────────────
//
// grep for "first-party-brokered" used to return only source lines: nothing
// exercised venueAttribution's regex gates or RECEIPT_LABELS_V0 reaching the
// wire. These two blocks close that gap.

function fakeReq(headers: Record<string, string>): Parameters<typeof venueAttribution>[0] {
  return { header: (name: string) => headers[name] } as unknown as Parameters<typeof venueAttribution>[0];
}

describe("venueAttribution — header sanitization", () => {
  it("passes through a valid venue slug and a valid lowercase hash", () => {
    const hash = "a".repeat(64);
    const out = venueAttribution(fakeReq({ "X-Venue": "apify", "X-Run-User-Hash": hash }));
    expect(out).toEqual({ venue: "apify", runUserHash: hash });
  });

  it("lowercases a valid but uppercase hex hash", () => {
    const out = venueAttribution(fakeReq({ "X-Venue": "apify", "X-Run-User-Hash": "A".repeat(64) }));
    expect(out.runUserHash).toBe("a".repeat(64));
  });

  it("drops an invalid venue to empty string (uppercase, bad chars, oversized)", () => {
    for (const bad of ["Apify", "apify!", "apify_venue", "a".repeat(33)]) {
      const out = venueAttribution(fakeReq({ "X-Venue": bad, "X-Run-User-Hash": "a".repeat(64) }));
      expect(out.venue).toBe("");
    }
  });

  it("drops an invalid run-user-hash to empty string (wrong length, non-hex)", () => {
    for (const bad of ["a".repeat(63), "a".repeat(65), "z".repeat(64), "not-hex-at-all"]) {
      const out = venueAttribution(fakeReq({ "X-Venue": "apify", "X-Run-User-Hash": bad }));
      expect(out.runUserHash).toBe("");
    }
  });

  it("defaults both fields to empty string when headers are missing", () => {
    const out = venueAttribution(fakeReq({}));
    expect(out).toEqual({ venue: "", runUserHash: "" });
  });
});

// ─── Happy path — receipt disclosure label reaches the response (I3) ────────

describe("POST /v1/ocr/extract — happy path", () => {
  it("200 response x_vector.receipt_labels contains first-party-brokered", async () => {
    const fetchFn = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/suppliers")) {
        return new Response(JSON.stringify([OCR_SUPPLIER]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const deps = makeDeps(fetchFn, { chain: fundedChain });
    const rawKey = makeKey(deps, 0);
    const keyRow = deps.store.getKeyByHash(hashApiKey(rawKey))!;

    // Stub only the chain-touching supplier call; escrow ref shape matches
    // what resolveSubmittedRef's mock (module-level, top of file) expects.
    const ctx = deps.registry.getContext(keyRow);
    const submitOcr = vi.fn(async () => ({
      output_format: "markdown",
      content: "extracted text",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      receipt: {
        prompt_hash: "1b".repeat(32),
        response_hash: "2c".repeat(32),
        model: "chandra-ocr-2",
        prompt_tokens: 10,
        completion_tokens: 5,
        wallclock_ms: Date.now(),
        supplier_pkh: "s3",
        escrow_ref: `${"d".repeat(64)}#0`,
      },
      receiptSignature: "sig".repeat(20),
      escrowRef: { txHash: "d".repeat(64), index: 0 },
    }));
    (ctx.sdk as { submitOcr: unknown }).submitOcr = submitOcr;

    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());

    expect(res.status).toBe(200);
    expect(submitOcr).toHaveBeenCalledTimes(1);
    expect(res.body.x_vector.receipt_labels).toContain("first-party-brokered");
    // escrow_ref in the response comes from submitOcr's returned escrowRef
    // (the ORIGINAL Open ref), not the mocked resolveSubmittedRef's answer —
    // see settle.ts's docstring on why those two refs differ on-chain.
    expect(res.body.x_vector.escrow_ref).toBe(`${"d".repeat(64)}#0`);
  });
});
