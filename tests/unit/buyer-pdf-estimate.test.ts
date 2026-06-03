/**
 * buyer-pdf-estimate.test.ts — reduce-tree call counting + cost bound math.
 */

import { describe, it, expect } from "vitest";
import { reduceCallCount, estimateJob, feeHeadroomLovelace } from "../../buyer/src/pdf/estimate.js";
import { SupplierPool } from "../../buyer/src/pdf/supplier-pool.js";
import type { PoolSupplier } from "../../buyer/src/pdf/types.js";

function sup(price: bigint): PoolSupplier {
  return {
    advertRef: { txHash: "a".repeat(64), index: 0 },
    utxoRef: `${"a".repeat(64)}#0`,
    supplierPkh: "pkh",
    model: "kimi",
    priceLovelace: price,
    maxOutputTokens: 512,
    endpointUrl: "http://x",
  };
}

describe("reduceCallCount", () => {
  it("matches the F-ary tree", () => {
    expect(reduceCallCount(90, 8)).toBe(15); // 12 + 2 + 1
    expect(reduceCallCount(8, 8)).toBe(1);
    expect(reduceCallCount(64, 8)).toBe(9); // 8 + 1
    expect(reduceCallCount(1, 8)).toBe(0);
    expect(reduceCallCount(0, 8)).toBe(0);
    expect(reduceCallCount(2, 8)).toBe(1);
  });

  it("is safe for degenerate fan-in", () => {
    expect(reduceCallCount(10, 1)).toBe(0);
  });
});

describe("estimateJob", () => {
  it("bounds total with the priciest supplier and counts map+reduce", () => {
    const pool = new SupplierPool([sup(2_000_000n), sup(3_000_000n)]);
    const est = estimateJob(90, 8, pool);
    expect(est.mapCalls).toBe(90);
    expect(est.reduceCalls).toBe(15);
    expect(est.totalCalls).toBe(105);
    expect(est.perCallMaxLovelace).toBe("3000000");
    expect(est.totalLovelace).toBe((3_000_000n * 105n).toString());
    expect(est.totalAp3x).toBe("315.00");
  });

  it("handles a single-chunk job (no reduce)", () => {
    const pool = new SupplierPool([sup(2_000_000n)]);
    const est = estimateJob(1, 8, pool);
    expect(est.totalCalls).toBe(1);
  });
});

describe("feeHeadroomLovelace", () => {
  it("scales with call count plus a fixed buffer", () => {
    expect(feeHeadroomLovelace(10)).toBe(12_000_000n);
  });
});
