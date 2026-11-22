/**
 * Supplier-side sample config of the surplus seller
 *
 * A deterministic SurplusManagerConfig for test injection. It sets every field, so a new field breaks this one file and not each test.
 */

import type { SurplusManagerConfig } from "../../../supplier/src/surplus/config.js";

/** The seller wallet (and payout address) of the sample config. */
export const SAMPLE_SELLER_WALLET = "0x1111111111111111111111111111111111111111";

export function buildSampleSurplusConfig(overrides: Partial<SurplusManagerConfig> = {}): SurplusManagerConfig {
  return {
    live: true,
    apiBaseUrl: "https://api.surplusintelligence.ai",
    sellerApiKey: "si_seller_test",
    providerApiKey: "sk-or-v1-test",
    providerBaseUrl: "https://openrouter.ai/api/v1",
    capacityBaseUrl: "https://openrouter.ai/api",
    perOfferCapUsd: "0.05",
    aggregateCapUsd: "0.05",
    sellerWallet: SAMPLE_SELLER_WALLET,
    payoutAddress: SAMPLE_SELLER_WALLET,
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
    proof: null,
    ...overrides,
  };
}
