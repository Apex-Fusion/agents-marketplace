import { randomUUID } from "node:crypto";
import { Paper2AgentClient } from "@marketplace/buyer/sdk/paper2agent";
import { PAPER2AGENT_CAPABILITY_ID, type JsonObject } from "@marketplace/shared/paper2agent";
import { receiptResultHash, type Receipt } from "@marketplace/shared/receipt";
import { decodeEscrowDatum } from "@marketplace/shared/cbor";
import type { GatewayDeps } from "../deps.js";
import type { ApiKeyRow, GatewayStore } from "../db/store.js";
import { badRequest, GatewayError } from "../openai/errors.js";
import { runOneShotJob, reserveOneShotSupplier, updateOneShotJob } from "../oneShotJobs.js";
import { selectCandidates } from "../routing/selectSupplier.js";
import { preflight } from "../onchain/preflight.js";
import { acceptAndConfirm, resolveSubmittedRef, fetchEscrowLineage } from "../onchain/settle.js";
import { assertPaper2AgentDatum, paper2AgentFinancial, savePaper2AgentResult, savePaper2AgentTransaction } from "./financial.js";
import { assertPaper2AgentLineage } from "./recovery.js";

const PAPER2AGENT_PAGE_SIZE = 20;

export interface Paper2AgentApprovalInput {
  keyId: string;
  manifestHash: string;
  supplierPkh: string;
  maxPriceLovelace: bigint;
  maxTotalSpendLovelace: bigint;
  maxCalls: number;
}

export interface Paper2AgentCallResult {
  job_id: string;
  result: JsonObject;
  receipt: Receipt;
  receipt_signature: string;
  pub_key_hex: string;
  escrow_ref: string;
  submitted_ref: string;
  financial: JsonObject;
}

export function approvePaper2Agent(store: GatewayStore, input: Paper2AgentApprovalInput): void {
  if (!input.keyId || !/^[0-9a-f]{64}$/.test(input.manifestHash) || !/^[0-9a-f]{56}$/.test(input.supplierPkh) ||
      typeof input.maxPriceLovelace !== "bigint" || typeof input.maxTotalSpendLovelace !== "bigint" ||
      input.maxPriceLovelace < 0n || input.maxTotalSpendLovelace <= 0n ||
      input.maxPriceLovelace > input.maxTotalSpendLovelace || !Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1) {
    throw new Error("paper2agent_invalid_approval");
  }
  store.paper2agent.approve({ key_id: input.keyId, manifest_hash: input.manifestHash, supplier_pkh: input.supplierPkh,
    max_price_lovelace: input.maxPriceLovelace.toString(), max_total_spend_lovelace: input.maxTotalSpendLovelace.toString(), max_calls: input.maxCalls });
}

export function revokePaper2Agent(store: GatewayStore, keyId: string): void {
  store.paper2agent.revoke(keyId);
}

/** Revocation stops new funding but never removes this wallet's spending restrictions. */
export function isPaper2AgentOnlyKey(store: GatewayStore, keyId: string): boolean {
  return store.paper2agent.approval(keyId) !== undefined;
}

export async function executePaper2AgentCall(
  deps: GatewayDeps, key: ApiKeyRow, args: { manifestHash: string; input: unknown }, admissionSignal?: AbortSignal,
): Promise<Paper2AgentCallResult> {
  const jobId = randomUUID();
  const money = deps.store.paper2agent;
  try {
    const approval = money.approval(key.id);
    if (!approval || approval.revoked || key.demo || key.disabled) throw new Error("paper2agent_not_approved");
    if (approval.manifest_hash !== args.manifestHash) throw new Error("paper2agent_manifest_not_approved");
    const model = `paper2agent:${args.manifestHash}`;
    return await runOneShotJob(deps, key, {
      id: jobId, model, signal: admissionSignal,
      onAdmit: () => money.reserve(jobId, key.id, args.manifestHash),
    }, async () => {
      const ownerId = deps.store.getOneShotJob(jobId)!.owner_id;
      const candidate = await reserveOneShotSupplier(deps, jobId, (signal) => selectCandidates({
        indexerUrl: deps.config.indexerUrl, model, capabilityId: PAPER2AGENT_CAPABILITY_ID,
        supplierPkh: approval.supplier_pkh, fetchFn: deps.fetchFn, signal,
      }), admissionSignal);
      const ctx = deps.registry.getContext(key);
      const client = new Paper2AgentClient({ chain: ctx.chain, walletKey: ctx.walletKey, indexerUrl: deps.config.indexerUrl, fetchFn: deps.fetchFn });
      const prepared = await client.prepare({ advertRef: candidate.advertRef, manifestHash: args.manifestHash, input: args.input,
        expectedSupplierPkh: approval.supplier_pkh, maxPriceLovelace: BigInt(approval.max_price_lovelace) });
      const posted = await ctx.mutex.run(async () => {
        if (admissionSignal?.aborted) throw new Error("paper2agent_admission_cancelled");
        const currentApproval = money.approval(key.id);
        const currentKey = deps.store.getKeyById(key.id);
        if (!currentKey || currentKey.disabled || !currentApproval || currentApproval.revoked) throw new Error("paper2agent_not_approved");
        const funds = await preflight(ctx.chain, ctx.walletKey.address, {
          capabilityId: PAPER2AGENT_CAPABILITY_ID, priceLovelace: prepared.advert.price_lovelace,
          buyerBondLovelace: prepared.advert.buyer_bond_lovelace, supplierBondLovelace: prepared.advert.supplier_bond_lovelace,
        });
        if (!funds.ok) throw new Error("paper2agent_insufficient_funds");
        updateOneShotJob(deps, jobId, { state: "funding", price_lovelace: prepared.advert.price_lovelace.toString() });
        money.update(jobId, { prepared_json: JSON.stringify(prepared, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value) });
        const value = await client.post(prepared, async (built) => {
          if (admissionSignal?.aborted) throw new Error("paper2agent_admission_cancelled");
          await savePaper2AgentTransaction(deps, key, { ...deps.store.getOneShotJob(jobId)!, owner_id: ownerId }, "post", built, built.escrowOutputRef);
        });
        money.confirm(jobId, value.escrowRef.txHash);
        // Recovery reads this exact snapshot, so it is durable before any supplier admission.
        money.update(jobId, { financial_status: "funded",
          posted_json: JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item) });
        updateOneShotJob(deps, jobId, { state: "running", deliver_by: value.deliverBy });
        return value;
      }, "paper2agent-post", 0);
      // A funded call outlives an HTTP disconnect. Never send a second paid supplier POST.
      const result = await client.execute(posted, {
        onJobAccepted: async (id) => { updateOneShotJob(deps, jobId, { supplier_job_id: id }); },
        // Evidence survives chain catch-up delays. Accept below still needs live lineage.
        onReceiptVerified: async (verified) => savePaper2AgentResult(deps, jobId, ownerId, verified),
      });
      const receiptHash = receiptResultHash({ receipt: result.receipt, signature: result.receipt_signature });
      if (deps.store.getOneShotJob(jobId)!.receipt_hash !== receiptHash) throw new Error("paper2agent_receipt_missing");
      await ctx.mutex.run(async () => {
        // No hint fast path: only the original spend-linked lineage authorizes settlement.
        const ref = await resolveSubmittedRef({ chain: ctx.chain, indexerUrl: deps.config.indexerUrl, buyerPkh: key.wallet_pkh,
          originalRefStr: `${posted.escrowRef.txHash}#${posted.escrowRef.index}`, receiptHash, fetchFn: deps.fetchFn });
        const lineage = await fetchEscrowLineage(deps.config.indexerUrl, `${posted.escrowRef.txHash}#${posted.escrowRef.index}`, deps.fetchFn);
        if (!lineage) throw new Error("paper2agent_lineage_missing");
        assertPaper2AgentLineage(lineage, `${posted.escrowRef.txHash}#${posted.escrowRef.index}`);
        if (lineage.terminal || lineage.rows.at(-1)?.utxo_ref !== `${ref.txHash}#${ref.index}`) throw new Error("paper2agent_lineage_mismatch");
        const utxo = await ctx.chain.queryUtxo(ref);
        const call = money.call(jobId)!;
        if (!utxo?.datumHex || !call.original_datum_hex) throw new Error("paper2agent_escrow_evidence_missing");
        const datum = decodeEscrowDatum(utxo.datumHex);
        assertPaper2AgentDatum(decodeEscrowDatum(call.original_datum_hex), datum);
        if (datum.state !== "Submitted" || datum.result_receipt_hash !== receiptHash) throw new Error("paper2agent_receipt_commitment_mismatch");
        updateOneShotJob(deps, jobId, { state: "settling", submitted_ref: `${ref.txHash}#${ref.index}` });
        const txHash = await acceptAndConfirm(ctx.chain, ctx.walletKey, ref, undefined,
          (built) => savePaper2AgentTransaction(deps, key, { ...deps.store.getOneShotJob(jobId)!, owner_id: ownerId }, "accept", built));
        money.confirm(jobId, txHash);
        const actual = money.transactions(jobId).reduce((sum, tx) => sum + BigInt(tx.wallet_debit_lovelace), 0n);
        money.finalize(jobId, "accepted", actual);
      }, "paper2agent-accept", 0);
      return { job_id: jobId, result: result.result, receipt: result.receipt, receipt_signature: result.receipt_signature,
        pub_key_hex: result.pub_key_hex, escrow_ref: result.escrow_ref, submitted_ref: deps.store.getOneShotJob(jobId)!.submitted_ref!,
        financial: paper2AgentFinancial(deps, jobId) };
    });
  } catch (error) {
    const code = error instanceof Error && /^paper2agent_[a-z_]+$/.test(error.message) ? error.message
      : error instanceof GatewayError ? error.code : "paper2agent_call_failed";
    const call = money.call(jobId);
    if (call) {
      money.update(jobId, { ...(call.result_status === "pending" ? { result_status: "failed" as const } : {}), error: code });
      if (money.transactions(jobId).length === 0) money.finalize(jobId, "unfunded", 0n);
    }
    throw new GatewayError(call ? 502 : 403, call ? "server_error" : "invalid_request_error", code,
      "Paper2Agent call does not complete. Check the job status before another call.",
      call ? { job_id: jobId, financial: paper2AgentFinancial(deps, jobId) } : undefined);
  }
}

export async function getPaper2AgentCall(deps: GatewayDeps, keyId: string, jobId: string): Promise<JsonObject | undefined> {
  const call = deps.store.paper2agent.call(jobId);
  const job = deps.store.getOneShotJob(jobId);
  if (!call || !job || call.key_id !== keyId || job.key_id !== keyId) return undefined;
  return { job_id: jobId, state: job.state, result_status: call.result_status, error: call.error,
    escrow_ref: job.escrow_ref, submitted_ref: job.submitted_ref, supplier_job_id: job.supplier_job_id,
    result: call.result_status === "verified" && call.result_json ? JSON.parse(call.result_json) as JsonObject : null,
    financial: paper2AgentFinancial(deps, jobId) };
}

/** Newest own jobs first, so a lost MCP response can still be traced to its job id. */
export async function listPaper2AgentCalls(
  deps: GatewayDeps, keyId: string, cursor?: string,
): Promise<{ jobs: JsonObject[]; next_cursor: string | null }> {
  // One lookahead row tells whether another page exists.
  const ids = deps.store.paper2agent.callPage(keyId, cursor, PAPER2AGENT_PAGE_SIZE + 1);
  // Unknown and foreign cursors get the same answer as a malformed one.
  if (!ids) throw badRequest("paper2agent_invalid_cursor", "invalid job cursor");
  const jobs: JsonObject[] = [];
  for (const id of ids.slice(0, PAPER2AGENT_PAGE_SIZE)) {
    const job = await getPaper2AgentCall(deps, keyId, id);
    if (job) jobs.push(job);
  }
  return { jobs, next_cursor: ids.length > PAPER2AGENT_PAGE_SIZE ? ids[PAPER2AGENT_PAGE_SIZE - 1] : null };
}
