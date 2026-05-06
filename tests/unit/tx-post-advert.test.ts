/**
 * tx-post-advert.test.ts — RED phase tests for buildPostAdvertTx()
 *
 * Tests the off-chain builder invariants that the on-chain validator cannot
 * enforce at UTxO creation time (ARCHITECTURE.md §4.1, advert.ak comment:
 * "PostAdvert is enforced OFF-CHAIN by M1-B's tx builder").
 *
 * Arrange-Act-Assert pattern throughout.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildPostAdvertTx } from "../../packages/shared/src/tx/advert/postAdvert.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW_MS = 1_745_500_000_000;
const DEPOSIT = 2_000_000n;

function freshActiveAdvert(overrides?: Partial<AdvertDatum>): AdvertDatum {
  const supplier = buildSupplierWalletKey();
  return {
    supplier_pkh: supplier.pubKeyHash,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com/v1",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: NOW_MS,
    status: "Active",
    ...overrides,
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("buildPostAdvertTx() — happy path", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    // Synthetic tip: slot with wallclock ≈ NOW_MS.
    // MockChainProvider.tip() returns slot number; for these tests we
    // use a convention where slot * 1000 ≈ POSIX ms (sufficient for RED).
    chain.advanceSlot(Math.floor(NOW_MS / 1000));
  });

  it("returns a non-empty txCborHex string", async () => {
    const supplier = buildSupplierWalletKey();
    const advert = freshActiveAdvert();
    const result = await buildPostAdvertTx({
      chain,
      walletKey: supplier,
      advertDatum: advert,
      deposit_lovelace: DEPOSIT,
    });
    expect(typeof result.txCborHex).toBe("string");
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });

  it("returns a 64-char hex expectedTxHash", async () => {
    const supplier = buildSupplierWalletKey();
    const result = await buildPostAdvertTx({
      chain,
      walletKey: supplier,
      advertDatum: freshActiveAdvert(),
      deposit_lovelace: DEPOSIT,
    });
    expect(result.expectedTxHash).toHaveLength(64);
    expect(result.expectedTxHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns an advertOutputRef with txHash and index", async () => {
    const supplier = buildSupplierWalletKey();
    const result = await buildPostAdvertTx({
      chain,
      walletKey: supplier,
      advertDatum: freshActiveAdvert(),
      deposit_lovelace: DEPOSIT,
    });
    expect(result.advertOutputRef).toBeDefined();
    expect(typeof result.advertOutputRef.txHash).toBe("string");
    expect(result.advertOutputRef.txHash).toHaveLength(64);
    expect(typeof result.advertOutputRef.index).toBe("number");
  });

  it("output is at the advert script address (addr_test1... on testnet)", async () => {
    const supplier = buildSupplierWalletKey();
    const result = await buildPostAdvertTx({
      chain,
      walletKey: supplier,
      advertDatum: freshActiveAdvert(),
      deposit_lovelace: DEPOSIT,
    });
    // Query the resulting UTxO by ref — it must be at the script address
    const utxo = await chain.queryUtxo(result.advertOutputRef);
    expect(utxo).not.toBeNull();
    expect(utxo!.address).toMatch(/^addr_test1/);
  });

  it("output datum hex matches encodeAdvertDatum(advertDatum)", async () => {
    const supplier = buildSupplierWalletKey();
    const advert = freshActiveAdvert();
    const result = await buildPostAdvertTx({
      chain,
      walletKey: supplier,
      advertDatum: advert,
      deposit_lovelace: DEPOSIT,
    });
    const utxo = await chain.queryUtxo(result.advertOutputRef);
    expect(utxo?.datumHex).toBe(encodeAdvertDatum(advert));
  });

  it("output lovelace is >= deposit_lovelace", async () => {
    const supplier = buildSupplierWalletKey();
    const result = await buildPostAdvertTx({
      chain,
      walletKey: supplier,
      advertDatum: freshActiveAdvert(),
      deposit_lovelace: DEPOSIT,
    });
    const utxo = await chain.queryUtxo(result.advertOutputRef);
    expect(utxo!.lovelace).toBeGreaterThanOrEqual(DEPOSIT);
  });

  it("required-signers list in the tx contains the supplier_pkh from datum", async () => {
    const supplier = buildSupplierWalletKey();
    const advert = freshActiveAdvert();
    const result = await buildPostAdvertTx({
      chain,
      walletKey: supplier,
      advertDatum: advert,
      deposit_lovelace: DEPOSIT,
    });
    // The txCborHex must reference the supplier's pubKeyHash as a required signer.
    // We verify indirectly: the hex must contain the supplier pkh bytes.
    expect(result.txCborHex).toContain(supplier.pubKeyHash);
  });
});

// ─── Rejection: supplier mismatch ────────────────────────────────────────────

describe("buildPostAdvertTx() — rejects supplier mismatch", () => {
  it("throws TxConstructionError when walletKey pkh != datum.supplier_pkh", async () => {
    const buyer = buildBuyerWalletKey();     // wrong signer
    const advert = freshActiveAdvert();      // supplier_pkh = supplier's pkh

    const chain = new MockChainProvider();
    await expect(
      buildPostAdvertTx({ chain, walletKey: buyer, advertDatum: advert, deposit_lovelace: DEPOSIT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'supplier signature mismatch'", async () => {
    const buyer = buildBuyerWalletKey();
    const advert = freshActiveAdvert();
    const chain = new MockChainProvider();

    let caught: unknown;
    try {
      await buildPostAdvertTx({ chain, walletKey: buyer, advertDatum: advert, deposit_lovelace: DEPOSIT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("supplier signature mismatch");
  });
});

// ─── Rejection: datum.status ≠ Active ────────────────────────────────────────

describe("buildPostAdvertTx() — rejects non-Active status", () => {
  it("throws TxConstructionError when datum.status is Retired", async () => {
    const supplier = buildSupplierWalletKey();
    const advert = freshActiveAdvert({ status: "Retired" });
    const chain = new MockChainProvider();

    await expect(
      buildPostAdvertTx({ chain, walletKey: supplier, advertDatum: advert, deposit_lovelace: DEPOSIT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'fresh advert must be Active'", async () => {
    const supplier = buildSupplierWalletKey();
    const advert = freshActiveAdvert({ status: "Retired" });
    const chain = new MockChainProvider();

    let caught: unknown;
    try {
      await buildPostAdvertTx({ chain, walletKey: supplier, advertDatum: advert, deposit_lovelace: DEPOSIT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("fresh advert must be Active");
  });
});

// ─── Rejection: advertised_at far outside validity window ────────────────────

describe("buildPostAdvertTx() — rejects advertised_at out of validity range", () => {
  it("throws TxConstructionError when advertised_at is >5min in the future", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor(NOW_MS / 1000));

    // advertised_at is 10 minutes ahead of chain tip wallclock
    const farFuture = NOW_MS + 10 * 60 * 1000;
    const advert = freshActiveAdvert({ advertised_at: farFuture });

    await expect(
      buildPostAdvertTx({ chain, walletKey: supplier, advertDatum: advert, deposit_lovelace: DEPOSIT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'advertised_at out of validity range' (far future)", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor(NOW_MS / 1000));

    const farFuture = NOW_MS + 10 * 60 * 1000;
    const advert = freshActiveAdvert({ advertised_at: farFuture });

    let caught: unknown;
    try {
      await buildPostAdvertTx({ chain, walletKey: supplier, advertDatum: advert, deposit_lovelace: DEPOSIT });
    } catch (e) {
      caught = e;
    }
    expect((caught as TxConstructionError).reason).toBe("advertised_at out of validity range");
  });

  it("throws TxConstructionError when advertised_at is >5min in the past", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor(NOW_MS / 1000));

    // advertised_at is 10 minutes before chain tip wallclock
    const farPast = NOW_MS - 10 * 60 * 1000;
    const advert = freshActiveAdvert({ advertised_at: farPast });

    await expect(
      buildPostAdvertTx({ chain, walletKey: supplier, advertDatum: advert, deposit_lovelace: DEPOSIT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("does NOT throw when advertised_at is within ±5min of chain tip", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor(NOW_MS / 1000));

    // Just 2 minutes ahead — within window
    const nearFuture = NOW_MS + 2 * 60 * 1000;
    const advert = freshActiveAdvert({ advertised_at: nearFuture });

    await expect(
      buildPostAdvertTx({ chain, walletKey: supplier, advertDatum: advert, deposit_lovelace: DEPOSIT }),
    ).resolves.toBeDefined();
  });
});
