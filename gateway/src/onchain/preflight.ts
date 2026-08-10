/**
 * gateway/src/onchain/preflight.ts — balance + collateral pre-flight.
 *
 * The buyer wallet funds the FULL escrow at PostEscrow: price + buyer_bond +
 * supplier_bond, raised to the Submitted-state min-ada floor so long
 * capability ids (e.g. the 33-byte OCR one) don't get bumped mid-flight —
 * see escrowLockFloor (packages/shared/.../minAdaFloor.ts) and
 * postOcrEscrow.ts:205, the SAME floor a POST actually locks. Accept/Reclaim
 * are Plutus script-spends that also need a pure-AP3X collateral UTxO ≥ 5
 * AP3X (assertCollateralCandidate). So required = escrowLockFloor(price +
 * buyer_bond + supplier_bond) + collateral + fee reserve, AND the wallet
 * must currently hold a pure-AP3X UTxO ≥ collateral. We check both up front
 * and return a clean 402 instead of failing mid-flight.
 */

import type { ChainProvider, Utxo } from "@marketplace/shared/chain";
import type { EscrowDatum } from "@marketplace/shared/cbor";
import { escrowLockFloor } from "@marketplace/shared/tx";

export const COLLATERAL_MIN_LOVELACE = 5_000_000n;
export const FEE_RESERVE_LOVELACE = 2_000_000n;

export function totalLovelace(utxos: Utxo[]): bigint {
  return utxos.reduce((sum, u) => sum + u.lovelace, 0n);
}

/** True iff some UTxO is pure-AP3X (no native assets) and ≥ collateral floor. */
export function hasCollateral(utxos: Utxo[]): boolean {
  return utxos.some(
    (u) => u.lovelace >= COLLATERAL_MIN_LOVELACE && Object.keys(u.assets).length === 0,
  );
}

export interface PreflightResult {
  ok: boolean;
  availableLovelace: bigint;
  requiredLovelace: bigint;
  collateralOk: boolean;
}

export interface PreflightCost {
  capabilityId: string;
  priceLovelace: bigint;
  buyerBondLovelace: bigint;
  supplierBondLovelace: bigint;
}

/** Placeholder datum used only to size-estimate the Submitted-state min-ada
 * floor. Every field except capability_id and the cost amounts is a
 * fixed-size stand-in (real hash/pkh byte widths, a realistic 13-digit
 * POSIX-ms timestamp) — capability_id's actual length is what drives the
 * estimate, exactly as in escrowLockFloor's own contract. */
function representativeEscrowDatum(cost: PreflightCost): EscrowDatum {
  return {
    buyer_pkh: "3b2fdaed0398485ff35887fb7d0ad2025348864407854f7831dc6a55",
    supplier_pkh: "401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
    advert_ref: { txHash: "a6".repeat(32), index: 0 },
    capability_id: cost.capabilityId,
    request_spec_hash: "1b".repeat(32),
    prompt_hash: "23".repeat(32),
    payment_lovelace: cost.priceLovelace,
    buyer_bond_lovelace: cost.buyerBondLovelace,
    supplier_bond_lovelace: cost.supplierBondLovelace,
    deliver_by: 1_786_105_955_257,
    posted_at: 1_786_105_625_257,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };
}

export async function preflight(
  chain: ChainProvider,
  address: string,
  cost: PreflightCost,
): Promise<PreflightResult> {
  const utxos = await chain.queryUtxosByAddress(address);
  const available = totalLovelace(utxos);
  const collateralOk = hasCollateral(utxos);
  const economicTotal = cost.priceLovelace + cost.buyerBondLovelace + cost.supplierBondLovelace;
  const escrowFloor = escrowLockFloor(representativeEscrowDatum(cost), economicTotal);
  const required = escrowFloor + COLLATERAL_MIN_LOVELACE + FEE_RESERVE_LOVELACE;
  return {
    ok: available >= required && collateralOk,
    availableLovelace: available,
    requiredLovelace: required,
    collateralOk,
  };
}
