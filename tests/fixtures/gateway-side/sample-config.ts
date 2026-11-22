/**
 * Gateway-side sample config fixture
 *
 * A deterministic GatewayConfig for the tests that build the gateway deps by hand. It sets every field of GatewayConfig that is not
 * optional, so a new field breaks this one file and not each test. The rate limits are high, so that no test reaches them.
 */

import type { GatewayConfig } from "../../../gateway/src/config.js";

/** A rate limit that no test reaches. */
const OPEN_RATE = { max: 1000, windowMs: 60_000 };

/** `dbDir` is the folder of the store that the test opens, so each test names it. */
export function buildSampleGatewayConfig(overrides: Partial<GatewayConfig> & Pick<GatewayConfig, "dbDir">): GatewayConfig {
  return {
    masterKeyHex: "ab".repeat(32),
    indexerUrl: "http://ix",
    ogmiosUrl: "http://og",
    networkId: 0,
    liveChain: true,
    port: 0,
    signupRate: { ...OPEN_RATE },
    keyRate: { ...OPEN_RATE },
    demoIpRate: { ...OPEN_RATE },
    sweeperIntervalMs: 60_000,
    demoSessionIdleMs: 180_000,
    chatSettleMode: "full",
    walletHealthIntervalMs: 600_000,
    walletConfirmPollIntervalMs: 1_000,
    sdkRegistryMax: 100,
    oneShotConcurrency: 4,
    oneShotMaxOutstanding: 64,
    oneShotQueueTimeoutMs: 60_000,
    oneShotPollIntervalMs: 2_000,
    mcpIpRate: { ...OPEN_RATE },
    mcpCallIpRate: { ...OPEN_RATE },
    mcpCallIpConcurrency: 1,
    mcpCallConcurrency: 2,
    mcpCallQueueTimeoutMs: 60_000,
    mcpCatalogTtlMs: 30_000,
    ocrCapabilityId: "ocr.page.extract.chandra-ocr-2.v1",
    corsOrigins: [],
    identityPolicyId: null,
    switchSlot: null,
    ...overrides,
  };
}
