/**
 * supplier/src/chatSessionRunner.ts — settles an open chat session.
 *
 * endChatSession is the chat-session analogue of runChatJob's receipt+Submit
 * tail (jobRunner.ts steps 3-7). It is invoked from BOTH /v1/chat/end (user
 * clicked "End chat") and the idle/hard-cap watchdog (abandoned session). It:
 *   1. atomically flips the session "active" → "ending" (idempotent re-entry)
 *   2. clears the idle + hard-cap timers
 *   3. builds + signs a receipt over the FULL transcript
 *      (response_hash = sha256(canonical(transcript)); the buyer recomputes
 *       this from its local transcript mirror to verify)
 *   4. buildSubmitTx against the Claimed UTxO → awaitTx (60s)
 *   5. stores the terminal result and ALWAYS releases the supplier lock
 *
 * Never throws. On any failure the session is marked "ended" with endFailure
 * and the lock is released (the escrow then lingers Claimed until the buyer
 * Reclaims after deliver_by — same fate as a failed one-off job).
 */

import { canonicalize } from "@marketplace/shared/cbor";
import { buildSubmitTx } from "@marketplace/shared/tx";
import { buildReceipt, signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
import { createHash } from "crypto";

import type { RunChatJobDeps } from "./jobRunner.js";
import type { ChatSessionStore, ChatSessionRecord } from "./chatSession.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface EndChatSessionDeps extends RunChatJobDeps {
  sessions: ChatSessionStore;
}

export interface EndChatSessionParams {
  deps: EndChatSessionDeps;
  escrowRef: string;
  /** Identifies what triggered the end, for logs ("end" | "idle" | "hard-cap"). */
  trigger?: string;
}

/**
 * Settle a chat session. Returns the (now terminal) record, or null if no
 * session exists for the ref. Idempotent: a second call returns the same
 * record without re-submitting.
 */
export async function endChatSession(
  params: EndChatSessionParams,
): Promise<ChatSessionRecord | null> {
  const { deps, escrowRef, trigger } = params;
  const record = deps.sessions.get(escrowRef);
  if (!record) return null;

  // Single-threaded between awaits: this check-then-set is atomic enough to
  // dedupe concurrent end/idle triggers.
  if (record.status !== "active") return record;
  record.status = "ending";
  deps.sessions.clearTimers(record);

  try {
    // ── Receipt over the full transcript ──────────────────────────────────
    const transcriptHash = sha256Hex(canonicalize(record.transcript));
    const receipt = buildReceipt({
      prompt_hash: record.escrowDatum.prompt_hash, // session-init placeholder
      response_hash: transcriptHash,
      model: record.advert.model,
      prompt_tokens: record.promptTokens,
      completion_tokens: record.completionTokens,
      wallclock_ms: Math.max(0, Date.now() - record.startedAtMs),
      supplier_pkh: deps.supplierKey.pubKeyHash,
      escrow_ref: record.escrowRef,
    });
    const signed = signReceipt(receipt, deps.supplierKey.privateKeyHex);
    const resultHash = receiptResultHash(signed);

    // ── Submit (Claimed → Submitted) ──────────────────────────────────────
    let buildResult: { txCborHex: string; expectedTxHash: string };
    try {
      buildResult = await buildSubmitTx({
        chain: deps.chain,
        supplierKey: deps.supplierKey,
        escrowRef: record.claimedRef,
        receiptHash: resultHash,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[chat_end_failed] escrow=${escrowRef} trigger=${trigger ?? "end"} reason=submit_failed msg=${message}`);
      record.endFailure = { reason: "submit_failed", message: `Submit tx failed: ${message}` };
      record.status = "ended";
      return record;
    }

    try {
      await deps.chain.awaitTx(buildResult.expectedTxHash, 60_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[chat_end_failed] escrow=${escrowRef} trigger=${trigger ?? "end"} reason=submit_timeout msg=${message}`);
      record.endFailure = { reason: "submit_timeout", message: `Submit awaitTx failed: ${message}` };
      record.status = "ended";
      return record;
    }

    record.endResult = {
      receipt: signed.receipt as unknown as Record<string, unknown>,
      receipt_signature: signed.signature,
      // The Submit tx output (index 0) is the new Submitted UTxO the buyer Accepts.
      submitted_ref: `${buildResult.expectedTxHash}#0`,
    };
    record.status = "ended";
    return record;
  } finally {
    // Always release the single-slot lock so the next chat can start.
    try {
      deps.state.release();
    } catch {
      /* never let lock-release escape */
    }
  }
}
