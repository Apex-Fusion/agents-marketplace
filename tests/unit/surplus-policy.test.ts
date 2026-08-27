import { describe, expect, it } from "vitest";
import {
  quoteSurplusMultiplier,
} from "../../supplier/src/surplus/policy.js";
import {
  eligibleCompetitors,
  selectSurplusModelCandidates,
} from "../../supplier/src/surplus/selection.js";
import type {
  SurplusDiscoveredModel,
  SurplusMarketSummary,
  SurplusOrderBookOffer,
} from "../../supplier/src/surplus/client.js";

function discovered(
  model: string,
  providerModelId: string,
): SurplusDiscoveredModel {
  return {
    model,
    providerModelId,
    supported: true,
    inputUsdPer1m: 0.07952,
    outputUsdPer1m: 0.15904,
    priceUnit: "M",
    priceVariable: false,
    modelType: "text",
    availabilityStatus: "available",
  };
}

function market(model: string, requests24h: number): SurplusMarketSummary {
  return {
    model,
    requests24h,
    volume24h: 1_000,
    bestInputMicroUsdPer1m: 4_052,
    bestOutputMicroUsdPer1m: 8_104,
    healthySellerCount: 1,
  };
}

describe("Surplus bounded price policy", () => {
  it("uses an exact recovery multiplier and undercuts in integer micro-USD", () => {
    const quote = quoteSurplusMultiplier({
      upstreamInputMicroUsdPer1m: 79_520,
      upstreamOutputMicroUsdPer1m: 159_040,
      recoveryBps: 490,
      undercutBps: 10,
      competitors: [{
        id: "external",
        inputMicroUsdPer1m: 3_976,
        outputMicroUsdPer1m: 7_952,
      }],
    });

    expect(quote.floorMultiplierPpm).toBe(49_000);
    expect(quote.costMultiplierPpm).toBe(49_950);
    expect(quote.costMultiplier).toBe(0.04995);
    expect(quote.inputMicroUsdPer1m).toBe(3_972);
    expect(quote.outputMicroUsdPer1m).toBe(7_944);
    expect(quote.competitive).toBe(true);
  });

  it("keeps the recovery floor when the cheapest offer is too low", () => {
    const quote = quoteSurplusMultiplier({
      upstreamInputMicroUsdPer1m: 79_520,
      upstreamOutputMicroUsdPer1m: 159_040,
      recoveryBps: 490,
      undercutBps: 10,
      competitors: [{
        id: "below-floor",
        inputMicroUsdPer1m: 1_000,
        outputMicroUsdPer1m: 2_000,
      }],
    });

    expect(quote.floorMultiplierPpm).toBe(49_000);
    expect(quote.costMultiplierPpm).toBe(49_000);
    expect(quote.competitive).toBe(false);
  });

  it("selects equal-price competitors with a stable total order", () => {
    const input = {
      upstreamInputMicroUsdPer1m: 100,
      upstreamOutputMicroUsdPer1m: 100,
      recoveryBps: 100,
      undercutBps: 10,
    };
    const left = { id: "left", inputMicroUsdPer1m: 100, outputMicroUsdPer1m: 300 };
    const right = { id: "right", inputMicroUsdPer1m: 200, outputMicroUsdPer1m: 200 };

    expect(quoteSurplusMultiplier({ ...input, competitors: [right, left] }).competitorId)
      .toBe("left");
    expect(quoteSurplusMultiplier({ ...input, competitors: [left, right] }).competitorId)
      .toBe("left");
  });
});

describe("Surplus multi-model selection", () => {
  it("selects any eligible OpenRouter model by demand, not a hardcoded model", () => {
    const discovery = [
      discovered("beta-model", "vendor/beta"),
      discovered("alpha-model", "vendor/alpha"),
      { ...discovered("deepseek-v4-flash", "deepseek/deepseek-v4-flash"), supported: false },
    ];
    const markets = [market("alpha-model", 50), market("beta-model", 100)];

    const result = selectSurplusModelCandidates(discovery, markets, 490, 10);

    expect(result.map((candidate) => candidate.model)).toEqual([
      "beta-model",
      "alpha-model",
    ]);
    expect(result[0].providerModelId).toBe("vendor/beta");
  });

  it("resolves equal demand independently of discovery order", () => {
    const alpha = discovered("alpha-model", "vendor/alpha");
    const beta = discovered("beta-model", "vendor/beta");
    const markets = [market("alpha-model", 100), market("beta-model", 100)];

    expect(selectSurplusModelCandidates([beta, alpha], markets, 490, 10)[0].model)
      .toBe("alpha-model");
    expect(selectSurplusModelCandidates([alpha, beta], markets, 490, 10)[0].model)
      .toBe("alpha-model");
  });

  it("prices against healthy available offers while excluding self", () => {
    const base: SurplusOrderBookOffer = {
      id: "external",
      seller: "0x2222222222222222222222222222222222222222",
      sellerBaseUrl: "https://openrouter.ai/api/v1",
      inputMicroUsdPer1m: 4_000,
      outputMicroUsdPer1m: 8_000,
      available: true,
      healthy: true,
      trusted: true,
      trades24h: 0,
    };
    const seller = "0x1111111111111111111111111111111111111111";
    const offers = [
      base,
      { ...base, id: "self-id", seller },
      { ...base, id: "managed-id" },
      { ...base, id: "unhealthy", healthy: false },
      { ...base, id: "untrusted", trusted: false },
      { ...base, id: "unavailable", available: false },
    ];

    expect(eligibleCompetitors(offers, seller, new Set(["managed-id"])))
      .toEqual([
        { id: "external", inputMicroUsdPer1m: 4_000, outputMicroUsdPer1m: 8_000 },
        { id: "untrusted", inputMicroUsdPer1m: 4_000, outputMicroUsdPer1m: 8_000 },
      ]);
  });
});
