/**
 * buyer-sdk-accept-reclaim.test.ts — RED phase (M1-E)
 *
 * Category D: Marketplace.acceptResult() / reclaim() (~10 tests)
 *
 * All tests FAIL until M1-E-green.
 *
 * acceptResult() wraps buildAcceptTx; reclaim() wraps buildReclaimTx.
 * Both interact with chain directly (no HTTP to supplier).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import type { Utxo, OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import type { ProgressEvent } from "../../buyer/src/sdk/types.js";
import { ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/escrow/accept.js";
import { mockSlotToWallclockMs } from "../../packages/shared/src/tx/internal/constants.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const buyer = buildBuyerWalletKey();
const supplier = buildSupplierWalletKey();

const ESCROW_TX = "e".repeat(64);
const ESCROW_REF: OutputReference = { txHash: ESCROW_TX, index: 0 };
const ESCROW_SCRIPT_ADDR = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";

const BASE_POSTED_AT = 1_745_500_000_000;
const BASE_DELIVER_BY = BASE_POSTED_AT + 60_000 + 30_000; // max_processing + buffer
const SUBMITTED_AT = BASE_POSTED_AT + 10_000;

function makeEscrowDatum(overrides: Partial<EscrowDatum> = {}): EscrowDatum {
  return {
    buyer_pkh: buyer.pubKeyHash,
    supplier_pkh: supplier.pubKeyHash,
    advert_ref: { txHash: "b".repeat(64), index: 0 },
    capability_id: "llm.text.generate.v1",
    request_spec_hash: "c".repeat(64),
    prompt_hash: "d".repeat(64),
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: BASE_DELIVER_BY,
    posted_at: BASE_POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    ...overrides,
  };
}

function seedEscrowUtxo(chain: MockChainProvider, datum: EscrowDatum, ref = ESCROW_REF) {
  const utxo: Utxo = {
    ref,
    address: ESCROW_SCRIPT_ADDR,
    lovelace: 4_000_000n,
    assets: {},
    datumHex: encodeEscrowDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
}

function makeMarketplace(chain: MockChainProvider): Marketplace {
  return new Marketplace({
    chain,
    indexerUrl: "http://indexer.test",
    walletKey: buyer,
    networkParams: { networkId: 0 },
  });
}

// ─── acceptResult tests ───────────────────────────────────────────────────────

describe("Marketplace.acceptResult()", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
  });

  it("queries the escrow UTxO from chain before building Accept tx", async () => {
    // Slot within accept window: submitted_at + 0 < submitted_at + ACCEPT_WINDOW_MS
    const slotAfterSubmit = Math.floor(SUBMITTED_AT / 1000) + 1;
    chain.advanceSlot(slotAfterSubmit);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Submitted", submitted_at: SUBMITTED_AT }));
    const querySpy = vi.spyOn(chain, "queryUtxo");
    const mp = makeMarketplace(chain);
    await mp.acceptResult({ escrowRef: ESCROW_REF });
    expect(querySpy).toHaveBeenCalledWith(ESCROW_REF);
  });

  it("submits Accept tx via chain.submitTx when state is Submitted", async () => {
    const slotAfterSubmit = Math.floor(SUBMITTED_AT / 1000) + 1;
    chain.advanceSlot(slotAfterSubmit);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Submitted", submitted_at: SUBMITTED_AT }));
    const submitSpy = vi.spyOn(chain, "submitTx");
    const mp = makeMarketplace(chain);
    await mp.acceptResult({ escrowRef: ESCROW_REF });
    expect(submitSpy).toHaveBeenCalled();
  });

  it("emits 'accept_submitted' after Accept tx is submitted", async () => {
    const slotAfterSubmit = Math.floor(SUBMITTED_AT / 1000) + 1;
    chain.advanceSlot(slotAfterSubmit);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Submitted", submitted_at: SUBMITTED_AT }));
    const events: ProgressEvent[] = [];
    const mp = makeMarketplace(chain);
    mp.on("progress", (e: ProgressEvent) => events.push(e));
    await mp.acceptResult({ escrowRef: ESCROW_REF });
    expect(events.some(e => e.type === "accept_submitted")).toBe(true);
  });

  it("throws TxConstructionError when escrow state is not Submitted (e.g. already Accepted)", async () => {
    chain.advanceSlot(1_745_500_000);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Accepted", submitted_at: SUBMITTED_AT }));
    const mp = makeMarketplace(chain);
    await expect(mp.acceptResult({ escrowRef: ESCROW_REF })).rejects.toBeInstanceOf(TxConstructionError);
  });

  it("throws TxConstructionError when buyer_pkh in escrow does not match walletKey", async () => {
    chain.advanceSlot(1_745_500_000);
    seedEscrowUtxo(chain, makeEscrowDatum({
      state: "Submitted",
      submitted_at: SUBMITTED_AT,
      buyer_pkh: supplier.pubKeyHash,  // wrong buyer
    }));
    const mp = makeMarketplace(chain);
    await expect(mp.acceptResult({ escrowRef: ESCROW_REF })).rejects.toBeInstanceOf(TxConstructionError);
  });
});

// ─── reclaim tests ────────────────────────────────────────────────────────────

describe("Marketplace.reclaim()", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
  });

  it("submits Reclaim tx when state is Open and deliver_by has passed", async () => {
    // Advance to past deliver_by
    const pastDeliverBy = Math.ceil(BASE_DELIVER_BY / 1000) + 1;
    chain.advanceSlot(pastDeliverBy);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Open" }));
    const submitSpy = vi.spyOn(chain, "submitTx");
    const mp = makeMarketplace(chain);
    await mp.reclaim({ escrowRef: ESCROW_REF });
    expect(submitSpy).toHaveBeenCalled();
  });

  it("submits Reclaim tx when state is Claimed and deliver_by has passed", async () => {
    const pastDeliverBy = Math.ceil(BASE_DELIVER_BY / 1000) + 1;
    chain.advanceSlot(pastDeliverBy);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Claimed" }));
    const mp = makeMarketplace(chain);
    await expect(mp.reclaim({ escrowRef: ESCROW_REF })).resolves.toBeUndefined();
  });

  it("throws TxConstructionError('reclaim before deliver_by') when deliver_by has not passed", async () => {
    // Set slot BEFORE deliver_by
    const beforeDeliverBy = Math.floor(BASE_DELIVER_BY / 1000) - 1;
    chain.advanceSlot(beforeDeliverBy);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Open" }));
    const mp = makeMarketplace(chain);
    await expect(mp.reclaim({ escrowRef: ESCROW_REF })).rejects.toSatisfy(
      (e: unknown) => e instanceof TxConstructionError && e.reason === "reclaim before deliver_by"
    );
  });

  it("throws TxConstructionError when state is Submitted (not reclaimable)", async () => {
    const pastDeliverBy = Math.ceil(BASE_DELIVER_BY / 1000) + 1;
    chain.advanceSlot(pastDeliverBy);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Submitted", submitted_at: SUBMITTED_AT }));
    const mp = makeMarketplace(chain);
    await expect(mp.reclaim({ escrowRef: ESCROW_REF })).rejects.toBeInstanceOf(TxConstructionError);
  });

  it("throws TxConstructionError when buyer_pkh does not match walletKey on reclaim", async () => {
    const pastDeliverBy = Math.ceil(BASE_DELIVER_BY / 1000) + 1;
    chain.advanceSlot(pastDeliverBy);
    seedEscrowUtxo(chain, makeEscrowDatum({
      state: "Open",
      buyer_pkh: supplier.pubKeyHash,  // wrong buyer
    }));
    const mp = makeMarketplace(chain);
    await expect(mp.reclaim({ escrowRef: ESCROW_REF })).rejects.toBeInstanceOf(TxConstructionError);
  });
});
