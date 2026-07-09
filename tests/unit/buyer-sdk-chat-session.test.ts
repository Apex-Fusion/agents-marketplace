/**
 * buyer-sdk-chat-session.test.ts — settle-mode handling in startChat/endChat.
 *
 * Ticket-mode suppliers answer /v1/chat/start with {status:"ticket"} and
 * /v1/chat/end with {status:"ended", settle_mode:"ticket"}. The SDK must map
 * those to settleMode:"ticket" — and, at end, skip receipt verification AND
 * the Accept tx entirely (zero chain calls). Full-shaped responses keep the
 * existing behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

const ADVERT_TX_HASH = "b".repeat(64);
const ESCROW_REF = { txHash: "f".repeat(64), index: 0 };
const ESCROW_REF_STR = `${ESCROW_REF.txHash}#0`;

function advertDatum(): AdvertDatum {
  return {
    supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
    capability_id: "llm.chat.v1",
    model: "kimi",
    max_output_tokens: 512,
    max_processing_ms: 1_800_000,
    price_lovelace: 200_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "http://supplier.test",
    detail_uri: "ipfs://QmTest",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

/** fetch stub answering the supplier's /status, /v1/chat/start, /v1/chat/end. */
function supplierFetch(responses: { start?: unknown; end?: unknown }) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/status")) {
      return new Response(JSON.stringify({ status: "free" }), { status: 200 });
    }
    if (u.includes("/v1/chat/start")) {
      return new Response(JSON.stringify(responses.start ?? { status: "claimed" }), { status: 200 });
    }
    if (u.includes("/v1/chat/end")) {
      return new Response(JSON.stringify(responses.end ?? {}), { status: 200 });
    }
    if (u.includes("/capability")) {
      return new Response(JSON.stringify({ supplier_pkh: "", model: "kimi" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

function makeMp(fetchImpl: typeof globalThis.fetch, chain = new MockChainProvider()) {
  chain.seed({
    ref: { txHash: ADVERT_TX_HASH, index: 0 },
    address: "addr_test1wfakeadvert",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(advertDatum()),
    scriptRef: null,
  });
  return { mp: new Marketplace({
    chain,
    indexerUrl: "http://indexer.test",
    walletKey: buildBuyerWalletKey(),
    networkParams: { networkId: 0 },
    _fetch: fetchImpl,
  }), chain };
}

describe("Marketplace.startChat — settle-mode mapping", () => {
  it("maps {status:'ticket'} to settleMode ticket", async () => {
    const { mp } = makeMp(supplierFetch({ start: { status: "ticket", settle_mode: "ticket" } }));
    const result = await mp.startChat({ advertRef: { txHash: ADVERT_TX_HASH, index: 0 }, payment_lovelace: 200_000n });
    expect(result.settleMode).toBe("ticket");
  });

  it("maps {status:'claimed'} (and legacy responses) to settleMode full", async () => {
    const { mp } = makeMp(supplierFetch({ start: { status: "claimed" } }));
    const result = await mp.startChat({ advertRef: { txHash: ADVERT_TX_HASH, index: 0 }, payment_lovelace: 200_000n });
    expect(result.settleMode).toBe("full");
  });
});

describe("Marketplace.endChat — ticket branch", () => {
  it("returns the ticket result with zero chain calls and no receipt verification", async () => {
    const chain = new MockChainProvider();
    const submitSpy = vi.spyOn(chain, "submitTx");
    const { mp } = makeMp(
      supplierFetch({ end: { status: "ended", escrow_ref: ESCROW_REF_STR, settle_mode: "ticket" } }),
      chain,
    );

    const result = await mp.endChat({
      escrowRef: ESCROW_REF,
      sessionNonce: "nonce-abc",
      supplierBaseUrl: "http://supplier.test",
    });

    expect(result.settleMode).toBe("ticket");
    expect("receipt" in result).toBe(false);
    expect(submitSpy).not.toHaveBeenCalled(); // no Accept tx
  });

  it("still rejects a receipt-less response that does not declare ticket mode", async () => {
    const { mp } = makeMp(supplierFetch({ end: { status: "submitted" } }));
    await expect(
      mp.endChat({ escrowRef: ESCROW_REF, sessionNonce: "nonce-abc", supplierBaseUrl: "http://supplier.test" }),
    ).rejects.toThrow(/receipt/);
  });
});
