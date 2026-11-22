/**
 * lucid-slot-config-patch.test.ts — M1-F time cleanup
 *
 * Asserts that createLucidContext mutates SLOT_CONFIG_NETWORK.Mainnet to match
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
 * SLOT_CONFIG_NETWORK is a global of the lucid package, and createLucidContext changes it. The isolation of this file holds
 * for one test file only. Do not merge this file into another test file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SLOT_CONFIG_NETWORK,
  unixTimeToEnclosingSlot,
} from "@lucid-evolution/lucid";
import {
  OgmiosLucidProvider,
} from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import { createLucidContext } from "../../packages/shared/src/tx/internal/lucidContext.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { makeOgmiosProtocolParams } from "../fixtures/chain-codec/ogmios-protocol-parameters.js";

// ─── Vector genesis constants ─────────────────────────────────────────────────

const VECTOR_GENESIS_UNIX_MS = 1_752_057_484_000;  // 1752057484 seconds * 1000
const VECTOR_SLOT_LENGTH_MS = 1000;
const VECTOR_ZERO_SLOT = 0;

const VECTOR_SLOT_CONFIG = {
  zeroTime: VECTOR_GENESIS_UNIX_MS,
  zeroSlot: VECTOR_ZERO_SLOT,
  slotLength: VECTOR_SLOT_LENGTH_MS,
};

// ─── Mock fetch for protocol-params bootstrap ─────────────────────────────────
// The calls below pass usePresetProtocolParameters, so lucid does not ask the provider for protocol parameters. The mock
// makes sure that a request never reaches a real node.

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", result: makeOgmiosProtocolParams() }),
  });
});

async function createContext(): Promise<void> {
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
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("applyVectorSlotConfig() — SLOT_CONFIG_NETWORK.Mainnet mutation", () => {
  it("createLucidContext patches SLOT_CONFIG_NETWORK.Mainnet to the Vector genesis (zeroTime, zeroSlot, slotLength)", async () => {
    await createContext();

    expect(SLOT_CONFIG_NETWORK["Mainnet"]).toMatchObject(VECTOR_SLOT_CONFIG);
  });

  it("patch is idempotent — calling createLucidContext twice does not corrupt SLOT_CONFIG", async () => {
    await createContext();
    await createContext();

    // Values must still be correct after two calls
    expect(SLOT_CONFIG_NETWORK["Mainnet"]).toMatchObject(VECTOR_SLOT_CONFIG);
  });

  it("after patch: unixTimeToEnclosingSlot(VECTOR_GENESIS_UNIX_MS) returns slot 0", async () => {
    await createContext();

    const slot = unixTimeToEnclosingSlot(VECTOR_GENESIS_UNIX_MS, SLOT_CONFIG_NETWORK["Mainnet"]);
    expect(slot).toBe(0);
  });

  it("after patch: unixTimeToEnclosingSlot(VECTOR_GENESIS_MS + 25_000_000 * 1000) returns slot 25_000_000", async () => {
    // 25,000,000 slots after genesis at 1 slot/s = 25_000_000_000 ms later
    await createContext();

    const targetUnixMs = VECTOR_GENESIS_UNIX_MS + 25_000_000 * VECTOR_SLOT_LENGTH_MS;
    const slot = unixTimeToEnclosingSlot(targetUnixMs, SLOT_CONFIG_NETWORK["Mainnet"]);
    expect(slot).toBe(25_000_000);
  });
});
