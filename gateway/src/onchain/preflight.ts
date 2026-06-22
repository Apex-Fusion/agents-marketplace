/**
 * gateway/src/onchain/preflight.ts — balance + collateral pre-flight.
 *
 * The buyer wallet funds the FULL escrow at PostEscrow: price + buyer_bond +
 * supplier_bond (postEscrow.ts:132). Accept/Reclaim are Plutus script-spends
 * that also need a pure-ADA collateral UTxO ≥ 5 ADA (assertCollateralCandidate).
 * So required = price + buyer_bond + supplier_bond + collateral + fee reserve,
 * AND the wallet must currently hold a pure-ADA UTxO ≥ collateral. We check both
 * up front and return a clean 402 instead of failing mid-flight.
 */

import type { ChainProvider, Utxo } from "@marketplace/shared/chain";

export const COLLATERAL_MIN_LOVELACE = 5_000_000n;
export const FEE_RESERVE_LOVELACE = 2_000_000n;

export function totalLovelace(utxos: Utxo[]): bigint {
  return utxos.reduce((sum, u) => sum + u.lovelace, 0n);
}

/** True iff some UTxO is pure-ADA (no native assets) and ≥ collateral floor. */
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

export async function preflight(
  chain: ChainProvider,
  address: string,
  cost: { priceLovelace: bigint; buyerBondLovelace: bigint; supplierBondLovelace: bigint },
): Promise<PreflightResult> {
  const utxos = await chain.queryUtxosByAddress(address);
  const available = totalLovelace(utxos);
  const collateralOk = hasCollateral(utxos);
  const required =
    cost.priceLovelace +
    cost.buyerBondLovelace +
    cost.supplierBondLovelace +
    COLLATERAL_MIN_LOVELACE +
    FEE_RESERVE_LOVELACE;
  return {
    ok: available >= required && collateralOk,
    availableLovelace: available,
    requiredLovelace: required,
    collateralOk,
  };
}
