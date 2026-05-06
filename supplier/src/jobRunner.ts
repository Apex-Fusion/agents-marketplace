/**
 * supplier/src/jobRunner.ts — Background async chat job runner.
 *
 * M1-F-async-chat-green — Catherine, 2026-04-28.
 * M1-F-async-chat-cleanup-green — Catherine, 2026-04-24.
 *
 * Invoked fire-and-forget from the POST chat handler after Claim tx confirms.
 * Steps (per Caroline's tests, ordering pinned):
 *   1. jobs.setRunning(jobId)                    [BEFORE callOllama — ordering pin]
 *   2. callOllama(...)                            [on rejection: jobs.fail("ollama_failure")]
 *   3. build + sign receipt
 *   4. construct + submit Submit tx via buildSubmitTx()
 *      [on rejection: jobs.fail("submit_failed")]
 *   5. await Submit tx confirmation (60s budget)
 *      [on rejection: jobs.fail("submit_timeout")]
 *   6. jobs.complete(jobId, payload)
 *   7. release supplier lock                      [ALWAYS, in try/finally]
 *
 * The function NEVER throws — all errors are captured into jobs.fail.
 *
 * Cleanup history: an earlier RED phase did not seed claimedRef in the chain
 * mock; the runner used an inline JSON-in-hex Submit body and a 200ms awaitTx
 * with a poll-timeout regex discriminator. Caroline's cleanup-RED migrated
 * fixtures to seed claimedRef and mock awaitTx, so we now flip back to the
 * canonical buildSubmitTx + 60_000ms awaitTx budget.
 */

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import { canonicalize } from "@marketplace/shared/cbor";
import type { WalletKey, ChatMessage } from "@marketplace/shared/tx";
import { buildSubmitTx } from "@marketplace/shared/tx";
import { buildReceipt, signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
import { createHash } from "crypto";

import type { SupplierState } from "./state.js";
import type { SupplierConfig } from "./config.js";
import * as ollama from "./ollama.js";
import type { JobStore, JobResponsePayload } from "./jobs.js";

export interface RunChatJobDeps {
  chain: ChainProvider;
  state: SupplierState;
  config: SupplierConfig;
  supplierKey: WalletKey;
  jobs: JobStore;
}

export interface RunChatJobParams {
  deps: RunChatJobDeps;
  jobId: string;
  escrowRef: string;
  claimedRef: OutputReference;
  advert: AdvertDatum;
  escrowDatum: EscrowDatum;
  requestBody: { messages: ChatMessage[] };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Run Ollama → receipt → Submit in the background.
 * Always resolves (never rejects). Terminal state written to jobs store.
 * Supplier lock is released in try/finally regardless of outcome.
 */
export async function runChatJob(params: RunChatJobParams): Promise<void> {
  const { deps, jobId, escrowRef, claimedRef, advert, escrowDatum, requestBody } = params;

  // ── 1. Mark job running BEFORE Ollama (ordering pin) ─────────────────
  deps.jobs.setRunning(jobId);

  try {
    // ── 2. Call Ollama ─────────────────────────────────────────────────
    let inference: ollama.OllamaResult;
    try {
      inference = await ollama.callOllama({
        ollamaUrl: deps.config.ollamaUrl,
        model: advert.model,
        messages: requestBody.messages,
        timeoutMs: deps.config.ollamaTimeoutMs,
      });
    } catch (err) {
      const reason = (err as ollama.OllamaError)?.reason ?? "ollama_failure";
      const message = err instanceof Error ? err.message : String(err);
      // Even ollama_timeout maps to httpStatus 502 here per Caroline's pin
      // (the runner failure-code table only enumerates 502/ollama_failure).
      // The narrower ollama_timeout code is preserved for HTTP routing later.
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: reason === "ollama_timeout" ? "ollama_failure" : reason,
        message,
      });
      return;
    }

    // ── 3. Build + sign receipt ────────────────────────────────────────
    const assistantMessage = { role: "assistant" as const, content: inference.content };
    const responseHash = sha256Hex(canonicalize(assistantMessage));

    const receipt = buildReceipt({
      prompt_hash: escrowDatum.prompt_hash,
      response_hash: responseHash,
      model: advert.model,
      prompt_tokens: inference.prompt_tokens,
      completion_tokens: inference.completion_tokens,
      wallclock_ms: inference.wallclock_ms,
      supplier_pkh: deps.supplierKey.pubKeyHash,
      escrow_ref: escrowRef,
    });
    const signed = signReceipt(receipt, deps.supplierKey.privateKeyHex);
    const resultHash = receiptResultHash(signed);

    // ── 4. Build + submit Submit tx ─────────────────────────────────────
    let buildResult: { txCborHex: string; expectedTxHash: string };
    try {
      buildResult = await buildSubmitTx({
        chain: deps.chain,
        supplierKey: deps.supplierKey,
        escrowRef: claimedRef,
        receiptHash: resultHash,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: "submit_failed",
        message: `Submit tx failed: ${message}`,
      });
      return;
    }

    // ── 5. Submit confirmation (awaitTx, 60s budget) ───────────────────
    try {
      await deps.chain.awaitTx(buildResult.expectedTxHash, 60_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: "submit_timeout",
        message: `Submit awaitTx failed: ${msg}`,
      });
      return;
    }

    // ── 6. Mark complete ────────────────────────────────────────────────
    const payload: JobResponsePayload = {
      choices: [
        {
          index: 0,
          message: assistantMessage,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: inference.prompt_tokens,
        completion_tokens: inference.completion_tokens,
        total_tokens: inference.prompt_tokens + inference.completion_tokens,
      },
      receipt: signed.receipt as unknown as Record<string, unknown>,
      receipt_signature: signed.signature,
    };
    deps.jobs.complete(jobId, payload);
  } finally {
    // ── 7. Always release the lock ──────────────────────────────────────
    try {
      deps.state.release();
    } catch {
      // never let a lock-release error escape the runner
    }
  }
}
