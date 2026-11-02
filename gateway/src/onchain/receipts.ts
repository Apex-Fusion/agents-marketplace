/**
 * gateway/src/onchain/receipts.ts — the receipt check before the gateway
 * Accepts an escrow (Part 2 §6.3).
 *
 * A receipt for a new escrow has 9 fields: the 8 legacy fields and
 * agent_did = "did:vector:<agent_id>" of the escrow's agent. A receipt for a
 * legacy escrow keeps the 8 fields. The buyer SDK refuses any other receipt
 * (receiptAgentProblem in executePrompt, TTS, OCR and endChat) and then does
 * not Accept. The request paths of the gateway Accept only after that SDK
 * check. The sweeper Accepts without an SDK call (after a chat session ends,
 * or after a request stops before its own Accept), so it applies the same
 * check here. One-shot recovery (oneShotJobs.ts) uses the receipt hash that
 * the SDK verified for the job.
 *
 * The gateway keeps the receipts that the sweeper can need: the end answer of
 * a chat session, and the receipt of an OCR request that the SDK verified.
 * The key is receiptResultHash({ receipt, signature }), the value that Submit
 * writes into the escrow as result_receipt_hash, so a Submitted datum names
 * the receipt that it commits to.
 *
 * Before an Accept:
 *   - a kept receipt must pass the agent check against the escrow's agent_id;
 *   - a new escrow needs a kept receipt: without one the gateway cannot check
 *     its agent, so it does not Accept, and after the acceptance window the
 *     supplier settles the escrow with Release;
 *   - a legacy escrow without a kept receipt keeps the legacy Accept (Part 2
 *     §9.6 drain).
 */

import type { AnyEscrowDatum } from "@marketplace/shared/cbor";
import { receiptResultHash, type Receipt } from "@marketplace/shared/receipt";
import { receiptAgentProblem } from "@marketplace/buyer/sdk";
import type { GatewayStore } from "../db/store.js";

/** A 64-byte Ed25519 signature in hex. */
const SIGNATURE_RE = /^[0-9a-fA-F]{128}$/;

/** The sweep deletes kept receipts after this time. An Accept is possible only up to 10 minutes after submitted_at. */
export const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Why the gateway does not Accept an escrow: the agent check of its kept receipt failed, or it keeps no receipt of a new escrow. */
export type AcceptRefusal = "agent_did_mismatch" | "malformed_receipt" | "receipt_not_held";

/**
 * Keeps the receipt that a supplier returned for `escrowRef` (the original
 * Open escrow ref). Returns its hash, or null when the values are not a
 * receipt object and a hex signature.
 */
export function keepReceipt(
  store: GatewayStore,
  keyId: string,
  escrowRef: string,
  receipt: unknown,
  signature: unknown,
): string | null {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt) ||
      typeof signature !== "string" || !SIGNATURE_RE.test(signature)) {
    return null;
  }
  let receiptHash: string;
  try {
    // The supplier's own object: Submit committed to exactly these bytes.
    receiptHash = receiptResultHash({ receipt: receipt as unknown as Receipt, signature });
  } catch {
    return null;
  }
  store.keepEscrowReceipt({
    receipt_hash: receiptHash,
    key_id: keyId,
    escrow_ref: escrowRef,
    receipt: JSON.stringify(receipt),
    receipt_signature: signature,
    created_at: Date.now(),
  });
  return receiptHash;
}

/** The receipt check before an Accept of the Submitted escrow `escrow`. Null: the Accept may go ahead. */
export function acceptRefusal(store: GatewayStore, escrow: AnyEscrowDatum): AcceptRefusal | null {
  const receiptHash = escrow.datum.result_receipt_hash;
  const kept = receiptHash === null ? undefined : store.getEscrowReceipt(receiptHash);
  if (kept === undefined) return escrow.layout === "identity" ? "receipt_not_held" : null;
  const receipt: unknown = JSON.parse(kept.receipt);
  if (typeof receipt !== "object" || receipt === null) return "malformed_receipt";
  return receiptAgentProblem(receipt, escrow.layout === "identity" ? escrow.datum.agent_id : null);
}
