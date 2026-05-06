/**
 * supplier-jobs.test.ts — RED phase tests for JobStore (supplier/src/jobs.ts)
 *
 * M1-F-async-chat RED phase — Caroline, 2026-04-28
 *
 * Tests the in-memory JobStore lifecycle:
 *   create → setRunning → complete / fail → evictExpired
 *
 * All tests are RED until Catherine implements JobStore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JobStore, JOB_TTL_MS } from "../../supplier/src/jobs.js";
import type { JobResponsePayload } from "../../supplier/src/jobs.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const SAMPLE_ESCROW_REF = `${"f".repeat(64)}#0`;
const OTHER_ESCROW_REF  = `${"e".repeat(64)}#1`;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function samplePayload(): JobResponsePayload {
  return {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello there!" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
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
  };
}

// ─── create / get ─────────────────────────────────────────────────────────────

describe("JobStore — create and get", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("create returns a 36-char UUIDv4 string", () => {
    // RED — throws "not implemented"
    const jobId = store.create(SAMPLE_ESCROW_REF);
    expect(typeof jobId).toBe("string");
    expect(jobId).toHaveLength(36);
    expect(UUID_V4_RE.test(jobId)).toBe(true);
  });

  it("get returns the record with status=accepted after create", () => {
    // RED — throws "not implemented"
    const jobId = store.create(SAMPLE_ESCROW_REF);
    const record = store.get(jobId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("accepted");
    expect(record!.jobId).toBe(jobId);
    expect(record!.escrowRef).toBe(SAMPLE_ESCROW_REF);
    expect(typeof record!.createdAtMs).toBe("number");
  });

  it("get returns null for an unknown jobId", () => {
    // RED — throws "not implemented"
    const result = store.get("00000000-0000-4000-8000-000000000000");
    expect(result).toBeNull();
  });

  it("two parallel create calls produce two distinct UUIDv4 jobIds", () => {
    // RED — throws "not implemented"
    const id1 = store.create(SAMPLE_ESCROW_REF);
    const id2 = store.create(OTHER_ESCROW_REF);
    expect(id1).not.toBe(id2);
    expect(UUID_V4_RE.test(id1)).toBe(true);
    expect(UUID_V4_RE.test(id2)).toBe(true);
  });
});

// ─── setRunning ───────────────────────────────────────────────────────────────

describe("JobStore — setRunning", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("setRunning transitions job from accepted to running", () => {
    // RED — throws "not implemented"
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    const record = store.get(jobId);
    expect(record!.status).toBe("running");
  });

  it("setRunning does not set terminalAtMs", () => {
    // RED — throws "not implemented"
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    const record = store.get(jobId);
    expect(record!.terminalAtMs).toBeUndefined();
  });
});

// ─── complete ─────────────────────────────────────────────────────────────────

describe("JobStore — complete", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("complete transitions job to done and populates responsePayload", () => {
    // RED — throws "not implemented"
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    const payload = samplePayload();
    store.complete(jobId, payload);
    const record = store.get(jobId);
    expect(record!.status).toBe("done");
    expect(record!.responsePayload).toEqual(payload);
  });

  it("complete sets terminalAtMs", () => {
    // RED — throws "not implemented"
    const now = Date.now();
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.complete(jobId, samplePayload());
    const record = store.get(jobId);
    expect(typeof record!.terminalAtMs).toBe("number");
    expect(record!.terminalAtMs).toBeGreaterThanOrEqual(now);
  });

  it("complete on an already-terminal job does not overwrite status", () => {
    // RED — throws "not implemented"
    // Pin decision: complete on a terminal job is a no-op (status stays done)
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    const payload1 = samplePayload();
    store.complete(jobId, payload1);
    // Second complete with different payload — must not overwrite
    const payload2: JobResponsePayload = {
      ...payload1,
      choices: [
        { index: 0, message: { role: "assistant", content: "second" }, finish_reason: "stop" },
      ],
    };
    store.complete(jobId, payload2);
    const record = store.get(jobId);
    // Status still done, and first payload is preserved
    expect(record!.status).toBe("done");
    expect(record!.responsePayload!.choices[0].message.content).toBe("Hello there!");
  });

  it("complete on unknown jobId does not throw", () => {
    // RED — throws "not implemented"
    // Pin decision: no-op / silent — unknown jobId is not an error at runtime
    expect(() =>
      store.complete("00000000-0000-4000-8000-000000000000", samplePayload()),
    ).not.toThrow();
  });
});

// ─── fail ─────────────────────────────────────────────────────────────────────

describe("JobStore — fail", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("fail transitions job to failed and populates failure", () => {
    // RED — throws "not implemented"
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.fail(jobId, { httpStatus: 502, reason: "ollama_failure", message: "ollama down" });
    const record = store.get(jobId);
    expect(record!.status).toBe("failed");
    expect(record!.failure!.httpStatus).toBe(502);
    expect(record!.failure!.reason).toBe("ollama_failure");
    expect(record!.failure!.message).toBe("ollama down");
  });

  it("fail sets terminalAtMs", () => {
    // RED — throws "not implemented"
    const now = Date.now();
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.fail(jobId, { httpStatus: 502, reason: "submit_failed", message: "tx failed" });
    const record = store.get(jobId);
    expect(typeof record!.terminalAtMs).toBe("number");
    expect(record!.terminalAtMs).toBeGreaterThanOrEqual(now);
  });
});

// ─── count ────────────────────────────────────────────────────────────────────

describe("JobStore — count", () => {
  let store: JobStore;

  beforeEach(() => { store = new JobStore(); });

  it("count returns 0 on empty store", () => {
    // RED — throws "not implemented"
    expect(store.count()).toBe(0);
  });

  it("count increments after each create", () => {
    // RED — throws "not implemented"
    store.create(SAMPLE_ESCROW_REF);
    expect(store.count()).toBe(1);
    store.create(OTHER_ESCROW_REF);
    expect(store.count()).toBe(2);
  });

  it("count decrements after evictExpired removes a terminal job", () => {
    // RED — throws "not implemented"
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.complete(jobId, samplePayload());
    expect(store.count()).toBe(1);
    // Advance past TTL
    store.evictExpired(1_000_000 + JOB_TTL_MS + 1);
    expect(store.count()).toBe(0);
    vi.useRealTimers();
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
    // RED — throws "not implemented"
    vi.setSystemTime(1_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.complete(jobId, samplePayload());
    // Advance well past TTL
    store.evictExpired(1_000 + JOB_TTL_MS + 1);
    expect(store.get(jobId)).toBeNull();
  });

  it("evictExpired removes a failed job older than JOB_TTL_MS", () => {
    // RED — throws "not implemented"
    vi.setSystemTime(2_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.fail(jobId, { httpStatus: 502, reason: "ollama_failure", message: "down" });
    store.evictExpired(2_000 + JOB_TTL_MS + 1);
    expect(store.get(jobId)).toBeNull();
  });

  it("evictExpired keeps a done job younger than JOB_TTL_MS", () => {
    // RED — throws "not implemented"
    vi.setSystemTime(3_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.setRunning(jobId);
    store.complete(jobId, samplePayload());
    // Evict at exactly TTL — not yet expired (strictly >)
    store.evictExpired(3_000 + JOB_TTL_MS);
    expect(store.get(jobId)).not.toBeNull();
  });

  it("evictExpired never removes a running job regardless of age", () => {
    // RED — throws "not implemented"
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
    // RED — throws "not implemented"
    vi.setSystemTime(5_000);
    const jobId = store.create(SAMPLE_ESCROW_REF);
    store.evictExpired(5_000 + JOB_TTL_MS * 100);
    const record = store.get(jobId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("accepted");
  });
});
