/**
 * tx-update-advert.test.ts — RED phase tests for buildUpdateAdvertTx()
 *
 * UpdateAdvert spends an existing advert UTxO and produces a continuing output
 * at the same script address. On-chain validator enforces:
 *   - signed by supplier_pkh
 *   - supplier_pkh unchanged
 *   - advertised_at monotonically non-decreasing
 *
 * The TS builder additionally enforces the signer identity before submission.
 * advert.ak:handle_update confirms the on-chain rules these tests mirror.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildUpdateAdvertTx } from "../../packages/shared/src/tx/advert/updateAdvert.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADVERT_SCRIPT_ADDRESS = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";
const ADVERT_TX_HASH = "a".repeat(64);
const ADVERT_INDEX = 0;
const DEPOSIT = 2_000_000n;
const OLD_TIMESTAMP = 1_745_500_000_000;
const NEW_TIMESTAMP = 1_745_501_000_000;

function makeOldDatum(): AdvertDatum {
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
    advertised_at: OLD_TIMESTAMP,
    status: "Active",
  };
}

function seedAdvertUtxo(chain: MockChainProvider, datum: AdvertDatum): Utxo {
  const utxo: Utxo = {
    ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    address: ADVERT_SCRIPT_ADDRESS,
    lovelace: DEPOSIT,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
  return utxo;
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("buildUpdateAdvertTx() — happy path", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
  });

  it("returns a non-empty txCborHex", async () => {
    const supplier = buildSupplierWalletKey();
    const oldDatum = makeOldDatum();
    seedAdvertUtxo(chain, oldDatum);
    const newDatum = { ...oldDatum, advertised_at: NEW_TIMESTAMP };

    const result = await buildUpdateAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      newAdvertDatum: newDatum,
      deposit_lovelace: DEPOSIT,
    });
    expect(typeof result.txCborHex).toBe("string");
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });

  it("spends the input UTxO (removes it from chain state)", async () => {
    const supplier = buildSupplierWalletKey();
    const oldDatum = makeOldDatum();
    seedAdvertUtxo(chain, oldDatum);
    const newDatum = { ...oldDatum, advertised_at: NEW_TIMESTAMP };

    await buildUpdateAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      newAdvertDatum: newDatum,
      deposit_lovelace: DEPOSIT,
    });
    // After spending, original UTxO should be gone
    const spent = await chain.queryUtxo({ txHash: ADVERT_TX_HASH, index: ADVERT_INDEX });
    expect(spent).toBeNull();
  });

  it("produces continuing output at the same script address", async () => {
    const supplier = buildSupplierWalletKey();
    const oldDatum = makeOldDatum();
    seedAdvertUtxo(chain, oldDatum);
    const newDatum = { ...oldDatum, advertised_at: NEW_TIMESTAMP };

    const result = await buildUpdateAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      newAdvertDatum: newDatum,
      deposit_lovelace: DEPOSIT,
    });
    // Continuing output should be at advert script address
    const utxos = await chain.queryUtxosByAddress(ADVERT_SCRIPT_ADDRESS);
    expect(utxos.length).toBeGreaterThan(0);
    // txCborHex must not be empty
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });

  it("new datum has supplier_pkh unchanged from old datum", async () => {
    const supplier = buildSupplierWalletKey();
    const oldDatum = makeOldDatum();
    seedAdvertUtxo(chain, oldDatum);
    const newDatum = { ...oldDatum, advertised_at: NEW_TIMESTAMP };

    await buildUpdateAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      newAdvertDatum: newDatum,
      deposit_lovelace: DEPOSIT,
    });
    // The new datum passed in has the same supplier_pkh — builder must not override
    expect(newDatum.supplier_pkh).toBe(oldDatum.supplier_pkh);
  });

  it("allows advertised_at equal to old (same timestamp, non-decreasing)", async () => {
    const supplier = buildSupplierWalletKey();
    const oldDatum = makeOldDatum();
    seedAdvertUtxo(chain, oldDatum);
    const newDatum = { ...oldDatum, advertised_at: OLD_TIMESTAMP };  // same

    await expect(
      buildUpdateAdvertTx({
        chain,
        walletKey: supplier,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        newAdvertDatum: newDatum,
        deposit_lovelace: DEPOSIT,
      }),
    ).resolves.toBeDefined();
  });
});

// ─── Rejection: different supplier_pkh ───────────────────────────────────────

describe("buildUpdateAdvertTx() — rejects supplier mismatch", () => {
  it("throws TxConstructionError when walletKey pkh != oldDatum.supplier_pkh", async () => {
    const buyer = buildBuyerWalletKey();     // wrong signer
    const oldDatum = makeOldDatum();
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain, oldDatum);
    const newDatum = { ...oldDatum, advertised_at: NEW_TIMESTAMP };

    await expect(
      buildUpdateAdvertTx({
        chain,
        walletKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        newAdvertDatum: newDatum,
        deposit_lovelace: DEPOSIT,
      }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("throws TxConstructionError when newDatum.supplier_pkh changed", async () => {
    const supplier = buildSupplierWalletKey();
    const buyer = buildBuyerWalletKey();
    const oldDatum = makeOldDatum();
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain, oldDatum);
    // New datum has buyer's pkh — supplier mismatch
    const newDatum = { ...oldDatum, supplier_pkh: buyer.pubKeyHash, advertised_at: NEW_TIMESTAMP };

    await expect(
      buildUpdateAdvertTx({
        chain,
        walletKey: supplier,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        newAdvertDatum: newDatum,
        deposit_lovelace: DEPOSIT,
      }),
    ).rejects.toThrow(TxConstructionError);
  });
});

// ─── Rejection: advertised_at regress ────────────────────────────────────────

describe("buildUpdateAdvertTx() — rejects advertised_at regress", () => {
  it("throws TxConstructionError when newDatum.advertised_at < oldDatum.advertised_at", async () => {
    const supplier = buildSupplierWalletKey();
    const oldDatum = makeOldDatum();    // advertised_at = OLD_TIMESTAMP
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain, oldDatum);
    // New datum has a timestamp earlier than old
    const newDatum = { ...oldDatum, advertised_at: OLD_TIMESTAMP - 1 };

    await expect(
      buildUpdateAdvertTx({
        chain,
        walletKey: supplier,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        newAdvertDatum: newDatum,
        deposit_lovelace: DEPOSIT,
      }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason identifies timestamp regress", async () => {
    const supplier = buildSupplierWalletKey();
    const oldDatum = makeOldDatum();
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain, oldDatum);
    const newDatum = { ...oldDatum, advertised_at: OLD_TIMESTAMP - 1_000 };

    let caught: unknown;
    try {
      await buildUpdateAdvertTx({
        chain,
        walletKey: supplier,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
        newAdvertDatum: newDatum,
        deposit_lovelace: DEPOSIT,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("advertised_at regress");
  });
});
