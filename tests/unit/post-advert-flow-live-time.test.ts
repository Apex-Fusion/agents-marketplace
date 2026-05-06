/**
 * post-advert-flow-live-time.test.ts — RED phase tests for M1-F-time-cleanup
 *
 * Proves that runPostAdvert() computes advertised_at:
 *   - via mockSlotToWallclockMs(tipSlot) when chain is a MockChainProvider
 *     (existing convention — must continue to pass after the live branch is added)
 *   - via Date.now() when chain is a LiveOgmiosProvider
 *     (new behavior — RED until Catherine implements the branch in postAdvertFlow.ts)
 *
 * Observation strategy for advertised_at on live chain:
 *   - Spy on chain.submitTx to capture the txCborHex submitted by buildPostAdvertTx.
 *   - The test tx format (encodeTxBody) is length-prefixed JSON over hex.
 *   - Parse the JSON to find the datumHex output field.
 *   - Decode the datumHex with decodeAdvertDatum to read advertised_at.
 *
 * Uses vi.useFakeTimers() + vi.setSystemTime() for deterministic Date.now().
 *
 * M1-F-time-cleanup RED — live backend tests fail until Catherine adds the
 * live-path branch in supplier/src/cli/postAdvertFlow.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runPostAdvert } from "../../supplier/src/cli/postAdvertFlow.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { decodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import {
  buildCliAdvertDatum,
  VALID_TIP_SLOT,
} from "../fixtures/supplier-side/sample-advert-datum.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

// ─── Fixed fake time ──────────────────────────────────────────────────────────

const FAKE_NOW_DATE = new Date("2026-04-28T12:00:00Z");
const FAKE_NOW_MS = FAKE_NOW_DATE.getTime(); // 1777377600000

// ─── Discriminating tip slot ──────────────────────────────────────────────────

/**
 * TIP_SLOT_LIVE is chosen so that:
 *   mockSlotToWallclockMs(TIP_SLOT_LIVE) = TIP_SLOT_LIVE * 1000 = 50_000_000
 * which is far below FAKE_NOW_MS (1_745_841_600_000).
 *
 * buildPostAdvertTx has a ±5min validity check (±300_000ms). Neither
 *   |FAKE_NOW_MS - 50_000_000| nor |50_000_000 - 50_000_000|
 * can satisfy the validity window simultaneously — so the test implicitly
 * validates that Catherine's implementation branches correctly AND also
 * updates the validity check in buildPostAdvertTx to use Date.now() for live chains.
 *
 * For RED phase: when postAdvertFlow uses mockSlotToWallclockMs on a live chain,
 * it sets advertised_at = 50_000_000. buildPostAdvertTx also uses mockSlotToWallclockMs,
 * so the ±5min check passes (|50_000_000 - 50_000_000| = 0). The datum gets written.
 * We then read it back and verify it is NOT FAKE_NOW_MS — proving the test is RED.
 */
const TIP_SLOT_LIVE = 50_000;
const TIP_SLOT_LIVE_MS = TIP_SLOT_LIVE * 1_000; // = 50_000_000 (mock convention, NOT real POSIX)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rpcOk<T>(result: T) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) };
}

function protocolParamsResponse() {
  return rpcOk({
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
  });
}

/**
 * Attempt to extract and decode the AdvertDatum from a submitted test-tx hex.
 *
 * The test tx format produced by encodeTxBody:
 *   - First 8 hex chars: big-endian uint32 byte length of JSON payload
 *   - Next (length * 2) hex chars: JSON UTF-8 encoded payload
 *
 * The JSON has shape { type, outputs: [{..., datumHex: "<hex>"}], ... }
 * We extract the first output's datumHex and decode it with decodeAdvertDatum.
 *
 * Returns null if the hex is not in this format or has no datum.
 */
function extractAdvertisedAtFromTxCbor(txCborHex: string): number | null {
  try {
    if (txCborHex.length < 8) return null;
    const lenHex = txCborHex.slice(0, 8);
    const jsonLen = parseInt(lenHex, 16);
    if (!Number.isFinite(jsonLen) || jsonLen <= 0) return null;
    const jsonHex = txCborHex.slice(8, 8 + jsonLen * 2);
    const jsonStr = Buffer.from(jsonHex, "hex").toString("utf8");
    const body = JSON.parse(jsonStr) as { outputs?: Array<{ datumHex?: string }> };
    const datumHex = body.outputs?.[0]?.datumHex;
    if (!datumHex) return null;
    const datum = decodeAdvertDatum(datumHex);
    return datum.advertised_at;
  } catch {
    return null;
  }
}

/**
 * Build a LiveOgmiosProvider with a mocked fetch returning TIP_SLOT_LIVE.
 * The submitTx and awaitTx methods are spied on so we can capture submitted CBOR.
 */
function buildLiveChain(): {
  chain: LiveOgmiosProvider;
  capturedTxCborHex: { value: string | undefined };
} {
  const supplier = buildSupplierWalletKey();
  const captured: { value: string | undefined } = { value: undefined };

  const mockFetch = vi.fn().mockImplementation(
    async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";

      if (method === "queryNetwork/tip") {
        return rpcOk({ slot: TIP_SLOT_LIVE, id: "a".repeat(64) });
      }
      if (method === "queryLedgerState/protocolParameters") {
        return protocolParamsResponse();
      }
      if (method === "queryLedgerState/utxo") {
        return rpcOk([
          {
            transaction: { id: "c".repeat(64) },
            index: 0,
            address: supplier.address,
            value: { ada: { lovelace: 10_000_000 } },
            datum: null,
            datumHash: null,
            script: null,
          },
        ]);
      }
      if (method === "submitTransaction") {
        return rpcOk({ transaction: { id: "e".repeat(64) } });
      }
      return rpcOk({});
    },
  );

  const chain = new LiveOgmiosProvider({
    ogmiosUrl: "http://ogmios:1337",
    fetch: mockFetch,
  });

  // Capture the tx CBOR from buildPostAdvertTx's chain.submitTx call
  vi.spyOn(chain, "submitTx").mockImplementation(async (txCborHex: string) => {
    captured.value = txCborHex;
    return "e".repeat(64);
  });

  vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);

  return { chain, capturedTxCborHex: captured };
}

/**
 * buildMockChain — matches the convention from cli-post-advert-flow.test.ts.
 * VALID_TIP_SLOT = 0 → mockSlotToWallclockMs(0) = 0.
 */
function buildMockChain(): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(VALID_TIP_SLOT);
  return chain;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW_DATE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Mock backend — existing convention preserved ─────────────────────────────

describe("runPostAdvert() [mock backend] — advertised_at = mockSlotToWallclockMs(tipSlot)", () => {
  it("advert.advertised_at === mockSlotToWallclockMs(VALID_TIP_SLOT)", async () => {
    // VALID_TIP_SLOT = 0 → mockSlotToWallclockMs(0) = 0
    const EXPECTED_ADVERTISED_AT = VALID_TIP_SLOT * 1_000; // = 0

    const chain = buildMockChain();
    const result = await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });

    // With MockChainProvider the seeded UTxO is queryable directly
    const utxo = await chain.queryUtxo(result.advertRef);
    expect(utxo).not.toBeNull();
    const storedDatum = decodeAdvertDatum(utxo!.datumHex!);
    expect(storedDatum.advertised_at).toBe(EXPECTED_ADVERTISED_AT);
  });
});

// ─── Live backend — uses Date.now() ──────────────────────────────────────────

describe("runPostAdvert() [live backend] — advertised_at = Date.now()", () => {
  it("advert.advertised_at === Date.now() (FAKE_NOW_MS) when chain is LiveOgmiosProvider", async () => {
    // RED phase: the current implementation uses mockSlotToWallclockMs(TIP_SLOT_LIVE)
    // = 50_000_000. The test asserts advertised_at === FAKE_NOW_MS (1_745_841_600_000).
    // This FAILS until Catherine branches postAdvertFlow.ts on LiveOgmiosProvider.
    //
    // Note: for this test to pass GREEN, Catherine must also update buildPostAdvertTx
    // to use Date.now() for the ±5min validity check on live chains, since
    // |FAKE_NOW_MS - 50_000_000| >> 5min and would otherwise throw
    // "advertised_at out of validity range".
    const { chain, capturedTxCborHex } = buildLiveChain();

    await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });

    // Extract advertised_at from the datum embedded in the submitted tx CBOR
    expect(capturedTxCborHex.value).not.toBeUndefined();
    const advertisedAt = extractAdvertisedAtFromTxCbor(capturedTxCborHex.value!);
    expect(advertisedAt).not.toBeNull();
    // Must be FAKE_NOW_MS, not TIP_SLOT_LIVE * 1000
    expect(advertisedAt).toBe(FAKE_NOW_MS);
  });

  it("callee uses Date.now() not tipSlot*1000 — advertised_at is in real-POSIX-ms range (>1.7e12)", async () => {
    // Complementary discriminating assertion:
    //   - TIP_SLOT_LIVE_MS = 50_000_000 (NOT in real POSIX range)
    //   - FAKE_NOW_MS = 1_745_841_600_000 (in real POSIX range > 1.7e12)
    // RED: current code sets advertised_at = 50_000_000 (< 1.7e12 threshold).
    // GREEN: Catherine's code must set advertised_at = Date.now() = FAKE_NOW_MS (> 1.7e12).
    const { chain, capturedTxCborHex } = buildLiveChain();

    await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });

    expect(capturedTxCborHex.value).not.toBeUndefined();
    const advertisedAt = extractAdvertisedAtFromTxCbor(capturedTxCborHex.value!);
    expect(advertisedAt).not.toBeNull();

    // Sanity checks on constants
    expect(FAKE_NOW_MS).toBeGreaterThan(1.7e12);
    expect(TIP_SLOT_LIVE_MS).toBeLessThan(1e9); // far below real-clock range

    // The actual assertion: advertised_at must be in the real-POSIX-ms range
    expect(advertisedAt!).toBeGreaterThan(1.7e12);
    // And must NOT be the mock-convention value
    expect(advertisedAt!).not.toBe(TIP_SLOT_LIVE_MS);
  });
});
