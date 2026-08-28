import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SurplusEarnings,
  SurplusSale,
} from "../../supplier/src/surplus/client.js";
import { FileSurplusVectorProofLedger } from "../../supplier/src/surplus/vectorProof.js";
import {
  SurplusVectorProofPublisher,
  type SurplusProofAnchorMetadata,
  type SurplusVectorProofPublisherOptions,
} from "../../supplier/src/surplus/vectorPublisher.js";

const directories: string[] = [];

async function temporaryLedger(): Promise<FileSurplusVectorProofLedger> {
  const directory = await mkdtemp(join(tmpdir(), "surplus-vector-publisher-"));
  directories.push(directory);
  return FileSurplusVectorProofLedger.open(join(directory, "ledger.json"));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function sale(
  id: string,
  overrides: Partial<SurplusSale> = {},
): SurplusSale {
  const createdAtMs = Date.parse("2026-08-28T11:00:00.123Z");
  return {
    id,
    model: "deepseek-v4-flash",
    offerId: "offer-1",
    settlementStatus: "confirmed",
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
    sellerCostMicroUsd: 83,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    effectiveInputUsdPer1m: 0.003972,
    effectiveOutputUsdPer1m: 0.007944,
    transactionHash: "0x" + "a".repeat(64),
    ...overrides,
  };
}

function earningsWith(recentSales: SurplusSale[]): SurplusEarnings {
  return {
    totalEarnedMicroUsd: 186_810,
    pendingMicroUsd: 176_817,
    paidMicroUsd: 9_993,
    requestCount: recentSales.length,
    tokenCount: 120,
    topModel: "deepseek-v4-flash",
    payoutHoldReason: null,
    payoutHoldReleasesAt: null,
    daily: [],
    byModel: [],
    recentSales,
  } as unknown as SurplusEarnings;
}

interface HarnessOverrides {
  sales?: SurplusSale[];
  balance?: bigint;
  anchor?: SurplusVectorProofPublisherOptions["anchor"];
  awaitTx?: SurplusVectorProofPublisherOptions["awaitTx"];
}

async function harness(overrides: HarnessOverrides = {}) {
  const ledger = await temporaryLedger();
  const anchors: SurplusProofAnchorMetadata[] = [];
  const logs: string[] = [];
  let txCounter = 0;
  const anchor = overrides.anchor ?? (async (metadata: SurplusProofAnchorMetadata) => {
    anchors.push(metadata);
    txCounter += 1;
    return { expectedTxHash: String(txCounter).repeat(64).slice(0, 64) };
  });
  const publisher = new SurplusVectorProofPublisher({
    ledger,
    earnings: async () => earningsWith(overrides.sales ?? []),
    anchor,
    awaitTx: overrides.awaitTx ?? (async () => undefined),
    balanceLovelace: async () => overrides.balance ?? 25_000_000n,
    reserveLovelace: 5_000_000n,
    feeBudgetLovelace: 1_000_000n,
    settledStatuses: ["confirmed"],
    intervalMs: 60_000,
    confirmTimeoutMs: 1_000,
    log: (message) => logs.push(message),
  });
  return { ledger, publisher, anchors, logs };
}

describe("SurplusVectorProofPublisher", () => {
  it("anchors one Vector transaction per settled Base settlement transaction", async () => {
    const baseTxA = "0x" + "a".repeat(64);
    const baseTxB = "0x" + "b".repeat(64);
    const sales = [
      sale("01SALEA1", { transactionHash: baseTxA }),
      sale("01SALEA2", { transactionHash: baseTxA }),
      sale("01SALEB1", {
        transactionHash: baseTxB,
        createdAtMs: Date.parse("2026-08-28T12:00:00.000Z"),
        createdAt: "2026-08-28T12:00:00.000Z",
      }),
      sale("01UNSETTLED", { transactionHash: null, settlementStatus: "accrued" }),
    ];
    const { ledger, publisher, anchors } = await harness({ sales });

    const result = await publisher.runCycle();

    expect(result).toMatchObject({
      ingested: 3,
      anchored: 2,
      fundingBlocked: false,
      failed: false,
    });
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toMatchObject({
      p: "surplus-sale-proof-v1",
      count: 2,
      first: "01SALEA1",
      last: "01SALEA2",
    });
    expect(anchors[1]).toMatchObject({ count: 1, first: "01SALEB1" });

    for (const id of ["01SALEA1", "01SALEA2", "01SALEB1"]) {
      expect(ledger.dashboardProof(id)).toMatchObject({ status: "confirmed" });
    }
    expect(ledger.dashboardProof("01SALEA1")?.txHash).not.toBe(
      ledger.dashboardProof("01SALEB1")?.txHash,
    );
    expect(ledger.dashboardProof("01UNSETTLED")).toBeNull();
    expect(ledger.confirmedBatchHistory()).toHaveLength(2);
  });

  it("pauses anchoring below the reserve plus fee budget without touching the ledger batches", async () => {
    const { ledger, publisher, anchors, logs } = await harness({
      sales: [sale("01SALEA1")],
      balance: 5_500_000n,
    });

    const result = await publisher.runCycle();

    expect(result).toMatchObject({ anchored: 0, fundingBlocked: true });
    expect(anchors).toHaveLength(0);
    expect(ledger.pendingBatchIntent()).toBeNull();
    expect(ledger.dashboardProof("01SALEA1")).toMatchObject({ status: "pending" });
    expect(logs.some((line) => line.includes("funding required"))).toBe(true);
  });

  it("records a submit failure and retries the same sales on the next cycle", async () => {
    const anchor = vi.fn()
      .mockRejectedValueOnce(new Error("ogmios unreachable"))
      .mockResolvedValue({ expectedTxHash: "c".repeat(64) });
    const { ledger, publisher } = await harness({
      sales: [sale("01SALEA1")],
      anchor,
    });

    const firstCycle = await publisher.runCycle();
    expect(firstCycle).toMatchObject({ anchored: 0, failed: true });
    expect(ledger.dashboardProof("01SALEA1")).toMatchObject({ status: "failed" });
    expect(ledger.failedAttemptHistory()).toHaveLength(1);

    const secondCycle = await publisher.runCycle();
    expect(secondCycle).toMatchObject({ anchored: 1, failed: false });
    expect(ledger.dashboardProof("01SALEA1")).toMatchObject({
      status: "confirmed",
      txHash: "c".repeat(64),
    });
  });

  it("fails a stale pending batch from an interrupted run and re-anchors it in the same cycle", async () => {
    const observed = sale("01SALEA1");
    const { ledger, publisher, anchors } = await harness({ sales: [observed] });
    await ledger.ingestSales([observed]);
    await ledger.persistPendingBatch(["01SALEA1"]);

    const result = await publisher.runCycle();

    expect(result).toMatchObject({ anchored: 1, failed: false });
    expect(anchors).toHaveLength(1);
    expect(ledger.failedAttemptHistory()).toMatchObject([{ stage: "submit" }]);
    expect(ledger.dashboardProof("01SALEA1")).toMatchObject({ status: "confirmed" });
  });

  it("anchors window-expired unproved sales together in a trailing catch-up batch", async () => {
    const expired = sale("01EXPIRED");
    const { ledger, publisher, anchors } = await harness({
      sales: [sale("01SALEB1", { transactionHash: "0x" + "b".repeat(64) })],
    });
    await ledger.ingestSales([expired]);

    const result = await publisher.runCycle();

    expect(result).toMatchObject({ anchored: 2 });
    expect(anchors.map((metadata) => metadata.first)).toEqual([
      "01SALEB1",
      "01EXPIRED",
    ]);
    expect(ledger.dashboardProof("01EXPIRED")).toMatchObject({ status: "confirmed" });
  });
  it("anchors export-only settlements per Base tx and never re-ingests known sale ids", async () => {
    const baseTxA = "0x" + "a".repeat(64);
    const baseTxB = "0x" + "b".repeat(64);
    const observed = sale("01OBSERVED", { transactionHash: baseTxA });
    const { ledger, publisher, anchors } = await harness({ sales: [observed] });

    await ledger.ingestSales([observed]);
    const conflictingExportCopy = sale("01OBSERVED", {
      transactionHash: baseTxA,
      inputTokens: 999_999,
      cacheReadTokens: 0,
    });
    const historical = [
      conflictingExportCopy,
      sale("01HISTA2", { transactionHash: baseTxA, cacheReadTokens: 0 }),
      sale("01HISTB1", {
        transactionHash: baseTxB,
        cacheReadTokens: 0,
        createdAtMs: Date.parse("2026-08-27T01:00:00.000Z"),
        createdAt: "2026-08-27T01:00:00.000Z",
      }),
    ];
    const historicalPublisher = new SurplusVectorProofPublisher({
      ledger,
      earnings: async () => earningsWith([observed]),
      historicalSales: async () => historical,
      anchor: publisher["options"].anchor,
      awaitTx: async () => undefined,
      balanceLovelace: async () => 25_000_000n,
      reserveLovelace: 5_000_000n,
      feeBudgetLovelace: 1_000_000n,
      settledStatuses: ["confirmed"],
      intervalMs: 60_000,
      confirmTimeoutMs: 1_000,
      log: () => undefined,
    });

    const result = await historicalPublisher.runCycle();

    expect(result).toMatchObject({ ingested: 2, anchored: 2, failed: false });
    expect(anchors.map((metadata) => metadata.first)).toEqual([
      "01HISTB1",
      "01HISTA2",
    ]);
    expect(ledger.dashboardProof("01OBSERVED")).toMatchObject({ status: "confirmed" });
    expect(ledger.dashboardProof("01HISTA2")).toMatchObject({ status: "confirmed" });
    expect(ledger.dashboardProof("01HISTB1")).toMatchObject({ status: "confirmed" });
  });

  it("marks a confirmation timeout as a confirm-stage failure", async () => {
    const { ledger, publisher } = await harness({
      sales: [sale("01SALEA1")],
      awaitTx: async () => {
        throw new Error("timed out");
      },
    });

    const result = await publisher.runCycle();

    expect(result).toMatchObject({ anchored: 0, failed: true });
    expect(ledger.failedAttemptHistory()).toMatchObject([{ stage: "confirm" }]);
    expect(ledger.dashboardProof("01SALEA1")).toMatchObject({ status: "failed" });
  });
});
