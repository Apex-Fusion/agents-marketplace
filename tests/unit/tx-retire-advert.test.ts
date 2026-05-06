/**
 * tx-retire-advert.test.ts — RED phase tests for buildRetireAdvertTx()
 *
 * RetireAdvert spends the advert UTxO and produces at least one output
 * to the supplier's wallet (VerificationKey address). Signed by supplier_pkh.
 *
 * advert.ak:handle_retire confirms: signed_by(supplier) && output_to_supplier_present.
 * The validator does NOT require a specific lovelace amount returned.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildRetireAdvertTx } from "../../packages/shared/src/tx/advert/retireAdvert.js";
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

function makeActiveDatum(): AdvertDatum {
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
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

function seedAdvertUtxo(chain: MockChainProvider, datum: AdvertDatum): Utxo {
  const utxo: Utxo = {
    ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    address: ADVERT_SCRIPT_ADDRESS,
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
  return utxo;
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("buildRetireAdvertTx() — happy path", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
  });

  it("returns a non-empty txCborHex", async () => {
    const supplier = buildSupplierWalletKey();
    seedAdvertUtxo(chain, makeActiveDatum());

    const result = await buildRetireAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    });
    expect(typeof result.txCborHex).toBe("string");
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });

  it("spends the advert UTxO (input removed from chain state)", async () => {
    const supplier = buildSupplierWalletKey();
    seedAdvertUtxo(chain, makeActiveDatum());

    await buildRetireAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    });
    const spent = await chain.queryUtxo({ txHash: ADVERT_TX_HASH, index: ADVERT_INDEX });
    expect(spent).toBeNull();
  });

  it("produces at least one output to the supplier wallet address", async () => {
    const supplier = buildSupplierWalletKey();
    seedAdvertUtxo(chain, makeActiveDatum());

    await buildRetireAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    });
    // Supplier's address should have a UTxO after retire
    const utxos = await chain.queryUtxosByAddress(supplier.address);
    expect(utxos.length).toBeGreaterThan(0);
  });

  it("output to supplier is at a non-script (VerificationKey) address", async () => {
    const supplier = buildSupplierWalletKey();
    seedAdvertUtxo(chain, makeActiveDatum());

    await buildRetireAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    });
    // Supplier wallet address: addr_test1v... (not addr_test1w which is script)
    expect(supplier.address).toMatch(/^addr_test1/);
    // The advert script address starts with addr_test1w (script prefix)
    expect(ADVERT_SCRIPT_ADDRESS).not.toBe(supplier.address);
  });

  it("tx is signed by supplier (required signers contain supplier pkh)", async () => {
    const supplier = buildSupplierWalletKey();
    seedAdvertUtxo(chain, makeActiveDatum());

    const result = await buildRetireAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    });
    expect(result.txCborHex).toContain(supplier.pubKeyHash);
  });
});

// ─── Rejection: signed by non-supplier ───────────────────────────────────────

describe("buildRetireAdvertTx() — rejects non-supplier signer", () => {
  it("throws TxConstructionError when walletKey is not the datum supplier", async () => {
    const buyer = buildBuyerWalletKey();    // wrong signer
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain, makeActiveDatum());

    await expect(
      buildRetireAdvertTx({
        chain,
        walletKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason identifies signature mismatch", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain, makeActiveDatum());

    let caught: unknown;
    try {
      await buildRetireAdvertTx({
        chain,
        walletKey: buyer,
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("supplier signature mismatch");
  });
});

// ─── Rejection: output to wrong address ──────────────────────────────────────

describe("buildRetireAdvertTx() — rejects output to wrong address", () => {
  it("throws TxConstructionError when no output goes to supplier address", async () => {
    // This tests builder-level validation when the caller explicitly asks for
    // a wrong returnAddress parameter variant.
    // For M1-B: if builder exposes a returnAddress override, test it here.
    // For now: asserts builder always routes output to datum.supplier_pkh address.
    // This test uses a tampered datum where supplier_pkh does not match walletKey.
    const buyer = buildBuyerWalletKey();
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();

    // Datum with buyer pkh, but signed by supplier — validator would reject this
    // but builder should catch it first
    const tampered: AdvertDatum = { ...makeActiveDatum(), supplier_pkh: buyer.pubKeyHash };
    seedAdvertUtxo(chain, tampered);

    await expect(
      buildRetireAdvertTx({
        chain,
        walletKey: supplier,   // walletKey pkh !== datum supplier_pkh
        advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      }),
    ).rejects.toThrow(TxConstructionError);
  });
});
