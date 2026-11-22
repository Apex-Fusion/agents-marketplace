/**
 * supplier-job-runner.test.ts — tests for runChatJob
 *
 * Tests the background job runner:
 *   Ollama → receipt → Submit → jobs.complete / jobs.fail → lock release
 *
 * The job store and the state are the real classes. The chain is a
 * MockChainProvider with submitTx and awaitTx stubbed, and callOllama is
 * stubbed. No real Ogmios / Ollama calls.
 *
 * ORDERING CONTRACT: the runner sets the job to "running" before it calls the
 * upstream. The happy-path test reads the job status inside the stubbed
 * callOllama.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { responseResultCommitment } from "../../packages/shared/src/responses.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import type { JobStore as JobStoreType } from "../../supplier/src/jobs.js";
import { runChatJob } from "../../supplier/src/jobRunner.js";
import type { RunChatJobParams } from "../../supplier/src/jobRunner.js";
import * as ollamaMod from "../../supplier/src/ollama.js";
import { buildSampleConfig } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey, SUPPLIER_PKH } from "../fixtures/supplier-side/wallet-keys.js";
import {
  ESCROW_TX_HASH,
  TEST_MODEL,
  TEST_RESPONSE_INPUT,
  PROMPT_HASH,
  POSTED_AT,
  DELIVER_BY,
  PAYMENT_LOVELACE,
  BUYER_BOND,
  SUPPLIER_BOND,
  CAPABILITY_ID,
  REQUEST_SPEC_HASH,
} from "../fixtures/supplier-side/sample-escrow-state.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ESCROW_REF_STR = `${ESCROW_TX_HASH}#0`;
const CLAIMED_TX_HASH = "1".repeat(64);
const CLAIMED_REF: OutputReference = { txHash: CLAIMED_TX_HASH, index: 0 };
const SUBMIT_TX_HASH = "2".repeat(64);

const HEX64_RE = /^[0-9a-f]{64}$/i;
const HEX128_RE = /^[0-9a-f]{128}$/i;

function buildAdvert(): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER_PKH,
    capability_id: CAPABILITY_ID,
    model: TEST_MODEL,
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "http://supplier.example:8080",
    detail_uri: "ipfs://QmTest",
    detail_hash: "a".repeat(64),
    advertised_at: POSTED_AT,
    status: "Active",
  };
}

function buildEscrowDatum(): EscrowDatum {
  return {
    buyer_pkh: "1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    supplier_pkh: SUPPLIER_PKH,
    advert_ref: { txHash: "b".repeat(64), index: 0 },
    capability_id: CAPABILITY_ID,
    request_spec_hash: REQUEST_SPEC_HASH,
    prompt_hash: PROMPT_HASH,
    payment_lovelace: PAYMENT_LOVELACE,
    buyer_bond_lovelace: BUYER_BOND,
    supplier_bond_lovelace: SUPPLIER_BOND,
    deliver_by: DELIVER_BY,
    posted_at: POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Claimed",
  };
}

function buildOllamaOkResult() {
  return {
    content: "I am a helpful assistant.",
    done_reason: "stop",
    prompt_tokens: 12,
    completion_tokens: 48,
    wallclock_ms: 3200,
  };
}

function makeParams(
  chain: MockChainProvider,
  state: SupplierState,
  jobs: JobStoreType,
  jobId: string,
): RunChatJobParams {
  return {
    deps: {
      chain,
      state,
      config: buildSampleConfig(),
      supplierKey: buildSupplierWalletKey(),
      jobs,
    },
    jobId,
    escrowRef: ESCROW_REF_STR,
    claimedRef: CLAIMED_REF,
    advert: buildAdvert(),
    escrowDatum: buildEscrowDatum(),
    requestBody: {
      input: TEST_RESPONSE_INPUT,
      max_output_tokens: 512,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockOllamaOk() {
  return vi.spyOn(ollamaMod, "callOllama").mockResolvedValue(buildOllamaOkResult());
}

function mockOllamaFail(message = "Ollama returned HTTP 500") {
  return vi.spyOn(ollamaMod, "callOllama").mockRejectedValue(
    new ollamaMod.OllamaError("ollama_failure", message),
  );
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("runChatJob — happy path", () => {
  let chain: MockChainProvider;
  let state: SupplierState;
  let jobs: JobStore;

  beforeEach(() => {
    chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    state = new SupplierState();
    state.tryAcquire(ESCROW_REF_STR);
    jobs = new JobStore();
    mockOllamaOk();
    // Mock submitTx to return deterministic hashes
    vi.spyOn(chain, "submitTx").mockResolvedValue(SUBMIT_TX_HASH);
    // Seed the claimedRef UTxO so buildSubmitTx's chain.queryUtxo(escrowRef)
    // can find it. state="Claimed", submitted_at=null, result_receipt_hash=null per spec.
    chain.seed({
      ref: CLAIMED_REF,
      address: "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6",
      lovelace: 4_000_000n,
      assets: {},
      datumHex: encodeEscrowDatum(buildEscrowDatum()),
      scriptRef: null,
    });
    // Mock awaitTx to resolve immediately after successful submitTx.
    // Without this mock, MockChainProvider.awaitTx polls for SUBMIT_TX_HASH,
    // which is never added to knownTxs (submitTx is mocked), causing a 200ms
    // hang.
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("sets the job to running before the upstream call, then completes it", async () => {
    // ORDERING CONTRACT: the status is "running" while callOllama runs.
    const jobId = jobs.create(ESCROW_REF_STR);
    let statusDuringUpstream: string | undefined;
    vi.mocked(ollamaMod.callOllama).mockImplementationOnce(async () => {
      statusDuringUpstream = jobs.get(jobId)?.status;
      return buildOllamaOkResult();
    });

    await runChatJob(makeParams(chain, state, jobs, jobId));

    expect(statusDuringUpstream).toBe("running");
    expect(jobs.get(jobId)?.status).toBe("done");
  });

  it("calls jobs.complete with the canonical Responses payload and settlement data", async () => {
    const jobId = jobs.create(ESCROW_REF_STR);
    const completeSpy = vi.spyOn(jobs, "complete");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    expect(completeSpy).toHaveBeenCalledOnce();
    const [calledJobId, payload] = completeSpy.mock.calls[0];
    expect(calledJobId).toBe(jobId);
    if (!("object" in payload)) throw new Error("expected Responses payload");
    expect(payload.object).toBe("response");
    expect(payload.status).toBe("completed");
    expect(payload.output[0]).toMatchObject({
      type: "message",
      role: "assistant",
    });
    expect(payload.usage?.input_tokens).toBe(12);
    expect(payload.usage?.output_tokens).toBe(48);
    expect(payload.receipt).toBeTruthy();
    expect(typeof payload.receipt_signature).toBe("string");
  });

  it("signs Ollama length results as incomplete, including an empty partial output", async () => {
    vi.mocked(ollamaMod.callOllama).mockResolvedValueOnce({
      content: "",
      done_reason: "length",
      prompt_tokens: 12,
      completion_tokens: 48,
      wallclock_ms: 3200,
    });
    const jobId = jobs.create(ESCROW_REF_STR);
    const completeSpy = vi.spyOn(jobs, "complete");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    const payload = completeSpy.mock.calls[0][1];
    if (!("object" in payload)) throw new Error("expected Responses payload");
    expect(payload.status).toBe("incomplete");
    expect(payload.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(payload.output).toEqual([{
      type: "message",
      id: `msg_${jobId}`,
      role: "assistant",
      status: "incomplete",
      content: [{ type: "output_text", text: "", annotations: [] }],
    }]);
    const responseHash = createHash("sha256")
      .update(canonicalize(responseResultCommitment(payload)), "utf8")
      .digest("hex");
    expect(payload.receipt.response_hash).toBe(responseHash);
  });

  it("receipt contains all 8 required fields with correct types and values", async () => {
    const jobId = jobs.create(ESCROW_REF_STR);
    const completeSpy = vi.spyOn(jobs, "complete");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    const receipt = completeSpy.mock.calls[0][1].receipt as Record<string, unknown>;
    // 8 fields: prompt_hash, response_hash, model, prompt_tokens,
    //           completion_tokens, wallclock_ms, supplier_pkh, escrow_ref
    expect(typeof receipt.prompt_hash).toBe("string");
    expect(HEX64_RE.test(receipt.prompt_hash as string)).toBe(true);
    expect(receipt.prompt_hash).toBe(PROMPT_HASH);

    expect(typeof receipt.response_hash).toBe("string");
    expect(HEX64_RE.test(receipt.response_hash as string)).toBe(true);

    expect(receipt.model).toBe(TEST_MODEL);

    expect(typeof receipt.prompt_tokens).toBe("number");
    expect(receipt.prompt_tokens).toBe(12);

    expect(typeof receipt.completion_tokens).toBe("number");
    expect(receipt.completion_tokens).toBe(48);

    expect(typeof receipt.wallclock_ms).toBe("number");
    // wallclock_ms comes from Ollama result, not total job time
    expect(receipt.wallclock_ms).toBe(3200);

    expect(receipt.supplier_pkh).toBe(SUPPLIER_PKH);
    expect(receipt.escrow_ref).toBe(ESCROW_REF_STR);
  });

  it("receipt_signature is a 128-char hex string (64-byte Ed25519)", async () => {
    const jobId = jobs.create(ESCROW_REF_STR);
    const completeSpy = vi.spyOn(jobs, "complete");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    const sig = completeSpy.mock.calls[0][1].receipt_signature;
    expect(HEX128_RE.test(sig)).toBe(true);
  });

  it("releases supplier lock on success (try/finally)", async () => {
    const jobId = jobs.create(ESCROW_REF_STR);
    expect(state.snapshot().status).toBe("working");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    expect(state.snapshot().status).toBe("free");
  });
});

// ─── Ollama failure ───────────────────────────────────────────────────────────

describe("runChatJob — Ollama failure", () => {
  let chain: MockChainProvider;
  let state: SupplierState;
  let jobs: JobStore;

  beforeEach(() => {
    chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    state = new SupplierState();
    state.tryAcquire(ESCROW_REF_STR);
    jobs = new JobStore();
    vi.spyOn(chain, "submitTx").mockResolvedValue(SUBMIT_TX_HASH);
    // Seed the claimedRef UTxO and mock awaitTx like the happy path. The Ollama
    // failure tests do not reach Submit, so these are defensive fixtures.
    chain.seed({
      ref: CLAIMED_REF,
      address: "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6",
      lovelace: 4_000_000n,
      assets: {},
      datumHex: encodeEscrowDatum(buildEscrowDatum()),
      scriptRef: null,
    });
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("calls jobs.fail with httpStatus=502, reason=ollama_failure on Ollama error", async () => {
    mockOllamaFail("Ollama returned HTTP 500: Internal Server Error");
    const jobId = jobs.create(ESCROW_REF_STR);
    const failSpy = vi.spyOn(jobs, "fail");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    expect(failSpy).toHaveBeenCalledOnce();
    const [calledJobId, failure] = failSpy.mock.calls[0];
    expect(calledJobId).toBe(jobId);
    expect(failure.httpStatus).toBe(502);
    expect(failure.reason).toBe("ollama_failure");
    expect(typeof failure.message).toBe("string");
  });

  it("releases supplier lock after Ollama failure (try/finally)", async () => {
    mockOllamaFail();
    const jobId = jobs.create(ESCROW_REF_STR);
    await runChatJob(makeParams(chain, state, jobs, jobId));
    expect(state.snapshot().status).toBe("free");
  });
});

// ─── Submit tx failure ────────────────────────────────────────────────────────

describe("runChatJob — Submit tx failure", () => {
  let chain: MockChainProvider;
  let state: SupplierState;
  let jobs: JobStore;

  beforeEach(() => {
    chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    state = new SupplierState();
    state.tryAcquire(ESCROW_REF_STR);
    jobs = new JobStore();
    mockOllamaOk();
    // Seed the claimedRef UTxO. In the Submit-failure tests, submitTx is mocked
    // to reject, so awaitTx is never reached; these fixtures are defensive.
    chain.seed({
      ref: CLAIMED_REF,
      address: "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6",
      lovelace: 4_000_000n,
      assets: {},
      datumHex: encodeEscrowDatum(buildEscrowDatum()),
      scriptRef: null,
    });
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("calls jobs.fail with httpStatus=502, reason=submit_failed when Submit tx throws", async () => {
    vi.spyOn(chain, "submitTx").mockRejectedValue(new Error("phase-2 script rejected"));
    const jobId = jobs.create(ESCROW_REF_STR);
    const failSpy = vi.spyOn(jobs, "fail");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    expect(failSpy).toHaveBeenCalledOnce();
    const [calledJobId, failure] = failSpy.mock.calls[0];
    expect(calledJobId).toBe(jobId);
    expect(failure.httpStatus).toBe(502);
    expect(failure.reason).toBe("submit_failed");
  });

  it("releases lock after Submit tx failure", async () => {
    vi.spyOn(chain, "submitTx").mockRejectedValue(new Error("phase-2 script rejected"));
    const jobId = jobs.create(ESCROW_REF_STR);
    await runChatJob(makeParams(chain, state, jobs, jobId));
    expect(state.snapshot().status).toBe("free");
  });
});

// ─── awaitTx timeout on Submit ────────────────────────────────────────────────

describe("runChatJob — awaitTx timeout on Submit", () => {
  let chain: MockChainProvider;
  let state: SupplierState;
  let jobs: JobStore;

  beforeEach(() => {
    chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    state = new SupplierState();
    state.tryAcquire(ESCROW_REF_STR);
    jobs = new JobStore();
    mockOllamaOk();
    vi.spyOn(chain, "submitTx").mockResolvedValue(SUBMIT_TX_HASH);
    // Seed the claimedRef UTxO. awaitTx is mocked per-test to reject
    // (submit_timeout scenario); do NOT add a resolve-mock here.
    chain.seed({
      ref: CLAIMED_REF,
      address: "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6",
      lovelace: 4_000_000n,
      assets: {},
      datumHex: encodeEscrowDatum(buildEscrowDatum()),
      scriptRef: null,
    });
    // NOTE: awaitTx is intentionally NOT mocked here at the describe level —
    // individual tests mock it to reject with a timeout error.
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("calls jobs.fail with reason=submit_timeout when awaitTx rejects", async () => {
    vi.spyOn(chain, "awaitTx").mockRejectedValue(new Error("awaitTx timed out"));
    const jobId = jobs.create(ESCROW_REF_STR);
    const failSpy = vi.spyOn(jobs, "fail");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    expect(failSpy).toHaveBeenCalledOnce();
    const [calledJobId, failure] = failSpy.mock.calls[0];
    expect(calledJobId).toBe(jobId);
    expect(failure.httpStatus).toBe(502);
    expect(failure.reason).toBe("submit_timeout");
  });

  it("releases lock after awaitTx timeout", async () => {
    vi.spyOn(chain, "awaitTx").mockRejectedValue(new Error("timeout"));
    const jobId = jobs.create(ESCROW_REF_STR);
    await runChatJob(makeParams(chain, state, jobs, jobId));
    expect(state.snapshot().status).toBe("free");
  });
});
