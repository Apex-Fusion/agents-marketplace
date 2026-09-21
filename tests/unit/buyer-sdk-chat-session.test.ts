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
import { chatSessionPromptHash } from "../../packages/shared/src/tx/index.js";
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

/** fetch stub answering the supplier's /status, /capability, and session routes. */
function supplierFetch(responses: {
  start?: Record<string, unknown>;
  end?: Record<string, unknown>;
  capability?: Record<string, unknown>;
}) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/status")) {
      return new Response(JSON.stringify({ status: "free" }), { status: 200 });
    }
    if (u.includes("/v1/chat/start")) {
      const escrowRef = new Headers(init?.headers).get("X-Escrow-Ref");
      return new Response(JSON.stringify({
        escrow_ref: escrowRef,
        ...(responses.start ?? { status: "claimed" }),
      }), { status: 200 });
    }
    if (u.includes("/v1/chat/end")) {
      return new Response(JSON.stringify({
        escrow_ref: ESCROW_REF_STR,
        ...(responses.end ?? {}),
      }), { status: 200 });
    }
    if (u.includes("/capability")) {
      const advert = advertDatum();
      return new Response(JSON.stringify({
        capability_id: advert.capability_id,
        model: advert.model,
        max_output_tokens: advert.max_output_tokens,
        max_processing_ms: advert.max_processing_ms,
        price_lovelace: advert.price_lovelace.toString(),
        advert_ref: `${ADVERT_TX_HASH}#0`,
        supplier_pkh: advert.supplier_pkh,
        pub_key_hex: "f".repeat(64),
        inference_api: "responses",
        upstream_api: "responses",
        ...(responses.capability ?? {}),
      }), { status: 200 });
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

describe("Marketplace.startChat — capability and result validation", () => {
  it("maps the declared ticket result and preserves the preflight upstream API", async () => {
    const { mp } = makeMp(supplierFetch({
      start: { status: "ticket", settle_mode: "ticket" },
    }));
    const result = await mp.startChat({
      advertRef: { txHash: ADVERT_TX_HASH, index: 0 },
      payment_lovelace: 200_000n,
    });
    expect(result.settleMode).toBe("ticket");
    expect(result.upstreamApi).toBe("responses");
  });

  it("maps the declared claimed result to full settlement", async () => {
    const { mp } = makeMp(supplierFetch({ start: { status: "claimed" } }));
    const result = await mp.startChat({
      advertRef: { txHash: ADVERT_TX_HASH, index: 0 },
      payment_lovelace: 200_000n,
    });
    expect(result.settleMode).toBe("full");
  });

  it("rejects a supplier without Responses capability before locking funds", async () => {
    const chain = new MockChainProvider();
    const submitSpy = vi.spyOn(chain, "submitTx");
    const { mp } = makeMp(supplierFetch({
      capability: { inference_api: undefined },
    }), chain);

    await expect(mp.startChat({
      advertRef: { txHash: ADVERT_TX_HASH, index: 0 },
      payment_lovelace: 200_000n,
    })).rejects.toMatchObject({ reason: "supplier_preflight_failed" });
    expect(submitSpy).not.toHaveBeenCalled();
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
      transcript: [],
    });

    expect(result.settleMode).toBe("ticket");
    expect("receipt" in result).toBe(false);
    expect(submitSpy).not.toHaveBeenCalled(); // no Accept tx
  });

  it("rejects a receipt-less submitted result", async () => {
    const { mp } = makeMp(supplierFetch({ end: { status: "submitted" } }));
    await expect(
      mp.endChat({
        escrowRef: ESCROW_REF,
        sessionNonce: "nonce-abc",
        supplierBaseUrl: "http://supplier.test",
        transcript: [],
      }),
    ).rejects.toMatchObject({ reason: "malformed_response" });
  });

  it("rejects a transcript receipt mismatch before accepting payment", async () => {
    const chain = new MockChainProvider();
    const submitSpy = vi.spyOn(chain, "submitTx");
    const transcript = [{
      type: "message" as const,
      role: "user" as const,
      content: [{ type: "input_text" as const, text: "hello" }],
    }];
    const receipt = {
      prompt_hash: chatSessionPromptHash({ session_nonce: "nonce-abc" }),
      response_hash: "0".repeat(64),
      model: advertDatum().model,
      prompt_tokens: 1,
      completion_tokens: 1,
      wallclock_ms: 1,
      supplier_pkh: advertDatum().supplier_pkh,
      escrow_ref: ESCROW_REF_STR,
    };
    const { mp } = makeMp(supplierFetch({
      end: {
        status: "submitted",
        submitted_ref: `${"e".repeat(64)}#0`,
        receipt,
        receipt_signature: "f".repeat(128),
      },
    }), chain);

    await expect(mp.endChat({
      escrowRef: ESCROW_REF,
      sessionNonce: "nonce-abc",
      supplierBaseUrl: "http://supplier.test",
      transcript,
    })).rejects.toMatchObject({ reason: "response_hash_mismatch" });
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
