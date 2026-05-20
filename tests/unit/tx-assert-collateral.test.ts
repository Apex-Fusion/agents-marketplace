/**
 * tx-assert-collateral.test.ts — unit tests for the assertCollateralCandidate
 * pre-check that fires from each script-spend builder.
 */

import { describe, it, expect } from "vitest";
import { assertCollateralCandidate } from "../../packages/shared/src/tx/internal/liveCbor.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";

type FakeLucidUtxo = { assets: Record<string, bigint> };

function lov(n: bigint): FakeLucidUtxo {
  return { assets: { lovelace: n } };
}

describe("assertCollateralCandidate", () => {
  it("passes when one UTxO is ≥ 5 AP3X pure-AP3X", () => {
    const utxos = [lov(1_000_000n), lov(5_000_000n), lov(2_400_000n)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertCollateralCandidate(utxos as any)).not.toThrow();
  });

  it("passes when one UTxO is much larger than 5 AP3X", () => {
    const utxos = [lov(1_000_000_000n)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertCollateralCandidate(utxos as any)).not.toThrow();
  });

  it("throws when the wallet has no UTxO ≥ 5 AP3X", () => {
    const utxos = [
      lov(2_400_750n),
      lov(1_679_301n),
      lov(1_679_301n),
      lov(1_679_301n),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertCollateralCandidate(utxos as any);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("collateral_required");
    expect((caught as TxConstructionError).message).toMatch(
      /tx:consolidate-wallet/,
    );
    expect((caught as TxConstructionError).message).toMatch(/4 UTxO/);
    expect((caught as TxConstructionError).message).toMatch(/2400750/);
  });

  it("throws when the wallet is empty", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertCollateralCandidate([] as any)).toThrow(
      TxConstructionError,
    );
  });

  it("skips UTxOs that carry native assets even when ≥ 5 AP3X", () => {
    // On Vector L2 the operator wallets are pure-AP3X, but the safety net
    // catches a hypothetical UTxO with native tokens — lucid's collateral
    // selector rejects those.
    const utxos = [
      { assets: { lovelace: 10_000_000n, ["d3.tok"]: 1n } },
      lov(1_000_000n),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertCollateralCandidate(utxos as any)).toThrow(
      /collateral/i,
    );
  });
});
