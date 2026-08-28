import { describe, expect, it } from "vitest";
import type { SurplusManagerConfig } from "../../supplier/src/surplus/config.js";
import {
  SurplusSellerController,
  type SurplusControllerClient,
} from "../../supplier/src/surplus/controller.js";
import {
  SurplusHttpError,
  type SurplusDiscoveredModel,
  type SurplusOffer,
  type SurplusOfferPatch,
  type SurplusOfferWrite,
} from "../../supplier/src/surplus/client.js";
import type { OpenRouterKeyAllowance } from "../../supplier/src/surplus/openRouterKey.js";
import type {
  SurplusControllerState,
  SurplusStateStore,
} from "../../supplier/src/surplus/state.js";

const SELLER_WALLET = "0x1111111111111111111111111111111111111111";

function config(): SurplusManagerConfig {
  return {
    live: true,
    apiBaseUrl: "https://api.surplusintelligence.ai",
    sellerApiKey: "si_seller_test",
    providerApiKey: "sk-or-v1-test",
    providerBaseUrl: "https://openrouter.ai/api/v1",
    capacityBaseUrl: "https://openrouter.ai/api",
    perOfferCapUsd: "1.00",
    aggregateCapUsd: "1.00",
    sellerWallet: SELLER_WALLET,
    payoutAddress: SELLER_WALLET,
    maxCandidateOrderBooks: 10,
    reserveUsd: "1.00",
    maxProviderLimitUsd: "20.00",
    recoveryBps: 490,
    undercutBps: 10,
    pollIntervalMs: 300_000,
    requestTimeoutMs: 120_000,
    stopAfterTrades: 1,
    settledStatuses: ["confirmed"],
    statePath: "/tmp/surplus-test-state.json",
    port: 8080,
  };
}

class MemoryStateStore implements SurplusStateStore {
  state: SurplusControllerState = { version: 1, phase: "selecting" };

  async load(): Promise<SurplusControllerState> {
    return structuredClone(this.state);
  }

  async save(state: SurplusControllerState): Promise<void> {
    this.state = structuredClone(state);
  }
}

class FakeSurplusClient implements SurplusControllerClient {
  offer: SurplusOffer | null = null;
  trades24h = 0;
  settled = false;
  createCalls = 0;
  pauseCalls = 0;
  externalCalls = 0;
  createError: Error | null = null;
  discoveryError: Error | null = null;
  createdPayload: SurplusOfferWrite | null = null;
  patchPayload: SurplusOfferPatch | null = null;

  async listAllOffers(): Promise<SurplusOffer[]> {
    this.externalCalls += 1;
    return this.offer ? [{ ...this.offer }] : [];
  }

  async discoverModels(): Promise<SurplusDiscoveredModel[]> {
    this.externalCalls += 1;
    if (this.discoveryError) throw this.discoveryError;
    return [{
      model: "beta-model",
      providerModelId: "vendor/beta-model",
      supported: true,
      inputUsdPer1m: 0.07952,
      outputUsdPer1m: 0.15904,
      priceUnit: "M",
      priceVariable: false,
      modelType: "text",
      availabilityStatus: "available",
    }];
  }

  async getMarkets() {
    this.externalCalls += 1;
    return [{
      model: "beta-model",
      requests24h: 100,
      volume24h: 1_000,
      bestInputMicroUsdPer1m: 3_976,
      bestOutputMicroUsdPer1m: 7_952,
      healthySellerCount: 1,
    }];
  }

  async getOrderBook(model: string) {
    this.externalCalls += 1;
    const offers = [{
      id: "external",
      seller: "0x2222222222222222222222222222222222222222",
      sellerBaseUrl: "https://openrouter.ai/api/v1",
      inputMicroUsdPer1m: 3_976,
      outputMicroUsdPer1m: 7_952,
      available: true,
      healthy: true,
      trusted: true,
      trades24h: 0,
    }];
    if (this.offer) {
      offers.push({
        id: this.offer.id,
        seller: SELLER_WALLET,
        sellerBaseUrl: this.offer.sellerBaseUrl,
        inputMicroUsdPer1m: this.offer.inputMicroUsdPer1m ?? 3_972,
        outputMicroUsdPer1m: this.offer.outputMicroUsdPer1m ?? 7_944,
        available: this.offer.status === "active",
        healthy: true,
        trusted: true,
        trades24h: this.trades24h,
      });
    }
    return { model, offers };
  }

  async testConnection(): Promise<number> {
    this.externalCalls += 1;
    return 10;
  }

  async createOffer(input: SurplusOfferWrite): Promise<string> {
    this.externalCalls += 1;
    this.createCalls += 1;
    this.createdPayload = input;
    if (this.createError) throw this.createError;
    this.offer = {
      id: "managed-offer",
      model: input.model,
      sellerBaseUrl: input.sellerBaseUrl,
      status: "active",
      capDailyUsd: input.dailyCapUsd,
      costMultiplierPpm: Math.round(input.costMultiplier * 1_000_000),
      inputMicroUsdPer1m: Math.floor(79_520 * input.costMultiplier),
      outputMicroUsdPer1m: Math.floor(159_040 * input.costMultiplier),
    };
    return this.offer.id;
  }

  async updateOffer(_id: string, patch: SurplusOfferPatch): Promise<void> {
    this.externalCalls += 1;
    this.patchPayload = patch;
    if (!this.offer) throw new Error("missing fake offer");
    this.offer.costMultiplierPpm = Math.round(
      patch.costMultiplier * 1_000_000,
    );
    this.offer.inputMicroUsdPer1m = Math.floor(
      79_520 * patch.costMultiplier,
    );
    this.offer.outputMicroUsdPer1m = Math.floor(
      159_040 * patch.costMultiplier,
    );
    this.offer.capDailyUsd = patch.dailyCapUsd;
  }

  async pauseOffer(): Promise<void> {
    this.externalCalls += 1;
    this.pauseCalls += 1;
    if (this.offer) this.offer.status = "inactive";
  }

  async resumeOffer(): Promise<void> {
    this.externalCalls += 1;
    if (this.offer) this.offer.status = "active";
  }

  async getEarnings() {
    this.externalCalls += 1;
    return {
      totalEarnedMicroUsd: this.settled ? 100 : 0,
      pendingMicroUsd: 0,
      paidMicroUsd: this.settled ? 100 : 0,
      recentSales: this.settled ? [{
        model: "beta-model",
        offerId: "managed-offer",
        settlementStatus: "confirmed",
        createdAt: "2026-08-27T10:00:01.000Z",
        sellerCostMicroUsd: 100,
      }] : [],
    };
  }
}

const ALLOWANCE: OpenRouterKeyAllowance = {
  limitUsdNanos: 20_000_000_000n,
  remainingUsdNanos: 20_000_000_000n,
  reset: null,
  checkedAtMs: Date.parse("2026-08-27T10:00:00.000Z"),
};

function controller(
  client: FakeSurplusClient,
  store: MemoryStateStore,
  allowance: { readAllowance(): Promise<OpenRouterKeyAllowance> } = {
    readAllowance: async () => ALLOWANCE,
  },
  managerConfig: SurplusManagerConfig = config(),
): SurplusSellerController {
  let mutation = 0;
  return new SurplusSellerController({
    config: managerConfig,
    client,
    allowance,
    stateStore: store,
    now: () => Date.parse("2026-08-27T10:00:00.000Z"),
    mutationId: () => `mutation-${++mutation}`,
  });
}

describe("SurplusSellerController", () => {
  it("selects a discovered model, creates one bounded offer, and stops after settlement", async () => {
    const client = new FakeSurplusClient();
    const store = new MemoryStateStore();
    const activeController = controller(client, store);

    await activeController.runOnce();

    expect(client.createCalls).toBe(1);
    expect(client.createdPayload).toMatchObject({
      model: "beta-model",
      costMultiplier: 0.04995,
      dailyCapUsd: 1,
      payoutAddress: SELLER_WALLET,
    });
    expect(store.state.phase).toBe("active");
    expect(activeController.snapshot()).toMatchObject({
      ok: true,
      phase: "active",
      model: "beta-model",
      providerModelId: "vendor/beta-model",
    });

    client.trades24h = 1;
    client.settled = true;
    await activeController.runOnce();

    expect(client.pauseCalls).toBeGreaterThan(0);
    expect(client.offer?.status).toBe("inactive");
    expect(store.state.phase).toBe("completed");
    expect(activeController.snapshot()).toMatchObject({ ok: true, phase: "completed" });

    const callsBeforeRestart = client.externalCalls;
    const restarted = controller(client, store);
    await restarted.start();
    expect(client.externalCalls).toBe(callsBeforeRestart);
    expect(restarted.snapshot()).toMatchObject({ ok: true, phase: "completed" });
    await restarted.stop();
  });

  it("pauses when provider spend reaches the per-offer cap", async () => {
    const client = new FakeSurplusClient();
    const store = new MemoryStateStore();
    let remaining = 20_000_000_000n;
    const activeController = controller(client, store, {
      readAllowance: async () => ({
        ...ALLOWANCE,
        remainingUsdNanos: remaining,
      }),
    });
    await activeController.runOnce();
    expect(client.offer?.status).toBe("active");

    remaining = 18_700_000_000n;
    await activeController.runOnce();

    expect(client.offer?.status).toBe("inactive");
    expect(store.state.phase).toBe("awaiting_settlement");
  });

  it("keeps selling in continuous mode after trades and provider spend", async () => {
    const client = new FakeSurplusClient();
    const store = new MemoryStateStore();
    let remaining = 20_000_000_000n;
    const activeController = controller(
      client,
      store,
      {
        readAllowance: async () => ({
          ...ALLOWANCE,
          remainingUsdNanos: remaining,
        }),
      },
      { ...config(), stopAfterTrades: 0 },
    );
    await activeController.runOnce();
    client.trades24h = 1;
    remaining = 18_700_000_000n;

    await activeController.runOnce();

    expect(client.offer?.status).toBe("active");
    expect(store.state.phase).toBe("active");
  });

  it("adopts and resumes an inactive offer after an ambiguous create", async () => {
    const client = new FakeSurplusClient();
    client.offer = {
      id: "managed-offer",
      model: "beta-model",
      sellerBaseUrl: "https://openrouter.ai/api/v1",
      status: "inactive",
      capDailyUsd: 1,
      costMultiplierPpm: 49_950,
      inputMicroUsdPer1m: 3_972,
      outputMicroUsdPer1m: 7_944,
    };
    const store = new MemoryStateStore();
    store.state = {
      version: 1,
      phase: "create_pending",
      intent: {
        model: "beta-model",
        providerModelId: "vendor/beta-model",
        costMultiplierPpm: 49_950,
        inputMicroUsdPer1m: 3_972,
        outputMicroUsdPer1m: 7_944,
        dailyCapUsd: 1,
        baselineRemainingUsdNanos: "20000000000",
        idempotencyKey: "create-1",
        createdAt: "2026-08-27T10:00:00.000Z",
        baselineTrades24h: 0,
      },
    };

    await controller(client, store).runOnce();

    expect(client.createCalls).toBe(0);
    expect(client.offer.status).toBe("active");
    expect(store.state.phase).toBe("active");
  });

  it("never retries an ambiguous create when no matching offer is visible", async () => {
    const client = new FakeSurplusClient();
    client.createError = new SurplusHttpError("network lost", null);
    const store = new MemoryStateStore();
    const activeController = controller(client, store);

    await activeController.runOnce();
    expect(client.createCalls).toBe(1);
    expect(store.state.phase).toBe("create_pending");

    await activeController.runOnce();
    expect(client.createCalls).toBe(1);
    expect(activeController.snapshot()).toMatchObject({ ok: false, phase: "error" });
  });

  it("pauses the managed offer when a required pricing snapshot fails", async () => {
    const client = new FakeSurplusClient();
    const store = new MemoryStateStore();
    const activeController = controller(client, store);
    await activeController.runOnce();
    expect(client.offer?.status).toBe("active");

    client.discoveryError = new Error("discovery unavailable");
    await activeController.runOnce();

    expect(client.offer?.status).toBe("inactive");
    expect(activeController.snapshot()).toMatchObject({ ok: false, phase: "error" });
  });
});
