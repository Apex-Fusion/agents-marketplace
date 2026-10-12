import type { BuildResult, PostEscrowBuildResult } from "@marketplace/shared/tx";
import { inspectSignedTransaction, inspectSignedTransactionFinancials, pkhToEnterpriseAddress } from "@marketplace/shared/tx/server";
import { decodeEscrowDatum, type EscrowDatum } from "@marketplace/shared/cbor";
import { PAPER2AGENT_CAPABILITY_ID, paper2AgentManifestHash, paper2AgentRequestSpecHash, verifyPaper2AgentReceipt, type JsonObject, type Paper2AgentManifest } from "@marketplace/shared/paper2agent";
import { receiptResultHash } from "@marketplace/shared/receipt";
import type { Paper2AgentResult } from "@marketplace/buyer/sdk/paper2agent";
import type { ApiKeyRow, OneShotJobRow } from "../db/store.js";
import type { Paper2AgentCallRow, Paper2AgentTransactionRow } from "../db/paper2agent.js";
import type { GatewayDeps } from "../deps.js";

/** Compare every immutable datum field, not only the supplier's reference hint. */
export function assertPaper2AgentDatum(original: EscrowDatum, current: EscrowDatum): void {
  const fields = ["buyer_pkh", "supplier_pkh", "capability_id", "request_spec_hash", "prompt_hash", "payment_lovelace", "buyer_bond_lovelace", "supplier_bond_lovelace", "posted_at", "deliver_by"] as const;
  if (fields.some((field) => original[field] !== current[field]) ||
      original.advert_ref.txHash !== current.advert_ref.txHash || original.advert_ref.index !== current.advert_ref.index ||
      current.capability_id !== PAPER2AGENT_CAPABILITY_ID) {
    throw new Error("paper2agent_escrow_identity_mismatch");
  }
}

/** Bind signed evidence to the journaled manifest, input, supplier key and original escrow. */
function assertPaper2AgentEvidence(call: Paper2AgentCallRow, job: OneShotJobRow, result: Paper2AgentResult): void {
  if (!call.prepared_json || !job.escrow_ref || !job.supplier_pkh) throw new Error("paper2agent_receipt_missing");
  const prepared = JSON.parse(call.prepared_json) as { manifest: Paper2AgentManifest; input: JsonObject; supplierPublicKeyHex: string };
  if (paper2AgentManifestHash(prepared.manifest) !== call.manifest_hash || result.manifest_hash !== call.manifest_hash ||
      result.pub_key_hex !== prepared.supplierPublicKeyHex || result.escrow_ref !== job.escrow_ref) {
    throw new Error("paper2agent_receipt_identity_mismatch");
  }
  verifyPaper2AgentReceipt({ manifest: prepared.manifest, input: prepared.input, result: result.result,
    receipt: result.receipt, signature: result.receipt_signature, publicKeyHex: result.pub_key_hex,
    supplierPkh: job.supplier_pkh, escrowRef: job.escrow_ref });
}

/** Reverify durable evidence after restart. A flag or a receipt hash alone grants no authority. */
export function verifiedPaper2AgentResult(call: Paper2AgentCallRow, job: OneShotJobRow): Paper2AgentResult {
  if (!call.result_json || call.result_status !== "verified") throw new Error("paper2agent_receipt_missing");
  const result = JSON.parse(call.result_json) as Paper2AgentResult;
  assertPaper2AgentEvidence(call, job, result);
  if (receiptResultHash({ receipt: result.receipt, signature: result.receipt_signature }) !== job.receipt_hash) {
    throw new Error("paper2agent_receipt_commitment_mismatch");
  }
  return result;
}

/** Durable before chain catch-up. This is evidence only: Accept still needs exact live lineage. */
export function savePaper2AgentResult(deps: GatewayDeps, jobId: string, ownerId: string, result: Paper2AgentResult): void {
  const call = deps.store.paper2agent.call(jobId);
  const job = deps.store.getOneShotJob(jobId);
  if (!call || !job) throw new Error("paper2agent_journal_missing");
  assertPaper2AgentEvidence(call, job, result);
  deps.store.paper2agent.saveResult(jobId, ownerId, JSON.stringify(result),
    receiptResultHash({ receipt: result.receipt, signature: result.receipt_signature }), result.submitted_ref);
}

export async function savePaper2AgentTransaction(
  deps: GatewayDeps, key: ApiKeyRow, job: OneShotJobRow,
  phase: Paper2AgentTransactionRow["phase"], built: BuildResult,
  escrowRef?: PostEscrowBuildResult["escrowOutputRef"],
): Promise<void> {
  const ctx = deps.registry.getContext(key);
  const call = deps.store.paper2agent.call(job.id);
  if (!call) throw new Error("paper2agent_journal_missing");
  if (phase === "accept") verifiedPaper2AgentResult(call, job);
  const inspected = inspectSignedTransaction(built.txCborHex);
  if (inspected.txHash !== built.expectedTxHash) throw new Error("paper2agent_transaction_hash_mismatch");
  const facts = inspectSignedTransactionFinancials(built.txCborHex);
  const inputs = [];
  let walletInputs = 0n;
  for (const ref of facts.inputs) {
    const utxo = await ctx.chain.queryUtxo(ref);
    if (!utxo) throw new Error("paper2agent_input_value_missing");
    inputs.push({ ref, address: utxo.address, lovelace: utxo.lovelace.toString(), datumHex: utxo.datumHex });
    if (utxo.address === ctx.walletKey.address) walletInputs += utxo.lovelace;
    else {
      if (phase === "post" || !call.original_datum_hex || !utxo.datumHex ||
          `${ref.txHash}#${ref.index}` !== job.submitted_ref) throw new Error("paper2agent_unexpected_input");
      const datum = decodeEscrowDatum(utxo.datumHex);
      assertPaper2AgentDatum(decodeEscrowDatum(call.original_datum_hex), datum);
      if (phase === "accept" && (datum.state !== "Submitted" || datum.result_receipt_hash !== job.receipt_hash)) {
        throw new Error("paper2agent_receipt_commitment_mismatch");
      }
    }
  }
  const collateral = [];
  let collateralValue = 0n;
  for (const ref of facts.collateralInputs) {
    const utxo = await ctx.chain.queryUtxo(ref);
    if (!utxo || utxo.address !== ctx.walletKey.address) throw new Error("paper2agent_collateral_value_missing");
    collateral.push({ ref, lovelace: utxo.lovelace.toString() });
    collateralValue += utxo.lovelace;
  }
  // The ledger takes at most the signed total; a collateral return is not buyer
  // exposure. Without a declared total, the whole pledged input is at risk.
  if (facts.totalCollateralLovelace !== null && facts.totalCollateralLovelace > collateralValue) {
    throw new Error("paper2agent_collateral_mismatch");
  }
  const collateralRisk = facts.totalCollateralLovelace ?? collateralValue;
  const walletOutputs = facts.outputs.reduce((sum, output) => sum + (output.address === ctx.walletKey.address ? output.lovelace : 0n), 0n);
  const supplierAddress = pkhToEnterpriseAddress(job.supplier_pkh!, deps.config.networkId);
  const supplierPayout = facts.outputs.reduce((sum, output) => sum + (output.address === supplierAddress ? output.lovelace : 0n), 0n);
  const patch: Parameters<typeof deps.store.paper2agent.saveTransaction>[2] = {};
  if (phase === "post") {
    if (!escrowRef || escrowRef.txHash !== built.expectedTxHash) throw new Error("paper2agent_post_reference_missing");
    const output = facts.outputs[escrowRef.index];
    if (!output?.datumHex || !call.prepared_json) throw new Error("paper2agent_post_datum_missing");
    const datum = decodeEscrowDatum(output.datumHex);
    const prepared = JSON.parse(call.prepared_json) as { manifest: Paper2AgentManifest; requestHash: string; advert: { buyer_bond_lovelace: string; supplier_bond_lovelace: string } };
    const approval = deps.store.paper2agent.approval(key.id)!;
    if (datum.state !== "Open" || datum.buyer_pkh !== key.wallet_pkh || datum.supplier_pkh !== approval.supplier_pkh ||
        datum.capability_id !== PAPER2AGENT_CAPABILITY_ID || datum.prompt_hash !== prepared.requestHash ||
        datum.request_spec_hash !== paper2AgentRequestSpecHash(prepared.manifest) ||
        paper2AgentManifestHash(prepared.manifest) !== approval.manifest_hash ||
        `${datum.advert_ref.txHash}#${datum.advert_ref.index}` !== job.advert_ref || datum.payment_lovelace.toString() !== job.price_lovelace ||
        datum.payment_lovelace > BigInt(approval.max_price_lovelace) ||
        datum.buyer_bond_lovelace.toString() !== prepared.advert.buyer_bond_lovelace ||
        datum.supplier_bond_lovelace.toString() !== prepared.advert.supplier_bond_lovelace) {
      throw new Error("paper2agent_post_identity_mismatch");
    }
    patch.escrow_ref = `${escrowRef.txHash}#${escrowRef.index}`;
    patch.original_datum_hex = output.datumHex;
    patch.locked_lovelace = output.lovelace.toString();
    patch.post_valid_until_slot = inspected.validUntilSlot;
  }
  deps.store.paper2agent.saveTransaction({ job_id: job.id, phase, tx_hash: built.expectedTxHash, tx_cbor: built.txCborHex,
    fee_lovelace: facts.feeLovelace.toString(), wallet_debit_lovelace: (walletInputs - walletOutputs).toString(),
    collateral_lovelace: collateralRisk.toString(), supplier_payout_lovelace: supplierPayout.toString(),
    facts_json: JSON.stringify({ inputs, collateral, collateralInputLovelace: collateralValue,
      totalCollateralLovelace: facts.totalCollateralLovelace, outputs: facts.outputs },
      (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value),
  }, job.owner_id, patch);
}

export function paper2AgentFinancial(deps: GatewayDeps, jobId: string): JsonObject {
  const call = deps.store.paper2agent.call(jobId)!;
  const txs = deps.store.paper2agent.transactions(jobId);
  const job = deps.store.getOneShotJob(jobId)!;
  const original = call.original_datum_hex ? decodeEscrowDatum(call.original_datum_hex) : null;
  return {
    status: call.financial_status, actual_cost_lovelace: call.actual_cost_lovelace,
    reserved_lovelace: call.accounted ? "0" : call.reserved_lovelace,
    service_price_lovelace: job.price_lovelace,
    buyer_bond_lovelace: original?.buyer_bond_lovelace.toString() ?? null,
    supplier_bond_lovelace: original?.supplier_bond_lovelace.toString() ?? null,
    escrow_lock_lovelace: call.locked_lovelace,
    funding_reserve_lovelace: call.locked_lovelace === null ? null : (BigInt(call.locked_lovelace) + 7_000_000n).toString(),
    terminal_tx_hash: job.settle_tx_hash,
    buyer_paid_fees_lovelace: txs.some((tx) => !tx.confirmed) ? null : txs.reduce((sum, tx) => sum + BigInt(tx.fee_lovelace), 0n).toString(),
    supplier_payout_lovelace: call.financial_status === "accepted"
      ? txs.filter((tx) => tx.confirmed).reduce((sum, tx) => sum + BigInt(tx.supplier_payout_lovelace), 0n).toString() : null,
    transactions: txs.map((tx) => ({ phase: tx.phase, tx_hash: tx.tx_hash, confirmed: tx.confirmed === 1,
      fee_lovelace: tx.fee_lovelace, wallet_debit_lovelace: tx.wallet_debit_lovelace, collateral_at_risk_lovelace: tx.collateral_lovelace })),
  };
}
