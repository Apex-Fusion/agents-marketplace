/**
 * supplier-routes-chat-jobs-get.test.ts — RED phase tests for GET /v1/chat/completions/:jobId
 *
 * M1-F-async-chat RED phase — Caroline, 2026-04-28
 *
 * Verifies the GET handler returns the correct status/body for each job lifecycle state:
 *   - 404 job_not_found      — jobId not in store (unknown or evicted)
 *   - 202 {status:"accepted"} — job was created but not yet running
 *   - 202 {status:"running"}  — background work in progress
 *   - 200 full payload        — job completed (choices/usage/receipt/receipt_signature/escrow_ref)
 *   - 4xx/5xx failure body    — job failed, uses recorded httpStatus
 *
 * The GET route is: GET /v1/chat/completions/:jobId
 *
 * SPEC FIX 2026-04-28 M1-F-async-chat: GET endpoint is new, no prior tests exist.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore, JOB_TTL_MS } from "../../supplier/src/jobs.js";
import type { JobResponsePayload } from "../../supplier/src/jobs.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig, SAMPLE_ADVERT_TX_HASH, SAMPLE_ADVERT_INDEX } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey, SUPPLIER_PKH } from "../fixtures/supplier-side/wallet-keys.js";
import {
  ESCROW_TX_HASH,
  CAPABILITY_ID,
  TEST_MODEL,
  TEST_MAX_OUTPUT_TOKENS,
  PROMPT_HASH,
} from "../fixtures/supplier-side/sample-escrow-state.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ESCROW_REF_STR = `${ESCROW_TX_HASH}#0`;
const NONEXISTENT_JOB_ID = "00000000-0000-4000-8000-000000000000";
const MALFORMED_JOB_ID = "abc";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

function sampleResponsePayload(): JobResponsePayload {
  return {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "The answer is 42." },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 48,
      total_tokens: 60,
    },
    receipt: {
      prompt_hash: PROMPT_HASH,
      response_hash: "b".repeat(64),
      model: TEST_MODEL,
      prompt_tokens: 12,
      completion_tokens: 48,
      wallclock_ms: 3200,
      supplier_pkh: SUPPLIER_PKH,
      escrow_ref: ESCROW_REF_STR,
    },
    receipt_signature: "d".repeat(128),
  };
}

function makeApp(chain: MockChainProvider, state?: SupplierState, jobs?: JobStore): Application {
  const c = new MockChainProvider();
  c.seed({
    ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
    address: "addr_test1wfakeadvertaddress",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(buildActiveAdvertDatum()),
    scriptRef: null,
  });
  return createApp({
    chain: chain ?? c,
    state: state ?? new SupplierState(),
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
    jobs: jobs ?? new JobStore(),
  });
}

// ─── 404 — not found ──────────────────────────────────────────────────────────

describe("GET /v1/chat/completions/:jobId — not found", () => {
  let app: Application;
  let jobs: JobStore;

  beforeEach(() => {
    jobs = new JobStore();
    app = makeApp(new MockChainProvider(), undefined, jobs);
  });

  it("404 with reason=job_not_found for unknown jobId", async () => {
    // RED — GET route does not exist yet
    const res = await request(app).get(`/v1/chat/completions/${NONEXISTENT_JOB_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.reason ?? res.body.error).toMatch(/job_not_found/i);
  });

  it("404 after job is evicted past TTL", async () => {
    // RED — GET route does not exist yet
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.complete(jobId, sampleResponsePayload());

    // Evict the job
    jobs.evictExpired(1_000 + JOB_TTL_MS + 1);

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.status).toBe(404);
    expect(res.body.reason ?? res.body.error).toMatch(/job_not_found/i);

    vi.useRealTimers();
  });

  it("400 with reason=invalid_job_id for malformed jobId (not UUIDv4)", async () => {
    // RED — GET route does not exist yet
    const res = await request(app).get(`/v1/chat/completions/${MALFORMED_JOB_ID}`);
    expect(res.status).toBe(400);
    expect(res.body.reason ?? res.body.error).toMatch(/invalid_job_id/i);
  });
});

// ─── 202 — accepted ───────────────────────────────────────────────────────────

describe("GET /v1/chat/completions/:jobId — status=accepted", () => {
  let app: Application;
  let jobs: JobStore;

  beforeEach(() => {
    jobs = new JobStore();
    app = makeApp(new MockChainProvider(), undefined, jobs);
  });

  it("202 with {status: 'accepted', escrow_ref} for a freshly created job", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("accepted");
    expect(res.body.escrow_ref).toBe(ESCROW_REF_STR);
  });

  it("Content-Type is application/json for 202 accepted response", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.headers["content-type"]).toMatch(/application\/json/i);
  });
});

// ─── 202 — running ────────────────────────────────────────────────────────────

describe("GET /v1/chat/completions/:jobId — status=running", () => {
  let app: Application;
  let jobs: JobStore;

  beforeEach(() => {
    jobs = new JobStore();
    app = makeApp(new MockChainProvider(), undefined, jobs);
  });

  it("202 with {status: 'running', escrow_ref} for a running job", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("running");
    expect(res.body.escrow_ref).toBe(ESCROW_REF_STR);
  });
});

// ─── 200 — done ───────────────────────────────────────────────────────────────

describe("GET /v1/chat/completions/:jobId — status=done", () => {
  let app: Application;
  let jobs: JobStore;

  beforeEach(() => {
    jobs = new JobStore();
    app = makeApp(new MockChainProvider(), undefined, jobs);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("200 with full payload for a completed job", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.complete(jobId, sampleResponsePayload());

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.status).toBe(200);
  });

  it("200 body contains choices[0].message.content", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.complete(jobId, sampleResponsePayload());

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.body.choices[0].message.content).toBe("The answer is 42.");
    expect(res.body.choices[0].message.role).toBe("assistant");
  });

  it("200 body contains usage with prompt_tokens, completion_tokens, total_tokens", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.complete(jobId, sampleResponsePayload());

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(typeof res.body.usage.prompt_tokens).toBe("number");
    expect(typeof res.body.usage.completion_tokens).toBe("number");
    expect(typeof res.body.usage.total_tokens).toBe("number");
  });

  it("200 body contains receipt with 8 fields", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.complete(jobId, sampleResponsePayload());

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    const { receipt } = res.body;
    expect(receipt).toBeTruthy();
    expect(receipt.prompt_hash).toBe(PROMPT_HASH);
    expect(receipt.response_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.model).toBe(TEST_MODEL);
    expect(typeof receipt.prompt_tokens).toBe("number");
    expect(typeof receipt.completion_tokens).toBe("number");
    expect(typeof receipt.wallclock_ms).toBe("number");
    expect(receipt.supplier_pkh).toBe(SUPPLIER_PKH);
    expect(receipt.escrow_ref).toBe(ESCROW_REF_STR);
  });

  it("200 body contains receipt_signature (128-char hex)", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.complete(jobId, sampleResponsePayload());

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.body.receipt_signature).toMatch(/^[0-9a-f]{128}$/i);
  });

  it("200 body contains escrow_ref", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.complete(jobId, sampleResponsePayload());

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.body.escrow_ref).toBe(ESCROW_REF_STR);
  });

  it("Content-Type is application/json for 200 done response", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.complete(jobId, sampleResponsePayload());

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.headers["content-type"]).toMatch(/application\/json/i);
  });
});

// ─── failed job ───────────────────────────────────────────────────────────────

describe("GET /v1/chat/completions/:jobId — status=failed", () => {
  let app: Application;
  let jobs: JobStore;

  beforeEach(() => {
    jobs = new JobStore();
    app = makeApp(new MockChainProvider(), undefined, jobs);
  });

  it("uses recorded failure.httpStatus (502) for a failed job", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.fail(jobId, { httpStatus: 502, reason: "ollama_failure", message: "Ollama is down" });

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.status).toBe(502);
  });

  it("failed job body contains status=failed, reason, message, escrow_ref", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.fail(jobId, { httpStatus: 502, reason: "submit_failed", message: "tx rejected" });

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.body.status).toBe("failed");
    expect(res.body.reason).toBe("submit_failed");
    expect(res.body.message).toBe("tx rejected");
    expect(res.body.escrow_ref).toBe(ESCROW_REF_STR);
  });

  it("failed job with httpStatus=503 returns 503", async () => {
    // RED — GET route does not exist yet
    const jobId = jobs.create(ESCROW_REF_STR);
    jobs.setRunning(jobId);
    jobs.fail(jobId, { httpStatus: 503, reason: "chain_submit_failed", message: "chain down" });

    const res = await request(app).get(`/v1/chat/completions/${jobId}`);
    expect(res.status).toBe(503);
  });
});
