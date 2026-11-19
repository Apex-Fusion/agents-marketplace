/**
 * tx-consolidate-wallet.test.ts — pure unit tests for the consolidate
 * planner. Drives planConsolidate directly without lucid / WASM.
 */

import { describe, it, expect } from "vitest";
import {
  planConsolidate,
  DEFAULT_COLLATERAL_LOVELACE,
  DEFAULT_FEE_RESERVE,
  MAX_CONSOLIDATE_INPUTS,
  type UtxoLike,
} from "../../packages/shared/src/tx/wallet/planConsolidate.js";

function u(lovelace: bigint): UtxoLike {
  return { assets: { lovelace } };
}

describe("planConsolidate", () => {
  it("consolidates a fragmented wallet (8 UTxOs, max 2.4 AP3X)", () => {
    const utxos: UtxoLike[] = [
      u(2_400_750n),
      u(1_679_301n),
      u(1_679_301n),
      u(1_679_301n),
      u(1_679_301n),
      u(1_679_301n),
      u(1_679_301n),
      u(1_679_301n),
    ];
    const total = utxos.reduce((s, x) => s + x.assets.lovelace, 0n);

    const plan = planConsolidate(utxos);

    expect(plan.reason).toBe("consolidate");
    expect(plan.alreadyHealthy).toBe(false);
    expect(plan.inputCount).toBe(8);
    expect(plan.totalLovelaceIn).toBe(total);
    expect(plan.collateralOutput).toBe(DEFAULT_COLLATERAL_LOVELACE);
    expect(plan.workingOutput).toBe(
      total - DEFAULT_COLLATERAL_LOVELACE - DEFAULT_FEE_RESERVE,
    );
  });

  it("splits a single large UTxO into 2 outputs", () => {
    const utxos = [u(17_500_000n)];
    const plan = planConsolidate(utxos);

    expect(plan.reason).toBe("split");
    expect(plan.alreadyHealthy).toBe(false);
    expect(plan.inputCount).toBe(1);
    expect(plan.collateralOutput).toBe(DEFAULT_COLLATERAL_LOVELACE);
    expect(plan.workingOutput).toBe(
      17_500_000n - DEFAULT_COLLATERAL_LOVELACE - DEFAULT_FEE_RESERVE,
    );
  });

  it("skips a wallet already in {collateral, working} shape", () => {
    const utxos = [u(5_000_000n), u(8_650_000n)];
    const plan = planConsolidate(utxos);

    expect(plan.reason).toBe("already-healthy");
    expect(plan.alreadyHealthy).toBe(true);
    expect(plan.collateralOutput).toBe(5_000_000n);
    expect(plan.workingOutput).toBe(8_650_000n);
  });

  it("accepts a 2-UTxO wallet where the LARGER is the collateral candidate", () => {
    // {3, 15}: the 15 qualifies as a pure >=5 candidate and the 3 covers
    // fees — this wallet can run script txs as-is. The old exact-2-slot
    // convention reshaped it for nothing (0.5 AP3X per pass).
    const utxos = [u(3_000_000n), u(15_000_000n)];
    const plan = planConsolidate(utxos);

    expect(plan.reason).toBe("already-healthy");
    expect(plan.alreadyHealthy).toBe(true);
    expect(plan.collateralOutput).toBe(15_000_000n);
    expect(plan.workingOutput).toBe(3_000_000n);
  });

  it("throws on 0 UTxOs", () => {
    expect(() => planConsolidate([])).toThrow(/no UTxOs/i);
  });

  it("throws on balance below threshold", () => {
    // 4 AP3X total — under 5 + 2 + 1 = 8 AP3X required minimum.
    const utxos = [u(2_000_000n), u(2_000_000n)];
    expect(() => planConsolidate(utxos)).toThrow(/balance too low/i);
  });

  it("respects custom collateralLovelace", () => {
    const utxos = [u(20_000_000n)];
    const plan = planConsolidate(utxos, 10_000_000n);

    expect(plan.reason).toBe("split");
    expect(plan.collateralOutput).toBe(10_000_000n);
    expect(plan.workingOutput).toBe(20_000_000n - 10_000_000n - DEFAULT_FEE_RESERVE);
  });
});

describe("planConsolidate — structural health predicate (F7)", () => {
  // The tx buildConsolidateWalletTx actually lands: {collateral 5.0,
  // working = total - 5.0 - 2.0 reserve, change = reserve - fee}. The fee
  // observed on mainnet is exactly 501,628, so the change is 1,498,372.
  const MAINNET_CONSOLIDATE_FEE = 501_628n;

  it("REGRESSION: the exact shape consolidation produces is healthy", () => {
    // This is the loop that burned 116 AP3X in the 2026-08-07 soak: the
    // planner called its own output shape unhealthy and re-consolidated
    // every 45s tick. Feed it precisely what the builder lands.
    const utxos = [
      u(5_000_000n),
      u(91_000_000n),
      u(DEFAULT_FEE_RESERVE - MAINNET_CONSOLIDATE_FEE), // 1,498,372 change
    ];
    const plan = planConsolidate(utxos);

    expect(plan.reason).toBe("already-healthy");
    expect(plan.alreadyHealthy).toBe(true);
    expect(plan.collateralOutput).toBe(5_000_000n);
  });

  it("is idempotent: applying the builder's output model to any plan yields healthy", () => {
    const fragmented = [u(2_400_750n), u(4_100_000n), u(1_679_301n), u(1_679_301n)];
    const plan = planConsolidate(fragmented);
    expect(plan.alreadyHealthy).toBe(false);

    // Model of what buildConsolidateWalletTx lands for this plan.
    const afterConsolidation = [
      u(plan.collateralOutput),
      u(plan.workingOutput),
      u(DEFAULT_FEE_RESERVE - MAINNET_CONSOLIDATE_FEE),
    ];
    const replan = planConsolidate(afterConsolidation);

    expect(replan.reason).toBe("already-healthy");
    expect(replan.alreadyHealthy).toBe(true);
  });

  it("still consolidates when fragmentation exceeds the max UTxO bound", () => {
    // Candidate present, but 7 UTxOs > DEFAULT_MAX_UTXOS (6).
    const utxos = [
      u(5_000_000n), u(1_100_000n), u(1_100_000n), u(1_100_000n),
      u(1_100_000n), u(1_100_000n), u(1_100_000n),
    ];
    const plan = planConsolidate(utxos);
    expect(plan.reason).toBe("consolidate");
  });

  it("still consolidates when no pure UTxO reaches the collateral threshold", () => {
    // The 2026-08-07 batch-stall shape: fragments only, max 4,498,372.
    const utxos = [u(4_498_372n), u(3_098_372n), u(1_498_372n)];
    const plan = planConsolidate(utxos);
    expect(plan.reason).toBe("consolidate");
    expect(plan.alreadyHealthy).toBe(false);
  });

  it("a UTxO 1,628 lovelace short of collateral is not a candidate", () => {
    // Seen live: 4,998,372 (= 5.0 minus a 501,628 fee twice-shuffled).
    const utxos = [u(4_998_372n), u(9_000_000n - 4_998_372n)];
    const plan = planConsolidate(utxos);
    expect(plan.reason).toBe("consolidate");
  });

  it("a UTxO carrying native assets is not a collateral candidate", () => {
    const withToken: UtxoLike = {
      assets: { lovelace: 6_000_000n, "deadbeef.72737456": 1n },
    };
    const utxos = [withToken, u(4_000_000n)];
    const plan = planConsolidate(utxos);
    expect(plan.reason).toBe("consolidate");
  });

  it("healthy shape below the reshape threshold is healthy, not an error", () => {
    // {5.0, 2.5} = 7.5 total: under the 8.0 reshape minimum but perfectly
    // able to run script txs. The old order threw "balance too low" here
    // on every tick (1,744 log lines in the soak).
    const utxos = [u(5_000_000n), u(2_500_000n)];
    const plan = planConsolidate(utxos);
    expect(plan.reason).toBe("already-healthy");
  });

  it("candidate with only dust outside it needs a reshape it cannot afford", () => {
    // {5.0, 0.4}: no working money outside the candidate, and 5.4 total is
    // below the reshape minimum — loud error, funds needed.
    const utxos = [u(5_000_000n), u(400_000n)];
    expect(() => planConsolidate(utxos)).toThrow(/balance too low/i);
  });
});

describe("planConsolidate — input limit", () => {
  it("spends the UTxOs with the most lovelace and leaves the others for the next run", () => {
    // A juror supplier wallet of 2026-11-19: no UTxO for the collateral, and 452 payouts of 2 AP3X.
    const change = u(1_498_372n);
    const utxos = [u(4_718_055n), change, u(4_498_372n), ...Array.from({ length: 452 }, () => u(2_000_000n))];
    const plan = planConsolidate(utxos);

    const spent = 4_718_055n + 4_498_372n + BigInt(MAX_CONSOLIDATE_INPUTS - 2) * 2_000_000n;
    expect(plan.reason).toBe("consolidate");
    expect(plan.inputs).toHaveLength(MAX_CONSOLIDATE_INPUTS);
    expect(plan.inputs).not.toContain(change);
    expect(plan.inputCount).toBe(MAX_CONSOLIDATE_INPUTS);
    expect(plan.remainingUtxos).toBe(utxos.length - MAX_CONSOLIDATE_INPUTS);
    expect(plan.totalLovelaceIn).toBe(spent);
    expect(plan.workingOutput).toBe(spent - DEFAULT_COLLATERAL_LOVELACE - DEFAULT_FEE_RESERVE);
  });

  it("spends every UTxO of a wallet at the limit", () => {
    const utxos = Array.from({ length: MAX_CONSOLIDATE_INPUTS }, () => u(2_000_000n));
    const plan = planConsolidate(utxos);

    expect(plan.inputs).toHaveLength(MAX_CONSOLIDATE_INPUTS);
    expect(plan.remainingUtxos).toBe(0);
  });

  it("refuses a run whose UTxOs hold too little, also when the full wallet holds enough", () => {
    // 300 UTxOs of 0.03 AP3X hold 9 AP3X. The 180 of one run hold 5.4 AP3X: below the 8 AP3X of a reshape.
    const utxos = Array.from({ length: 300 }, () => u(30_000n));
    expect(() => planConsolidate(utxos)).toThrow(/balance too low/i);
  });
});

describe("planConsolidate — limits of a busy wallet", () => {
  const LIMITS = { maxUtxos: 150, minWorkingUtxo: 25_000_000n };
  const payouts = (count: number): UtxoLike[] => Array.from({ length: count }, () => u(2_000_000n));

  it("leaves the payouts alone while the working UTxO is high", () => {
    const utxos = [u(5_000_000n), u(400_000_000n), ...payouts(100)];

    expect(planConsolidate(utxos, DEFAULT_COLLATERAL_LOVELACE, DEFAULT_FEE_RESERVE, LIMITS).reason).toBe("already-healthy");
    // Without the limits the same wallet is reshaped: more than 6 UTxOs.
    expect(planConsolidate(utxos).reason).toBe("consolidate");
  });

  it("reshapes above maxUtxos, in one run", () => {
    const utxos = [u(5_000_000n), u(400_000_000n), ...payouts(149)];
    const plan = planConsolidate(utxos, DEFAULT_COLLATERAL_LOVELACE, DEFAULT_FEE_RESERVE, LIMITS);

    expect(plan.reason).toBe("consolidate");
    expect(plan.inputCount).toBe(151);
    expect(plan.remainingUtxos).toBe(0);
  });

  it("reshapes when the working UTxO is low and the payouts can fill it", () => {
    const utxos = [u(5_000_000n), u(24_000_000n), ...payouts(60)];
    const plan = planConsolidate(utxos, DEFAULT_COLLATERAL_LOVELACE, DEFAULT_FEE_RESERVE, LIMITS);

    expect(plan.reason).toBe("consolidate");
    expect(plan.workingOutput).toBe(149_000_000n - DEFAULT_COLLATERAL_LOVELACE - DEFAULT_FEE_RESERVE);
  });

  it("does not reshape a wallet with little money again and again", () => {
    // {5, 13, change}: the working UTxO is below the low mark, and the other UTxOs cannot fill it.
    const poor = [u(5_000_000n), u(13_000_000n), u(1_498_372n)];
    expect(planConsolidate(poor, DEFAULT_COLLATERAL_LOVELACE, DEFAULT_FEE_RESERVE, LIMITS).reason).toBe("already-healthy");

    // After 4 jobs: 4 payouts, and the working UTxO paid 8 fees. Now a reshape moves 4 fee reserves.
    const later = [u(5_000_000n), u(13_000_000n - 4n * 1_003_256n), u(1_498_372n), ...payouts(4)];
    const plan = planConsolidate(later, DEFAULT_COLLATERAL_LOVELACE, DEFAULT_FEE_RESERVE, LIMITS);
    expect(plan.reason).toBe("consolidate");

    // The shape that the reshape lands is healthy: the next tick sends no transaction.
    const landed = [u(plan.collateralOutput), u(plan.workingOutput), u(DEFAULT_FEE_RESERVE - 501_628n)];
    expect(planConsolidate(landed, DEFAULT_COLLATERAL_LOVELACE, DEFAULT_FEE_RESERVE, LIMITS).reason).toBe("already-healthy");
  });
});
