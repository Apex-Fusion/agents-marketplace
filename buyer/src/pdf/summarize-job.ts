/**
 * buyer/src/pdf/summarize-job.ts — the summarization orchestrator + in-memory
 * job registry.
 *
 * One job = one uploaded book. The worker:
 *   MAP    — summarize each chunk (one paid escrow per chunk).
 *   REDUCE — hierarchically collapse chunk summaries (fan-in F) up a tree to a
 *            single book summary; each reduce node is another paid escrow.
 *
 * Each call reuses the exact run-cycle.ts sequence: submitPrompt (PostEscrow →
 * supplier → receipt-verify) → findSubmittedEscrowRef (indexer) → runAccept.
 *
 * Concurrency: v1 is serial. submitPrompt+accept run under a global mutex
 * because the shared tx builder can't pin wallet inputs yet, so two in-flight
 * PostEscrow txs would select the same wallet UTxO and double-spend. laneCount
 * is honored for dispatch but the mutex keeps chain ops serialized regardless
 * — the parallel fast-follow lifts the mutex once PostEscrow takes
 * presetWalletInputs.
 *
 * Failure policy: a failed call retries on a *different* supplier up to
 * caps.retryK times; if still failing it becomes a "gap" (excluded, job
 * continues). Orphaned escrows from failed calls are recovered by the existing
 * `reclaim:orphans` cron (submitPrompt throws before returning a ref, so we
 * can't reclaim inline).
 *
 * Job state is in-memory only (lost on restart); already-posted escrows remain
 * recoverable via the indexer + reclaim cron.
 */

import { randomUUID } from "crypto";
import { canonicalize } from "@marketplace/shared/cbor";
import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import type { Marketplace } from "../sdk/Marketplace.js";
import type { ResponseArchive } from "../db/archive.js";
import { runAccept } from "../cli/acceptFlow.js";
import { SUMMARIZE_CAPABILITY_ID, buildSupplierPool, SupplierPool } from "./supplier-pool.js";
import { estimateJob, feeHeadroomLovelace, type JobEstimate } from "./estimate.js";
import type { Chunk, ChunkResult, JobPhase, JobView, PdfCaps, PoolSupplier } from "./types.js";

const ESCROW_REF_RE = /^([0-9a-f]{64})#(\d+)$/;
const SUBMITTED_LOOKUP_TIMEOUT_MS = 30_000;

/** The result of running one supplier call's full on-chain lifecycle. */
export interface CallOutcome {
  response: string;
  escrowRef: string;
  supplierPkh: string;
  model: string;
  receipt: Record<string, unknown>;
  receiptSignature: string;
}

/** Runs one call (PostEscrow → supplier → verify → Accept). Injectable for
 * tests so the orchestrator can be exercised without lucid/chain. */
export type RunCallFn = (supplier: PoolSupplier, prompt: string) => Promise<CallOutcome>;

export interface JobDeps {
  marketplace: Marketplace;
  chain: ChainProvider;
  walletKey: WalletKey;
  indexerUrl: string;
  archive?: ResponseArchive;
  caps: PdfCaps;
  /** Override the per-call lifecycle (tests). Defaults to the real
   * submitPrompt → findSubmittedEscrowRef → runAccept sequence. */
  runCall?: RunCallFn;
  /** Override the wallet-balance read (tests). Defaults to chain query. */
  walletBalance?: () => Promise<bigint>;
}

export interface ProgressEvent {
  phase: "map" | "reduce" | "done" | "error";
  label?: string;
  completed: number;
  failed: number;
  total: number;
  reduce_level?: number;
  running_cost_lovelace: string;
  coverage: { done: number; total: number };
  message?: string;
  status?: JobPhase;
}

export interface EstimateView extends JobEstimate {
  suppliers: { model: string; price_lovelace: string }[];
  wallet_balance_lovelace: string;
  wallet_floor_lovelace: string;
  would_drop_below_floor: boolean;
  no_capable_suppliers: boolean;
}

/** Minimal async mutex — serializes the chain-touching critical section. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive but swallow errors so one failure doesn't poison
    // the queue; callers observe the real result/throw via `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function walletLovelace(chain: ChainProvider, address: string): Promise<bigint> {
  const utxos = await chain.queryUtxosByAddress(address);
  return utxos.reduce((acc, u) => acc + BigInt(u.lovelace), 0n);
}

/**
 * Poll the indexer for the current Submitted-state escrow ref matching this
 * prompt_hash. submitPrompt returns the Open ref, which Claim+Submit have
 * already spent — runAccept needs the live Submitted ref. Lifted from
 * buyer/src/cli/run-cycle.ts.
 */
async function findSubmittedEscrowRef(
  indexerUrl: string,
  buyerPkh: string,
  promptHash: string,
  timeoutMs: number,
): Promise<OutputReference> {
  const deadline = Date.now() + timeoutMs;
  const base = indexerUrl.replace(/\/+$/, "");
  while (Date.now() < deadline) {
    const resp = await fetch(`${base}/escrows?buyer=${buyerPkh}`);
    if (resp.ok) {
      const rows = (await resp.json()) as Array<{
        utxo_ref: string;
        prompt_hash: string;
        state: string;
        submitted_at: number | null;
      }>;
      const match = rows
        .filter((r) => r.prompt_hash === promptHash && r.state === "Submitted")
        .sort((a, b) => (b.submitted_at ?? 0) - (a.submitted_at ?? 0))[0];
      if (match) {
        const m = ESCROW_REF_RE.exec(match.utxo_ref);
        if (m) return { txHash: m[1], index: Number(m[2]) };
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `indexer: no Submitted escrow with prompt_hash=${promptHash} within ${timeoutMs}ms`,
  );
}

function mapPrompt(chunk: Chunk): string {
  // The "[chunk N]" prefix salts the prompt so prompt_hash is unique even when
  // two chunks share identical text — the indexer Submitted lookup matches on
  // hash and would otherwise be ambiguous.
  return (
    `[chunk ${chunk.index + 1}] You are summarizing one section of a longer book. ` +
    `Write a faithful, self-contained summary of the passage below in clear prose — ` +
    `capture the key events, arguments, characters, and conclusions, and add nothing ` +
    `that is not present.\n\nPASSAGE:\n${chunk.text}`
  );
}

function reducePrompt(level: number, node: number, summaries: string[]): string {
  const joined = summaries
    .map((s, i) => `--- Section ${i + 1} ---\n${s}`)
    .join("\n\n");
  return (
    `[reduce L${level}.${node}] Below are summaries of consecutive sections of a book, ` +
    `in order. Synthesize them into a single coherent summary that preserves the overall ` +
    `narrative/argument and chronological flow. Be faithful; do not invent.\n\nSECTIONS:\n${joined}`
  );
}

function groupBy<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(lanes);
}

export class Job {
  readonly jobId: string;
  readonly filename: string;
  readonly pageCount: number;
  readonly chunks: Chunk[];
  status: JobPhase = "estimated";
  runningCost = 0n;
  finalSummary?: string;
  coverageDone = 0;
  failedCount = 0;
  readonly escrowRefs: string[] = [];
  /** Map results indexed by chunk index; reduce results appended after. */
  readonly chunkResults: ChunkResult[];

  private subscribers = new Set<(frame: string) => void>();
  private frames: string[] = [];

  constructor(filename: string, pageCount: number, chunks: Chunk[]) {
    this.jobId = `job_${randomUUID()}`;
    this.filename = filename;
    this.pageCount = pageCount;
    this.chunks = chunks;
    this.chunkResults = chunks.map((c) => ({
      index: c.index,
      label: `map:${c.index}`,
      status: "pending" as const,
    }));
  }

  get coverageTotal(): number {
    return this.chunks.length;
  }

  emit(ev: ProgressEvent): void {
    const eventName = ev.phase === "done" ? "done" : "progress";
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(ev)}\n\n`;
    this.frames.push(frame);
    if (this.frames.length > 1000) this.frames.shift();
    for (const send of this.subscribers) {
      try {
        send(frame);
      } catch {
        /* dropped client; route's close handler unsubscribes */
      }
    }
  }

  /** Attach an SSE writer; replays buffered frames so reconnects catch up. */
  subscribe(send: (frame: string) => void): () => void {
    for (const f of this.frames) send(f);
    this.subscribers.add(send);
    return () => {
      this.subscribers.delete(send);
    };
  }

  view(): JobView {
    return {
      job_id: this.jobId,
      filename: this.filename,
      status: this.status,
      page_count: this.pageCount,
      chunk_count: this.chunks.length,
      coverage: { done: this.coverageDone, total: this.coverageTotal },
      running_cost_lovelace: this.runningCost.toString(),
      final_summary_md: this.finalSummary,
      chunk_results: this.chunkResults,
      escrow_refs: this.escrowRefs,
    };
  }
}

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly started = new Set<string>();
  private readonly chainMutex = new Mutex();

  constructor(private readonly deps: JobDeps) {}

  createJob(filename: string, pageCount: number, chunks: Chunk[]): Job {
    const job = new Job(filename, pageCount, chunks);
    this.jobs.set(job.jobId, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Discover suppliers + read balance to produce the pre-spend estimate. */
  async estimate(job: Job): Promise<EstimateView> {
    const pool = await buildSupplierPool(this.deps.marketplace, this.deps.caps);
    const est = estimateJob(job.chunks.length, this.deps.caps.reduceFanin, pool);
    const balance = this.deps.walletBalance
      ? await this.deps.walletBalance()
      : await walletLovelace(this.deps.chain, this.deps.walletKey.address);
    const projected = BigInt(est.totalLovelace) + feeHeadroomLovelace(est.totalCalls);
    const wouldDrop = balance - projected < this.deps.caps.walletFloorLovelace;
    return {
      ...est,
      suppliers: pool.all().map((s) => ({
        model: s.model,
        price_lovelace: s.priceLovelace.toString(),
      })),
      wallet_balance_lovelace: balance.toString(),
      wallet_floor_lovelace: this.deps.caps.walletFloorLovelace.toString(),
      would_drop_below_floor: wouldDrop,
      no_capable_suppliers: pool.size === 0,
    };
  }

  /** Kick off the background worker. Idempotent: a second call is a no-op. */
  start(job: Job): void {
    if (this.started.has(job.jobId)) return;
    this.started.add(job.jobId);
    job.status = "running";
    void this.run(job).catch((err) => {
      job.status = "failed";
      // Terminal: emit a `done` frame so SSE clients stop waiting; carries the
      // failure message + status so the UI can surface it.
      job.emit(
        this.event(job, "done", {
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }

  private async run(job: Job): Promise<void> {
    const { caps } = this.deps;
    const pool = await buildSupplierPool(this.deps.marketplace, caps);
    if (pool.size === 0) {
      job.status = "failed";
      job.emit(this.event(job, "done", { message: "no_capable_suppliers", status: "failed" }));
      return;
    }

    // ── MAP ────────────────────────────────────────────────────────────
    await runWithConcurrency(
      job.chunks,
      async (chunk) => {
        const r = await this.doOneCall(job, pool, "map", `map:${chunk.index}`, mapPrompt(chunk));
        const row = job.chunkResults[chunk.index];
        if (r.ok) {
          row.status = "ok";
          row.summary = r.summary;
          row.escrowRef = r.escrowRef;
          row.supplierModel = r.model;
          job.coverageDone++;
        } else {
          row.status = "gap";
          job.failedCount++;
        }
        job.emit(this.event(job, "map", { label: row.label }));
      },
      caps.laneCount,
    );

    // ── REDUCE (hierarchical) ───────────────────────────────────────────
    let summaries = job.chunkResults
      .filter((r) => r.status === "ok" && typeof r.summary === "string")
      .map((r) => r.summary as string);
    let level = 0;
    while (summaries.length > 1) {
      level++;
      const groups = groupBy(summaries, caps.reduceFanin);
      const nextLevel: (string | undefined)[] = new Array(groups.length);
      await runWithConcurrency(
        groups.map((g, i) => ({ g, i })),
        async ({ g, i }) => {
          const label = `reduce:${level}.${i}`;
          const r = await this.doOneCall(job, pool, "reduce", label, reducePrompt(level, i, g));
          const row: ChunkResult = {
            index: -1,
            label,
            status: r.ok ? "ok" : "gap",
            escrowRef: r.escrowRef,
            supplierModel: r.model,
            summary: r.summary,
          };
          job.chunkResults.push(row);
          if (r.ok) {
            nextLevel[i] = r.summary;
          } else {
            job.failedCount++;
          }
          job.emit(this.event(job, "reduce", { label, reduce_level: level }));
        },
        caps.laneCount,
      );
      summaries = nextLevel.filter((s): s is string => typeof s === "string");
    }

    job.finalSummary = summaries[0] ?? this.assembleFromPartials(job);

    const hasSummary = typeof job.finalSummary === "string" && job.finalSummary.length > 0;
    if (!hasSummary) {
      job.status = "failed";
    } else if (job.coverageDone < job.coverageTotal || job.failedCount > 0) {
      job.status = "completed_with_gaps";
    } else {
      job.status = "completed";
    }

    // Per-call chats are already persisted in doOneCall; the final summary
    // lives in job state and is downloadable via GET .../summary.md.
    job.emit(this.event(job, "done", { status: job.status }));
  }

  /** The real per-call lifecycle: submitPrompt → resolve Submitted → Accept. */
  private async defaultRunCall(sup: PoolSupplier, prompt: string): Promise<CallOutcome> {
    const submit = await this.deps.marketplace.submitPrompt({
      advertRef: sup.advertRef,
      messages: [{ role: "user", content: prompt }],
      payment_lovelace: sup.priceLovelace,
      max_output_tokens: sup.maxOutputTokens,
    });
    const submittedRef = await findSubmittedEscrowRef(
      this.deps.indexerUrl,
      this.deps.walletKey.pubKeyHash,
      submit.receipt.prompt_hash,
      SUBMITTED_LOOKUP_TIMEOUT_MS,
    );
    await runAccept({
      chain: this.deps.chain,
      walletKey: this.deps.walletKey,
      escrowRef: submittedRef,
    });
    return {
      response: submit.response,
      escrowRef: `${submit.escrowRef.txHash}#${submit.escrowRef.index}`,
      supplierPkh: submit.receipt.supplier_pkh,
      model: submit.receipt.model,
      receipt: submit.receipt as unknown as Record<string, unknown>,
      receiptSignature: submit.receiptSignature,
    };
  }

  /** One map/reduce call: round-robin a supplier, run the full lifecycle.
   * Serialized through chainMutex so concurrent PostEscrow txs never select
   * the same wallet UTxO (v1 has no input pinning). */
  private async doOneCall(
    job: Job,
    pool: SupplierPool,
    phase: "map" | "reduce",
    label: string,
    prompt: string,
  ): Promise<{ ok: boolean; summary?: string; escrowRef?: string; model?: string }> {
    const runCall: RunCallFn = this.deps.runCall ?? ((s, p) => this.defaultRunCall(s, p));
    const tried = new Set<string>();
    for (let attempt = 0; attempt <= this.deps.caps.retryK; attempt++) {
      const sup = pool.next(tried);
      if (!sup) break; // ran out of distinct suppliers
      tried.add(sup.utxoRef);
      try {
        const result = await this.chainMutex.run(() => runCall(sup, prompt));

        job.runningCost += sup.priceLovelace;
        job.escrowRefs.push(result.escrowRef);

        if (this.deps.archive) {
          try {
            const canonicalAssistant = canonicalize({
              role: "assistant",
              content: result.response,
            });
            this.deps.archive.persistChat({
              escrow_ref: result.escrowRef,
              posted_at: Date.now(),
              capability_id: SUMMARIZE_CAPABILITY_ID,
              supplier_pkh: result.supplierPkh,
              model: result.model,
              payment_lovelace: sup.priceLovelace.toString(),
              request_messages: [{ role: "user", content: prompt }],
              response_canonical: canonicalAssistant,
              receipt: result.receipt,
              receipt_signature: result.receiptSignature,
            });
          } catch (err) {
            // archive is best-effort; the on-chain receipt is authoritative
            // eslint-disable-next-line no-console
            console.error(`[pdf] archive.persistChat failed for ${label}:`, err);
          }
        }

        return { ok: true, summary: result.response, escrowRef: result.escrowRef, model: sup.model };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.emit(
          this.event(job, phase, {
            label,
            message: `retry ${attempt + 1}/${this.deps.caps.retryK + 1} on new supplier: ${message}`,
          }),
        );
        // Orphaned escrow (if PostEscrow landed) is recovered by reclaim:orphans.
      }
    }
    return { ok: false };
  }

  /** Fallback book summary built from surviving map summaries, gaps marked. */
  private assembleFromPartials(job: Job): string {
    const parts: string[] = [];
    for (const r of job.chunkResults.filter((x) => x.index >= 0)) {
      if (r.status === "ok" && r.summary) {
        parts.push(`## Section ${r.index + 1}\n\n${r.summary}`);
      } else {
        parts.push(`## Section ${r.index + 1}\n\n_[gap: section omitted — summarization failed]_`);
      }
    }
    return parts.join("\n\n");
  }

  private event(
    job: Job,
    phase: ProgressEvent["phase"],
    extra: Partial<ProgressEvent> = {},
  ): ProgressEvent {
    return {
      phase,
      completed: job.coverageDone,
      failed: job.failedCount,
      total: job.coverageTotal,
      running_cost_lovelace: job.runningCost.toString(),
      coverage: { done: job.coverageDone, total: job.coverageTotal },
      ...extra,
    };
  }
}
