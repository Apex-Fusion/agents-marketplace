/**
 * planConsolidate.ts — pure pre-flight planner for the wallet-consolidate flow.
 *
 * Given a wallet's current UTxO set + a target collateral lovelace, decide
 * whether the wallet needs reshaping or is already usable for script spends.
 *
 * Healthy is a STRUCTURAL predicate, not a UTxO count (F7, 2026-08-08):
 *   (a) some pure-lovelace UTxO >= collateralLovelace exists (the collateral
 *       candidate lucid's setCollateral needs), AND
 *   (b) at least MIN_WORKING_LOVELACE sits OUTSIDE that candidate (fee and
 *       spend money that is not the candidate), AND
 *   (c) fragmentation is bounded (utxos.length <= limits.maxUtxos), AND
 *   (d) with limits.minWorkingUtxo: the working UTxO is not below that value
 *       while the other UTxOs can fill it again (see ConsolidateLimits).
 *
 * The earlier revision returned `already-healthy` only for EXACTLY 2 UTxOs.
 * The consolidate tx itself lands 3 (collateral + working + the fee-reserve
 * remainder as change), so the shape consolidation produced could never
 * satisfy its own health check — the wallet-health ticker re-consolidated
 * every tick and burned 0.5 AP3X per pass (116 AP3X in one 24h soak).
 * The health check also runs BEFORE the low-balance guard now: a wallet that
 * can already transact must never be told "balance too low to consolidate".
 *
 * One reshape spends at most MAX_CONSOLIDATE_INPUTS UTxOs (2026-11-19). A
 * reshape of every UTxO of a large wallet gave a transaction that Vector
 * refuses, so such a wallet could never be reshaped again. The UTxOs that a
 * run leaves stay for the next run (`remainingUtxos`).
 *
 * No lucid / WASM deps so this is unit-testable from a vanilla vitest.
 */

export interface UtxoLike {
  assets: { lovelace?: bigint } & Record<string, bigint | undefined>;
}

export type ConsolidateReason = "consolidate" | "split" | "already-healthy";

/** When a wallet is reshaped. The defaults are right for a wallet that makes few transactions. */
export interface ConsolidateLimits {
  /** Reshape when the wallet holds more UTxOs than this. Default: DEFAULT_MAX_UTXOS. */
  maxUtxos?: number;
  /**
   * Low mark of the working UTxO: the UTxO with the most lovelace besides the collateral candidate. Lucid pays each
   * fee from the UTxO with the most lovelace. When the working UTxO holds less than the candidate, lucid pays from
   * the candidate, and after that no UTxO can be the collateral. With this value the wallet is reshaped when the
   * working UTxO is below it and the other UTxOs hold at least LOW_WORKING_MIN_GAIN_RESERVES fee reserves, so a wallet
   * with little money is not reshaped again and again. Default 0: the rule is off.
   */
  minWorkingUtxo?: bigint;
}

export interface PlannedConsolidate<T extends UtxoLike = UtxoLike> {
  /** The UTxOs that the reshape spends. Empty when the wallet is already healthy. */
  inputs: T[];
  /** Number of UTxOs that the reshape spends; the UTxO count of the wallet when it is already healthy. */
  inputCount: number;
  /** Wallet UTxOs that the reshape leaves, because one run spends at most MAX_CONSOLIDATE_INPUTS. */
  remainingUtxos: number;
  totalLovelaceIn: bigint;
  collateralOutput: bigint;
  workingOutput: bigint;
  alreadyHealthy: boolean;
  reason: ConsolidateReason;
}

export const DEFAULT_COLLATERAL_LOVELACE = 5_000_000n;
export const DEFAULT_FEE_RESERVE = 2_000_000n;
/** Reshape only when fragmentation passes this; receipt/change UTxOs
 *  accumulating between jobs are fine as long as a candidate exists. */
export const DEFAULT_MAX_UTXOS = 6;
/**
 * One reshape spends at most this many UTxOs: the ones with the most lovelace. Two limits of Vector give the value
 * (seen on 2026-11-19, supplier wallets with 455 to 533 UTxOs):
 *   - a transaction has at most 16,384 bytes, and 455 inputs gave 16,619 bytes (about 36 bytes for each input);
 *   - the builder pays the fee floor of 500,000 lovelace, and Vector asks 45 lovelace for each byte plus 156,253.
 *     Above about 7,600 bytes (about 200 inputs) the node refuses the transaction. 180 inputs give about 6,800 bytes.
 */
export const MAX_CONSOLIDATE_INPUTS = 180;
/** Rule (d) reshapes only when the UTxOs besides the candidate and the working UTxO hold this many fee reserves. */
export const LOW_WORKING_MIN_GAIN_RESERVES = 4n;
const MIN_WORKING_LOVELACE = 1_000_000n;

/** Lovelace of a UTxO iff it carries no native assets; null otherwise. */
function pureLovelace(u: UtxoLike): bigint | null {
  for (const [unit, amount] of Object.entries(u.assets)) {
    if (unit !== "lovelace" && (amount ?? 0n) > 0n) return null;
  }
  return u.assets.lovelace ?? 0n;
}

function lovelaceOf(u: UtxoLike): bigint {
  return u.assets.lovelace ?? 0n;
}

function mostLovelaceFirst(a: UtxoLike, b: UtxoLike): number {
  const left = lovelaceOf(a);
  const right = lovelaceOf(b);
  return left > right ? -1 : left < right ? 1 : 0;
}

export function planConsolidate<T extends UtxoLike>(
  utxos: T[],
  collateralLovelace: bigint = DEFAULT_COLLATERAL_LOVELACE,
  feeReserve: bigint = DEFAULT_FEE_RESERVE,
  limits: ConsolidateLimits = {},
): PlannedConsolidate<T> {
  if (utxos.length === 0) {
    throw new Error("wallet has no UTxOs — fund the address first");
  }
  const maxUtxos = limits.maxUtxos ?? DEFAULT_MAX_UTXOS;
  const minWorkingUtxo = limits.minWorkingUtxo ?? 0n;

  const walletLovelace = utxos.reduce((acc, u) => acc + lovelaceOf(u), 0n);

  // Structural health check first — reshaping a usable wallet wastes a fee.
  if (utxos.length <= maxUtxos) {
    // Smallest qualifying candidate: leave larger UTxOs as working funds.
    let candidate: T | null = null;
    let candidateLovelace = 0n;
    for (const u of utxos) {
      const pure = pureLovelace(u);
      if (pure !== null && pure >= collateralLovelace) {
        if (candidate === null || pure < candidateLovelace) {
          candidate = u;
          candidateLovelace = pure;
        }
      }
    }
    if (candidate !== null) {
      const workingOutside = walletLovelace - candidateLovelace;
      let workingUtxo = 0n;
      for (const u of utxos) {
        if (u !== candidate && lovelaceOf(u) > workingUtxo) workingUtxo = lovelaceOf(u);
      }
      const workingIsLow =
        workingUtxo < minWorkingUtxo &&
        workingOutside - workingUtxo >= LOW_WORKING_MIN_GAIN_RESERVES * feeReserve;
      if (workingOutside >= MIN_WORKING_LOVELACE && !workingIsLow) {
        return {
          inputs: [],
          inputCount: utxos.length,
          remainingUtxos: 0,
          totalLovelaceIn: walletLovelace,
          collateralOutput: candidateLovelace,
          workingOutput: workingOutside,
          alreadyHealthy: true,
          reason: "already-healthy",
        };
      }
    }
  }

  // Reshape needed. One run spends the UTxOs with the most lovelace, up to the limit.
  const inputs =
    utxos.length <= MAX_CONSOLIDATE_INPUTS
      ? utxos
      : [...utxos].sort(mostLovelaceFirst).slice(0, MAX_CONSOLIDATE_INPUTS);
  const totalLovelaceIn =
    inputs === utxos ? walletLovelace : inputs.reduce((acc, u) => acc + lovelaceOf(u), 0n);

  // Only an actual reshape has a funds threshold.
  const required = collateralLovelace + feeReserve + MIN_WORKING_LOVELACE;
  if (totalLovelaceIn < required) {
    throw new Error(
      `balance too low to consolidate: have ${totalLovelaceIn} lovelace, ` +
        `need at least ${required} (= ${collateralLovelace} collateral + ` +
        `${feeReserve} fee reserve + ${MIN_WORKING_LOVELACE} min working)`,
    );
  }

  const workingOutput = totalLovelaceIn - collateralLovelace - feeReserve;

  return {
    inputs,
    inputCount: inputs.length,
    remainingUtxos: utxos.length - inputs.length,
    totalLovelaceIn,
    collateralOutput: collateralLovelace,
    workingOutput,
    alreadyHealthy: false,
    reason: utxos.length === 1 ? "split" : "consolidate",
  };
}
