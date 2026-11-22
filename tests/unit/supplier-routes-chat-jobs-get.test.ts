/**
 * supplier-routes-chat-jobs-get.test.ts — GET /v1/responses/:jobId
 *
 * M1-F-async-chat (2026-04-28).
 *
 * The route shows each state of a job in the JobStore:
 *   - 400 invalid_job_id      — the id is not a UUIDv4
 *   - 404 job_not_found       — the id is not in the store (unknown or evicted)
 *   - 202 {status, escrow_ref} — the job is accepted or running
 *   - 200 the stored payload, with the escrow_ref — the job is done
 *   - the recorded httpStatus, with {status: "failed", reason, message, escrow_ref} — the job failed
 */

import { describe, expect, it } from "vitest";
import request from "supertest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { JobResponsePayload } from "../../supplier/src/jobs.js";
import { makeApp } from "../fixtures/supplier-side/chat-harness.js";
import { ESCROW_TX_HASH, PROMPT_HASH, TEST_MODEL } from "../fixtures/supplier-side/sample-escrow-state.js";
import { SUPPLIER_PKH } from "../fixtures/supplier-side/wallet-keys.js";

const ESCROW_REF = `${ESCROW_TX_HASH}#0`;

const RESPONSE_PAYLOAD: JobResponsePayload = {
  id: "resp_test",
  object: "response",
  created_at: 1_745_500_000,
  model: TEST_MODEL,
  status: "completed",
  output: [{
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "The answer is 42.", annotations: [] }],
  }],
  usage: { input_tokens: 12, output_tokens: 48, total_tokens: 60 },
  error: null,
  incomplete_details: null,
  receipt: {
    prompt_hash: PROMPT_HASH,
    response_hash: "b".repeat(64),
    model: TEST_MODEL,
    prompt_tokens: 12,
    completion_tokens: 48,
    wallclock_ms: 3200,
    supplier_pkh: SUPPLIER_PKH,
    escrow_ref: ESCROW_REF,
  },
  receipt_signature: "d".repeat(128),
  submitted_ref: `${"9".repeat(64)}#0`,
};

/** The app over an empty chain: the job route reads only the JobStore. */
const setup = () => makeApp(new MockChainProvider());

describe("GET /v1/responses/:jobId", () => {
  it.each([
    { name: "an unknown id", jobId: "00000000-0000-4000-8000-000000000000", status: 404, reason: "job_not_found" },
    { name: "an id that is not a UUIDv4", jobId: "abc", status: 400, reason: "invalid_job_id" },
  ])("$status $reason for $name", async ({ jobId, status, reason }) => {
    const { app } = setup();

    const res = await request(app).get(`/v1/responses/${jobId}`);

    expect(res.status).toBe(status);
    expect(res.body.reason).toBe(reason);
  });

  it.each(["accepted", "running"] as const)("202 with the status and the escrow_ref for a %s job", async (status) => {
    const { app, jobs } = setup();
    const jobId = jobs.create(ESCROW_REF);
    if (status === "running") jobs.setRunning(jobId);

    const res = await request(app).get(`/v1/responses/${jobId}`);

    expect(res.status).toBe(202);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ status, escrow_ref: ESCROW_REF });
  });

  it("200 with the stored payload and the escrow_ref for a done job", async () => {
    const { app, jobs } = setup();
    const jobId = jobs.create(ESCROW_REF);
    jobs.setRunning(jobId);
    jobs.complete(jobId, RESPONSE_PAYLOAD);

    const res = await request(app).get(`/v1/responses/${jobId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...RESPONSE_PAYLOAD, escrow_ref: ESCROW_REF });
  });

  it.each([
    { httpStatus: 502, reason: "submit_failed", message: "tx rejected" },
    { httpStatus: 503, reason: "chain_submit_failed", message: "chain down" },
  ])("$httpStatus with the recorded reason for a failed job ($reason)", async ({ httpStatus, reason, message }) => {
    const { app, jobs } = setup();
    const jobId = jobs.create(ESCROW_REF);
    jobs.setRunning(jobId);
    jobs.fail(jobId, { httpStatus, reason, message });

    const res = await request(app).get(`/v1/responses/${jobId}`);

    expect(res.status).toBe(httpStatus);
    expect(res.body).toEqual({ status: "failed", reason, message, escrow_ref: ESCROW_REF });
  });
});
