/**
 * buyer/src/sdk/types.ts — SDK-specific types for M1-E.
 *
 * Stub — all runtime values throw until M1-E-green.
 */

import type { Receipt } from "@marketplace/shared/receipt";
import type { SignedReceipt } from "@marketplace/shared/receipt";
import type { OutputReference } from "@marketplace/shared/chain";

// Re-export for consumers
export type { Receipt, SignedReceipt };

/**
 * SubmitPromptResult — returned from Marketplace.submitPrompt() on success.
 */
export interface SubmitPromptResult {
  /** The assistant content string from the supplier's response. */
  response: string;
  /** Full receipt object, validated and canonical. */
  receipt: Receipt;
  /** Ed25519 hex signature over canonical(receipt), 64 bytes. */
  receiptSignature: string;
  /** The escrow OutputReference created for this prompt. */
  escrowRef: OutputReference;
}

/**
 * TaskStatus — lifecycle states for a recorded task.
 */
export type TaskStatus = "pending" | "completed" | "failed" | "reclaimed";

/**
 * TaskRecord — stored in TaskHistoryStore (localStorage-backed or memory).
 */
export interface TaskRecord {
  escrow_ref: string;                // "<txHash>#<index>"
  supplier_pkh: string;              // 28-byte hex
  capability_id: string;
  prompt_preview: string;            // first 100 chars of first user message
  posted_at: number;                 // POSIX ms
  status: TaskStatus;
  response?: string;                 // set on completed
  receipt?: Receipt;                 // set on completed
  receipt_signature?: string;        // set on completed
  failure_reason?: string;           // set on failed
}

/**
 * ProgressEventType — names of events emitted by Marketplace.
 */
export type ProgressEventType =
  | "escrow_posted"
  | "supplier_called"
  | "receipt_verified"
  | "accept_submitted"
  | "reclaim_submitted"
  | "chain_submit_failed"
  | "chat_started"
  | "chat_ended";

/**
 * ProgressEvent — payload emitted via EventEmitter on each step.
 */
export interface ProgressEvent {
  type: ProgressEventType;
  escrow_ref?: string;
  detail?: string;
}

/**
 * ReceiptVerificationError — thrown when receipt signature or fields are invalid.
 * `reason` is a machine-readable snake_case identifier tests assert against.
 */
export class ReceiptVerificationError extends Error {
  public readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "ReceiptVerificationError";
    this.reason = reason;
  }
}

/**
 * IndexerError — thrown when the indexer returns a non-2xx or unparseable response.
 */
export class IndexerError extends Error {
  public readonly status?: number;
  public readonly reason: string;

  constructor(reason: string, opts?: { status?: number; message?: string }) {
    super(opts?.message ?? reason);
    this.name = "IndexerError";
    this.reason = reason;
    this.status = opts?.status;
  }
}

/**
 * SupplierError — thrown when the supplier returns a non-2xx, times out, or
 * returns a malformed response body.
 */
export class SupplierError extends Error {
  public readonly status?: number;
  public readonly reason: string;

  constructor(reason: string, opts?: { status?: number; message?: string }) {
    super(opts?.message ?? reason);
    this.name = "SupplierError";
    this.reason = reason;
    this.status = opts?.status;
  }
}

/**
 * SupplierView — the shape returned by GET /suppliers (indexer).
 * Matches indexer/src/routes/suppliers.ts `SupplierView`.
 */
export interface SupplierView {
  utxo_ref: string;
  supplier_pkh: string;
  capability_id: string;
  model: string;
  max_output_tokens: number;
  max_processing_ms: number;
  price_lovelace: string;
  supplier_bond_lovelace: string;
  buyer_bond_lovelace: string;
  endpoint_url: string;
  detail_uri: string;
  detail_hash: string;
  advertised_at: number;
  status: string;
  advert_status: string;
  current_escrow_ref: string | null;
  last_seen_iso: string | null;
  created_slot: number;
}

/**
 * DiscoverSuppliersOptions — optional filters for discoverSuppliers().
 */
export interface DiscoverSuppliersOptions {
  capability_id?: string;
  sort?: "price" | "last_seen";
}

/**
 * SubmitPromptOptions — arguments to Marketplace.submitPrompt().
 */
export interface SubmitPromptOptions {
  advertRef: OutputReference;
  messages: import("@marketplace/shared/tx").ChatMessage[];
  payment_lovelace: bigint;
  max_output_tokens?: number;
}

/**
 * SubmitTtsOptions — arguments to Marketplace.submitTts() for the
 * `audio.synthesize.piper.v1` capability. The same `{text, voice, format,
 * speed}` envelope is hashed (sha256 ∘ canonical) into the escrow datum's
 * `prompt_hash` AND posted to the supplier's /v1/audio/synthesize body, so
 * the supplier can verify the request matches what was committed on chain.
 */
export interface SubmitTtsOptions {
  advertRef: OutputReference;
  text: string;
  voice: string;       // alloy | echo | fable | onyx | nova | shimmer | lessac
  format: string;      // mp3 | wav | opus | aac | flac
  speed: number;       // 0.5 .. 1.5
  payment_lovelace: bigint;
}

/**
 * SubmitTtsResult — returned from Marketplace.submitTts() on success.
 * Audio is base64 over the wire to keep the JSON poll response clean; the
 * caller decodes once and renders / persists as needed.
 */
export interface SubmitTtsResult {
  audio_b64: string;
  format: string;
  content_type: string;
  byte_length: number;
  receipt: Receipt;
  receiptSignature: string;
  escrowRef: OutputReference;
}

/**
 * StartChatOptions / StartChatResult — Marketplace.startChat() for the
 * `llm.chat.v1` capability. Opens the escrow (session-init prompt_hash) and
 * tells the supplier to Claim, reserving its single slot. The conversation
 * then runs off-chain via the buyer-app's /v1/chat/message SSE passthrough.
 */
export interface StartChatOptions {
  advertRef: OutputReference;
  payment_lovelace: bigint;
}
export interface StartChatResult {
  escrowRef: OutputReference;
  /** Random nonce committed into the escrow's session-init prompt_hash. The
   * buyer-app must hold this to verify the receipt at End. */
  sessionNonce: string;
  /** Supplier endpoint_url, cached by the buyer-app for message routing. */
  supplierBaseUrl: string;
}

/**
 * EndChatOptions / EndChatResult — Marketplace.endChat(). Tells the supplier to
 * Submit a transcript receipt, verifies it, then Accepts (charging the user).
 */
export interface EndChatOptions {
  escrowRef: OutputReference;
  sessionNonce: string;
  /** Supplier endpoint_url cached by the buyer-app from startChat. Required
   * because the Open escrow UTxO is already spent (Claimed) by End time, so we
   * resolve the supplier via its cached URL + /capability rather than chain. */
  supplierBaseUrl: string;
  /** The browser's local transcript mirror, used to verify response_hash. */
  transcript?: import("@marketplace/shared/tx").ChatMessage[];
}
export interface EndChatResult {
  receipt: Receipt;
  receiptSignature: string;
  escrowRef: OutputReference;
  /** The Submitted escrow UTxO that was Accepted. */
  acceptedRef: OutputReference;
}

/**
 * AcceptResultOptions — arguments to Marketplace.acceptResult().
 */
export interface AcceptResultOptions {
  escrowRef: OutputReference;
}

/**
 * ReclaimOptions — arguments to Marketplace.reclaim().
 */
export interface ReclaimOptions {
  escrowRef: OutputReference;
}

/**
 * GetTaskHistoryOptions — optional filters for getTaskHistory().
 */
export interface GetTaskHistoryOptions {
  status?: TaskStatus;
  supplier?: string;   // supplier_pkh
}
