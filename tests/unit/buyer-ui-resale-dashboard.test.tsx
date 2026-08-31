// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../../buyer/src/ui/App.js";
import { AuthProvider } from "../../buyer/src/ui/state/AuthContext.js";

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
    recentSales: [
      {
        id: "sale-1",
        model: "deepseek-v4-flash",
        createdAt: "2026-08-28T11:00:00.000Z",
        settlementStatus: "confirmed",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        revenueUsd: "0.000083",
        vectorProof: {
          status: "confirmed",
          saleHash: "1".repeat(64),
          batchRoot: "2".repeat(64),
          txHash: "d".repeat(64),
          leafIndex: 0,
          siblings: ["3".repeat(64)],
        },
      },
      {
        id: "sale-2",
        model: "deepseek-v4-flash",
        createdAt: "2026-08-28T11:01:00.000Z",
        settlementStatus: "confirmed",
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 6,
        revenueUsd: "0.000166",
        vectorProof: {
          status: "pending",
          saleHash: "4".repeat(64),
          batchRoot: null,
          txHash: null,
          leafIndex: null,
          siblings: [],
        },
      },
      {
        id: "sale-3",
        model: "deepseek-v4-flash",
        createdAt: "2026-08-28T11:02:00.000Z",
        settlementStatus: "confirmed",
        inputTokens: 30,
        outputTokens: 6,
        cacheReadTokens: 9,
        revenueUsd: "0.000249",
        vectorProof: {
          status: "failed",
          saleHash: "5".repeat(64),
          batchRoot: null,
          txHash: null,
          leafIndex: null,
          siblings: [],
        },
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Capacity markets dashboard", () => {
  it("renders the authenticated route with a Vector proof state for every sale", async () => {
    const fetchMock = vi.fn(async () => Response.json(DASHBOARD));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/capacity"]}>
        <AuthProvider initialStatus="authenticated">
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Capacity Markets" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Capacity" })).toHaveAttribute("href", "/capacity");
    expect(screen.getByRole("heading", { name: "Surplus Intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Vector proof" })).toBeInTheDocument();
    expect(screen.getByText("$0.2399")).toBeInTheDocument();
    expect(screen.getByTestId("resale-dashboard")).toHaveClass("max-w-7xl");
    expect(document.querySelectorAll(".bg-white").length).toBeGreaterThan(3);

    const proofSummary = screen.getByRole("group", { name: "Vector proof summary" });
    expect(within(proofSummary).getByText("Confirmed 1")).toHaveClass("bg-green-100");
    expect(within(proofSummary).getByText("Pending 1")).toHaveClass("bg-amber-100");
    expect(within(proofSummary).getByText("Failed 1")).toHaveClass("bg-red-100");
    expect(screen.getByText("pending")).toHaveClass("bg-amber-100");
    expect(screen.getByText("failed")).toHaveClass("bg-red-100");

    const proofLink = screen.getByRole("link", { name: /Confirmed Vector proof transaction/ });
    expect(proofLink).toHaveAttribute(
      "href",
      `https://vector.apexscan.org/en/transaction/${"d".repeat(64)}/summary/`,
    );
    expect(within(proofLink).getByText("dddddddddddd…ddddddddd")).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/v1/resale-dashboard",
      { cache: "no-store" },
    ));
  });

  it("removes the old dashboard route instead of keeping an alias", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AuthProvider initialStatus="authenticated">
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole("heading", { name: "Capacity Markets" }))
      .not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
