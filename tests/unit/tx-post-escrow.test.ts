/**
 * tx-post-escrow.test.ts — RED phase tests for buildPostEscrowTx()
 *
 * PostEscrow is the most complex builder: it must query the advert UTxO,
 * verify it is Active and matches the buyer's expectations, then construct
 * the EscrowDatum and lock payment + bonds at the escrow script.
 *
 * Ref: ARCHITECTURE.md §4.2, escrow.ak (advert_ref is SPEC-LOCK),
 *      Catherine's requirement 2 and 3 from the M1-B brief.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildPostEscrowTx } from "../../packages/shared/src/tx/escrow/postEscrow.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { Utxo, OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADVERT_SCRIPT_ADDRESS = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";
const ADVERT_TX_HASH = "b".repeat(64);
const ADVERT_INDEX = 0;
const ADVERT_REF: OutputReference = { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX };

function makeActiveAdvert(): AdvertDatum {
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

function seedAdvertUtxo(chain: MockChainProvider, datum: AdvertDatum, ref = ADVERT_REF): void {
  const utxo: Utxo = {
    ref,
    address: ADVERT_SCRIPT_ADDRESS,
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
}

// SPEC FIX 2026-04-25: prompt_hash hashes canonical(messages) per ARCHITECTURE §4.2.
import type { ChatMessage } from "../../packages/shared/src/tx/types.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
const SAMPLE_MESSAGES: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }];
const PAYMENT = 2_000_000n;

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("buildPostEscrowTx() — happy path", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);   // synthetic tip
    seedAdvertUtxo(chain, makeActiveAdvert());
  });

  it("queries the advert UTxO at advertRef before building", async () => {
    const buyer = buildBuyerWalletKey();
    // If chain has no advert UTxO, builder must throw TxConstructionError
    const emptyChain = new MockChainProvider();
    await expect(
      buildPostEscrowTx({ chain: emptyChain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("returns a non-empty txCborHex", async () => {
    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    expect(typeof result.txCborHex).toBe("string");
    expect(result.txCborHex.length).toBeGreaterThan(0);
  });

  it("returns escrowOutputRef with txHash and index", async () => {
    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    expect(result.escrowOutputRef).toBeDefined();
    expect(result.escrowOutputRef.txHash).toHaveLength(64);
  });

  it("constructs EscrowDatum with state: Open", async () => {
    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(utxo!.datumHex!);
    expect(datum.state).toBe("Open");
  });

  it("constructs EscrowDatum with submitted_at: null (None)", async () => {
    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(utxo!.datumHex!);
    expect(datum.submitted_at).toBeNull();
  });

  it("constructs EscrowDatum with result_receipt_hash: null (None)", async () => {
    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(utxo!.datumHex!);
    expect(datum.result_receipt_hash).toBeNull();
  });

  it("constructs EscrowDatum with advert_ref matching the queried advertRef", async () => {
    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(utxo!.datumHex!);
    expect(datum.advert_ref.txHash).toBe(ADVERT_TX_HASH);
    expect(datum.advert_ref.index).toBe(ADVERT_INDEX);
  });

  it("constructs EscrowDatum with capability_id copied from advert", async () => {
    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(utxo!.datumHex!);
    expect(datum.capability_id).toBe("llm.text.generate.v1");
  });

  it("constructs prompt_hash as sha256 of canonical(messages) — ARCHITECTURE §4.2", async () => {
    // SPEC FIX 2026-04-25: prompt_hash binds the full messages envelope, not the bare prompt string.
    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(utxo!.datumHex!);
    const expectedHash = createHash("sha256").update(canonicalize(SAMPLE_MESSAGES), "utf8").digest("hex");
    expect(datum.prompt_hash).toBe(expectedHash);
  });

  it("constructs request_spec_hash as sha256 of canonical {capability_id, model, max_output_tokens}", async () => {
    const buyer = buildBuyerWalletKey();
    const advert = makeActiveAdvert();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(utxo!.datumHex!);
    // Canonical: sorted keys, no whitespace (RFC-8785 subset)
    const canonicalSpec = JSON.stringify({
      capability_id: advert.capability_id,
      max_output_tokens: advert.max_output_tokens,
      model: advert.model,
    });
    const expectedHash = createHash("sha256").update(canonicalSpec, "utf8").digest("hex");
    expect(datum.request_spec_hash).toBe(expectedHash);
  });

  it("constructs deliver_by = posted_at + max_processing_ms + 30_000", async () => {
    const buyer = buildBuyerWalletKey();
    const advert = makeActiveAdvert();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(utxo!.datumHex!);
    // deliver_by = posted_at + 60_000 (max_processing_ms) + 30_000 (network_buffer)
    expect(datum.deliver_by).toBe(datum.posted_at + advert.max_processing_ms + 30_000);
  });

  it("locked value equals price + buyer_bond + supplier_bond", async () => {
    const buyer = buildBuyerWalletKey();
    const advert = makeActiveAdvert();
    const result = await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const utxo = await chain.queryUtxo(result.escrowOutputRef);
    expect(utxo!.lovelace).toBe(advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace);
  });
});

// ─── Rejection: advert UTxO not found ────────────────────────────────────────

describe("buildPostEscrowTx() — rejects missing advert UTxO", () => {
  it("throws TxConstructionError when advert ref not on chain", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    // No advert seeded

    await expect(
      buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'advert ref not on chain'", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();

    let caught: unknown;
    try {
      await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("advert ref not on chain");
  });
});

// ─── Rejection: advert is Retired ────────────────────────────────────────────

describe("buildPostEscrowTx() — rejects Retired advert", () => {
  it("throws TxConstructionError when advert datum.status = Retired", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain, { ...makeActiveAdvert(), status: "Retired" });

    await expect(
      buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'advert is retired'", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    seedAdvertUtxo(chain, { ...makeActiveAdvert(), status: "Retired" });

    let caught: unknown;
    try {
      await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("advert is retired");
  });
});

// ─── Rejection: payment mismatch ─────────────────────────────────────────────

describe("buildPostEscrowTx() — rejects wrong payment amount", () => {
  it("throws TxConstructionError when payment_lovelace != advert.price_lovelace", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, makeActiveAdvert());  // price = 2_000_000n

    await expect(
      buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: 1_000_000n }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'payment must equal advertised price'", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, makeActiveAdvert());

    let caught: unknown;
    try {
      await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: 1_000_000n });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("payment must equal advertised price");
  });
});

// ─── Rejection: buyer is supplier ────────────────────────────────────────────

describe("buildPostEscrowTx() — rejects buyer == supplier", () => {
  it("throws TxConstructionError when buyerKey pkh equals supplier_pkh", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, makeActiveAdvert());

    await expect(
      buildPostEscrowTx({ chain, buyerKey: supplier, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'buyer cannot be supplier'", async () => {
    const supplier = buildSupplierWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, makeActiveAdvert());

    let caught: unknown;
    try {
      await buildPostEscrowTx({ chain, buyerKey: supplier, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("buyer cannot be supplier");
  });
});

// ─── Rejection: empty messages ───────────────────────────────────────────────

describe("buildPostEscrowTx() — rejects empty messages", () => {
  it("throws TxConstructionError when messages is empty array", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, makeActiveAdvert());

    await expect(
      buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: [], payment_lovelace: PAYMENT }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("TxConstructionError.reason is 'messages required'", async () => {
    const buyer = buildBuyerWalletKey();
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, makeActiveAdvert());

    let caught: unknown;
    try {
      await buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: [], payment_lovelace: PAYMENT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("messages required");
  });
});
