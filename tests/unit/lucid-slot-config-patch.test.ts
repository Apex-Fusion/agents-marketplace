/**
 * lucid-slot-config-patch.test.ts — RED phase tests for M1-F-time-cleanup
 *
 * Asserts that createLucidContext (or a standalone applyVectorSlotConfig()
 * helper Catherine will add) mutates SLOT_CONFIG_NETWORK.Mainnet to match
 * Vector's actual genesis parameters:
 *   { zeroTime: 1752057484000, zeroSlot: 0, slotLength: 1000 }
 *
 * The patch must be applied BEFORE lucid uses the network's slot config for
 * validity-range calculations, otherwise live CBOR tx builders produce wrong
 * slot bounds that the chain validator rejects.
 *
 * Imported from @lucid-evolution/plutus (re-exported via @lucid-evolution/lucid):
 *   SLOT_CONFIG_NETWORK — mutable Record<Network, SlotConfig>
 *   unixTimeToEnclosingSlot — used to verify the patch is semantically correct
 *
 * Production constants:
 *   VECTOR_GENESIS_UNIX_MS = 1752057484 * 1000 = 1752057484000
 *   VECTOR_SLOT_LENGTH_MS  = 1000
 *   VECTOR_ZERO_SLOT       = 0
 *
 * M1-F-time-cleanup RED — all tests fail until Catherine implements applyVectorSlotConfig().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SLOT_CONFIG_NETWORK,
  unixTimeToEnclosingSlot,
  slotToBeginUnixTime,
} from "@lucid-evolution/lucid";
import {
  OgmiosLucidProvider,
} from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import { createLucidContext } from "../../packages/shared/src/tx/internal/lucidContext.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

// ─── Vector genesis constants ─────────────────────────────────────────────────

const VECTOR_GENESIS_UNIX_MS = 1_752_057_484_000;  // 1752057484 seconds * 1000
const VECTOR_SLOT_LENGTH_MS = 1000;
const VECTOR_ZERO_SLOT = 0;

// ─── Mock fetch for protocol-params bootstrap ─────────────────────────────────

const mockFetch = vi.fn();

function makeProtocolParamsResponse() {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: "2.0",
      result: {
        minFeeCoefficient: 44,
        minFeeConstant: { ada: { lovelace: 155381 } },
        maxTransactionSize: { bytes: 16384 },
        maxValueSize: { bytes: 5000 },
        stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
        stakePoolDeposit: { ada: { lovelace: 500000000 } },
        prices: { memory: "0.0577", steps: "0.0000721" },
        maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
        coinsPerUtxoByte: { ada: { lovelace: 4310 } },
        collateralPercentage: 150,
        maxCollateralInputs: 3,
        plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
        monetaryExpansion: "0.003",
        treasuryExpansion: "0.2",
        minStakePoolCost: { ada: { lovelace: 340000000 } },
        minFeeReferenceScripts: { base: 15 },
        governanceActionDeposit: { ada: { lovelace: 100000000000 } },
        delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
      },
    }),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(makeProtocolParamsResponse());
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("applyVectorSlotConfig() — SLOT_CONFIG_NETWORK.Mainnet mutation", () => {
  it("createLucidContext patches SLOT_CONFIG_NETWORK.Mainnet.zeroTime to Vector genesis ms", async () => {
    // Arrange: SLOT_CONFIG_NETWORK.Mainnet may start with a different zeroTime.
    // Calling createLucidContext must mutate it to the Vector genesis.
    const provider = new OgmiosLucidProvider({
      ogmiosUrl: "http://localhost:1337",
      fetch: mockFetch,
    });
    const buyer = buildBuyerWalletKey();

    // Act
    await createLucidContext(provider, buyer, {
      networkId: 1,
      systemStartUnix: 1_752_057_484,
      slotLengthMs: 1000,
    }, { usePresetProtocolParameters: true });

    // Assert
    expect(SLOT_CONFIG_NETWORK["Mainnet"].zeroTime).toBe(VECTOR_GENESIS_UNIX_MS);
  });

  it("createLucidContext patches SLOT_CONFIG_NETWORK.Mainnet.zeroSlot to 0", async () => {
    const provider = new OgmiosLucidProvider({
      ogmiosUrl: "http://localhost:1337",
      fetch: mockFetch,
    });
    const buyer = buildBuyerWalletKey();

    await createLucidContext(provider, buyer, {
      networkId: 1,
      systemStartUnix: 1_752_057_484,
      slotLengthMs: 1000,
    }, { usePresetProtocolParameters: true });

    expect(SLOT_CONFIG_NETWORK["Mainnet"].zeroSlot).toBe(VECTOR_ZERO_SLOT);
  });

  it("createLucidContext patches SLOT_CONFIG_NETWORK.Mainnet.slotLength to 1000", async () => {
    const provider = new OgmiosLucidProvider({
      ogmiosUrl: "http://localhost:1337",
      fetch: mockFetch,
    });
    const buyer = buildBuyerWalletKey();

    await createLucidContext(provider, buyer, {
      networkId: 1,
      systemStartUnix: 1_752_057_484,
      slotLengthMs: 1000,
    }, { usePresetProtocolParameters: true });

    expect(SLOT_CONFIG_NETWORK["Mainnet"].slotLength).toBe(VECTOR_SLOT_LENGTH_MS);
  });

  it("patch is idempotent — calling createLucidContext twice does not corrupt SLOT_CONFIG", async () => {
    const provider = new OgmiosLucidProvider({
      ogmiosUrl: "http://localhost:1337",
      fetch: mockFetch,
    });
    const buyer = buildBuyerWalletKey();

    await createLucidContext(provider, buyer, {
      networkId: 1,
      systemStartUnix: 1_752_057_484,
      slotLengthMs: 1000,
    }, { usePresetProtocolParameters: true });

    // Reset mock for second call
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(makeProtocolParamsResponse());

    await createLucidContext(provider, buyer, {
      networkId: 1,
      systemStartUnix: 1_752_057_484,
      slotLengthMs: 1000,
    }, { usePresetProtocolParameters: true });

    // Values must still be correct after two calls
    expect(SLOT_CONFIG_NETWORK["Mainnet"].zeroTime).toBe(VECTOR_GENESIS_UNIX_MS);
    expect(SLOT_CONFIG_NETWORK["Mainnet"].zeroSlot).toBe(VECTOR_ZERO_SLOT);
    expect(SLOT_CONFIG_NETWORK["Mainnet"].slotLength).toBe(VECTOR_SLOT_LENGTH_MS);
  });

  it("after patch: unixTimeToEnclosingSlot(VECTOR_GENESIS_UNIX_MS) returns slot 0", async () => {
    const provider = new OgmiosLucidProvider({
      ogmiosUrl: "http://localhost:1337",
      fetch: mockFetch,
    });
    const buyer = buildBuyerWalletKey();

    await createLucidContext(provider, buyer, {
      networkId: 1,
      systemStartUnix: 1_752_057_484,
      slotLengthMs: 1000,
    }, { usePresetProtocolParameters: true });

    const slot = unixTimeToEnclosingSlot(VECTOR_GENESIS_UNIX_MS, SLOT_CONFIG_NETWORK["Mainnet"]);
    expect(slot).toBe(0);
  });

  it("after patch: unixTimeToEnclosingSlot(VECTOR_GENESIS_MS + 25_000_000 * 1000) returns ~25_000_000", async () => {
    // 25,000,000 slots after genesis at 1 slot/s = 25_000_000_000 ms later
    const provider = new OgmiosLucidProvider({
      ogmiosUrl: "http://localhost:1337",
      fetch: mockFetch,
    });
    const buyer = buildBuyerWalletKey();

    await createLucidContext(provider, buyer, {
      networkId: 1,
      systemStartUnix: 1_752_057_484,
      slotLengthMs: 1000,
    }, { usePresetProtocolParameters: true });

    const targetUnixMs = VECTOR_GENESIS_UNIX_MS + 25_000_000 * VECTOR_SLOT_LENGTH_MS;
    const slot = unixTimeToEnclosingSlot(targetUnixMs, SLOT_CONFIG_NETWORK["Mainnet"]);
    expect(slot).toBe(25_000_000);
  });
});
