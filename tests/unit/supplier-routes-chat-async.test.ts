/**
 * supplier-routes-chat-async.test.ts — RED phase tests for async POST /v1/chat/completions
 *
 * M1-F-async-chat RED phase — Caroline, 2026-04-28
 *
 * Verifies that POST /v1/chat/completions returns 202 Accepted immediately
 * (after Claim tx confirms) and kicks off background work via runChatJob.
 *
 * These tests REPLACE the happy-path 200 tests from supplier-routes-chat.test.ts.
 * The validation-error cases are NOT touched (they live in supplier-routes-chat.test.ts).
 *
 * Architecture: POST validates → acquires lock → submits Claim tx → awaitTx Claim
 *   → jobs.create → runChatJob (fire-and-forget) → 202 with {job_id, status, escrow_ref}
 *
 * SPEC FIX 2026-04-28 M1-F-async-chat: response is now async (202, not 200)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig, SAMPLE_ADVERT_TX_HASH, SAMPLE_ADVERT_INDEX } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey, SUPPLIER_PKH } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildOpenEscrowUtxo,
  buildClaimedEscrowUtxo,
  ESCROW_TX_HASH,
  ESCROW_SCRIPT_ADDRESS,
  TOTAL_LOCKED,
  CAPABILITY_ID,
  TEST_MODEL,
  TEST_MAX_OUTPUT_TOKENS,
  TEST_MESSAGES,
} from "../fixtures/supplier-side/sample-escrow-state.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const OPEN_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#0`;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validChatBody() {
  return {
    model: TEST_MODEL,
    messages: TEST_MESSAGES,
    max_tokens: TEST_MAX_OUTPUT_TOKENS,
  };
}

function buildActiveAdvertDatum(): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER_PKH,
    capability_id: CAPABILITY_ID,
    model: TEST_MODEL,
    max_output_tokens: TEST_MAX_OUTPUT_TOKENS,
    max_processing_ms: 60_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "http://supplier.example:8080",
    detail_uri: "ipfs://QmTest",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

function seedAdvertUtxo(chain: MockChainProvider, datum: AdvertDatum = buildActiveAdvertDatum()) {
  chain.seed({
    ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
    address: "addr_test1wfakeadvertaddress",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  });
}

/**
 * makeApp injects a JobStore so tests can inspect it after the HTTP call.
 * NOTE: server.ts will need to accept jobs as part of SupplierDeps (Catherine).
 */
function makeApp(
  chain: MockChainProvider,
  state?: SupplierState,
  jobs?: JobStore,
): Application {
  return createApp({
    chain,
    state: state ?? new SupplierState(),
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
    jobs: jobs ?? new JobStore(),
  });
}

// Mock Ollama as deferred (never resolves during test) by default for async tests
function mockOllamaDeferred() {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })));
}

function mockOllamaOk(content = "I am a helpful assistant.") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      message: { role: "assistant", content },
      done: true,
      prompt_eval_count: 12,
      eval_count: 48,
      total_duration: 3_200_000_000,
    }),
  }));
}

// ─── Happy path — 202 returned immediately ────────────────────────────────────

describe("POST /v1/chat/completions (async) — happy path 202", () => {
  let chain: MockChainProvider;
  let state: SupplierState;
  let jobs: JobStore;
  let app: Application;

  beforeEach(() => {
    chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    state = new SupplierState();
    jobs = new JobStore();
    app = makeApp(chain, state, jobs);
    // Ollama is deferred — POST must return 202 before Ollama completes
    mockOllamaDeferred();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("returns 202 Accepted (not 200) on valid request", async () => {
    // RED — stub throws / server returns 200 currently
    // SPEC FIX 2026-04-28 M1-F-async-chat: response is now async (202, not 200)
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(202);
  });

  it("202 body contains job_id, status=accepted, escrow_ref", async () => {
    // RED — stub throws
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(202);
    expect(UUID_V4_RE.test(res.body.job_id)).toBe(true);
    expect(res.body.status).toBe("accepted");
    expect(res.body.escrow_ref).toBe(OPEN_ESCROW_REF_HEADER);
  });

  it("202 body contains no choices/usage/receipt (those come via GET)", async () => {
    // RED — stub throws
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(202);
    expect(res.body.choices).toBeUndefined();
    expect(res.body.usage).toBeUndefined();
    expect(res.body.receipt).toBeUndefined();
  });

  it("jobs.count() === 1 after 202 lands", async () => {
    // RED — stub throws
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(202);
    expect(jobs.count()).toBe(1);
  });

  it("POST returns 202 BEFORE callOllama is invoked (fire-and-forget)", async () => {
    // RED — stub throws
    // The 202 must land before Ollama is called. With a deferred Ollama mock,
    // at the time the HTTP response is received, callOllama must not yet have
    // settled (it's the deferred promise).
    // We verify via call count: after supertest.post() resolves, fetch (Ollama)
    // must have been called (the fire-and-forget fires immediately) but the
    // POST response must have arrived before it could have settled.
    // The key assertion: the HTTP response is 202 even though fetch never resolves.
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    // If we got here, the response arrived even though fetch never resolved
    expect(res.status).toBe(202);
    // fetch was called (background job started) — but it's still pending
    const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
    expect(fetchMock).toHaveBeenCalled();
  });
});

// ─── Lock contention ──────────────────────────────────────────────────────────

describe("POST /v1/chat/completions (async) — lock contention", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("409 supplier_busy when supplier is already working", async () => {
    // RED — stub throws (this passes already, but included for completeness)
    const state = new SupplierState();
    const anotherRef = `${"e".repeat(64)}#0`;
    state.tryAcquire(anotherRef);

    const chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    const app = makeApp(chain, state);
    mockOllamaDeferred();

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(409);
    expect(res.body.reason ?? res.body.error).toMatch(/supplier_busy/i);
  });

  it("no job is created when lock is already held", async () => {
    // RED — stub throws
    const state = new SupplierState();
    const anotherRef = `${"e".repeat(64)}#0`;
    state.tryAcquire(anotherRef);
    const jobs = new JobStore();

    const chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    const app = makeApp(chain, state, jobs);
    mockOllamaDeferred();

    await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(jobs.count()).toBe(0);
  });
});

// ─── Claim tx failures ────────────────────────────────────────────────────────

describe("POST /v1/chat/completions (async) — Claim tx failure", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("503 chain_submit_failed when Claim tx submit throws", async () => {
    // RED — stub throws
    const chain = new MockChainProvider();
    let submitCount = 0;
    vi.spyOn(chain, "submitTx").mockImplementation(async (_tx) => {
      submitCount++;
      if (submitCount === 1) throw new Error("chain submit failed");
      return "0".repeat(64);
    });
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    const state = new SupplierState();
    const jobs = new JobStore();
    const app = makeApp(chain, state, jobs);
    mockOllamaDeferred();

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(503);
    expect(res.body.reason ?? res.body.error).toMatch(/chain_submit_failed/i);
  });

  it("lock is released and no job created on Claim tx failure", async () => {
    // RED — stub throws
    const chain = new MockChainProvider();
    vi.spyOn(chain, "submitTx").mockRejectedValueOnce(new Error("chain submit failed"));
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    const state = new SupplierState();
    const jobs = new JobStore();
    const app = makeApp(chain, state, jobs);
    mockOllamaDeferred();

    await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    expect(state.snapshot().status).toBe("free");
    expect(jobs.count()).toBe(0);
  });

  it("504 claim_timeout when Claim awaitTx times out", async () => {
    // RED — stub throws
    // Pin decision: claim awaitTx timeout → 504 claim_timeout
    const chain = new MockChainProvider();
    // submitTx succeeds but awaitTx rejects
    vi.spyOn(chain, "submitTx").mockResolvedValue("0".repeat(64));
    vi.spyOn(chain, "awaitTx").mockRejectedValue(new Error("awaitTx timed out after 30000ms"));
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    const state = new SupplierState();
    const jobs = new JobStore();
    const app = makeApp(chain, state, jobs);
    mockOllamaDeferred();

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(504);
    expect(res.body.reason ?? res.body.error).toMatch(/claim_timeout/i);
  });
});

// ─── Background job completes ─────────────────────────────────────────────────

describe("POST /v1/chat/completions (async) — background job completion", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("after background Ollama+Submit completes, job status is done and lock is free", async () => {
    // RED — stub throws
    // This test uses a fast Ollama mock (resolves immediately) to verify that
    // the background job eventually completes. We await the fire-and-forget
    // indirectly by draining the microtask queue after the POST.
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    const state = new SupplierState();
    const jobs = new JobStore();
    const app = makeApp(chain, state, jobs);

    // Ollama resolves immediately
    mockOllamaOk("The answer is 42.");
    // SPEC FIX 2026-04-28: do NOT mock submitTx — let MockChainProvider's
    // natural spending convention seed the continuing-output UTxO at the
    // computed sha256(cbor) ref so the runner's buildSubmitTx finds the
    // claimed escrow on chain. Awaitable on first poll for the same reason.
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    // queryUtxo for the runner's claimedRef returns the Claimed datum.
    // The actual continuing-output UTxO is seeded by MockChainProvider when
    // chain.submitTx parses the synthetic JSON tx body — but the body's
    // outputs use the Open datum (continuing through Claim transition), so
    // we shadow queryUtxo to return a Claimed datum for any ref the runner
    // looks up that's not the original Open escrow.
    const originalQueryUtxo = chain.queryUtxo.bind(chain);
    vi.spyOn(chain, "queryUtxo").mockImplementation(async (ref) => {
      const real = await originalQueryUtxo(ref);
      if (real) return real;  // pass through seeded UTxOs (open escrow, advert)
      // For unseeded refs (= the runner's claimedRef), return a Claimed UTxO
      return {
        ref,
        address: ESCROW_SCRIPT_ADDRESS,
        lovelace: TOTAL_LOCKED,
        assets: {},
        datumHex: buildClaimedEscrowUtxo().datumHex,
        scriptRef: null,
      };
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    expect(res.status).toBe(202);
    const { job_id: jobId } = res.body;

    // Drain microtask / promise queue so fire-and-forget settles
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const record = jobs.get(jobId);
    expect(record!.status).toBe("done");
    expect(state.snapshot().status).toBe("free");
  });
});
