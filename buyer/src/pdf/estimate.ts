/**
 * buyer/src/pdf/estimate.ts — pure cost math, computed BEFORE any escrow is
 * posted so the operator can confirm the spend.
 *
 * A job's call count = mapCalls (one per chunk) + reduceCalls (the hierarchical
 * reduce tree). Each call pays exactly one supplier's flat price_lovelace; the
 * pool mixes prices, so we bound the total with the priciest supplier.
 */

import type { SupplierPool } from "./supplier-pool.js";

/**
 * Number of reduce calls in an F-ary reduce tree over `n` leaves.
 * e.g. n=90,F=8 → 12 + 2 + 1 = 15; n=8 → 1; n=1 → 0.
 */
export function reduceCallCount(n: number, fanin: number): number {
  if (n <= 1 || fanin < 2) return 0;
  let total = 0;
  let level = n;
  while (level > 1) {
    level = Math.ceil(level / fanin);
    total += level;
  }
  return total;
}

export interface JobEstimate {
  mapCalls: number;
  reduceCalls: number;
  totalCalls: number;
  /** Upper-bound per-call price (priciest supplier), lovelace. */
  perCallMaxLovelace: string;
  /** Upper-bound total payment, lovelace. */
  totalLovelace: string;
  /** Same, expressed in AP3X (1 AP3X = 1e6 lovelace), 2dp. */
  totalAp3x: string;
}

export function estimateJob(
  chunkCount: number,
  fanin: number,
  pool: SupplierPool,
): JobEstimate {
  const mapCalls = chunkCount;
  const reduceCalls = reduceCallCount(chunkCount, fanin);
  const totalCalls = mapCalls + reduceCalls;
  const priceMax = pool.maxPrice();
  const totalLovelace = priceMax * BigInt(totalCalls);
  return {
    mapCalls,
    reduceCalls,
    totalCalls,
    perCallMaxLovelace: priceMax.toString(),
    totalLovelace: totalLovelace.toString(),
    totalAp3x: (Number(totalLovelace) / 1e6).toFixed(2),
  };
}

/**
 * Conservative lovelace headroom for chain fees + transient bonds across a
 * whole job. The buyer pays PostEscrow + Accept fees per call and locks a
 * 1 AP3X bond transiently; this over-estimates so the wallet floor check
 * errs safe.
 */
export function feeHeadroomLovelace(totalCalls: number): bigint {
  return BigInt(totalCalls) * 1_000_000n + 2_000_000n;
}
