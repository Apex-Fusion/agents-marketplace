/**
 * lucid-context.test.ts — RED phase tests for createLucidContext()
 *
 * Verifies that the factory returns a usable LucidEvolution instance with the
 * wallet selected from the private key and the correct network configuration.
 *
 * All Ogmios calls are mocked via injected fetch so no real node is required.
 *
 * M1-F-4 RED — tests fail until Catherine implements createLucidContext.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OgmiosLucidProvider,
} from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import { createLucidContext } from "../../packages/shared/src/tx/internal/lucidContext.js";
import { VECTOR_TESTNET } from "../../packages/shared/src/network.js";
import {
  buildBuyerWalletKey,
  BUYER_PRIVATE_KEY_HEX,
} from "../fixtures/buyer-side/wallet-keys.js";

// ─── Mock fetch for protocol-params bootstrap ─────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  // Protocol-params call that Lucid() issues on construction
  mockFetch.mockResolvedValue({
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
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createLucidContext()", () => {
  it("returns an object with lucid and networkParams keys", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: "http://localhost:1337", fetch: mockFetch });
    const buyer = buildBuyerWalletKey();

    const ctx = await createLucidContext(provider, buyer, VECTOR_TESTNET);

    expect(ctx).toHaveProperty("lucid");
    expect(ctx).toHaveProperty("networkParams");
  });

  it("lucid.newTx() returns a TxBuilder (not null/undefined)", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: "http://localhost:1337", fetch: mockFetch });
    const buyer = buildBuyerWalletKey();

    const { lucid } = await createLucidContext(provider, buyer, VECTOR_TESTNET);

    expect(lucid.newTx).toBeDefined();
    expect(typeof lucid.newTx).toBe("function");
    const txBuilder = lucid.newTx();
    expect(txBuilder).toBeDefined();
  });

  it("wallet is selected (lucid.wallet() does not throw)", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: "http://localhost:1337", fetch: mockFetch });
    const buyer = buildBuyerWalletKey();

    const { lucid } = await createLucidContext(provider, buyer, VECTOR_TESTNET);

    // After fromPrivateKey, wallet() should be accessible
    expect(() => lucid.wallet()).not.toThrow();
  });

  it("returns networkParams matching the input networkParams", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: "http://localhost:1337", fetch: mockFetch });
    const buyer = buildBuyerWalletKey();

    const ctx = await createLucidContext(provider, buyer, VECTOR_TESTNET);

    expect(ctx.networkParams).toBe(VECTOR_TESTNET);
  });

  it("throws when privateKeyHex is not 64 hex chars (invalid length)", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: "http://localhost:1337", fetch: mockFetch });
    const badKey = { ...buildBuyerWalletKey(), privateKeyHex: "deadbeef" };

    await expect(
      createLucidContext(provider, badKey, VECTOR_TESTNET),
    ).rejects.toThrow();
  });
});

describe("createLucidContext() — network ID mapping", () => {
  it("Vector testnet (networkId=0) maps to Mainnet for lucid (as per genesis)", async () => {
    // ARCHITECTURE decision: Vector testnet uses Cardano mainnet network ID 0.
    // Lucid's "Mainnet" corresponds to networkId=0 in CIP-0019 address encoding.
    // This test verifies the factory wires the correct lucid network string.
    const provider = new OgmiosLucidProvider({ ogmiosUrl: "http://localhost:1337", fetch: mockFetch });
    const buyer = buildBuyerWalletKey();

    const { lucid } = await createLucidContext(provider, buyer, VECTOR_TESTNET);

    // lucid.config() exposes the network string; "Mainnet" = networkId 0
    const cfg = lucid.config();
    expect(cfg.network).toBe("Mainnet");
  });
});
