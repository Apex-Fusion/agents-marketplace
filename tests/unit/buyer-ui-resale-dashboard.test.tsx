// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ResaleDashboard from "../../buyer/src/ui/pages/ResaleDashboard.js";

const DASHBOARD = {
  generatedAt: "2026-08-28T12:00:00.000Z",
  controller: { ok: true, phase: "active", lastError: null },
  identity: {
    sellerWallet: "0x1111111111111111111111111111111111111111",
    payoutAddress: "0x1111111111111111111111111111111111111111",
  },
  provider: {
    hardLimitUsd: "20.000000",
    remainingUsd: "15.157733",
    usedUsd: "4.842267",
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
      costMultiplier: 0.05065,
      inputUsdPer1m: "0.004027",
      outputUsdPer1m: "0.008055",
      rank: 11,
      available: true,
      healthy: true,
      trusted: true,
      trades24h: 654,
      volume24hUsd: "0.112434",
      capRemainingUsd: "0.000000",
    },
    earnings: {
      totalUsd: "0.239903",
      pendingUsd: "0.219945",
      paidUsd: "0.019958",
      requests: 1_333,
      tokens: 138_612_442,
      today: { earnedUsd: 0.053093, requests: 240, totalTokens: 33_913_537 },
      topModel: "deepseek-v4-flash",
      payoutHoldReason: "new_seller",
      payoutHoldReleasesAt: "2026-08-29T11:24:42.552Z",
    },
    recentSales: [{
      id: "sale-1",
      model: "deepseek-v4-flash",
      createdAt: "2026-08-28T11:00:00.000Z",
      settlementStatus: "confirmed",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      revenueUsd: "0.000083",
      transactionHash: "0x" + "c".repeat(64),
    }],
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResaleDashboard", () => {
  it("matches the marketplace card system and renders both settlement markets", async () => {
    const fetchMock = vi.fn(async () => Response.json(DASHBOARD));
    vi.stubGlobal("fetch", fetchMock);

    render(<ResaleDashboard />);

    expect(await screen.findByRole("heading", { name: "Resale Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Surplus Intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Vector marketplace" })).toBeInTheDocument();
    expect(screen.getByText("$0.2399")).toBeInTheDocument();
    expect(screen.getByText("1.600000 AP3X")).toBeInTheDocument();
    expect(screen.getByText("confirmed")).toBeInTheDocument();
    expect(screen.getByTestId("resale-dashboard")).toHaveClass("max-w-7xl");
    expect(document.querySelectorAll(".bg-white").length).toBeGreaterThan(3);
    expect(screen.getByRole("link", { name: /Open confirmed transaction/ })).toHaveAttribute(
      "href",
      `https://vector.apexscan.org/en/transaction/${"b".repeat(64)}/summary/`,
    );
    expect(screen.getByRole("link", { name: /0xcccc/ })).toHaveAttribute(
      "href",
      `https://basescan.org/tx/0x${"c".repeat(64)}`,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/v1/resale-dashboard",
      { cache: "no-store" },
    ));
  });
});
