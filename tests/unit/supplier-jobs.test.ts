/**
 * supplier-jobs.test.ts — tests for JobStore (supplier/src/jobs.ts)
 *
 * Tests the in-memory JobStore lifecycle:
 *   create → setRunning → complete / fail → evictExpired
 *
 * Design pins:
 *   - complete on a terminal job is a no-op: the first payload stays.
 *   - evictExpired uses a strict ">": a terminal job is kept at exactly JOB_TTL_MS.
 *   - evictExpired never removes a running or an accepted job.
 *
 * The evict cases also show that complete and fail set terminalAtMs, and that
 * setRunning does not: a job that lacked terminalAtMs would never be removed,
 * and a running job that had one would be removed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JobStore, JOB_TTL_MS } from "../../supplier/src/jobs.js";
import type { ChatJobResponsePayload, JobResponsePayload } from "../../supplier/src/jobs.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const SAMPLE_ESCROW_REF = `${"f".repeat(64)}#0`;

function samplePayload(): ChatJobResponsePayload {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1_745_500_000,
    model: "qwen2.5:0.5b",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello there!", annotations: [] }],
    }],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    },
    error: null,
    incomplete_details: null,
    receipt: {
      prompt_hash: "a".repeat(64),
      response_hash: "b".repeat(64),
      model: "qwen2.5:0.5b",
      prompt_tokens: 10,
      completion_tokens: 20,
      wallclock_ms: 3200,
      supplier_pkh: "c".repeat(56),
      escrow_ref: SAMPLE_ESCROW_REF,
    },
    receipt_signature: "d".repeat(128),
    submitted_ref: `${"9".repeat(64)}#0`,
  };
}

// ─── create / get ─────────────────────────────────────────────────────────────

describe("JobStore — create and get", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("get returns the record with status=accepted after create", () => {
    const jobId = store.create(SAMPLE_ESCROW_REF);
    const record = store.get(jobId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("accepted");
    expect(record!.jobId).toBe(jobId);
    expect(record!.escrowRef).toBe(SAMPLE_ESCROW_REF);
    expect(typeof record!.createdAtMs).toBe("number");
  });

  it("get returns null for an unknown jobId", () => {
    const result = store.get("00000000-0000-4000-8000-000000000000");
    expect(result).toBeNull();
  });
});

// ─── setRunning ───────────────────────────────────────────────────────────────

describe("JobStore — setRunning", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("setRunning transitions job from accepted to running", () => {
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    const record = store.get(jobId);
    expect(record!.status).toBe("running");
  });
});

// ─── complete ─────────────────────────────────────────────────────────────────

describe("JobStore — complete", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("complete transitions job to done and populates responsePayload", () => {
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    const payload = samplePayload();
    store.complete(jobId, payload);
    const record = store.get(jobId);
    expect(record!.status).toBe("done");
    expect(record!.responsePayload).toEqual(payload);
  });

  it("complete on an already-terminal job does not overwrite status", () => {
    // Pin decision: complete on a terminal job is a no-op (status stays done)
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    const payload1 = samplePayload();
    store.complete(jobId, payload1);
    // Second complete with different payload — must not overwrite
    const payload2: JobResponsePayload = {
      ...payload1,
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "second", annotations: [] }],
      }],
    };
    store.complete(jobId, payload2);
    const record = store.get(jobId);
    expect(record!.status).toBe("done");
    const first = record!.responsePayload!;
    expect("output" in first && first.output[0]).toEqual(payload1.output[0]);
  });
});

// ─── fail ─────────────────────────────────────────────────────────────────────

describe("JobStore — fail", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("fail transitions job to failed and populates failure", () => {
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.fail(jobId, { httpStatus: 502, reason: "ollama_failure", message: "ollama down" });
    const record = store.get(jobId);
    expect(record!.status).toBe("failed");
    expect(record!.failure!.httpStatus).toBe(502);
    expect(record!.failure!.reason).toBe("ollama_failure");
    expect(record!.failure!.message).toBe("ollama down");
  });
});

// ─── complete / fail on an unknown job ──────────────────────────────────────

describe("JobStore — an unknown job", () => {
  it("complete and fail on an unknown jobId create no record", () => {
    const store = new JobStore();
    const unknown = "00000000-0000-4000-8000-000000000000";

    store.complete(unknown, samplePayload());
    store.fail(unknown, { httpStatus: 502, reason: "ollama_failure", message: "down" });

    expect(store.get(unknown)).toBeNull();
  });
});

// ─── evictExpired ─────────────────────────────────────────────────────────────

describe("JobStore — evictExpired", () => {
  let store: JobStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    store = new JobStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evictExpired removes a done job older than JOB_TTL_MS", () => {
    vi.setSystemTime(1_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.complete(jobId, samplePayload());
    // Advance well past TTL
    store.evictExpired(1_000 + JOB_TTL_MS + 1);
    expect(store.get(jobId)).toBeNull();
  });

  it("evictExpired removes a failed job older than JOB_TTL_MS", () => {
    vi.setSystemTime(2_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.fail(jobId, { httpStatus: 502, reason: "ollama_failure", message: "down" });
    store.evictExpired(2_000 + JOB_TTL_MS + 1);
    expect(store.get(jobId)).toBeNull();
  });

  it("evictExpired keeps a done job younger than JOB_TTL_MS", () => {
    vi.setSystemTime(3_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.complete(jobId, samplePayload());
    // Evict at exactly TTL — not yet expired (strictly >)
    store.evictExpired(3_000 + JOB_TTL_MS);
    expect(store.get(jobId)).not.toBeNull();
  });

  it("evictExpired never removes a running job regardless of age", () => {
    vi.setSystemTime(4_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    // Evict with a very large now — running jobs have no terminalAtMs, must stay
    store.evictExpired(4_000 + JOB_TTL_MS * 100);
    const record = store.get(jobId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("running");
  });

  it("evictExpired never removes an accepted job regardless of age", () => {
    vi.setSystemTime(5_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.evictExpired(5_000 + JOB_TTL_MS * 100);
    const record = store.get(jobId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("accepted");
  });
});
