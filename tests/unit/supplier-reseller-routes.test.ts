import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { createApp } from "../../supplier/src/server.js";
import { SupplierState } from "../../supplier/src/state.js";
import type { ResellerRuntime } from "../../supplier/src/reseller/runtime.js";
import { buildSampleConfig } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ESCROW_REF = `${"f".repeat(64)}#0`;

function fakeReseller(canServe: boolean, maxInputTokens = 100): ResellerRuntime {
  const snapshot = {
    provider: "openrouter",
    model: "provider/model",
    canServe,
    reason: canServe ? "ready" as const : "insufficient_for_job" as const,
    checkedAtMs: 1_000,
    lastSuccessAtMs: 1_000,
    keyLimitUsdNanos: 5_000_000_000n,
    remainingAllowanceUsdNanos: 2_000_000_000n,
    reserveUsdNanos: 1_000_000_000n,
    sellableUsdNanos: 1_000_000_000n,
    worstCaseJobUsdNanos: 100_000_000n,
    promptPriceUsdNanosPerToken: 1n,
    completionPriceUsdNanosPerToken: 1n,
    requestPriceUsdNanos: 0n,
    availableJobs: 10n,
    limitReset: "monthly",
    error: null,
  };
  return {
    maxInputTokens,
    effectiveStatus: vi.fn(() => canServe ? "free" : "offline"),
    capacitySnapshot: vi.fn(() => snapshot),
    refreshCapacity: vi.fn(async () => snapshot),
  } as unknown as ResellerRuntime;
}

describe("reseller supplier routes", () => {
  it("reports offline without retiring an exhausted supplier", async () => {
    const app = createApp({
      chain: new MockChainProvider(),
      state: new SupplierState(),
      config: buildSampleConfig(),
      supplierKey: buildSupplierWalletKey(),
      reseller: fakeReseller(false),
    });
    const response = await request(app).get("/status");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "offline",
      capacity: {
        provider: "openrouter",
        reason: "insufficient_for_job",
      },
    });
  });

  it("rejects oversized input before any chain submission", async () => {
    const chain = new MockChainProvider();
    const submitSpy = vi.spyOn(chain, "submitTx");
    const app = createApp({
      chain,
      state: new SupplierState(),
      config: buildSampleConfig(),
      supplierKey: buildSupplierWalletKey(),
      reseller: fakeReseller(true, 1),
    });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", ESCROW_REF)
      .send({ messages: [{ role: "user", content: "too large" }] });
    expect(response.status).toBe(413);
    expect(response.body.reason).toBe("input_cap_exceeded");
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
