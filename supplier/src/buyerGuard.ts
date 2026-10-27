/**
 * supplier/src/buyerGuard.ts — interim guard: one acceptable job per buyer.
 *
 * The deployed escrow validator checks the Accept payout by summing every
 * output to the supplier key and does not limit escrow inputs per
 * transaction. A buyer holding two Submitted escrows of this supplier inside
 * their accept windows can Accept both in one transaction and pay the
 * supplier once. Until the escrow validator requires one escrow input per
 * transaction, the supplier refuses to Claim a buyer's escrow while another
 * escrow of the same buyer and this supplier key can still be Accepted:
 *   - Claimed and before its deliver_by (it can still be Submitted), or
 *   - Submitted and inside submitted_at + ACCEPT_WINDOW_MS.
 *
 * Refusing costs the supplier nothing: Claim adds no value, the escrow stays
 * Open, and the buyer sends again after the other job settles (every buyer
 * already retries 409 `supplier_busy` on the same escrow) or Reclaims after
 * deliver_by.
 *
 * The check scans the escrow script address on chain, as tx:release-escrows
 * does, so it holds across restarts and across processes sharing the supplier
 * key. Callers run it while they hold the only slot that can Claim (capacity
 * 1), or inside walletMutex right before buildClaimTx (chat sessions), so a
 * claim this process just confirmed is visible to the next check.
 *
 * Buyer keys listed in BUYER_GUARD_EXEMPT_PKHS (first-party buyers such as
 * the gateway) skip the check.
 */

import type { ChainProvider, OutputReference, Utxo } from "@marketplace/shared/chain";
import { decodeEscrowDatum } from "@marketplace/shared/cbor";
import { ACCEPT_WINDOW_MS, loadBlueprint } from "@marketplace/shared/tx";

/** Clock-skew allowance on both deadlines: refuse a little longer, never shorter. */
export const BUYER_GUARD_MARGIN_MS = 60_000;

export interface AcceptableJob {
  ref: OutputReference;
  state: "Claimed" | "Submitted";
  /** Latest wallclock ms at which the buyer could still Accept this escrow. */
  acceptableUntilMs: number;
}

export interface BuyerGuardParams {
  chain: ChainProvider;
  escrowAddress: string;
  supplierPkh: string;
  buyerPkh: string;
  /** The escrow being admitted; never counts against itself. */
  exclude: OutputReference;
  nowMs: number;
  exemptBuyerPkhs?: readonly string[];
}

/**
 * The escrow address to scan. Live: the marketplace escrow script address, so
 * a request cannot point the scan at an arbitrary address. Mock chains: the
 * address the admitted escrow sits at (test fixtures use a placeholder).
 */
export function escrowScanAddress(isLive: boolean, networkId: 0 | 1, escrowUtxo: Utxo): string {
  return isLive ? loadBlueprint().escrowScriptAddress(networkId) : escrowUtxo.address;
}

/**
 * Another escrow of the same buyer and supplier that can still be Accepted,
 * or null. When several exist, returns the one acceptable longest.
 */
export async function findAcceptableJobOfBuyer(p: BuyerGuardParams): Promise<AcceptableJob | null> {
  if (p.exemptBuyerPkhs?.includes(p.buyerPkh.toLowerCase())) return null;

  let found: AcceptableJob | null = null;
  for (const utxo of await p.chain.queryUtxosByAddress(p.escrowAddress)) {
    if (!utxo.datumHex) continue;
    if (utxo.ref.txHash === p.exclude.txHash && utxo.ref.index === p.exclude.index) continue;
    let datum;
    try {
      datum = decodeEscrowDatum(utxo.datumHex);
    } catch {
      continue; // foreign or malformed datum at the script address
    }
    if (datum.supplier_pkh !== p.supplierPkh || datum.buyer_pkh !== p.buyerPkh) continue;

    let acceptableUntilMs: number;
    if (datum.state === "Claimed") {
      if (p.nowMs >= datum.deliver_by + BUYER_GUARD_MARGIN_MS) continue; // stray: can never be Submitted
      acceptableUntilMs = datum.deliver_by + ACCEPT_WINDOW_MS;
    } else if (datum.state === "Submitted" && datum.submitted_at !== null) {
      acceptableUntilMs = datum.submitted_at + ACCEPT_WINDOW_MS;
      if (p.nowMs > acceptableUntilMs + BUYER_GUARD_MARGIN_MS) continue; // past the window: only Release remains
    } else {
      continue;
    }
    if (found === null || acceptableUntilMs > found.acceptableUntilMs) {
      found = { ref: utxo.ref, state: datum.state, acceptableUntilMs };
    }
  }
  return found;
}

/** Retry-After seconds for a refused buyer (at least 1). */
export function retryAfterSeconds(job: AcceptableJob, nowMs: number): number {
  return Math.max(1, Math.ceil((job.acceptableUntilMs + BUYER_GUARD_MARGIN_MS - nowMs) / 1000));
}

export function buyerBusyMessage(job: AcceptableJob): string {
  return `supplier has escrow ${job.ref.txHash}#${job.ref.index} (${job.state}) from this buyer that can still be accepted; send again after it is accepted or released`;
}
