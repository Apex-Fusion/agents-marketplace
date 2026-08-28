import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { SurplusManagerConfig } from "../../supplier/src/surplus/config.js";
import {
  SurplusDashboardService,
  type SurplusDashboardSnapshot,
} from "../../supplier/src/surplus/dashboard.js";
import { createSurplusServer } from "../../supplier/src/cli/surplus-seller.js";
import type { SurplusControllerStatus } from "../../supplier/src/surplus/controller.js";

const STATUS: SurplusControllerStatus = {
  ok: true,
  phase: "active",
  live: true,
  model: "deepseek-v4-flash",
  providerModelId: "deepseek/deepseek-v4-flash",
  offerId: "offer-1",
  inputUsdPer1m: "0.003972",
  outputUsdPer1m: "0.007944",
  competitorId: "external",
  remainingAllowanceUsd: "16.313443",
  reserveThresholdUsd: "1.00",
  totalEarnedUsd: "0.186810",
  lastCycleAt: "2026-08-28T12:00:00.000Z",
  lastSuccessAt: "2026-08-28T12:00:00.000Z",
  lastError: null,
};

function config(): SurplusManagerConfig {
  return {
    live: true,
    apiBaseUrl: "https://api.surplusintelligence.ai",
    sellerApiKey: "si_seller_test_secret",
    providerApiKey: "sk-or-v1-test-secret",
    providerBaseUrl: "https://openrouter.ai/api/v1",
    capacityBaseUrl: "https://openrouter.ai/api",
    perOfferCapUsd: "0.05",
    aggregateCapUsd: "0.05",
    sellerWallet: "0x1111111111111111111111111111111111111111",
    payoutAddress: "0x1111111111111111111111111111111111111111",
    maxCandidateOrderBooks: 10,
    reserveUsd: "1.00",
    maxProviderLimitUsd: "20.00",
    recoveryBps: 490,
    undercutBps: 10,
    pollIntervalMs: 300_000,
    requestTimeoutMs: 120_000,
    stopAfterTrades: 0,
    settledStatuses: ["confirmed"],
    statePath: "/tmp/surplus-dashboard-test.json",
    port: 8080,
  };
}

function snapshot(): SurplusDashboardSnapshot {
  return {
    generatedAt: "2026-08-28T12:00:00.000Z",
    controller: STATUS,
    identity: {
      sellerWallet: "0x1111111111111111111111111111111111111111",
      payoutAddress: "0x1111111111111111111111111111111111111111",
    },
    provider: {
      name: "OpenRouter",
      hardLimitUsd: "20.000000",
      remainingUsd: "16.313443",
      usedUsd: "3.686557",
      reserveUsd: "1.00",
      estimatedDailyExposureUsd: "1.020408",
    },
    surplus: {
      offer: {
        id: "offer-1",
        model: "deepseek-v4-flash",
        providerModel: "deepseek/deepseek-v4-flash",
        status: "active",
        dailyCapUsd: "0.050000",
        costMultiplier: 0.04995,
        inputUsdPer1m: "0.003972",
        outputUsdPer1m: "0.007944",
        rank: 10,
        available: true,
        healthy: true,
        trusted: true,
        trades24h: 429,
        volume24hUsd: "0.064030",
        capRemainingUsd: "0.050000",
      },
      earnings: {
        totalUsd: "0.186810",
        pendingUsd: "0.176817",
        paidUsd: "0.009993",
        requests: 1_093,
        tokens: 104_698_905,
        today: null,
        topModel: "deepseek-v4-flash",
        payoutHoldReason: "new_seller",
        payoutHoldReleasesAt: "2026-08-29T11:24:42.552Z",
      },
      recentSales: [],
    },
    vector: {
      status: "retired",
      model: "deepseek/deepseek-v4-flash",
      supplierWallet: "addr1test",
      advertRef: `${"a".repeat(64)}#0`,
      retirementTransaction: "b".repeat(64),
      retiredOn: "2026-08-27",
      historicalAp3xEarned: "1.600000",
      historicalSettledJobs: 8,
      historicalUpstreamSpendUsd: "0.000093",
    },
  };
}

describe("SurplusDashboardService", () => {
  it("combines safe live metrics with the Vector migration record", async () => {
    const listAllOffers = vi.fn(async () => [{
      id: "offer-1",
      model: "deepseek-v4-flash",
      sellerBaseUrl: "https://openrouter.ai/api/v1",
      status: "active" as const,
      capDailyUsd: 0.05,
      costMultiplierPpm: 49_950,
      inputMicroUsdPer1m: 3_972,
      outputMicroUsdPer1m: 7_944,
    }]);
    const getEarnings = vi.fn(async () => ({
      totalEarnedMicroUsd: 186_810,
      pendingMicroUsd: 176_817,
      paidMicroUsd: 9_993,
      daily: [{
        day: "2026-08-28",
        earnedUsd: 0.01,
        inputTokens: 10,
        outputTokens: 2,
        requests: 1,
        totalTokens: 12,
      }],
      byModel: [],
      requestCount: 1_093,
      tokenCount: 104_698_905,
      topModel: "deepseek-v4-flash",
      payoutHoldReason: "new_seller",
      payoutHoldReleasesAt: "2026-08-29T11:24:42.552Z",
      recentSales: [{
        id: "sale-1",
        model: "deepseek-v4-flash",
        offerId: "offer-1",
        settlementStatus: "confirmed",
        createdAt: "2026-08-28T11:00:00.000Z",
        sellerCostMicroUsd: 83,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        effectiveInputUsdPer1m: 0.003972,
        effectiveOutputUsdPer1m: 0.007944,
        transactionHash: "0x" + "c".repeat(64),
      }],
    }));
    const getOrderBook = vi.fn(async () => ({
      model: "deepseek-v4-flash",
      offers: [{
        id: "offer-1",
        seller: "0x1111111111111111111111111111111111111111",
        sellerBaseUrl: "https://openrouter.ai/api/v1",
        inputMicroUsdPer1m: 3_972,
        outputMicroUsdPer1m: 7_944,
        available: true,
        healthy: true,
        trusted: true,
        trades24h: 429,
        rank: 10,
        capRemainingMicroUsd: 50_000,
        volume24hMicroUsd: 64_030,
      }],
    }));
    const service = new SurplusDashboardService({
      controller: { snapshot: () => STATUS },
      client: { listAllOffers, getEarnings, getOrderBook },
      allowance: {
        readAllowance: async () => ({
          limitUsdNanos: 20_000_000_000n,
          remainingUsdNanos: 16_313_443_131n,
          reset: null,
          checkedAtMs: Date.parse("2026-08-28T12:00:00.000Z"),
        }),
      },
      config: config(),
      now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    });

    const first = await service.getSnapshot();
    const second = await service.getSnapshot();

    expect(first.surplus.offer).toMatchObject({
      id: "offer-1",
      rank: 10,
      available: true,
      dailyCapUsd: "0.050000",
    });
    expect(first.surplus.earnings).toMatchObject({
      totalUsd: "0.186810",
      requests: 1_093,
      topModel: "deepseek-v4-flash",
    });
    expect(first.provider).toMatchObject({
      usedUsd: "3.686556",
      estimatedDailyExposureUsd: "1.020408",
    });
    expect(first.vector).toMatchObject({ status: "retired", historicalSettledJobs: 8 });
    expect(first.surplus.recentSales[0]).toMatchObject({
      settlementStatus: "confirmed",
      revenueUsd: "0.000083",
    });
    expect(JSON.stringify(first)).not.toContain("si_seller_test_secret");
    expect(JSON.stringify(first)).not.toContain("sk-or-v1-test-secret");
    expect(second).toBe(first);
    expect(listAllOffers).toHaveBeenCalledTimes(1);
    expect(getEarnings).toHaveBeenCalledTimes(1);
    expect(getOrderBook).toHaveBeenCalledTimes(1);
  });
});
describe("private supplier dashboard data surface", () => {
  it("serves redacted data internally without hosting a dashboard page", async () => {
    const data = snapshot();
    const server = createSurplusServer(
      { snapshot: () => STATUS, healthy: () => true },
      { getSnapshot: async () => data },
    );

    const api = await request(server).get("/internal/resale-dashboard");
    expect(api.status).toBe(200);
    expect(api.body).toEqual(data);
    expect(JSON.stringify(api.body)).not.toContain("test-secret");

    expect((await request(server).get("/reseller")).status).toBe(404);
    expect((await request(server).get("/")).status).toBe(404);
    server.close();
  });
});
