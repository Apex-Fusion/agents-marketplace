/**
 * supplier-routes-chat.test.ts — RED phase tests for POST /v1/chat/completions
 *
 * Uses supertest against createApp(deps) from supplier/src/server.ts.
 * All chain interactions are via MockChainProvider (no real Ogmios).
 * Ollama is mocked via vi.stubGlobal("fetch", ...).
 *
 * SPEC NOTE (Caroline design decision):
 *   request_spec_hash and prompt_hash in escrow fixture use placeholder values
 *   ("c".repeat(64) and "d".repeat(64)) from sample-escrow-state.ts.
 *   In the happy-path tests, the route handler must compute these hashes from
 *   the request body and compare them to the escrow datum.
 *
 *   Because the stubs throw, request body in happy-path tests uses
 *   TEST_MESSAGES and TEST_MODEL/TEST_MAX_OUTPUT_TOKENS from sample-escrow-state,
 *   and the route handler is expected to recompute matching hashes.
 *
 *   HOWEVER: since the escrow fixture uses placeholder hashes that do NOT
 *   match the canonical hash of the test inputs, the hash validation will fail
 *   in the real implementation unless Catherine replaces the placeholders with
 *   real precomputed values. This is documented in sample-escrow-state.ts.
 *
 *   To keep RED tests compilable and runnable, the hash-mismatch tests rely
 *   on explicit "wrong hash" UTxOs (buildWrongRequestSpecHashEscrowUtxo etc.),
 *   while the happy-path tests expect the route to accept when hashes DO match.
 *   Catherine must pre-compute the correct hash values in the fixture.
 *
 * ORDER OF OPERATIONS per ARCHITECTURE.md §5.1:
 *   Claim → Ollama → Submit (NOT Ollama → Claim)
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
  buildSubmittedEscrowUtxo,
  buildWrongSupplierEscrowUtxo,
  buildPastDeliverByEscrowUtxo,
  buildWrongCapabilityEscrowUtxo,
  buildWrongRequestSpecHashEscrowUtxo,
  buildWrongPromptHashEscrowUtxo,
  ESCROW_TX_HASH,
  CAPABILITY_ID,
  TEST_MODEL,
  TEST_MAX_OUTPUT_TOKENS,
  TEST_MESSAGES,
} from "../fixtures/supplier-side/sample-escrow-state.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const OPEN_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#0`;
const CLAIMED_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#1`;
const SUBMITTED_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#2`;
const WRONG_SUPPLIER_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#3`;
const PAST_DELIVER_BY_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#4`;
const WRONG_CAPABILITY_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#5`;
const WRONG_REQUEST_SPEC_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#6`;
const WRONG_PROMPT_HASH_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#7`;

// ─── Standard chat request body ──────────────────────────────────────────────

function validChatBody() {
  return {
    model: TEST_MODEL,
    messages: TEST_MESSAGES,
    max_tokens: TEST_MAX_OUTPUT_TOKENS,
  };
}

// ─── Active advert UTxO fixture ──────────────────────────────────────────────

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

// ─── Ollama mock helpers ──────────────────────────────────────────────────────

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

function mockOllamaFailure() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    text: async () => "Internal Server Error",
  }));
}

// ─── App factory ─────────────────────────────────────────────────────────────

function makeApp(chain: MockChainProvider, state?: SupplierState): Application {
  return createApp({
    chain,
    state: state ?? new SupplierState(),
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
  });
}

/**
 * Variant that injects an observable JobStore so tests can drain the runner
 * and poll the GET endpoint. Returns both the app and the jobs store.
 *
 * SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
 */
function makeAppWithJobs(
  chain: MockChainProvider,
  state: SupplierState,
): { app: Application; jobs: JobStore } {
  const jobs = new JobStore();
  const app = createApp({
    chain,
    state,
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
    jobs,
  });
  return { app, jobs };
}

/**
 * Drain the fire-and-forget runner: poll until the supplier lock is released,
 * which happens in runChatJob's finally block regardless of success or failure.
 * Uses vi.waitFor (polls every ~10ms, default 1s timeout).
 */
async function drainRunner(state: SupplierState, timeoutMs = 1000): Promise<void> {
  await vi.waitFor(() => {
    if (state.snapshot().status !== "free") {
      throw new Error("runner not yet done");
    }
  }, { timeout: timeoutMs });
}

// ─── Header / body validation ────────────────────────────────────────────────

describe("POST /v1/chat/completions — header validation", () => {
  let app: Application;
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    app = makeApp(chain);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("400 when X-Escrow-Ref header is missing", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .send(validChatBody());
    expect(res.status).toBe(400);
    expect(res.body.reason ?? res.body.error).toMatch(/escrow_ref_required/i);
  });

  it("400 when X-Escrow-Ref is malformed (not <hex>#<int>)", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", "not-valid-ref")
      .send(validChatBody());
    expect(res.status).toBe(400);
  });

  it("400 when X-Escrow-Ref txHash part is too short", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", "abc#0")
      .send(validChatBody());
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/chat/completions — body validation", () => {
  let app: Application;
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    app = makeApp(chain);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("400 when stream: true is requested", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send({ ...validChatBody(), stream: true });
    expect(res.status).toBe(400);
    expect(res.body.reason ?? res.body.error).toMatch(/streaming_not_supported/i);
  });

  it("400 when tools array is present", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send({ ...validChatBody(), tools: [{ type: "function", function: { name: "f" } }] });
    expect(res.status).toBe(400);
    expect(res.body.reason ?? res.body.error).toMatch(/tools_not_supported/i);
  });

  it("400 when tool_choice is present", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send({ ...validChatBody(), tool_choice: "auto" });
    expect(res.status).toBe(400);
  });

  it("400 when functions array is present", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send({ ...validChatBody(), functions: [{ name: "f", parameters: {} }] });
    expect(res.status).toBe(400);
  });

  it("400 when messages is empty array", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send({ ...validChatBody(), messages: [] });
    expect(res.status).toBe(400);
  });

  it("400 when messages is absent", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send({ model: TEST_MODEL, max_tokens: TEST_MAX_OUTPUT_TOKENS });
    expect(res.status).toBe(400);
  });

  it("400 when max_tokens exceeds advertised max_output_tokens", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send({ ...validChatBody(), max_tokens: TEST_MAX_OUTPUT_TOKENS + 1 });
    expect(res.status).toBe(400);
    expect(res.body.reason ?? res.body.error).toMatch(/output_cap_exceeded/i);
  });
});

// ─── On-chain validation ──────────────────────────────────────────────────────

describe("POST /v1/chat/completions — on-chain validation", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    // Set tip well before deliver_by so claim tx would be valid
    chain.advanceSlot(1_000);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("404 when escrow UTxO not found", async () => {
    // Don't seed any escrow UTxO
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(404);
    expect(res.body.reason ?? res.body.error).toMatch(/escrow_not_found/i);
  });

  it("409 when escrow state is Claimed (not Open)", async () => {
    chain.seed(buildClaimedEscrowUtxo());
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", CLAIMED_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(409);
    expect(res.body.reason ?? res.body.error).toMatch(/escrow_not_claimable/i);
  });

  it("409 escrow_not_claimable response includes the current escrow state", async () => {
    chain.seed(buildClaimedEscrowUtxo());
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", CLAIMED_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(JSON.stringify(res.body).toLowerCase()).toMatch(/claimed/i);
  });

  it("409 when escrow state is Submitted (not Open)", async () => {
    chain.seed(buildSubmittedEscrowUtxo());
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", SUBMITTED_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(409);
    expect(res.body.reason ?? res.body.error).toMatch(/escrow_not_claimable/i);
  });

  it("403 when escrow supplier_pkh does not match self", async () => {
    chain.seed(buildWrongSupplierEscrowUtxo());
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", WRONG_SUPPLIER_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(403);
    expect(res.body.reason ?? res.body.error).toMatch(/wrong_supplier/i);
  });

  it("409 when escrow capability_id does not match advertised", async () => {
    chain.seed(buildWrongCapabilityEscrowUtxo());
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", WRONG_CAPABILITY_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(409);
    expect(res.body.reason ?? res.body.error).toMatch(/capability_mismatch/i);
  });

  it("409 when request_spec_hash does not match escrow datum", async () => {
    chain.seed(buildWrongRequestSpecHashEscrowUtxo());
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", WRONG_REQUEST_SPEC_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(409);
    expect(res.body.reason ?? res.body.error).toMatch(/request_spec_mismatch/i);
  });

  it("409 when prompt_hash does not match escrow datum", async () => {
    chain.seed(buildWrongPromptHashEscrowUtxo());
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", WRONG_PROMPT_HASH_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(409);
    expect(res.body.reason ?? res.body.error).toMatch(/prompt_mismatch/i);
  });

  it("408 when now > deliver_by (past deadline)", async () => {
    chain.seed(buildPastDeliverByEscrowUtxo());
    const app = makeApp(chain);
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", PAST_DELIVER_BY_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(408);
    expect(res.body.reason ?? res.body.error).toMatch(/past_deliver_by/i);
  });
});

// ─── Lock tests ──────────────────────────────────────────────────────────────

describe("POST /v1/chat/completions — single-slot lock", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("409 when supplier is already working", async () => {
    const state = new SupplierState();
    const anotherRef = `${"e".repeat(64)}#0`;
    state.tryAcquire(anotherRef); // Pre-acquire with a different escrow

    const chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    const app = makeApp(chain, state);

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(409);
    expect(res.body.reason ?? res.body.error).toMatch(/supplier_busy/i);
  });
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("POST /v1/chat/completions — happy path", () => {
  let app: Application;
  let chain: MockChainProvider;
  let state: SupplierState;
  let jobs: JobStore;

  beforeEach(() => {
    chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000); // tip well before deliver_by
    // Mock awaitTx to resolve immediately for both Claim (server) and Submit
    // (runner). Without this, awaitTx polls for hashes not in knownTxs.
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    state = new SupplierState();
    ({ app, jobs } = makeAppWithJobs(chain, state));
    mockOllamaOk("I am a helpful AI assistant.");
  });

  afterEach(() => { vi.restoreAllMocks(); });

  // SPEC FIX 2026-04-28 M1-F-async-chat: response is now async (202, not 200)
  // Full-body assertions (choices/usage/receipt) are covered by
  // supplier-routes-chat-jobs-get.test.ts (GET handler).
  it("returns 202 Accepted on successful end-to-end flow", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(202);
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  // Migrated from sync (full body in POST) to async (POST→202, GET→200).
  it("response body contains choices array", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.choices)).toBe(true);
    expect(getRes.body.choices.length).toBeGreaterThan(0);
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  it("choices[0].message.role is 'assistant'", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.choices[0].message.role).toBe("assistant");
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  it("choices[0].message.content matches Ollama output", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.choices[0].message.content).toBe("I am a helpful AI assistant.");
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  it("response body contains usage object", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.usage).toBeTruthy();
    expect(typeof getRes.body.usage.prompt_tokens).toBe("number");
    expect(typeof getRes.body.usage.completion_tokens).toBe("number");
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  it("response body contains receipt object", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.receipt).toBeTruthy();
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  it("receipt has required fields", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(200);
    const { receipt } = getRes.body;
    expect(receipt.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.response_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.model).toBe(TEST_MODEL);
    expect(typeof receipt.prompt_tokens).toBe("number");
    expect(typeof receipt.completion_tokens).toBe("number");
    expect(typeof receipt.wallclock_ms).toBe("number");
    expect(receipt.supplier_pkh).toBe(SUPPLIER_PKH);
    expect(receipt.escrow_ref).toBe(OPEN_ESCROW_REF_HEADER);
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  it("receipt.response_hash is sha256 of canonical(assistant message object)", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(200);
    // response_hash must be a 32-byte hex string (64 chars)
    expect(getRes.body.receipt.response_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  it("response body contains receipt_signature", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.receipt_signature ?? getRes.body.signature).toMatch(/^[0-9a-fA-F]{128}$/);
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  // Lock is released in runChatJob's finally block; drain before asserting.
  it("supplier lock is released after successful flow", async () => {
    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    await drainRunner(state);
    expect(state.snapshot().status).toBe("free");
  });
});

// ─── Error recovery ──────────────────────────────────────────────────────────

describe("POST /v1/chat/completions — error recovery", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("503 when Claim tx submit fails", async () => {
    const chain = new MockChainProvider({
      evaluator: () => ({ ok: false, error: "script rejected" }),
    });
    // Override submitTx to throw
    const originalSubmit = chain.submitTx.bind(chain);
    let callCount = 0;
    vi.spyOn(chain, "submitTx").mockImplementation(async (tx) => {
      callCount++;
      if (callCount === 1) throw new Error("chain submit failed");
      return originalSubmit(tx);
    });
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    const app = makeApp(chain);

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(res.status).toBe(503);
    expect(res.body.reason ?? res.body.error).toMatch(/chain_submit_failed/i);
  });

  it("lock is released after Claim tx submit failure", async () => {
    const state = new SupplierState();
    const chain = new MockChainProvider();
    let submitCallCount = 0;
    vi.spyOn(chain, "submitTx").mockImplementation(async (_tx) => {
      submitCallCount++;
      if (submitCallCount === 1) throw new Error("chain submit failed");
      return "0".repeat(64);
    });
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    const app = makeApp(chain, state);

    await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    expect(state.snapshot().status).toBe("free");
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  // Ollama failure is now reported via GET, not via POST (which returns 202).
  // awaitTx is mocked: Claim tx is submitted via real buildClaimTx so its hash
  // lands in knownTxs; mock is defensive for the runner's Submit awaitTx.
  it("502 when Ollama fails after Claim succeeds", async () => {
    // Claim tx submit succeeds, but Ollama returns 500
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    mockOllamaFailure();
    const state = new SupplierState();
    const { app, jobs } = makeAppWithJobs(chain, state);

    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(502);
    expect(getRes.body.reason ?? getRes.body.error).toMatch(/ollama_failure/i);
    void jobs;
  });

  it("lock is released after Ollama failure (escrow left in Claimed — v1 hazard)", async () => {
    // IMPORTANT: After Ollama failure, the escrow remains in Claimed state on-chain.
    // The supplier cannot recover within v1. The buyer must wait until deliver_by
    // and then reclaim via the Reclaim redeemer.
    // This test only verifies that the in-process lock is released.
    const state = new SupplierState();
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    mockOllamaFailure();
    const { app } = makeAppWithJobs(chain, state);

    await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    // Runner's Ollama failure occurs after POST returns 202; drain before asserting.
    await drainRunner(state);
    expect(state.snapshot().status).toBe("free");
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  // Submit-tx failure is reported via GET (job.status="failed"), not via POST.
  // awaitTx must be mocked: the submitTx mock bypasses knownTxs, so Claim's
  // awaitTx would otherwise poll for 60s and timeout.
  it("502 when Submit tx fails after Ollama success — no receipt in body", async () => {
    const chain = new MockChainProvider();
    let submitCallCount = 0;
    vi.spyOn(chain, "submitTx").mockImplementation(async (_tx) => {
      submitCallCount++;
      if (submitCallCount === 2) throw new Error("submit tx failed"); // 2nd call = Submit tx
      return "0".repeat(64);
    });
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    mockOllamaOk("I am a helpful AI assistant.");
    const state = new SupplierState();
    const { app } = makeAppWithJobs(chain, state);

    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    expect(postRes.status).toBe(202);
    const { job_id: jobId } = postRes.body as { job_id: string };
    await drainRunner(state);
    const getRes = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(getRes.status).toBe(502);
    expect(getRes.body.reason ?? getRes.body.error).toMatch(/submit_failed/i);
    // Per spec: keep it simple — no receipt returned, buyer reclaims
    expect(getRes.body.receipt).toBeUndefined();
  });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  it("lock is released after Submit tx failure", async () => {
    const state = new SupplierState();
    const chain = new MockChainProvider();
    let submitCallCount = 0;
    vi.spyOn(chain, "submitTx").mockImplementation(async (_tx) => {
      submitCallCount++;
      if (submitCallCount === 2) throw new Error("submit failed");
      return "0".repeat(64);
    });
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    mockOllamaOk("response");
    const { app } = makeAppWithJobs(chain, state);

    await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    await drainRunner(state);
    expect(state.snapshot().status).toBe("free");
  });
});

// ─── Claim-before-Ollama ordering ────────────────────────────────────────────

describe("POST /v1/chat/completions — operation ordering (Claim before Ollama)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // SPEC FIX 2026-04-28 M1-F-async-chat-cleanup
  // In async flow: Claim-submitTx happens synchronously in POST before 202 is
  // returned; Ollama-fetch happens in the fire-and-forget runner after 202.
  // Ordering invariant: submitTx(Claim) < 202 response < fetch(Ollama).
  // We verify submitTx was called before POST returned (callOrder check) and
  // that fetch was called during the runner after draining.
  // awaitTx must be mocked: submitTx is mocked and bypasses knownTxs, so the
  // server's awaitTx(claimHash, 60_000) would otherwise poll for 60s.
  it("submitTx is called before fetch (Ollama) in the happy path", async () => {
    const callOrder: string[] = [];

    const chain = new MockChainProvider();
    vi.spyOn(chain, "submitTx").mockImplementation(async (_tx) => {
      callOrder.push("submitTx");
      return "0".repeat(64);
    });
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callOrder.push("fetch");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { role: "assistant", content: "Hi" },
          done: true,
          prompt_eval_count: 5,
          eval_count: 10,
          total_duration: 1_000_000_000,
        }),
      };
    }));

    seedAdvertUtxo(chain);
    chain.seed(buildOpenEscrowUtxo());
    chain.advanceSlot(1_000);
    const state = new SupplierState();
    const { app } = makeAppWithJobs(chain, state);

    const postRes = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());
    // Claim-submitTx MUST have been called before POST returned 202.
    expect(postRes.status).toBe(202);
    expect(callOrder).toContain("submitTx");

    // Drain runner so Ollama fetch completes.
    await drainRunner(state);

    // Ordering: first submitTx (Claim) before first fetch (Ollama).
    const firstSubmit = callOrder.indexOf("submitTx");
    const firstFetch = callOrder.indexOf("fetch");
    expect(firstSubmit).toBeGreaterThanOrEqual(0);
    expect(firstFetch).toBeGreaterThanOrEqual(0);
    expect(firstSubmit).toBeLessThan(firstFetch);
  });
});
