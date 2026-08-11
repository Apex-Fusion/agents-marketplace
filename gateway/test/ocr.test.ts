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
import { SupplierError } from "@marketplace/buyer/sdk";

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

// ─── Failure path — escrow ref survives a post-escrow SupplierError (I2) ────
//
// submitOcr posts the escrow, THEN calls the supplier. A SupplierError
// (timeout, network failure, non-2xx, malformed response, receipt mismatch)
// means the escrow already landed on chain even though submitOcr rejects —
// per the OCR route's 120s supplier budget, this is likely the MOST common
// paid-but-failed shape. Before this fix, escrowRefStr was only assigned
// from submitOcr's *return value*, so this exact case recorded escrow_ref:
// null. The route now also listens for the SDK's "escrow_posted" progress
// event around each attempt, so the ref survives regardless of whether
// submitOcr goes on to resolve or reject.

describe("POST /v1/ocr/extract — escrow ref survives a post-escrow SupplierError", () => {
  it("records the escrow_ref from the escrow_posted progress event, not null, when submitOcr posts an escrow then rejects", async () => {
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

    // Same monkeypatch pattern as the happy-path test above: fetch the real
    // per-key Marketplace instance from the registry BEFORE the request so
    // its real EventEmitter (on/off/emit) stays live, then replace only
    // submitOcr. The stub mirrors what Marketplace.submitOcr actually does
    // on this failure shape: emit "escrow_posted" the instant the tx
    // confirms, then throw once the supplier call fails.
    const ctx = deps.registry.getContext(keyRow);
    const knownEscrowRef = `${"9".repeat(64)}#0`;
    const submitOcr = vi.fn(async () => {
      ctx.sdk.emit("progress", { type: "escrow_posted", escrow_ref: knownEscrowRef });
      throw new SupplierError("timeout", { message: "supplier did not respond within budget" });
    });
    (ctx.sdk as { submitOcr: unknown }).submitOcr = submitOcr;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());
    // Snapshot the recorded calls BEFORE restoring — mockRestore() also
    // clears .mock.calls (it runs mockReset()/mockClear() first), so
    // reading logSpy.mock.calls after restore always sees [].
    const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
    logSpy.mockRestore();

    expect(submitOcr).toHaveBeenCalledTimes(1);
    // toGatewayError maps SupplierError("timeout") to 504 supplier_timeout —
    // confirms the request actually took the failure path this test targets.
    expect(res.status).toBe(504);
    expect(res.body.error?.code).toBe("supplier_timeout");

    // The reconciliation spine: the usage row recorded in the catch block
    // must carry the real ref, not null.
    const rows = deps.store.listUsage(keyRow.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].escrow_ref).toBe(knownEscrowRef);

    // The structured ocr_failed log line (wedge-ledger emitter input) must
    // carry the same ref.
    const failedLine = loggedLines
      .filter((line) => line.includes('"evt":"ocr_failed"'))
      .map((line) => JSON.parse(line) as { escrow_ref: string | null });
    expect(failedLine).toHaveLength(1);
    expect(failedLine[0].escrow_ref).toBe(knownEscrowRef);
  });
});

// ─── Busy pre-check - never post an escrow to a candidate that is busy ──────
//
// runOcrOneShot now checks each candidate's live /status immediately before
// calling submitOcr for it (mirrors sessions.ts's startChat pre-check):
// "working" means busy and moves on to the next candidate WITHOUT posting an
// escrow; anything else (free, unreachable, malformed, slow) is treated as
// usable. submitOcr is the escrow-posting path in these tests (same
// monkeypatch pattern as the suites above), so asserting its call count is
// exactly how "no escrow was posted" is observed.

const OCR_SUPPLIER_A = {
  ...OCR_SUPPLIER,
  utxo_ref: `${"aa".repeat(32)}#0`,
  supplier_pkh: "sA",
  endpoint_url: "http://sup-a",
};
const OCR_SUPPLIER_B = {
  ...OCR_SUPPLIER,
  utxo_ref: `${"bb".repeat(32)}#0`,
  supplier_pkh: "sB",
  endpoint_url: "http://sup-b",
};

/** Indexer /suppliers lookup plus a per-endpoint /status responder, on one
 * fetchFn - everything else falls back to the suite's usual empty array. */
function makeFetchWithStatus(
  suppliers: Array<typeof OCR_SUPPLIER>,
  statusByEndpoint: Record<string, () => Response>,
): typeof globalThis.fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/suppliers")) {
      return new Response(JSON.stringify(suppliers), { status: 200 });
    }
    for (const [endpoint, respond] of Object.entries(statusByEndpoint)) {
      if (u === `${endpoint}/status`) return respond();
    }
    return new Response("[]", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

/** Same successful submitOcr shape as the happy-path suite above, reused
 * across the busy pre-check tests. */
function makeSubmitOcrStub() {
  return vi.fn(async (_opts: { advertRef: { txHash: string; index: number } }) => ({
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
}

describe("POST /v1/ocr/extract - busy pre-check", () => {
  it("a busy supplier is never sent an escrow; the route returns the busy response", async () => {
    const fetchFn = makeFetchWithStatus([OCR_SUPPLIER], {
      "http://sup": () => new Response(JSON.stringify({ status: "working" }), { status: 200 }),
    });
    const deps = makeDeps(fetchFn, { chain: fundedChain });
    const rawKey = makeKey(deps, 0);
    const keyRow = deps.store.getKeyByHash(hashApiKey(rawKey))!;

    const ctx = deps.registry.getContext(keyRow);
    const submitOcr = makeSubmitOcrStub();
    (ctx.sdk as { submitOcr: unknown }).submitOcr = submitOcr;

    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());

    // The escrow-posting path was never invoked.
    expect(submitOcr).not.toHaveBeenCalled();
    // toGatewayError maps SupplierError("supplier_busy") to 503 overloaded -
    // the same busy response a post-escrow 409 would have produced.
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe("overloaded");

    const rows = deps.store.listUsage(keyRow.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].escrow_ref).toBeNull();
  });

  it("a free supplier proceeds to post and settle exactly as before", async () => {
    const fetchFn = makeFetchWithStatus([OCR_SUPPLIER], {
      "http://sup": () => new Response(JSON.stringify({ status: "free" }), { status: 200 }),
    });
    const deps = makeDeps(fetchFn, { chain: fundedChain });
    const rawKey = makeKey(deps, 0);
    const keyRow = deps.store.getKeyByHash(hashApiKey(rawKey))!;

    const ctx = deps.registry.getContext(keyRow);
    const submitOcr = makeSubmitOcrStub();
    (ctx.sdk as { submitOcr: unknown }).submitOcr = submitOcr;

    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());

    expect(submitOcr).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body.x_vector.receipt_labels).toContain("first-party-brokered");
  });

  it("falls back to the second candidate when the first is busy, posting exactly one escrow", async () => {
    const fetchFn = makeFetchWithStatus([OCR_SUPPLIER_A, OCR_SUPPLIER_B], {
      "http://sup-a": () => new Response(JSON.stringify({ status: "working" }), { status: 200 }),
      "http://sup-b": () => new Response(JSON.stringify({ status: "free" }), { status: 200 }),
    });
    const deps = makeDeps(fetchFn, { chain: fundedChain });
    const rawKey = makeKey(deps, 0);
    const keyRow = deps.store.getKeyByHash(hashApiKey(rawKey))!;

    const ctx = deps.registry.getContext(keyRow);
    const submitOcr = makeSubmitOcrStub();
    (ctx.sdk as { submitOcr: unknown }).submitOcr = submitOcr;

    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());

    expect(res.status).toBe(200);
    // Exactly one escrow posted, and it is the second (free) candidate's -
    // the busy first candidate was skipped, not retried after failing.
    expect(submitOcr).toHaveBeenCalledTimes(1);
    expect(submitOcr.mock.calls[0][0].advertRef).toEqual({ txHash: "bb".repeat(32), index: 0 });
  });

  it("a status check that errors does not block the attempt", async () => {
    const fetchFn = makeFetchWithStatus([OCR_SUPPLIER], {
      "http://sup": () => {
        // Simulates both a network error and an aborted (timed-out) request -
        // isSupplierBusy's catch block treats every failure mode the same
        // way: unknown, not busy, proceed. A real AbortSignal timeout is not
        // exercised here to keep the suite fast; the outcome is identical.
        throw new Error("simulated network failure reaching /status");
      },
    });
    const deps = makeDeps(fetchFn, { chain: fundedChain });
    const rawKey = makeKey(deps, 0);
    const keyRow = deps.store.getKeyByHash(hashApiKey(rawKey))!;

    const ctx = deps.registry.getContext(keyRow);
    const submitOcr = makeSubmitOcrStub();
    (ctx.sdk as { submitOcr: unknown }).submitOcr = submitOcr;

    const res = await request(createApp(deps))
      .post("/v1/ocr/extract")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validBody());

    // The candidate was still tried despite the failed pre-check.
    expect(submitOcr).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});
