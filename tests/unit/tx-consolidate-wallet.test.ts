/**
 * tx-consolidate-wallet.test.ts — pure unit tests for the consolidate
 * planner. Drives planConsolidate directly without lucid / WASM.
 */

import { describe, it, expect } from "vitest";
import {
  planConsolidate,
  DEFAULT_COLLATERAL_LOVELACE,
  DEFAULT_FEE_RESERVE,
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

  it("consolidates a 2-UTxO wallet where the smaller is below collateral threshold", () => {
    // Both fit budget but smaller (3 AP3X) is below 5 AP3X — needs reshape.
    const utxos = [u(3_000_000n), u(15_000_000n)];
    const plan = planConsolidate(utxos);

    expect(plan.reason).toBe("consolidate");
    expect(plan.alreadyHealthy).toBe(false);
    expect(plan.inputCount).toBe(2);
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
