import { randomUUID } from "crypto";
import { setTimeout as delay } from "node:timers/promises";
import { decodeEscrowDatum } from "@marketplace/shared/cbor";
import type { GatewayDeps } from "./deps.js";
import type { ApiKeyRow, GatewayStore, OneShotJobRow } from "./db/store.js";
import { GatewayError, notFound, toGatewayError } from "./openai/errors.js";
import { completeStoredResponse } from "./openai/responseStore.js";
import { isResponseObject, streamFailure } from "./openai/shapes.js";
import { acceptAndConfirm, fetchEscrowLineage, reclaimAndConfirm } from "./onchain/settle.js";
import type { EscrowLineage } from "./onchain/settle.js";
import { parseRef, type SupplierCandidate } from "./routing/selectSupplier.js";

const HEARTBEAT_MS = 5_000;
const OWNER_STALE_MS = 60_000;
const ADMISSION_POLL_MS = 250;
const RECLAIM_BUFFER_MS = 60_000;
const runtimes = new WeakMap<GatewayStore, JobRuntime>();

class JobRuntime {
  readonly owner = randomUUID();
  readonly active = new Set<string>();
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly store: GatewayStore) {}

  start(id: string): void {
    this.active.add(id);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        this.store.heartbeatOneShotJobs(this.owner, Date.now());
      }, HEARTBEAT_MS);
      this.heartbeat.unref();
    }
  }

  stop(id: string): void {
    this.active.delete(id);
    if (this.active.size === 0) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}

function runtime(deps: GatewayDeps): JobRuntime {
  let current = runtimes.get(deps.store);
  if (!current) {
    current = new JobRuntime(deps.store);
    runtimes.set(deps.store, current);
  }
  return current;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new GatewayError(408, "invalid_request_error", "request_cancelled", "request closed before escrow funding");
  }
}


export function updateOneShotJob(
  deps: GatewayDeps,
  id: string,
  patch: Partial<OneShotJobRow>,
): void {
  const current = runtime(deps);
  if (!current.active.has(id) || !deps.store.updateOneShotJob(id, current.owner, patch)) {
    throw new GatewayError(503, "server_error", "job_ownership_lost", "request recovery owns this job");
  }
}

export async function reserveOneShotSupplier(
  deps: GatewayDeps,
  id: string,
  select: (signal: AbortSignal) => Promise<SupplierCandidate[]>,
  signal?: AbortSignal,
): Promise<SupplierCandidate> {
  const current = runtime(deps);
  const job = deps.store.getOneShotJob(id);
  if (!job) throw new Error("missing one-shot job");
  const deadline = job.created_at + deps.config.oneShotQueueTimeoutMs;
  const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const admissionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    for (;;) {
      checkAbort(signal);
      let candidates: SupplierCandidate[] = [];
      try {
        candidates = await select(admissionSignal);
        if (candidates.length === 0) {
          throw notFound("model_not_found", `no eligible supplier for model "${job.model}"`, "model");
        }
      } catch (error) {
        if (!(error instanceof GatewayError && error.code === "overloaded")) throw error;
      }
      checkAbort(signal);
      if (Date.now() >= deadline) {
        throw new GatewayError(503, "server_error", "supplier_capacity_timeout", "no request slot became available before the queue deadline");
      }
      const reserved = deps.store.reserveOneShotSupplier(id, current.owner, candidates, deps.config.oneShotConcurrency);
      if (reserved) {
        const candidate = candidates.find((item) => item.supplierPkh === reserved.supplier_pkh);
        if (!candidate) throw new Error("reserved supplier disappeared from candidate snapshot");
        return candidate;
      }
      await delay(ADMISSION_POLL_MS, undefined, { signal: admissionSignal });
    }
  } catch (error) {
    checkAbort(signal);
    if (timeout.aborted) {
      throw new GatewayError(503, "server_error", "supplier_capacity_timeout", "no request slot became available before the queue deadline");
    }
    throw error;
  }
}

/** The journal has no prompts or response text and is independent of store:false. */
export async function runOneShotJob<T>(
  deps: GatewayDeps,
  key: ApiKeyRow,
  args: { id: string; model: string; signal?: AbortSignal },
  execute: () => Promise<T>,
): Promise<T> {
  checkAbort(args.signal);
  const current = runtime(deps);
  if (!deps.store.insertOneShotJob({
    id: args.id, key_id: key.id, owner_id: current.owner, model: args.model, created_at: Date.now(),
  }, deps.config.oneShotMaxOutstanding)) {
    throw new GatewayError(429, "rate_limit_error", "concurrency_queue_full", "this key has reached its outstanding request limit");
  }
  current.start(args.id);
  try {
    const result = await execute();
    if (!deps.store.completeOneShotJob(args.id, current.owner, "completed")) {
      throw new GatewayError(503, "server_error", "job_ownership_lost", "request recovery owns this job");
    }
    return result;
  } catch (error) {
    const job = deps.store.getOneShotJob(args.id);
    if (job?.owner_id === current.owner && job.state !== "completed") {
      // Upstream error text can quote prompts or generated output.
      const message = toGatewayError(error).code;
      if (job.escrow_ref === null) {
        deps.store.completeOneShotJob(args.id, current.owner, "failed", message);
      } else {
        // No retry may create a second escrow for this job. Recovery follows
        // the exact original output, including when the post response was lost.
        deps.store.updateOneShotJob(args.id, current.owner, { state: "recovering", error: message });
      }
    }
    throw error;
  } finally {
    current.stop(args.id);
  }
}

function recordRecoveredOutcome(
  deps: GatewayDeps,
  job: OneShotJobRow,
  state: "completed" | "failed" | "reclaimed",
  error: string,
): void {
  deps.store.upsertUsage({
    id: job.id, key_id: job.key_id, created_at: job.created_at, kind: "completion",
    model: job.model, capability_id: "llm.text.generate.v1", supplier_pkh: job.supplier_pkh,
    escrow_ref: job.escrow_ref, cost_lovelace: state === "completed" ? job.price_lovelace : null,
    prompt_tokens: 0, completion_tokens: 0, status: state, failure_reason: error,
  });
  const stored = deps.store.getOwnedResponse(job.id, job.key_id);
  if (stored?.status === "in_progress") {
    const failed = streamFailure(job.id, job.model, { code: "request_interrupted", message: error })
      .find((event) => event.type === "response.failed");
    if (failed && isResponseObject(failed.response)) {
      completeStoredResponse(deps, {
        id: job.id, keyId: job.key_id,
        response: { ...failed.response, created_at: Math.floor(stored.created_at / 1000) },
      });
    }
  }
  deps.store.completeOneShotJob(job.id, runtime(deps).owner, state, error);
}

export interface OneShotRecoveryResult {
  /** Legacy sweeping must not race jobs whose exact lineage we protect. */
  protectedRefs: Set<string>;
  /** Fail closed if the indexer cannot identify a funded job's lineage. */
  protectedKeys: Set<string>;
}

/** Recover finances, never replay a prompt or create another payment. */
export async function recoverOneShotJobs(deps: GatewayDeps): Promise<OneShotRecoveryResult> {
  const current = runtime(deps);
  const protection: OneShotRecoveryResult = { protectedRefs: new Set(), protectedKeys: new Set() };
  for (const initial of deps.store.listUnfinishedOneShotJobs()) {
    if (initial.escrow_ref) protection.protectedRefs.add(initial.escrow_ref);
    if (initial.escrow_ref) protection.protectedKeys.add(initial.key_id);
    let lineage: EscrowLineage | null = null;
    if (initial.escrow_ref) {
      try {
        lineage = await fetchEscrowLineage(deps.config.indexerUrl, initial.escrow_ref, deps.fetchFn);
        if (lineage) {
          for (const row of lineage.rows) protection.protectedRefs.add(row.utxo_ref);
        } else {
          protection.protectedKeys.add(initial.key_id);
        }
      } catch {
        protection.protectedKeys.add(initial.key_id);
        continue;
      }
    }
    if (current.active.has(initial.id)) continue;
    if (initial.owner_id !== current.owner &&
        !deps.store.claimOneShotJob(initial.id, current.owner, Date.now() - OWNER_STALE_MS)) continue;
    current.start(initial.id);
    try {
      const job = deps.store.getOneShotJob(initial.id);
      if (!job || job.owner_id !== current.owner) continue;
      if (job.escrow_ref === null) {
        recordRecoveredOutcome(deps, job, "failed", "request interrupted before payment");
        continue;
      }
      const key = deps.store.getKeyById(job.key_id);
      if (!key) continue;
      const ctx = deps.registry.getContext(key);
      await ctx.mutex.run(async () => {
        // The wallet guard reconciles ambiguous broadcasts before entering.
        // Fetch again after acquiring it: another transaction may have settled.
        const observed = await fetchEscrowLineage(deps.config.indexerUrl, job.escrow_ref!, deps.fetchFn);
        if (!observed) {
          const original = parseRef(job.escrow_ref!);
          const outcome = original && deps.store.getWalletTransactionOutcome(job.key_id, original.txHash);
          if (outcome?.state === "rejected") {
            recordRecoveredOutcome(deps, job, "failed", "escrow transaction rejected before payment");
          } else if (outcome?.state === "expired" ||
                     (job.post_valid_until_slot !== null && await ctx.chain.tip() >= job.post_valid_until_slot)) {
            // Signed validity proves no future inclusion. A caught-up indexer
            // proves no past inclusion, including a crash before wallet submit.
            const checkpoint = job.recovery_slot ?? await ctx.chain.tip();
            if (job.recovery_slot === null) {
              updateOneShotJob(deps, job.id, { recovery_slot: checkpoint });
            }
            const health = await deps.fetchFn(`${deps.config.indexerUrl.replace(/\/$/, "")}/healthz`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (!health.ok) throw new Error(`indexer health returned ${health.status}`);
            const body = await health.json() as { sync_slot?: unknown; ogmios_status?: unknown };
            if (typeof body.sync_slot !== "number" || body.sync_slot < checkpoint ||
                body.ogmios_status !== "connected") return;
            if (await fetchEscrowLineage(deps.config.indexerUrl, job.escrow_ref!, deps.fetchFn)) return;
            recordRecoveredOutcome(deps, job, "failed", "escrow transaction expired without payment");
          }
          return;
        }
        if (observed.original_ref !== job.escrow_ref) throw new Error("escrow lineage origin mismatch");
        if (observed.terminal) {
          const reclaimed = observed.terminal.type === "ReclaimEscrow";
          updateOneShotJob(deps, job.id, { settle_tx_hash: observed.terminal.tx_hash });
          recordRecoveredOutcome(deps, job, reclaimed ? "reclaimed" : "completed",
            reclaimed ? "interrupted request refunded" : "interrupted request settled on chain");
          return;
        }
        const latest = observed.rows.at(-1);
        if (!latest || latest.spent_tx) return;
        const ref = parseRef(latest.utxo_ref);
        if (!ref) throw new Error("invalid escrow lineage reference");
        const utxo = await ctx.chain.queryUtxo(ref);
        if (!utxo?.datumHex) return; // spent after the indexer's snapshot
        const datum = decodeEscrowDatum(utxo.datumHex);
        if (datum.buyer_pkh !== key.wallet_pkh || datum.supplier_pkh !== job.supplier_pkh) {
          throw new Error("escrow lineage wallet mismatch");
        }
        if (datum.state === "Submitted") {
          if (job.receipt_hash && datum.result_receipt_hash !== job.receipt_hash) {
            throw new Error("escrow receipt commitment mismatch");
          }
          updateOneShotJob(deps, job.id, { state: "settling", submitted_ref: latest.utxo_ref });
          const txHash = await acceptAndConfirm(ctx.chain, ctx.walletKey, ref);
          updateOneShotJob(deps, job.id, { settle_tx_hash: txHash });
          recordRecoveredOutcome(deps, job, "completed", "interrupted request settled on chain");
        } else if ((datum.state === "Open" || datum.state === "Claimed") &&
                   Date.now() > datum.deliver_by + RECLAIM_BUFFER_MS) {
          const txHash = await reclaimAndConfirm(ctx.chain, ctx.walletKey, ref);
          updateOneShotJob(deps, job.id, { settle_tx_hash: txHash });
          recordRecoveredOutcome(deps, job, "reclaimed", "interrupted request refunded");
        }
      }, "recover-one-shot", 0);
    } catch (error) {
      deps.store.updateOneShotJob(initial.id, current.owner, {
        state: "recovering", error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      current.stop(initial.id);
    }
  }
  return protection;
}
