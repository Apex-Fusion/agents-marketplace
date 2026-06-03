/**
 * buyer/src/pdf/types.ts — shared types + errors for the PDF book summarizer.
 *
 * The summarizer is a server-side feature bolted onto the buyer web app: an
 * operator uploads a PDF, the server chunks it and runs a hierarchical
 * map-reduce summarization by paying marketplace suppliers per chunk (one
 * escrow per map call + per reduce node). See pdf/summarize-job.ts for the
 * orchestrator and pdf/routes.ts for the HTTP surface.
 */

import type { OutputReference } from "@marketplace/shared/chain";

/** One paragraph-aligned slice of the book, fed to a supplier as one prompt. */
export interface Chunk {
  /** 0-based position in the book — also salts the map prompt so prompt_hash
   * is unique even for identical text (the indexer lookup matches on hash). */
  index: number;
  text: string;
  tokenEstimate: number;
}

/** Operator-tunable safety + sizing knobs, resolved from env at boot. */
export interface PdfCaps {
  /** Reject books with more pages than this (hard cap). */
  maxPages: number;
  /** Reject books that chunk into more than this many calls (hard cap). */
  maxChunks: number;
  /** Refuse to start a job if projected spend would drop the wallet below
   * this lovelace balance. */
  walletFloorLovelace: bigint;
  /** Concurrency for the orchestrator. v1 ships 1 (serial PostEscrow — the
   * shared tx builder can't pin wallet inputs yet, so parallel escrows would
   * double-spend). Kept configurable for the parallel fast-follow. */
  laneCount: number;
  /** Target tokens per chunk (greedy packing). */
  chunkTargetTokens: number;
  /** Hard ceiling per chunk; oversize paragraphs split on sentence bounds. */
  chunkMaxTokens: number;
  /** Reduce-tree fan-in: how many summaries collapse into one per level. */
  reduceFanin: number;
  /** Per-call retries on a *different* supplier before a chunk is a gap. */
  retryK: number;
  /** Model-name substrings considered capable (empty = allow all). */
  modelAllowlist: string[];
  /** Model-name substrings to always exclude (e.g. weak local models). */
  modelDenylist: string[];
  /** Max upload size in bytes (multer fileSize). */
  maxPdfBytes: number;
}

/** A discovered, capable supplier ready to be paid. */
export interface PoolSupplier {
  advertRef: OutputReference;
  utxoRef: string; // "<txhash>#<index>"
  supplierPkh: string;
  model: string;
  priceLovelace: bigint;
  maxOutputTokens: number;
  endpointUrl: string;
}

export type JobPhase =
  | "estimated"
  | "running"
  | "completed"
  | "completed_with_gaps"
  | "failed"
  // A job that was mid-flight when the process died (persisted as running but
  // no live worker on the next boot). Its partial summary/coverage is still
  // openable; it cannot be resumed.
  | "interrupted";

/** Per-call result row, surfaced to the UI. */
export interface ChunkResult {
  /** chunk index for map calls; -1 for reduce nodes. */
  index: number;
  /** "map:12" or "reduce:1.3". */
  label: string;
  status: "ok" | "gap" | "pending";
  escrowRef?: string;
  supplierModel?: string;
  summary?: string;
}

/** JSON view returned by GET /v1/pdf-jobs/:id. */
export interface JobView {
  job_id: string;
  filename: string;
  status: JobPhase;
  page_count: number;
  chunk_count: number;
  coverage: { done: number; total: number };
  running_cost_lovelace: string;
  final_summary_md?: string;
  chunk_results: ChunkResult[];
  escrow_refs: string[];
  created_at: number;
}

/** Compact row returned by GET /v1/pdf-jobs (the past-work list). */
export interface JobListItem {
  job_id: string;
  filename: string;
  status: JobPhase;
  coverage: { done: number; total: number };
  chunk_count: number;
  running_cost_lovelace: string;
  created_at: number;
  has_summary: boolean;
}

/** Thrown by extractPdfText for unusable PDFs (e.g. scanned/image-only). */
export class PdfExtractionError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "PdfExtractionError";
    this.reason = reason;
  }
}
