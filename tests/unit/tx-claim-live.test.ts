/**
 * tx-claim-live.test.ts — RED phase tests for buildClaimTx() with LiveOgmiosProvider
 *
 * The live path produces real Cardano CBOR spending the Open escrow UTxO.
 * Redeemer = Claim (Constr0, variant 0 of EscrowRedeemer).
 * The escrow spending validator is attached to the tx.
 *
 * Existing MockChainProvider tests in tx-claim.test.ts are NOT modified.
 *
 * M1-F-4 RED — tests fail until Catherine implements the live CBOR path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { buildClaimTx } from "../../packages/shared/src/tx/escrow/claim.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { encodeEscrowDatum, decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildSupplierWalletKey, SUPPLIER_PKH } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey, BUYER_PKH } from "../fixtures/buyer-side/wallet-keys.js";
import {
  buildOpenEscrowUtxo,
  DELIVER_BY,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const ESCROW_TX_HASH = "f".repeat(64);
const ESCROW_INDEX = 0;
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

function setupClaimHappyPath(escrowDatumHex: string): void {
  const supplier = buildSupplierWalletKey();
  const openUtxo = buildOpenEscrowUtxo();
  const escrowAddress = openUtxo.address;

  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const method: string = body.method ?? "";

    if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
    if (method === "queryLedgerState/utxo") {
      if ((body.params ?? {}).outputReferences) {
        return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, escrowAddress, 4_000_000, escrowDatumHex)]);
      }
      // Supplier wallet UTxOs (for coin selection + collateral)
      return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, supplier.address, COLLATERAL_LOVELACE)]);
    }
    if (method === "queryNetwork/tip") {
      // Tip well before deliver_by
      return rpcOk({ slot: Math.floor((DELIVER_BY - 60_000) / 1000), id: "a".repeat(64) });
    }
    if (method === "submitTransaction") return rpcOk({ transaction: { id: "d".repeat(64) } });
    return rpcOk({});
  });
}

// ─── A. CBOR shape ─────────────────────────────────────────────────────────────

describe("buildClaimTx() [live] — CBOR shape", () => {
  it("returns real Cardano CBOR starting with 83 or 84", async () => {
    const openUtxo = buildOpenEscrowUtxo();
    setupClaimHappyPath(openUtxo.datumHex!);
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

  it("txCborHex is non-empty lowercase hex", async () => {
    const openUtxo = buildOpenEscrowUtxo();
    setupClaimHappyPath(openUtxo.datumHex!);
    const chain = buildLiveChain();
    const supplier = buildSupplierWalletKey();

    const result = await buildClaimTx({
      chain,
      supplierKey: supplier,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    expect(result.txCborHex.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/i.test(result.txCborHex)).toBe(true);
  });
});

// ─── B. State transition in continuing output ─────────────────────────────────

describe("buildClaimTx() [live] — datum state transition", () => {
  it("contains the encoded Claimed datum hex as a substring of the tx CBOR", async () => {
    const openUtxo = buildOpenEscrowUtxo();
    setupClaimHappyPath(openUtxo.datumHex!);
    const chain = buildLiveChain();
    const supplier = buildSupplierWalletKey();

    const result = await buildClaimTx({
      chain,
      supplierKey: supplier,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    // The encoded Claimed datum bytes must appear somewhere in the tx body
    // (inline datum in the continuing output)
    const openDatumDecoded = decodeEscrowDatum(openUtxo.datumHex!);
    const claimedDatumHex = encodeEscrowDatum({ ...openDatumDecoded, state: "Claimed" as const });
    expect(result.txCborHex).toContain(claimedDatumHex);
  });
});

// ─── C. Validity range ─────────────────────────────────────────────────────────

describe("buildClaimTx() [live] — validity range", () => {
  it("tx is built successfully when tip is before deliver_by", async () => {
    const openUtxo = buildOpenEscrowUtxo();
    setupClaimHappyPath(openUtxo.datumHex!);
    const chain = buildLiveChain();
    const supplier = buildSupplierWalletKey();

    const result = await buildClaimTx({
      chain,
      supplierKey: supplier,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
    });

    expect(result.txCborHex.length).toBeGreaterThan(0);
  });
});

// ─── D. Rejection paths ────────────────────────────────────────────────────────

describe("buildClaimTx() [live] — rejection paths", () => {
  it("throws TxConstructionError('supplier signature mismatch') when caller pkh != datum.supplier_pkh", async () => {
    const openUtxo = buildOpenEscrowUtxo();
    setupClaimHappyPath(openUtxo.datumHex!);
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey(); // buyer tries to claim

    await expect(
      buildClaimTx({
        chain,
        supplierKey: buyer,  // wrong key
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toMatchObject({ reason: "supplier signature mismatch" });
  });

  it("throws TxConstructionError('wrong state') when escrow.state != Open", async () => {
    // Use a Claimed datum instead of Open
    const openUtxo = buildOpenEscrowUtxo();
    const openDatum = decodeEscrowDatum(openUtxo.datumHex!);
    const claimedDatumHex = encodeEscrowDatum({ ...openDatum, state: "Claimed" as const });

    setupClaimHappyPath(claimedDatumHex);
    const chain = buildLiveChain();
    const supplier = buildSupplierWalletKey();

    await expect(
      buildClaimTx({
        chain,
        supplierKey: supplier,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toMatchObject({ reason: "wrong state" });
  });

  it("throws TxConstructionError('claim after deliver_by') when tip >= deliver_by", async () => {
    // On the live path, tipMs = Date.now(). To trigger 'claim after deliver_by'
    // we need datum.deliver_by < Date.now(), so use a deliver_by explicitly in the past.
    const openUtxo = buildOpenEscrowUtxo();
    const openDatum = decodeEscrowDatum(openUtxo.datumHex!);
    const pastDeliverBy = Date.now() - 1;
    const pastDatumHex = encodeEscrowDatum({ ...openDatum, deliver_by: pastDeliverBy });
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
      // Tip slot value is not used for the live deadline check (Date.now() is used instead)
      if (method === "queryNetwork/tip") {
        return rpcOk({ slot: 100_000, id: "a".repeat(64) });
      }
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

  it("throws TxConstructionError('escrow ref not on chain') when escrow UTxO absent", async () => {
    const supplier = buildSupplierWalletKey();

    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      // All UTxO queries return empty
      return rpcOk([]);
    });

    const chain = buildLiveChain();

    await expect(
      buildClaimTx({
        chain,
        supplierKey: supplier,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toMatchObject({ reason: "escrow ref not on chain" });
  });
});

// ─── E. Collateral ─────────────────────────────────────────────────────────────

describe("buildClaimTx() [live] — collateral", () => {
  it("throws TxConstructionError containing 'collateral' when supplier wallet has no ≥5 ADA UTxO", async () => {
    const openUtxo = buildOpenEscrowUtxo();
    const escrowDatumHex = openUtxo.datumHex!;
    const supplier = buildSupplierWalletKey();

    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, "addr_escrow", 4_000_000, escrowDatumHex)]);
        }
        // Supplier has only 1 ADA — below collateral floor
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, supplier.address, 1_000_000)]);
      }
      if (method === "queryNetwork/tip") {
        return rpcOk({ slot: Math.floor((DELIVER_BY - 60_000) / 1000), id: "a".repeat(64) });
      }
      return rpcOk({});
    });

    const chain = buildLiveChain();

    await expect(
      buildClaimTx({
        chain,
        supplierKey: supplier,
        escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      }),
    ).rejects.toThrow(TxConstructionError);
  });
});
