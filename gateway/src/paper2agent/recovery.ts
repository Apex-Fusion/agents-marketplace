import { decodeEscrowDatum, encodeEscrowDatum } from "@marketplace/shared/cbor";
import { Paper2AgentClient, type PostedPaper2Agent } from "@marketplace/buyer/sdk/paper2agent";
import type { GatewayDeps } from "../deps.js";
import type { OneShotJobRow } from "../db/store.js";
import type { Paper2AgentCallRow } from "../db/paper2agent.js";
import { acceptAndConfirm, reclaimAndConfirm, fetchEscrowLineage, type EscrowLineage } from "../onchain/settle.js";
import { parseRef } from "../routing/selectSupplier.js";
import { assertPaper2AgentDatum, savePaper2AgentResult, savePaper2AgentTransaction, verifiedPaper2AgentResult } from "./financial.js";

/** The indexer's links must trace this exact original output. Hints do not establish ancestry. */
export function assertPaper2AgentLineage(lineage: EscrowLineage, original: string): void {
  if (lineage.original_ref !== original || lineage.rows[0]?.utxo_ref !== original) throw new Error("paper2agent_lineage_mismatch");
  for (let index = 1; index < lineage.rows.length; index++) {
    if (lineage.rows[index - 1].spent_tx !== parseRef(lineage.rows[index].utxo_ref)?.txHash) {
      throw new Error("paper2agent_lineage_mismatch");
    }
  }
  if (lineage.terminal && lineage.rows.at(-1)?.spent_tx !== lineage.terminal.tx_hash) throw new Error("paper2agent_terminal_mismatch");
}

/** Restore the confirmed Post snapshot. Its JSON keeps bigint amounts as decimal strings. */
function postedPaper2Agent(call: Paper2AgentCallRow, job: OneShotJobRow): PostedPaper2Agent {
  const posted = JSON.parse(call.posted_json!) as PostedPaper2Agent;
  const { advert, escrowUtxo } = posted;
  if (!escrowUtxo?.datumHex || !call.original_datum_hex ||
      `${posted.escrowRef.txHash}#${posted.escrowRef.index}` !== job.escrow_ref ||
      `${escrowUtxo.ref.txHash}#${escrowUtxo.ref.index}` !== job.escrow_ref ||
      encodeEscrowDatum(decodeEscrowDatum(escrowUtxo.datumHex)) !== encodeEscrowDatum(decodeEscrowDatum(call.original_datum_hex))) {
    throw new Error("paper2agent_posted_snapshot_mismatch");
  }
  return {
    ...posted,
    advert: { ...advert, price_lovelace: BigInt(advert.price_lovelace),
      supplier_bond_lovelace: BigInt(advert.supplier_bond_lovelace), buyer_bond_lovelace: BigInt(advert.buyer_bond_lovelace) },
    escrowUtxo: { ...escrowUtxo, lovelace: BigInt(escrowUtxo.lovelace),
      assets: Object.fromEntries(Object.entries(escrowUtxo.assets).map(([unit, amount]) => [unit, BigInt(amount)] as const)) },
    escrowDatum: decodeEscrowDatum(escrowUtxo.datumHex),
  };
}

/** Never sends another paid supplier request. Replay only the original signed buyer transactions. */
export async function recoverPaper2AgentJob(deps: GatewayDeps, job: OneShotJobRow): Promise<void> {
  const money = deps.store.paper2agent;
  let call = money.call(job.id);
  if (!call) throw new Error("paper2agent_journal_missing");
  const complete = (state: "completed" | "failed" | "reclaimed") => {
    deps.store.completeOneShotJob(job.id, job.owner_id, state, money.call(job.id)?.error ?? undefined);
  };
  if (call.accounted) {
    complete(call.financial_status === "accepted" && call.result_status === "verified" ? "completed" : call.financial_status === "reclaimed" ? "reclaimed" : "failed");
    return;
  }
  if (call.result_status === "pending") {
    money.update(job.id, { result_status: "failed", error: "paper2agent_request_interrupted" });
  }
  if (!job.escrow_ref) {
    if (money.transactions(job.id).length) throw new Error("paper2agent_original_reference_missing");
    money.finalize(job.id, "unfunded", 0n);
    complete("failed");
    return;
  }
  const key = deps.store.getKeyById(job.key_id);
  if (!key || !call.original_datum_hex) throw new Error("paper2agent_original_evidence_missing");
  const original = decodeEscrowDatum(call.original_datum_hex);
  if (original.buyer_pkh !== key.wallet_pkh || original.supplier_pkh !== job.supplier_pkh) throw new Error("paper2agent_original_identity_mismatch");
  const ctx = deps.registry.getContext(key);
  await ctx.mutex.run(async () => {
    let lineage = await fetchEscrowLineage(deps.config.indexerUrl, job.escrow_ref!, deps.fetchFn);
    if (lineage) assertPaper2AgentLineage(lineage, job.escrow_ref!);
    for (const tx of money.transactions(job.id)) {
      if (tx.confirmed) continue;
      const outcome = deps.store.getWalletTransactionOutcome(key.id, tx.tx_hash);
      const lineageProof = tx.phase === "post" ? Boolean(lineage) : lineage?.terminal?.tx_hash === tx.tx_hash;
      if (lineageProof || outcome?.state === "confirmed") {
        money.confirm(job.id, tx.tx_hash);
        continue;
      }
      // Another spend closed this lineage, so these exact bytes can never land.
      if (lineage?.terminal) continue;
      if (outcome?.state === "expired" || outcome?.state === "rejected") {
        // An expiry label alone cannot prove absence of a past ledger effect.
        money.finalize(job.id, "unknown", null);
        // A rejected first Post created no escrow, so no supplier works on this job.
        if (tx.phase === "post" && outcome.state === "rejected") {
          money.update(job.id, { error: "paper2agent_post_rejected" });
          complete("failed");
        }
        return;
      }
      // Includes a crash after our hook and before the guard saves its pending row.
      // The guard serializes this and retains the same signed bytes on ambiguity.
      await ctx.chain.submitTx(tx.tx_cbor);
      await ctx.chain.awaitTx(tx.tx_hash, 120_000);
      money.confirm(job.id, tx.tx_hash);
    }
    const txs = money.transactions(job.id);
    const settlement = txs.find((tx) => tx.phase !== "post");
    if (settlement?.confirmed) {
      const actual = txs.reduce((sum, tx) => sum + BigInt(tx.wallet_debit_lovelace), 0n);
      money.finalize(job.id, settlement.phase === "accept" ? "accepted" : "reclaimed", actual);
      call = money.call(job.id)!;
      complete(settlement.phase === "reclaim" ? "reclaimed" : call.result_status === "verified" ? "completed" : "failed");
      return;
    }
    lineage = await fetchEscrowLineage(deps.config.indexerUrl, job.escrow_ref!, deps.fetchFn);
    if (!lineage) return;
    assertPaper2AgentLineage(lineage, job.escrow_ref!);
    if (lineage.terminal) {
      // Legacy indexers infer Accept when a redeemer is absent. Do not price that label.
      money.update(job.id, { error: `paper2agent_external_terminal_${lineage.terminal.type}` });
      money.finalize(job.id, "unknown", null);
      deps.store.updateOneShotJob(job.id, job.owner_id, { settle_tx_hash: lineage.terminal.tx_hash });
      // The escrow is spent, so the supplier slot is free. The key's unknown
      // financial liability stays reserved in the separate money journal.
      complete("failed");
      return;
    }
    const latest = lineage.rows.at(-1);
    const ref = latest && !latest.spent_tx ? parseRef(latest.utxo_ref) : null;
    if (!ref) return;
    const utxo = await ctx.chain.queryUtxo(ref);
    if (!utxo?.datumHex) return;
    const datum = decodeEscrowDatum(utxo.datumHex);
    assertPaper2AgentDatum(original, datum);
    let phase: "accept" | "reclaim";
    if (datum.state === "Submitted") {
      call = money.call(job.id)!;
      // Read the supplier's existing job. Recovery never POSTs /run, so it cannot buy again.
      if (call.result_json === null && call.posted_json !== null) {
        const client = new Paper2AgentClient({ chain: ctx.chain, walletKey: ctx.walletKey, indexerUrl: deps.config.indexerUrl, fetchFn: deps.fetchFn });
        await client.recover(postedPaper2Agent(call, job), {
          jobId: job.supplier_job_id ?? undefined,
          onJobAccepted: async (id) => {
            if (!deps.store.updateOneShotJob(job.id, job.owner_id, { supplier_job_id: id })) throw new Error("job_ownership_lost");
          },
          onReceiptVerified: async (result) => savePaper2AgentResult(deps, job.id, job.owner_id, result),
        });
        call = money.call(job.id)!;
      }
      const stored = deps.store.getOneShotJob(job.id)!;
      try {
        verifiedPaper2AgentResult(call, stored);
        if (!stored.receipt_hash || datum.result_receipt_hash !== stored.receipt_hash) throw new Error("paper2agent_receipt_commitment_mismatch");
      } catch {
        money.update(job.id, { result_status: "failed", error: "paper2agent_receipt_invalid" });
        throw new Error("paper2agent_receipt_invalid");
      }
      phase = "accept";
    } else if ((datum.state === "Open" || datum.state === "Claimed") && Date.now() > datum.deliver_by + 60_000) {
      phase = "reclaim";
    } else return;
    if (!deps.store.updateOneShotJob(job.id, job.owner_id, { state: "settling", submitted_ref: latest!.utxo_ref })) throw new Error("job_ownership_lost");
    const currentJob = deps.store.getOneShotJob(job.id)!;
    const settle = phase === "accept" ? acceptAndConfirm : reclaimAndConfirm;
    const hash = await settle(ctx.chain, ctx.walletKey, ref, undefined,
      (built) => savePaper2AgentTransaction(deps, key, currentJob, phase, built));
    money.confirm(job.id, hash);
    const all = money.transactions(job.id);
    const actual = all.reduce((sum, tx) => sum + BigInt(tx.wallet_debit_lovelace), 0n);
    money.finalize(job.id, phase === "accept" ? "accepted" : "reclaimed", actual);
    call = money.call(job.id)!;
    complete(phase === "reclaim" ? "reclaimed" : call.result_status === "verified" ? "completed" : "failed");
  }, "recover-paper2agent", 0);
}
