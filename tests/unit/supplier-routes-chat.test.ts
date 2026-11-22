/**
 * supplier-routes-chat.test.ts — POST /v1/responses (the chat route) and the job route behind it
 *
 * supertest against createApp(deps) from supplier/src/server.ts. A MockChainProvider replaces Ogmios. Ollama answers through
 * vi.stubGlobal("fetch", ...). The 202 reply and the failures of the Claim are in supplier-routes-chat-async.test.ts.
 *
 * The sample escrows (sample-escrow-state.ts) commit to validChatBody(): their request_spec_hash and prompt_hash are real hashes.
 *
 * ORDER OF OPERATIONS per ARCHITECTURE.md §5.1:
 *   Claim → Ollama → Submit (NOT Ollama → Claim)
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Application } from "express";
import type { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { verifyReceipt } from "../../packages/shared/src/receipt/verify.js";
import { responseResultCommitment } from "../../packages/shared/src/responses.js";
import type { SupplierConfig } from "../../supplier/src/config.js";
import { SupplierState } from "../../supplier/src/state.js";
import {
  chainWith, drainRunner, makeApp, mockOllamaFailure, mockOllamaOk, postChat, validChatBody,
} from "../fixtures/supplier-side/chat-harness.js";
import {
  buildClaimedEscrowUtxo,
  buildOpenEscrowUtxo,
  buildPastDeliverByEscrowUtxo,
  buildSubmittedEscrowUtxo,
  buildWrongCapabilityEscrowUtxo,
  buildWrongPromptHashEscrowUtxo,
  buildWrongRequestSpecHashEscrowUtxo,
  buildWrongSupplierEscrowUtxo,
  OPEN_ESCROW_REF,
  PROMPT_HASH,
  TEST_MAX_OUTPUT_TOKENS,
  TEST_MODEL,
} from "../fixtures/supplier-side/sample-escrow-state.js";
import { SUPPLIER_PKH, SUPPLIER_PUB_KEY_HEX } from "../fixtures/supplier-side/wallet-keys.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /v1/responses: the request is refused before the Claim", () => {
  it.each([
    { header: null, reason: "escrow_ref_required" },
    { header: "not-valid-ref", reason: "escrow_ref_malformed" },
    { header: "abc#0", reason: "escrow_ref_malformed" },
  ])("400 $reason when X-Escrow-Ref is $header", async ({ header, reason }) => {
    const { app } = makeApp(chainWith());

    const res = await postChat(app, validChatBody(), header);

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe(reason);
  });

  interface BodyRefusal {
    name: string;
    body: Record<string, unknown>;
    config?: Partial<SupplierConfig>;
    reason: string;
    param?: string;
  }
  const FUNCTION_CALL_HISTORY = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Use the tool" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "done" },
  ];
  const bodyRefusals: BodyRefusal[] = [
    { name: "stream: true", body: { stream: true }, reason: "streaming_not_supported" },
    { name: "a legacy tool definition", body: { tools: [{ type: "function", function: { name: "f" } }] }, reason: "invalid_request" },
    { name: "a functions array", body: { functions: [{ name: "f", parameters: {} }] }, reason: "unsupported_parameter" },
    { name: "tool_choice, which Ollama cannot keep", body: { tool_choice: "auto" }, reason: "upstream_api_incompatible", param: "tool_choice" },
    { name: "reasoning options, which Ollama cannot keep", body: { reasoning: { effort: "high" } }, reason: "upstream_api_incompatible", param: "reasoning" },
    { name: "function call history, which Ollama cannot replay", body: { input: FUNCTION_CALL_HISTORY }, reason: "upstream_api_incompatible", param: "input[1]" },
    {
      name: "reasoning that the operator policy disables",
      body: { reasoning: { effort: "high" } },
      config: { llmBackend: "openai", openaiUpstreamApi: "responses", openaiReasoningDisabled: true },
      reason: "reasoning_disabled",
      param: "reasoning.effort",
    },
    { name: "an empty input", body: { input: [] }, reason: "invalid_request" },
    { name: "no input", body: { input: undefined }, reason: "invalid_request" },
  ];

  it.each(bodyRefusals)("400 $reason for $name, and nothing is claimed", async ({ body, config, reason, param }) => {
    const chain = chainWith(buildOpenEscrowUtxo());
    const submit = vi.spyOn(chain, "submitTx");
    const { app, state } = makeApp(chain, { config });

    const res = await postChat(app, { ...validChatBody(), ...body });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason, ...(param === undefined ? {} : { param }) });
    expect(submit).not.toHaveBeenCalled();
    expect(state.snapshot().status).toBe("free");
  });

  interface EscrowRefusal {
    name: string;
    /** The escrow on chain; null puts none on chain. */
    utxo: Utxo | null;
    status: number;
    reason: string;
    /** A text that the message gives to the buyer. */
    message?: string;
  }
  const escrowRefusals: EscrowRefusal[] = [
    { name: "is not on chain", utxo: null, status: 404, reason: "escrow_not_found" },
    { name: "is Claimed", utxo: buildClaimedEscrowUtxo(), status: 409, reason: "escrow_not_claimable", message: "Claimed" },
    { name: "is Submitted", utxo: buildSubmittedEscrowUtxo(), status: 409, reason: "escrow_not_claimable", message: "Submitted" },
    { name: "names another supplier", utxo: buildWrongSupplierEscrowUtxo(), status: 403, reason: "wrong_supplier" },
    { name: "has another capability than the advert", utxo: buildWrongCapabilityEscrowUtxo(), status: 409, reason: "capability_mismatch" },
    { name: "has another request_spec_hash", utxo: buildWrongRequestSpecHashEscrowUtxo(), status: 409, reason: "request_spec_mismatch" },
    { name: "has another prompt_hash", utxo: buildWrongPromptHashEscrowUtxo(), status: 409, reason: "prompt_mismatch" },
    { name: "is past deliver_by", utxo: buildPastDeliverByEscrowUtxo(), status: 408, reason: "past_deliver_by" },
  ];

  it.each(escrowRefusals)("$status $reason when the escrow $name, and nothing is claimed", async ({ utxo, status, reason, message }) => {
    const chain = chainWith(...(utxo === null ? [] : [utxo]));
    const submit = vi.spyOn(chain, "submitTx");
    const { app, state, jobs } = makeApp(chain);
    const ref = utxo === null ? OPEN_ESCROW_REF : `${utxo.ref.txHash}#${utxo.ref.index}`;

    const res = await postChat(app, validChatBody(), ref);

    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ reason, ...(message === undefined ? {} : { message: expect.stringContaining(message) }) });
    expect(submit).not.toHaveBeenCalled();
    expect(jobs.count()).toBe(0);
    expect(state.snapshot().status).toBe("free");
  });

  it("409 supplier_busy while another job holds the slot, and that job keeps it", async () => {
    const otherRef = `${"e".repeat(64)}#0`;
    const state = new SupplierState();
    state.tryAcquire(otherRef);
    const chain = chainWith(buildOpenEscrowUtxo());
    const submit = vi.spyOn(chain, "submitTx");
    const { app, jobs } = makeApp(chain, { state });

    const res = await postChat(app);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("supplier_busy");
    expect(submit).not.toHaveBeenCalled();
    expect(jobs.count()).toBe(0);
    expect(state.snapshot().currentEscrowRef).toBe(otherRef);
  });
});

describe("POST /v1/responses: an accepted request", () => {
  let chain: MockChainProvider;
  let app: Application;
  let state: SupplierState;

  beforeEach(() => {
    chain = chainWith(buildOpenEscrowUtxo());
    // The Claim (server) and the Submit (runner) wait for the chain to confirm: the stand-in chain confirms at once.
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    ({ app, state } = makeApp(chain));
    mockOllamaOk("I am a helpful AI assistant.");
  });

  it("answers 202; then the job route answers 200 with the response, its usage and the signed receipt", async () => {
    const posted = await postChat(app);
    expect(posted.status).toBe(202);
    await drainRunner(state);

    const polled = await request(app).get(`/v1/responses/${posted.body.job_id}`);

    expect(polled.status).toBe(200);
    const { receipt, receipt_signature: signature, ...response } = polled.body;
    expect(response).toMatchObject({
      model: TEST_MODEL,
      status: "completed",
      output: [{ role: "assistant", content: [{ type: "output_text", text: "I am a helpful AI assistant." }] }],
      usage: { input_tokens: 12, output_tokens: 48, total_tokens: 60 },
      submitted_ref: expect.stringMatching(/^[0-9a-f]{64}#0$/),
      escrow_ref: OPEN_ESCROW_REF,
    });
    // The receipt commits to the escrow's prompt and to the canonical result, and its signature verifies.
    expect(receipt).toEqual({
      prompt_hash: PROMPT_HASH,
      response_hash: createHash("sha256").update(canonicalize(responseResultCommitment(response)), "utf8").digest("hex"),
      model: TEST_MODEL,
      prompt_tokens: 12,
      completion_tokens: 48,
      wallclock_ms: 3_200,
      supplier_pkh: SUPPLIER_PKH,
      escrow_ref: OPEN_ESCROW_REF,
    });
    expect(verifyReceipt({ receipt, signature }, SUPPLIER_PUB_KEY_HEX)).toBe(true);
    expect(state.snapshot().status).toBe("free");
  });

  it("caps max_output_tokens at the advertised limit: the escrow commits to the capped request, and Ollama gets the cap", async () => {
    const posted = await postChat(app, { ...validChatBody(), max_output_tokens: TEST_MAX_OUTPUT_TOKENS + 1 });

    // Without the cap, the prompt_hash of the escrow does not match the request: 409 prompt_mismatch.
    expect(posted.status).toBe(202);
    await drainRunner(state);
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(sent.options).toEqual({ num_predict: TEST_MAX_OUTPUT_TOKENS });
  });
});

describe("POST /v1/responses: the runner fails after the Claim", () => {
  it("Ollama fails: the job route answers 502 ollama_failure, and the slot is free again", async () => {
    const chain = chainWith(buildOpenEscrowUtxo());
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    mockOllamaFailure();
    const { app, state } = makeApp(chain);

    const posted = await postChat(app);
    expect(posted.status).toBe(202);
    await drainRunner(state);

    // The escrow stays Claimed on chain: the buyer reclaims it after deliver_by. Only the slot of this process is freed.
    const polled = await request(app).get(`/v1/responses/${posted.body.job_id}`);
    expect(polled.status).toBe(502);
    expect(polled.body.reason).toBe("ollama_failure");
    expect(state.snapshot().status).toBe("free");
  });

  it("the chain refuses the Submit: the job route answers 502 submit_failed with no receipt, and the slot is free again", async () => {
    const chain = chainWith(buildOpenEscrowUtxo());
    const submit = chain.submitTx.bind(chain);
    let submitCalls = 0;
    vi.spyOn(chain, "submitTx").mockImplementation(async (tx) => {
      // The chain takes the first transaction, the Claim. The second one is the Submit.
      if (++submitCalls === 2) throw new Error("submit tx refused");
      return submit(tx);
    });
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    mockOllamaOk("I am a helpful AI assistant.");
    const { app, state } = makeApp(chain);

    const posted = await postChat(app);
    expect(posted.status).toBe(202);
    await drainRunner(state);

    const polled = await request(app).get(`/v1/responses/${posted.body.job_id}`);
    expect(polled.status).toBe(502);
    expect(polled.body).toMatchObject({ reason: "submit_failed", message: expect.stringContaining("submit tx refused") });
    expect(polled.body.receipt).toBeUndefined();
    expect(state.snapshot().status).toBe("free");
  });
});

describe("POST /v1/responses: the order of the operations", () => {
  it("submits the Claim before it calls Ollama", async () => {
    const chain = chainWith(buildOpenEscrowUtxo());
    // The mocked submitTx bypasses the known transactions, so the confirmation is mocked as well.
    const submit = vi.spyOn(chain, "submitTx").mockResolvedValue("0".repeat(64));
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
    mockOllamaOk("Hi");
    const { app, state } = makeApp(chain);

    const posted = await postChat(app);

    // The Claim goes out before the 202 comes back; the runner calls Ollama after it.
    expect(posted.status).toBe(202);
    expect(submit).toHaveBeenCalled();
    await drainRunner(state);
    const upstream = vi.mocked(fetch);
    expect(upstream).toHaveBeenCalled();
    expect(submit.mock.invocationCallOrder[0]).toBeLessThan(upstream.mock.invocationCallOrder[0]!);
  });
});
