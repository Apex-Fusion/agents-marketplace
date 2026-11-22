/**
 * buyer-sdk-accept-reclaim.test.ts — what Marketplace.acceptResult() and reclaim() add to the tx builders: the
 * tx goes to the chain and the progress event names the escrow ref. The builder rules (signer, state, time
 * window) are tested in tx-accept.test.ts and tx-reclaim.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import type { Utxo, OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import type { ProgressEvent } from "../../buyer/src/sdk/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const buyer = buildBuyerWalletKey();
const supplier = buildSupplierWalletKey();

const ESCROW_TX = "e".repeat(64);
const ESCROW_REF: OutputReference = { txHash: ESCROW_TX, index: 0 };
const ESCROW_REF_STR = `${ESCROW_TX}#0`;
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

function recordProgress(mp: Marketplace): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  mp.on("progress", (event) => events.push(event as ProgressEvent));
  return events;
}

// ─── acceptResult tests ───────────────────────────────────────────────────────

describe("Marketplace.acceptResult()", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
  });

  it("accepts a Submitted escrow: the escrow output is spent", async () => {
    // Slot within the accept window.
    chain.advanceSlot(Math.floor(SUBMITTED_AT / 1000) + 1);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Submitted", submitted_at: SUBMITTED_AT }));
    await makeMarketplace(chain).acceptResult({ escrowRef: ESCROW_REF });
    await expect(chain.queryUtxo(ESCROW_REF)).resolves.toBeNull();
  });

  it("emits accept_submitted with the escrow ref after the Accept tx is submitted", async () => {
    chain.advanceSlot(Math.floor(SUBMITTED_AT / 1000) + 1);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Submitted", submitted_at: SUBMITTED_AT }));
    const mp = makeMarketplace(chain);
    const events = recordProgress(mp);
    await mp.acceptResult({ escrowRef: ESCROW_REF });
    expect(events).toEqual([{ type: "accept_submitted", escrow_ref: ESCROW_REF_STR }]);
  });

  it("rejects an escrow that is not Submitted and emits no progress event", async () => {
    chain.advanceSlot(1_745_500_000);
    seedEscrowUtxo(chain, makeEscrowDatum({ state: "Accepted", submitted_at: SUBMITTED_AT }));
    const mp = makeMarketplace(chain);
    const events = recordProgress(mp);
    await expect(mp.acceptResult({ escrowRef: ESCROW_REF })).rejects.toBeInstanceOf(TxConstructionError);
    expect(events).toEqual([]);
  });
});

// ─── reclaim tests ────────────────────────────────────────────────────────────

describe("Marketplace.reclaim()", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
  });

  it.each<EscrowDatum["state"]>(["Open", "Claimed"])(
    "reclaims a %s escrow after deliver_by: the escrow output is spent and reclaim_submitted names the escrow ref",
    async (state) => {
      chain.advanceSlot(Math.ceil(BASE_DELIVER_BY / 1000) + 1);
      seedEscrowUtxo(chain, makeEscrowDatum({ state }));
      const mp = makeMarketplace(chain);
      const events = recordProgress(mp);
      await expect(mp.reclaim({ escrowRef: ESCROW_REF })).resolves.toBeUndefined();
      await expect(chain.queryUtxo(ESCROW_REF)).resolves.toBeNull();
      expect(events).toEqual([{ type: "reclaim_submitted", escrow_ref: ESCROW_REF_STR }]);
    },
  );
});
