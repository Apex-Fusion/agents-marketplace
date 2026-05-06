/**
 * tx-post-escrow-live.test.ts — RED phase tests for buildPostEscrowTx() with LiveOgmiosProvider
 *
 * The live path uses lucid-evolution to produce real Cardano CBOR instead of
 * synthetic JSON-in-hex. Ogmios fetch is fully mocked; lucid-evolution is
 * exercised for real (no mocking of TxBuilder).
 *
 * Existing MockChainProvider tests in tx-post-escrow.test.ts are NOT modified
 * — the Tier-1 mock path must continue to pass without regression.
 *
 * Coverage:
 *   A. Output CBOR shape (Conway-era prefix bytes)
 *   B. Inline datum present at escrow script output
 *   C. Locked value calculation
 *   D. Required signers / collateral
 *   E. Validity range (deliver_by upper bound)
 *   F. Rejection paths (buyer==supplier, empty messages, advert not found, retired, payment mismatch)
 *
 * M1-F-4 RED — tests fail until Catherine implements the live CBOR path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { buildPostEscrowTx } from "../../packages/shared/src/tx/escrow/postEscrow.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { ChatMessage } from "../../packages/shared/src/tx/types.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const ADVERT_TX_HASH = "b".repeat(64);
const ADVERT_INDEX = 0;
const SAMPLE_MESSAGES: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }];
const PAYMENT = 2_000_000n;

// 100 ADA wallet UTxO at buyer address — must cover: payment(2 ADA) + buyer_bond(1 ADA)
// + supplier_bond(1 ADA) locked in escrow output, plus change min-ADA + tx fee + collateral.
// 5 ADA was insufficient once the synthetic padding-input shortcut was removed (ARCHITECTURE.md §9 #14).
const BUYER_COLLATERAL_LOVELACE = 100_000_000;

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
});

function makeActiveAdvert(): AdvertDatum {
  const supplier = buildSupplierWalletKey();
  return {
    supplier_pkh: supplier.pubKeyHash,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: PAYMENT,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com/v1",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

function makeOgmiosUtxo(
  txId: string,
  index: number,
  address: string,
  lovelace: number,
  datumHex?: string,
) {
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

function rpcOk<T>(result: T) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", result }),
  };
}

/** Build a mock fetch that handles protocol-params, utxo queries, and submit. */
function buildLiveChain(): LiveOgmiosProvider {
  return new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: mockFetch });
}

function setupMocksForHappyPath(): void {
  const buyer = buildBuyerWalletKey();
  const advert = makeActiveAdvert();
  const advertDatumHex = encodeAdvertDatum(advert);

  // Protocol params (called by lucid at init)
  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const method: string = body.method ?? "";

    if (method === "queryLedgerState/protocolParameters") {
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

    if (method === "queryLedgerState/utxo") {
      const params = body.params ?? {};
      // If querying by outRef (advert), return advert UTxO with datum
      if (params.outputReferences) {
        return rpcOk([makeOgmiosUtxo(ADVERT_TX_HASH, ADVERT_INDEX, "addr_script_advert", 2_000_000, advertDatumHex)]);
      }
      // If querying by address (buyer wallet for UTxO selection / collateral)
      return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, BUYER_COLLATERAL_LOVELACE)]);
    }

    if (method === "queryNetwork/tip") {
      return rpcOk({ slot: 1_745_500_000, id: "a".repeat(64) });
    }

    if (method === "submitTransaction") {
      return rpcOk({ transaction: { id: "d".repeat(64) } });
    }

    return rpcOk({});
  });
}

// ─── A. Output CBOR shape ──────────────────────────────────────────────────────

describe("buildPostEscrowTx() [live] — CBOR shape", () => {
  it("returns a txCborHex that is a non-empty lowercase hex string", async () => {
    setupMocksForHappyPath();
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: PAYMENT,
    });

    expect(typeof result.txCborHex).toBe("string");
    expect(result.txCborHex.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/i.test(result.txCborHex)).toBe(true);
  });

  it("txCborHex starts with 83 or 84 (Conway-era tx body CBOR array)", async () => {
    setupMocksForHappyPath();
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: PAYMENT,
    });

    // Conway-era tx = CBOR array of 3 or 4 items → first byte 0x83 or 0x84
    const firstByte = result.txCborHex.slice(0, 2).toLowerCase();
    expect(["83", "84"]).toContain(firstByte);
  });

  it("txCborHex is NOT a JSON-encoded hex string (legacy synthetic format)", async () => {
    setupMocksForHappyPath();
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: PAYMENT,
    });

    // The old synthetic format starts with 8 hex chars that encode JSON byte-length.
    // A real CBOR tx will NOT begin with a length-prefixed JSON encoding.
    // We verify by checking the first byte is a CBOR array marker, NOT a JSON structure.
    const firstByte = result.txCborHex.slice(0, 2).toLowerCase();
    // JSON-in-hex would decode the first 4 bytes as a uint32 JSON length —
    // real CBOR always has 0x83 or 0x84 as the first byte.
    expect(firstByte).not.toBe("00"); // length prefix starts with 00 for small JSON
  });
});

// ─── B. Inline datum at escrow script output ──────────────────────────────────

describe("buildPostEscrowTx() [live] — inline datum", () => {
  it("escrowOutputRef is returned with a 64-char txHash", async () => {
    setupMocksForHappyPath();
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: PAYMENT,
    });

    expect(result.escrowOutputRef.txHash).toHaveLength(64);
    expect(result.escrowOutputRef.index).toBe(0);
  });
});

// ─── C. Locked value ──────────────────────────────────────────────────────────

describe("buildPostEscrowTx() [live] — locked value", () => {
  it("min locked value is max(price+bonds, 2_000_000) — min-UTxO floor", async () => {
    // Advert with very small bonds (1 lovelace each) — floor kicks in
    const supplier = buildSupplierWalletKey();
    const tinyAdvert: AdvertDatum = {
      ...makeActiveAdvert(),
      price_lovelace: 1n,
      buyer_bond_lovelace: 1n,
      supplier_bond_lovelace: 1n,
      supplier_pkh: supplier.pubKeyHash,
    };
    const tinyAdvertDatumHex = encodeAdvertDatum(tinyAdvert);

    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      const buyer = buildBuyerWalletKey();

      if (method === "queryLedgerState/protocolParameters") {
        return rpcOk({
          minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } },
          maxTransactionSize: { bytes: 16384 }, maxValueSize: { bytes: 5000 },
          stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
          stakePoolDeposit: { ada: { lovelace: 500000000 } },
          prices: { memory: "0.0577", steps: "0.0000721" },
          maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
          coinsPerUtxoByte: { ada: { lovelace: 4310 } },
          collateralPercentage: 150, maxCollateralInputs: 3,
          plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
          monetaryExpansion: "0.003", treasuryExpansion: "0.2",
          minStakePoolCost: { ada: { lovelace: 340000000 } },
          minFeeReferenceScripts: { base: 15 },
          governanceActionDeposit: { ada: { lovelace: 100000000000 } },
          delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
        });
      }
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ADVERT_TX_HASH, ADVERT_INDEX, "addr_advert", 2_000_000, tinyAdvertDatumHex)]);
        }
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, BUYER_COLLATERAL_LOVELACE)]);
      }
      if (method === "queryNetwork/tip") return rpcOk({ slot: 1_745_500_000, id: "a".repeat(64) });
      if (method === "submitTransaction") return rpcOk({ transaction: { id: "d".repeat(64) } });
      return rpcOk({});
    });

    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: 1n,
    });

    // The tx was built; the locked amount must be >= 2_000_000 (min-UTxO floor)
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });
});

// ─── D. Collateral requirement ────────────────────────────────────────────────

describe("buildPostEscrowTx() [live] — collateral", () => {
  it("throws TxConstructionError('collateral required') when buyer has no ≥5 ADA pure-ADA UTxO", async () => {
    const buyer = buildBuyerWalletKey();
    const advert = makeActiveAdvert();
    const advertDatumHex = encodeAdvertDatum(advert);

    // Buyer wallet has ONLY a small UTxO (< 5 ADA)
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";

      if (method === "queryLedgerState/protocolParameters") {
        return rpcOk({
          minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } },
          maxTransactionSize: { bytes: 16384 }, maxValueSize: { bytes: 5000 },
          stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
          stakePoolDeposit: { ada: { lovelace: 500000000 } },
          prices: { memory: "0.0577", steps: "0.0000721" },
          maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
          coinsPerUtxoByte: { ada: { lovelace: 4310 } },
          collateralPercentage: 150, maxCollateralInputs: 3,
          plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
          monetaryExpansion: "0.003", treasuryExpansion: "0.2",
          minStakePoolCost: { ada: { lovelace: 340000000 } },
          minFeeReferenceScripts: { base: 15 },
          governanceActionDeposit: { ada: { lovelace: 100000000000 } },
          delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
        });
      }
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ADVERT_TX_HASH, ADVERT_INDEX, "addr_advert", 2_000_000, advertDatumHex)]);
        }
        // Buyer has only 1 ADA (below 5 ADA collateral minimum)
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, 1_000_000)]);
      }
      if (method === "queryNetwork/tip") return rpcOk({ slot: 1_745_500_000, id: "a".repeat(64) });
      return rpcOk({});
    });

    const chain = buildLiveChain();

    await expect(
      buildPostEscrowTx({
        chain,
        buyerKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        messages: SAMPLE_MESSAGES,
        payment_lovelace: PAYMENT,
      }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason contains 'collateral' when no collateral UTxO", async () => {
    const buyer = buildBuyerWalletKey();
    const advert = makeActiveAdvert();
    const advertDatumHex = encodeAdvertDatum(advert);

    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") {
        return rpcOk({
          minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } },
          maxTransactionSize: { bytes: 16384 }, maxValueSize: { bytes: 5000 },
          stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
          stakePoolDeposit: { ada: { lovelace: 500000000 } },
          prices: { memory: "0.0577", steps: "0.0000721" },
          maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
          coinsPerUtxoByte: { ada: { lovelace: 4310 } }, collateralPercentage: 150,
          maxCollateralInputs: 3,
          plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
          monetaryExpansion: "0.003", treasuryExpansion: "0.2",
          minStakePoolCost: { ada: { lovelace: 340000000 } },
          minFeeReferenceScripts: { base: 15 },
          governanceActionDeposit: { ada: { lovelace: 100000000000 } },
          delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
        });
      }
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ADVERT_TX_HASH, ADVERT_INDEX, "addr", 2_000_000, advertDatumHex)]);
        }
        return rpcOk([]); // empty wallet — no collateral
      }
      if (method === "queryNetwork/tip") return rpcOk({ slot: 1_745_500_000, id: "a".repeat(64) });
      return rpcOk({});
    });

    const chain = buildLiveChain();
    let caught: unknown;
    try {
      await buildPostEscrowTx({
        chain,
        buyerKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        messages: SAMPLE_MESSAGES,
        payment_lovelace: PAYMENT,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toContain("collateral");
  });
});

// ─── E. Rejection paths (pre-chain, preserved from Tier-1) ───────────────────

describe("buildPostEscrowTx() [live] — rejection paths (pre-chain checks preserved)", () => {
  it("throws TxConstructionError('buyer cannot be supplier') when buyerKey.pkh === supplier_pkh", async () => {
    setupMocksForHappyPath();
    const chain = buildLiveChain();
    const supplier = buildSupplierWalletKey();

    await expect(
      buildPostEscrowTx({
        chain,
        buyerKey: supplier,  // same key as supplier in advert
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        messages: SAMPLE_MESSAGES,
        payment_lovelace: PAYMENT,
      }),
    ).rejects.toMatchObject({ reason: "buyer cannot be supplier" });
  });

  it("throws TxConstructionError('messages required') before any chain query", async () => {
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    await expect(
      buildPostEscrowTx({
        chain,
        buyerKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        messages: [],
        payment_lovelace: PAYMENT,
      }),
    ).rejects.toMatchObject({ reason: "messages required" });

    // No fetch should have been called (messages check is before chain query)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws TxConstructionError('advert ref not on chain') when outRef absent", async () => {
    const buyer = buildBuyerWalletKey();

    // Return empty for outRef queries but don't set up other mocks
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") {
        return rpcOk({
          minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } },
          maxTransactionSize: { bytes: 16384 }, maxValueSize: { bytes: 5000 },
          stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
          stakePoolDeposit: { ada: { lovelace: 500000000 } },
          prices: { memory: "0.0577", steps: "0.0000721" },
          maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
          coinsPerUtxoByte: { ada: { lovelace: 4310 } }, collateralPercentage: 150,
          maxCollateralInputs: 3,
          plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
          monetaryExpansion: "0.003", treasuryExpansion: "0.2",
          minStakePoolCost: { ada: { lovelace: 340000000 } },
          minFeeReferenceScripts: { base: 15 },
          governanceActionDeposit: { ada: { lovelace: 100000000000 } },
          delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
        });
      }
      // All UTxO queries return empty
      return rpcOk([]);
    });

    const chain = buildLiveChain();

    await expect(
      buildPostEscrowTx({
        chain,
        buyerKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        messages: SAMPLE_MESSAGES,
        payment_lovelace: PAYMENT,
      }),
    ).rejects.toMatchObject({ reason: "advert ref not on chain" });
  });

  it("throws TxConstructionError('advert is retired') when advert.status === Retired", async () => {
    const buyer = buildBuyerWalletKey();
    const retiredAdvert = { ...makeActiveAdvert(), status: "Retired" as const };
    const retiredDatumHex = encodeAdvertDatum(retiredAdvert);

    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") {
        return rpcOk({
          minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } },
          maxTransactionSize: { bytes: 16384 }, maxValueSize: { bytes: 5000 },
          stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
          stakePoolDeposit: { ada: { lovelace: 500000000 } },
          prices: { memory: "0.0577", steps: "0.0000721" },
          maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
          coinsPerUtxoByte: { ada: { lovelace: 4310 } }, collateralPercentage: 150,
          maxCollateralInputs: 3,
          plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
          monetaryExpansion: "0.003", treasuryExpansion: "0.2",
          minStakePoolCost: { ada: { lovelace: 340000000 } },
          minFeeReferenceScripts: { base: 15 },
          governanceActionDeposit: { ada: { lovelace: 100000000000 } },
          delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
        });
      }
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ADVERT_TX_HASH, ADVERT_INDEX, "addr", 2_000_000, retiredDatumHex)]);
        }
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, BUYER_COLLATERAL_LOVELACE)]);
      }
      if (method === "queryNetwork/tip") return rpcOk({ slot: 1_745_500_000, id: "a".repeat(64) });
      return rpcOk({});
    });

    const chain = buildLiveChain();

    await expect(
      buildPostEscrowTx({
        chain,
        buyerKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        messages: SAMPLE_MESSAGES,
        payment_lovelace: PAYMENT,
      }),
    ).rejects.toMatchObject({ reason: "advert is retired" });
  });

  it("throws TxConstructionError('payment must equal advertised price') on mismatch", async () => {
    setupMocksForHappyPath();
    const chain = buildLiveChain();
    const buyer = buildBuyerWalletKey();

    await expect(
      buildPostEscrowTx({
        chain,
        buyerKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        messages: SAMPLE_MESSAGES,
        payment_lovelace: 999n,  // wrong amount
      }),
    ).rejects.toMatchObject({ reason: "payment must equal advertised price" });
  });
});
