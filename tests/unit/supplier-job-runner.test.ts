/**
 * supplier-job-runner.test.ts — RED phase tests for runChatJob
 *
 * M1-F-async-chat RED phase — Caroline, 2026-04-28
 *
 * Tests the background job runner:
 *   Ollama → receipt → Submit → jobs.complete / jobs.fail → lock release
 *
 * All external side-effects are mocked. Chain, Ollama, and state are injected.
 * No real Ogmios / Ollama calls.
 *
 * ORDERING CONTRACT (documented, not silently assumed):
 *   jobs.setRunning MUST be called before callOllama.
 *   If Catherine implements it in the opposite order, the ordering test will
 *   fail and must be reported rather than silently corrected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
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
  TEST_MESSAGES,
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

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    requestBody: { messages: TEST_MESSAGES },
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
    // Fix A — 2026-04-28 M1-F-async-chat-cleanup:
    // Seed the claimedRef UTxO so buildSubmitTx's chain.queryUtxo(escrowRef)
    // can find it once Catherine flips the runner back to buildSubmitTx.
    // state="Claimed", submitted_at=null, result_receipt_hash=null per spec.
    chain.seed({
      ref: CLAIMED_REF,
      address: "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6",
      lovelace: 4_000_000n,
      assets: {},
      datumHex: encodeEscrowDatum(buildEscrowDatum()),
      scriptRef: null,
    });
    // Mock awaitTx to resolve immediately after successful submitTx.
    // Without this mock, MockChainProvider.awaitTx polls for SUBMIT_TX_HASH
    // which is never added to knownTxs (submitTx is mocked), causing a 200ms
    // hang. Once Catherine flips the runner to buildSubmitTx, the real
    // chain.submitTx will add the hash to knownTxs and awaitTx finds it;
    // this spy then becomes a no-op override — safe to leave in.
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("calls setRunning before callOllama (ordering contract)", async () => {
    // RED — throws "not implemented"
    // ORDERING CONTRACT: setRunning must precede callOllama.
    // If Catherine inverts this order, the test fails and must be flagged.
    const callOrder: string[] = [];
    const jobId = jobs.create(ESCROW_REF_STR);

    const setRunningSpy = vi.spyOn(jobs, "setRunning").mockImplementation((id) => {
      callOrder.push(`setRunning:${id}`);
    });
    const ollamaSpy = vi.spyOn(ollamaMod, "callOllama").mockImplementation(async () => {
      callOrder.push("callOllama");
      return buildOllamaOkResult();
    });
    const completeSpy = vi.spyOn(jobs, "complete").mockImplementation(() => {});

    await runChatJob(makeParams(chain, state, jobs, jobId));

    expect(callOrder.indexOf(`setRunning:${jobId}`)).toBeLessThan(
      callOrder.indexOf("callOllama"),
    );

    setRunningSpy.mockRestore();
    ollamaSpy.mockRestore();
    completeSpy.mockRestore();
  });

  it("calls jobs.complete with a payload containing choices, usage, receipt, receipt_signature", async () => {
    // RED — throws "not implemented"
    const jobId = jobs.create(ESCROW_REF_STR);
    const completeSpy = vi.spyOn(jobs, "complete");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    expect(completeSpy).toHaveBeenCalledOnce();
    const [calledJobId, payload] = completeSpy.mock.calls[0];
    expect(calledJobId).toBe(jobId);
    expect(Array.isArray(payload.choices)).toBe(true);
    expect(payload.choices[0].message.role).toBe("assistant");
    expect(typeof payload.choices[0].message.content).toBe("string");
    expect(payload.choices[0].message.content.length).toBeGreaterThan(0);
    expect(typeof payload.usage.prompt_tokens).toBe("number");
    expect(typeof payload.usage.completion_tokens).toBe("number");
    expect(typeof payload.usage.total_tokens).toBe("number");
    expect(payload.receipt).toBeTruthy();
    expect(typeof payload.receipt_signature).toBe("string");
  });

  it("receipt contains all 8 required fields with correct types and values", async () => {
    // RED — throws "not implemented"
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
    // RED — throws "not implemented"
    const jobId = jobs.create(ESCROW_REF_STR);
    const completeSpy = vi.spyOn(jobs, "complete");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    const sig = completeSpy.mock.calls[0][1].receipt_signature;
    expect(HEX128_RE.test(sig)).toBe(true);
  });

  it("wallclock_ms in receipt equals the wallclock_ms from Ollama (not total job time)", async () => {
    // RED — throws "not implemented"
    // The receipt's wallclock_ms must be inference.wallclock_ms, not wall clock
    // elapsed for the whole runChatJob invocation.
    const jobId = jobs.create(ESCROW_REF_STR);
    const completeSpy = vi.spyOn(jobs, "complete");

    await runChatJob(makeParams(chain, state, jobs, jobId));

    const receipt = completeSpy.mock.calls[0][1].receipt as Record<string, unknown>;
    // Our mock returns wallclock_ms = 3200; that must be what ends up in receipt
    expect(receipt.wallclock_ms).toBe(3200);
  });

  it("releases supplier lock on success (try/finally)", async () => {
    // RED — throws "not implemented"
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
    // Fix A — 2026-04-28 M1-F-async-chat-cleanup:
    // Seed claimedRef and mock awaitTx for Catherine's buildSubmitTx flip.
    // Ollama failure tests don't reach Submit, so these are defensive fixtures.
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
    // RED — throws "not implemented"
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
    // RED — throws "not implemented"
    mockOllamaFail();
    const jobId = jobs.create(ESCROW_REF_STR);
    await runChatJob(makeParams(chain, state, jobs, jobId));
    expect(state.snapshot().status).toBe("free");
  });

  it("does not throw — resolves after Ollama failure", async () => {
    // RED — throws "not implemented"
    mockOllamaFail();
    const jobId = jobs.create(ESCROW_REF_STR);
    await expect(runChatJob(makeParams(chain, state, jobs, jobId))).resolves.toBeUndefined();
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
    // Fix A — 2026-04-28 M1-F-async-chat-cleanup:
    // Seed claimedRef UTxO. In Submit-failure tests, submitTx is mocked to
    // reject so awaitTx is never reached; these fixtures are defensive for
    // Catherine's buildSubmitTx flip.
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
    // RED — throws "not implemented"
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
    // RED — throws "not implemented"
    vi.spyOn(chain, "submitTx").mockRejectedValue(new Error("phase-2 script rejected"));
    const jobId = jobs.create(ESCROW_REF_STR);
    await runChatJob(makeParams(chain, state, jobs, jobId));
    expect(state.snapshot().status).toBe("free");
  });

  it("does not throw — resolves after Submit tx failure", async () => {
    // RED — throws "not implemented"
    vi.spyOn(chain, "submitTx").mockRejectedValue(new Error("rejected"));
    const jobId = jobs.create(ESCROW_REF_STR);
    await expect(runChatJob(makeParams(chain, state, jobs, jobId))).resolves.toBeUndefined();
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
    // Fix A — 2026-04-28 M1-F-async-chat-cleanup:
    // Seed claimedRef UTxO for buildSubmitTx flip. awaitTx is mocked per-test
    // to reject (submit_timeout scenario); do NOT add a resolve-mock here.
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
    // This is the only describe block that keeps the submit_timeout RED until
    // Catherine flips the 60_000ms budget (see Catherine's flip checklist).
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("calls jobs.fail with reason=submit_timeout when awaitTx rejects", async () => {
    // RED — throws "not implemented"
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
    // RED — throws "not implemented"
    vi.spyOn(chain, "awaitTx").mockRejectedValue(new Error("timeout"));
    const jobId = jobs.create(ESCROW_REF_STR);
    await runChatJob(makeParams(chain, state, jobs, jobId));
    expect(state.snapshot().status).toBe("free");
  });
});
