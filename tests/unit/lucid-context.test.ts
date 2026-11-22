/**
 * lucid-context.test.ts — createLucidContext()
 *
 * The factory refuses a private key that is not 64 hex characters. It gives lucid the "Mainnet" network tag for the Vector
 * network.
 *
 * All Ogmios calls are mocked via injected fetch so no real node is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OgmiosLucidProvider,
} from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import { createLucidContext } from "../../packages/shared/src/tx/internal/lucidContext.js";
import { VECTOR_TESTNET } from "../../packages/shared/src/network.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { makeOgmiosProtocolParams } from "../fixtures/chain-codec/ogmios-protocol-parameters.js";

// ─── Mock fetch for protocol-params bootstrap ─────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  // Protocol-params call that Lucid() issues on construction
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", result: makeOgmiosProtocolParams() }),
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createLucidContext()", () => {
  it("throws when privateKeyHex is not 64 hex chars (invalid length)", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: "http://localhost:1337", fetch: mockFetch });
    const badKey = { ...buildBuyerWalletKey(), privateKeyHex: "deadbeef" };

    await expect(
      createLucidContext(provider, badKey, VECTOR_TESTNET),
    ).rejects.toThrow(/invalid privateKeyHex/);
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
