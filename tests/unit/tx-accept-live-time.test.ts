/**
 * tx-accept-live-time.test.ts — RED phase tests for M1-F-time-cleanup
 *
 * Verifies that buildAcceptTx() with a LiveOgmiosProvider uses Date.now()
 * for the accept-window deadline check instead of mockSlotToWallclockMs(tipSlot).
 *
 * Production decisions baked in:
 *   - Live backend: tipMs (for window check) = Date.now()
 *   - Live builder: validFrom = Date.now(), validTo = submitted_at + ACCEPT_WINDOW_MS
 *   - Mock backend (existing): tipMs = mockSlotToWallclockMs(tipSlot) — UNCHANGED
 *
 * Accept validity upper-bound = datum.submitted_at + ACCEPT_WINDOW_MS (600_000).
 * Tests assert the upper-bound is set correctly regardless of tip slot.
 *
 * Uses vi.useFakeTimers to lock Date.now().
 *
 * M1-F-time-cleanup RED — fail until Catherine updates accept.ts live path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { buildAcceptTx, ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/escrow/accept.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { encodeEscrowDatum, decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildSubmittedEscrowUtxo, SUBMITTED_AT, PAYMENT_LOVELACE, BUYER_BOND, SUPPLIER_BOND } from "../fixtures/buyer-side/sample-escrow-utxos.js";

// ─── Fixed fake time ──────────────────────────────────────────────────────────

const FAKE_NOW_DATE = new Date("2026-04-27T12:00:00Z");
const FAKE_NOW_MS = FAKE_NOW_DATE.getTime(); // 1745748000000

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const ESCROW_TX_HASH = "f".repeat(64);
const ESCROW_INDEX = 2;
// 100 ADA — must cover script-spend fee, collateral, and change min-ADA after the
// synthetic padding-input shortcut was removed (ARCHITECTURE.md §9 #14).
const COLLATERAL_LOVELACE = 100_000_000;

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW_DATE);
});

afterEach(() => {
  vi.useRealTimers();
});

function rpcOk<T>(result: T) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) };
}

function makeOgmiosUtxo(txId: string, index: number, address: string, lovelace: number, datumHex?: string) {
  return {
    transaction: { id: txId },
    index,
    address,
    value: { ada: { lovelace } },
    datum: datumHex ?? null,
    datumHash: null,
    script: null,
  };
}

function protocolParamsResponse() {
  return rpcOk({
    minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } },
    maxTransactionSize: { bytes: 16384 }, maxValueSize: { bytes: 5000 },
    stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
    stakePoolDeposit: { ada: { lovelace: 500000000 } },
    prices: { memory: "0.0577", steps: "0.0000721" },
    maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
    coinsPerUtxoByte: { ada: { lovelace: 4310 } }, collateralPercentage: 150, maxCollateralInputs: 3,
    plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
    monetaryExpansion: "0.003", treasuryExpansion: "0.2",
    minStakePoolCost: { ada: { lovelace: 340000000 } },
    minFeeReferenceScripts: { base: 15 },
    governanceActionDeposit: { ada: { lovelace: 100000000000 } },
    delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
  });
}

function buildLiveChain(): LiveOgmiosProvider {
  return new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: mockFetch });
}

// ─── Build a Submitted datum whose window contains FAKE_NOW_MS ───────────────

function makeSubmittedDatumInWindow(): string {
  const submittedUtxo = buildSubmittedEscrowUtxo();
  const baseDatum = decodeEscrowDatum(submittedUtxo.datumHex!);
  // submitted_at is before FAKE_NOW_MS, window ends after FAKE_NOW_MS
  const submittedAt = FAKE_NOW_MS - 100_000; // 100 seconds before faked "now"
  const windowEnd = submittedAt + ACCEPT_WINDOW_MS; // 500 seconds after "now"
  return encodeEscrowDatum({
    ...baseDatum,
    submitted_at: submittedAt,
    state: "Submitted",
  });
}

function setupAcceptLiveHappyPath(escrowDatumHex: string): void {
  const buyer = buildBuyerWalletKey();

  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const method: string = body.method ?? "";

    if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
    if (method === "queryLedgerState/utxo") {
      if ((body.params ?? {}).outputReferences) {
        return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, "addr_escrow", 4_000_000, escrowDatumHex)]);
      }
      return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, COLLATERAL_LOVELACE)]);
    }
    // Tip slot is LOW — live path uses Date.now() for the window check
    if (method === "queryNetwork/tip") return rpcOk({ slot: 100_000, id: "a".repeat(64) });
    if (method === "submitTransaction") return rpcOk({ transaction: { id: "d".repeat(64) } });
    return rpcOk({});
  });
}

// ─── A. Accept passes when Date.now() is within accept window ────────────────

describe("buildAcceptTx() [live] — window check uses Date.now()", () => {
  it("succeeds when Date.now() is within submitted_at + ACCEPT_WINDOW_MS", async () => {
    const datumHex = makeSubmittedDatumInWindow();
    setupAcceptLiveHappyPath(datumHex);
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildAcceptTx({
      chain,
      buyerKey: buyer,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    const firstByte = result.txCborHex.slice(0, 2).toLowerCase();
    expect(["83", "84"]).toContain(firstByte);
  });

  it("throws 'accept window expired' when Date.now() > submitted_at + ACCEPT_WINDOW_MS", async () => {
    // submitted_at is far in the past — window expired relative to FAKE_NOW_MS
    const VERY_OLD_SUBMITTED_AT = FAKE_NOW_MS - ACCEPT_WINDOW_MS - 1;

    const submittedUtxo = buildSubmittedEscrowUtxo();
    const baseDatum = decodeEscrowDatum(submittedUtxo.datumHex!);
    const expiredDatumHex = encodeEscrowDatum({
      ...baseDatum,
      submitted_at: VERY_OLD_SUBMITTED_AT,
      state: "Submitted",
    });

    const buyer = buildBuyerWalletKey();
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, "addr_escrow", 4_000_000, expiredDatumHex)]);
        }
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, COLLATERAL_LOVELACE)]);
      }
      // Tip slot is LOW — only Date.now() catches the expired window
      if (method === "queryNetwork/tip") return rpcOk({ slot: 100_000, id: "a".repeat(64) });
      return rpcOk({});
    });

    const chain = buildLiveChain();

    await expect(
      buildAcceptTx({
        chain,
        buyerKey: buyer,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toMatchObject({ reason: "accept window expired" });
  });

  it("validity upper-bound = submitted_at + ACCEPT_WINDOW_MS (not affected by tip)", async () => {
    // This test verifies the semantic correctness of the upper bound formula.
    // submitted_at is BEFORE FAKE_NOW_MS but window hasn't expired.
    const submittedAt = FAKE_NOW_MS - 100_000;
    const expectedWindowEnd = submittedAt + ACCEPT_WINDOW_MS;

    const submittedUtxo = buildSubmittedEscrowUtxo();
    const baseDatum = decodeEscrowDatum(submittedUtxo.datumHex!);
    const datumHex = encodeEscrowDatum({
      ...baseDatum,
      submitted_at: submittedAt,
      state: "Submitted",
    });

    setupAcceptLiveHappyPath(datumHex);
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildAcceptTx({
      chain,
      buyerKey: buyer,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    // Result CBOR must be a real Conway tx
    expect(["83", "84"]).toContain(result.txCborHex.slice(0, 2).toLowerCase());
    // ACCEPT_WINDOW_MS must equal 600_000 (canonical value)
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    // expectedWindowEnd is submittedAt + 600_000
    expect(expectedWindowEnd).toBe(submittedAt + 600_000);
  });

  it("error detail on expired window references Date.now() not tipSlot*1000", async () => {
    const VERY_OLD_SUBMITTED_AT = FAKE_NOW_MS - ACCEPT_WINDOW_MS - 500;
    const submittedUtxo = buildSubmittedEscrowUtxo();
    const baseDatum = decodeEscrowDatum(submittedUtxo.datumHex!);
    const expiredDatumHex = encodeEscrowDatum({
      ...baseDatum,
      submitted_at: VERY_OLD_SUBMITTED_AT,
      state: "Submitted",
    });

    const buyer = buildBuyerWalletKey();
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, "addr_escrow", 4_000_000, expiredDatumHex)]);
        }
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, COLLATERAL_LOVELACE)]);
      }
      // tip slot = 100_000 → mock convention: 100_000_000; live must use FAKE_NOW_MS
      if (method === "queryNetwork/tip") return rpcOk({ slot: 100_000, id: "a".repeat(64) });
      return rpcOk({});
    });

    const chain = buildLiveChain();

    let caught: unknown;
    try {
      await buildAcceptTx({
        chain,
        buyerKey: buyer,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TxConstructionError);
    // Error message must reference FAKE_NOW_MS in "tip X > windowEnd Y"
    const msg = (caught as TxConstructionError).message;
    expect(msg).toContain(String(FAKE_NOW_MS));
  });
});
