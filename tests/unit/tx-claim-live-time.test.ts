/**
 * tx-claim-live-time.test.ts — RED phase tests for M1-F-time-cleanup
 *
 * Verifies that buildClaimTx() with a LiveOgmiosProvider uses Date.now()
 * for the validity range lower-bound rather than mockSlotToWallclockMs(tipSlot).
 *
 * Production decisions baked in:
 *   - Live backend: tipMs (for deadline check) = Date.now()
 *   - Live builder: validFrom = Date.now(), validTo = datum.deliver_by
 *   - Mock backend (existing): tipMs = mockSlotToWallclockMs(tipSlot) — UNCHANGED
 *
 * The deadline check in claim.ts must branch on backend:
 *   if live: tipMs = Date.now()
 *   else: tipMs = mockSlotToWallclockMs(tipSlot)   (unchanged)
 *
 * Uses vi.useFakeTimers to lock Date.now().
 *
 * M1-F-time-cleanup RED — fail until Catherine updates claim.ts live path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { buildClaimTx } from "../../packages/shared/src/tx/escrow/claim.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { encodeEscrowDatum, decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildOpenEscrowUtxo } from "../fixtures/buyer-side/sample-escrow-utxos.js";

// ─── Fixed fake time ──────────────────────────────────────────────────────────

const FAKE_NOW_DATE = new Date("2026-04-27T12:00:00Z");
const FAKE_NOW_MS = FAKE_NOW_DATE.getTime(); // 1745748000000

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const ESCROW_TX_HASH = "f".repeat(64);
const ESCROW_INDEX = 0;
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

/**
 * Setup claim happy path where:
 *   - deliver_by is Date.now() + 300_000 (well in the future relative to faked Date.now)
 *   - tip slot is intentionally low (mock convention tipSlot*1000 would be << Date.now)
 */
function setupClaimLiveHappyPath(escrowDatumHex: string): void {
  const supplier = buildSupplierWalletKey();

  // deliver_by must be strictly after Date.now() for the claim to succeed
  const DELIVER_BY_AFTER_NOW = FAKE_NOW_MS + 300_000;

  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const method: string = body.method ?? "";

    if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
    if (method === "queryLedgerState/utxo") {
      if ((body.params ?? {}).outputReferences) {
        return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, "addr_escrow", 4_000_000, escrowDatumHex)]);
      }
      return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, supplier.address, COLLATERAL_LOVELACE)]);
    }
    // Tip slot is intentionally low — real deadline check uses Date.now(), not tipMs
    if (method === "queryNetwork/tip") {
      return rpcOk({ slot: 100_000, id: "a".repeat(64) });
    }
    if (method === "submitTransaction") return rpcOk({ transaction: { id: "d".repeat(64) } });
    return rpcOk({});
  });
}

// ─── A. Live claim passes when Date.now() < deliver_by ───────────────────────

describe("buildClaimTx() [live] — deadline check uses Date.now()", () => {
  it("succeeds when Date.now() is before datum.deliver_by (ignoring tip slot)", async () => {
    // Arrange: Build an escrow with deliver_by well AFTER faked Date.now()
    // The tip slot (100_000 → slot*1000 = 100_000_000 ms) is also before deliver_by,
    // but the key is that live path must read Date.now() not tip*1000.
    const openUtxo = buildOpenEscrowUtxo();
    const openDatum = decodeEscrowDatum(openUtxo.datumHex!);
    // Create datum whose deliver_by is after FAKE_NOW_MS
    const futureDeliverBy = FAKE_NOW_MS + 300_000;
    const futureDatumHex = encodeEscrowDatum({ ...openDatum, deliver_by: futureDeliverBy });

    setupClaimLiveHappyPath(futureDatumHex);
    const chain = buildLiveChain();
    const supplier = buildSupplierWalletKey();

    const result = await buildClaimTx({
      chain,
      supplierKey: supplier,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    const firstByte = result.txCborHex.slice(0, 2).toLowerCase();
    expect(["83", "84"]).toContain(firstByte);
  });

  it("throws 'claim after deliver_by' when Date.now() >= deliver_by on live backend", async () => {
    // deliver_by is in the PAST relative to faked Date.now()
    const PAST_DELIVER_BY = FAKE_NOW_MS - 1;

    const openUtxo = buildOpenEscrowUtxo();
    const openDatum = decodeEscrowDatum(openUtxo.datumHex!);
    const pastDatumHex = encodeEscrowDatum({ ...openDatum, deliver_by: PAST_DELIVER_BY });

    const supplier = buildSupplierWalletKey();
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, "addr_escrow", 4_000_000, pastDatumHex)]);
        }
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, supplier.address, COLLATERAL_LOVELACE)]);
      }
      // Tip slot is LOW (tip*1000 = 100_000_000 << FAKE_NOW_MS) so only Date.now()
      // catches the expired deadline correctly
      if (method === "queryNetwork/tip") return rpcOk({ slot: 100_000, id: "a".repeat(64) });
      return rpcOk({});
    });

    const chain = buildLiveChain();

    await expect(
      buildClaimTx({
        chain,
        supplierKey: supplier,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toMatchObject({ reason: "claim after deliver_by" });
  });

  it("continuing output contains Claimed datum with same deliver_by as original", async () => {
    const openUtxo = buildOpenEscrowUtxo();
    const openDatum = decodeEscrowDatum(openUtxo.datumHex!);
    const futureDeliverBy = FAKE_NOW_MS + 300_000;
    const futureDatumHex = encodeEscrowDatum({ ...openDatum, deliver_by: futureDeliverBy });

    setupClaimLiveHappyPath(futureDatumHex);
    const chain = buildLiveChain();
    const supplier = buildSupplierWalletKey();

    const result = await buildClaimTx({
      chain,
      supplierKey: supplier,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    // The tx CBOR must contain the Claimed datum with deliver_by preserved
    const claimedDatumHex = encodeEscrowDatum({
      ...openDatum,
      deliver_by: futureDeliverBy,
      state: "Claimed",
    });
    expect(result.txCborHex).toContain(claimedDatumHex);
  });

  it("error message on expiry references real-ms 'now', not slot*1000", async () => {
    // deliver_by is just before Date.now()
    const PAST_DELIVER_BY = FAKE_NOW_MS - 500;

    const openUtxo = buildOpenEscrowUtxo();
    const openDatum = decodeEscrowDatum(openUtxo.datumHex!);
    const pastDatumHex = encodeEscrowDatum({ ...openDatum, deliver_by: PAST_DELIVER_BY });

    const supplier = buildSupplierWalletKey();
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, "addr_escrow", 4_000_000, pastDatumHex)]);
        }
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, supplier.address, COLLATERAL_LOVELACE)]);
      }
      if (method === "queryNetwork/tip") return rpcOk({ slot: 100_000, id: "a".repeat(64) });
      return rpcOk({});
    });

    const chain = buildLiveChain();

    let caught: unknown;
    try {
      await buildClaimTx({
        chain,
        supplierKey: supplier,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TxConstructionError);
    // Error message must reference FAKE_NOW_MS (real ms), not 100_000 * 1000 = 100_000_000
    const msg = (caught as TxConstructionError).message;
    expect(msg).toContain(String(FAKE_NOW_MS));
  });
});
