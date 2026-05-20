/**
 * planConsolidate.ts — pure pre-flight planner for the wallet-consolidate flow.
 *
 * Given a wallet's current UTxO set + a target collateral lovelace, decide
 * whether to consolidate (many → 2), split (1 → 2), or skip (already at
 * {≥collateral, working}). The same downstream tx-builder handles
 * consolidate and split — only the "reason" tag differs for logging.
 *
 * No lucid / WASM deps so this is unit-testable from a vanilla vitest.
 */

export interface UtxoLike {
  assets: { lovelace?: bigint } & Record<string, bigint | undefined>;
}

export type ConsolidateReason = "consolidate" | "split" | "already-healthy";

export interface PlannedConsolidate {
  inputCount: number;
  totalLovelaceIn: bigint;
  collateralOutput: bigint;
  workingOutput: bigint;
  alreadyHealthy: boolean;
  reason: ConsolidateReason;
}

export const DEFAULT_COLLATERAL_LOVELACE = 5_000_000n;
export const DEFAULT_FEE_RESERVE = 2_000_000n;
const MIN_WORKING_LOVELACE = 1_000_000n;

export function planConsolidate(
  utxos: UtxoLike[],
  collateralLovelace: bigint = DEFAULT_COLLATERAL_LOVELACE,
  feeReserve: bigint = DEFAULT_FEE_RESERVE,
): PlannedConsolidate {
  if (utxos.length === 0) {
    throw new Error("wallet has no UTxOs — fund the address first");
  }

  const totalLovelaceIn = utxos.reduce(
    (acc, u) => acc + (u.assets.lovelace ?? 0n),
    0n,
  );

  const required = collateralLovelace + feeReserve + MIN_WORKING_LOVELACE;
  if (totalLovelaceIn < required) {
    throw new Error(
      `balance too low to consolidate: have ${totalLovelaceIn} lovelace, ` +
        `need at least ${required} (= ${collateralLovelace} collateral + ` +
        `${feeReserve} fee reserve + ${MIN_WORKING_LOVELACE} min working)`,
    );
  }

  if (utxos.length === 2) {
    const lov0 = utxos[0].assets.lovelace ?? 0n;
    const lov1 = utxos[1].assets.lovelace ?? 0n;
    const smaller = lov0 < lov1 ? lov0 : lov1;
    const larger = lov0 < lov1 ? lov1 : lov0;
    if (smaller >= collateralLovelace) {
      return {
        inputCount: 2,
        totalLovelaceIn,
        collateralOutput: smaller,
        workingOutput: larger,
        alreadyHealthy: true,
        reason: "already-healthy",
      };
    }
  }

  const workingOutput = totalLovelaceIn - collateralLovelace - feeReserve;

  return {
    inputCount: utxos.length,
    totalLovelaceIn,
    collateralOutput: collateralLovelace,
    workingOutput,
    alreadyHealthy: false,
    reason: utxos.length === 1 ? "split" : "consolidate",
  };
}
