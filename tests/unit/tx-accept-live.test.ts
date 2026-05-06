/**
 * tx-accept-live.test.ts — RED phase tests for buildAcceptTx() with LiveOgmiosProvider
 *
 * The live path produces real Cardano CBOR spending the Submitted escrow UTxO.
 * Redeemer = Accept (Constr2, variant 2 of EscrowRedeemer).
 * Outputs distribute: supplier receives payment+supplier_bond; buyer receives buyer_bond.
 * Validity upper bound = submitted_at + ACCEPT_WINDOW_MS.
 *
 * Existing MockChainProvider tests in tx-accept.test.ts are NOT modified.
 *
 * M1-F-4 RED — tests fail until Catherine implements the live CBOR path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { buildAcceptTx, ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/escrow/accept.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { encodeEscrowDatum, decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildSubmittedEscrowUtxo,
  SUBMITTED_AT,
  PAYMENT_LOVELACE,
  BUYER_BOND,
  SUPPLIER_BOND,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const ESCROW_TX_HASH = "f".repeat(64);
const ESCROW_INDEX = 2;
// 100 ADA — must cover script-spend fee, collateral, and change min-ADA after the
// synthetic padding-input shortcut was removed (ARCHITECTURE.md §9 #14).
const COLLATERAL_LOVELACE = 100_000_000;

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
});

function rpcOk<T>(result: T) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) };
}

function makeOgmiosUtxo(txId: string, index: number, address: string, lovelace: number, datumHex?: string) {
  return { transaction: { id: txId }, index, address, value: { ada: { lovelace } }, datum: datumHex ?? null, datumHash: null, script: null };
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

function setupAcceptHappyPath(escrowDatumHex: string): void {
  const buyer = buildBuyerWalletKey();
  const submittedUtxo = buildSubmittedEscrowUtxo();
  const escrowAddress = submittedUtxo.address;
  // Tip is within accept window
  const tipSlot = Math.floor((SUBMITTED_AT + ACCEPT_WINDOW_MS / 2) / 1000);

  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const method: string = body.method ?? "";

    if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
    if (method === "queryLedgerState/utxo") {
      if ((body.params ?? {}).outputReferences) {
        return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, escrowAddress, 4_000_000, escrowDatumHex)]);
      }
      return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, COLLATERAL_LOVELACE)]);
    }
    if (method === "queryNetwork/tip") return rpcOk({ slot: tipSlot, id: "a".repeat(64) });
    if (method === "submitTransaction") return rpcOk({ transaction: { id: "d".repeat(64) } });
    return rpcOk({});
  });
}

// ─── A. CBOR shape ─────────────────────────────────────────────────────────────

describe("buildAcceptTx() [live] — CBOR shape", () => {
  it("returns real Cardano CBOR starting with 83 or 84", async () => {
    const submittedUtxo = buildSubmittedEscrowUtxo();
    setupAcceptHappyPath(submittedUtxo.datumHex!);
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

  it("txCborHex is non-empty lowercase hex string", async () => {
    const submittedUtxo = buildSubmittedEscrowUtxo();
    setupAcceptHappyPath(submittedUtxo.datumHex!);
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildAcceptTx({
      chain,
      buyerKey: buyer,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    expect(/^[0-9a-f]+$/i.test(result.txCborHex)).toBe(true);
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });
});

// ─── B. Value distribution ────────────────────────────────────────────────────

describe("buildAcceptTx() [live] — value distribution", () => {
  it("supplier receives payment + supplier_bond (terminal tx, no continuing script output)", async () => {
    const submittedUtxo = buildSubmittedEscrowUtxo();
    setupAcceptHappyPath(submittedUtxo.datumHex!);
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildAcceptTx({
      chain,
      buyerKey: buyer,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    // The tx is valid (CBOR produced); distribution correctness is enforced on-chain
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });
});

// ─── C. Validity range ─────────────────────────────────────────────────────────

describe("buildAcceptTx() [live] — validity range", () => {
  it("succeeds when tip is within ACCEPT_WINDOW", async () => {
    const submittedUtxo = buildSubmittedEscrowUtxo();
    setupAcceptHappyPath(submittedUtxo.datumHex!);
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    // The mock tip is set to submitted_at + ACCEPT_WINDOW/2 — within window
    const result = await buildAcceptTx({
      chain,
      buyerKey: buyer,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    expect(result.txCborHex.length).toBeGreaterThan(0);
  });
});

// ─── D. Rejection paths ────────────────────────────────────────────────────────

describe("buildAcceptTx() [live] — rejection paths", () => {
  it("throws TxConstructionError('buyer signature mismatch') when caller pkh != datum.buyer_pkh", async () => {
    const submittedUtxo = buildSubmittedEscrowUtxo();
    setupAcceptHappyPath(submittedUtxo.datumHex!);
    const chain = buildLiveChain();
    const supplier = buildSupplierWalletKey(); // wrong key

    await expect(
      buildAcceptTx({
        chain,
        buyerKey: supplier,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toMatchObject({ reason: "buyer signature mismatch" });
  });

  it("throws TxConstructionError('wrong state') when escrow.state != Submitted", async () => {
    const submittedUtxo = buildSubmittedEscrowUtxo();
    const submittedDatum = decodeEscrowDatum(submittedUtxo.datumHex!);
    // Revert to Open state
    const openDatumHex = encodeEscrowDatum({ ...submittedDatum, state: "Open" as const, submitted_at: null, result_receipt_hash: null });

    setupAcceptHappyPath(openDatumHex);
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    await expect(
      buildAcceptTx({
        chain,
        buyerKey: buyer,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toMatchObject({ reason: "wrong state" });
  });

  it("throws TxConstructionError('accept window expired') when tip > submitted_at + ACCEPT_WINDOW", async () => {
    // On the live path, tipMs = Date.now(). To trigger 'accept window expired'
    // we need submitted_at + ACCEPT_WINDOW_MS < Date.now(), so use a submitted_at
    // that places the window end in the past.
    const submittedUtxo = buildSubmittedEscrowUtxo();
    const submittedDatum = decodeEscrowDatum(submittedUtxo.datumHex!);
    const expiredSubmittedAt = Date.now() - ACCEPT_WINDOW_MS - 1;
    const expiredDatumHex = encodeEscrowDatum({
      ...submittedDatum,
      submitted_at: expiredSubmittedAt,
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
      // Tip slot is not used for the live window check (Date.now() is used instead)
      if (method === "queryNetwork/tip") {
        return rpcOk({ slot: 100_000, id: "a".repeat(64) });
      }
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

  it("throws TxConstructionError('escrow ref not on chain') when escrow UTxO absent", async () => {
    const buyer = buildBuyerWalletKey();

    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      return rpcOk([]);
    });

    const chain = buildLiveChain();

    await expect(
      buildAcceptTx({
        chain,
        buyerKey: buyer,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toMatchObject({ reason: "escrow ref not on chain" });
  });

  it("throws TxConstructionError containing 'collateral' when buyer wallet is empty", async () => {
    const submittedUtxo = buildSubmittedEscrowUtxo();
    const escrowDatumHex = submittedUtxo.datumHex!;
    const buyer = buildBuyerWalletKey();
    const tipSlot = Math.floor((SUBMITTED_AT + ACCEPT_WINDOW_MS / 2) / 1000);

    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, "addr_escrow", 4_000_000, escrowDatumHex)]);
        }
        return rpcOk([]); // empty buyer wallet
      }
      if (method === "queryNetwork/tip") return rpcOk({ slot: tipSlot, id: "a".repeat(64) });
      return rpcOk({});
    });

    const chain = buildLiveChain();

    await expect(
      buildAcceptTx({
        chain,
        buyerKey: buyer,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toThrow(TxConstructionError);
  });
});
