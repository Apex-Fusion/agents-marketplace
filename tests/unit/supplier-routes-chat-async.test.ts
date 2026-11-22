/**
 * supplier-routes-chat-async.test.ts — POST /v1/responses answers 202 once the Claim is confirmed
 *
 * M1-F-async-chat (2026-04-28).
 *
 * POST validates → takes the supplier slot → submits the Claim → awaits it → creates the job → starts runChatJob in the
 * background → answers 202 {job_id, status, escrow_ref}. The checks before the Claim, the runner and the job route are in
 * supplier-routes-chat.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { chainWith, makeApp, mockOllamaDeferred, postChat } from "../fixtures/supplier-side/chat-harness.js";
import { buildOpenEscrowUtxo, OPEN_ESCROW_REF } from "../fixtures/supplier-side/sample-escrow-state.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /v1/responses (async)", () => {
  it("answers 202 with the job, and does not wait for Ollama", async () => {
    // Ollama never answers: the 202 must come back with the runner still waiting for it.
    mockOllamaDeferred();
    const { app, jobs } = makeApp(chainWith(buildOpenEscrowUtxo()));

    const res = await postChat(app);

    // The body has no output, usage or receipt: those are in the job route, after the runner is done.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ job_id: expect.stringMatching(UUID_V4_RE), status: "accepted", escrow_ref: OPEN_ESCROW_REF });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    expect(jobs.get(res.body.job_id)?.status).toBe("running");
  });

  it.each([
    {
      name: "the Claim submit throws",
      status: 503,
      reason: "chain_submit_failed",
      fail: (chain: MockChainProvider) => { vi.spyOn(chain, "submitTx").mockRejectedValueOnce(new Error("chain submit failed")); },
    },
    {
      name: "the Claim is not confirmed in time",
      status: 504,
      reason: "claim_timeout",
      fail: (chain: MockChainProvider) => {
        vi.spyOn(chain, "submitTx").mockResolvedValue("0".repeat(64));
        vi.spyOn(chain, "awaitTx").mockRejectedValue(new Error("awaitTx timed out after 30000ms"));
      },
    },
  ])("$status $reason when $name: the slot is free again and no job exists", async ({ fail, status, reason }) => {
    mockOllamaDeferred();
    const chain = chainWith(buildOpenEscrowUtxo());
    fail(chain);
    const { app, state, jobs } = makeApp(chain);

    const res = await postChat(app);

    expect(res.status).toBe(status);
    expect(res.body.reason).toBe(reason);
    expect(state.snapshot().status).toBe("free");
    expect(jobs.count()).toBe(0);
  });
});
