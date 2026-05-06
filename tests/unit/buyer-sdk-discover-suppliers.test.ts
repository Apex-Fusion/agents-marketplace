/**
 * buyer-sdk-discover-suppliers.test.ts — RED phase (M1-E)
 *
 * Category A: Marketplace.discoverSuppliers()
 *
 * All tests are expected to FAIL until M1-E-green because Marketplace.discoverSuppliers()
 * currently throws "not implemented — M1-E-green".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { IndexerError } from "../../buyer/src/sdk/types.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMarketplace(fetchImpl: typeof globalThis.fetch): Marketplace {
  return new Marketplace({
    chain: new MockChainProvider(),
    indexerUrl: "http://indexer.test",
    walletKey: buildBuyerWalletKey(),
    networkParams: { networkId: 0 },
    _fetch: fetchImpl as unknown as typeof fetch,
  } as never);
}

function makeSampleSupplier(overrides: Record<string, unknown> = {}) {
  return {
    utxo_ref: "a".repeat(64) + "#0",
    supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "https://supplier.example.com",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "free",
    advert_status: "Active",
    current_escrow_ref: null,
    last_seen_iso: "2026-04-24T00:00:00.000Z",
    created_slot: 1000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Marketplace.discoverSuppliers()", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
  });

  it("calls GET ${indexerUrl}/suppliers with no extra params when called with no options", async () => {
    fetchSpy.mockReturnValue(jsonResponse([makeSampleSupplier()]));
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    await mp.discoverSuppliers();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(url).toBe("http://indexer.test/suppliers");
  });

  it("returns a list shaped as SupplierView[]", async () => {
    const sample = makeSampleSupplier();
    fetchSpy.mockReturnValue(jsonResponse([sample]));
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    const result = await mp.discoverSuppliers();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      supplier_pkh: sample.supplier_pkh,
      capability_id: sample.capability_id,
      price_lovelace: sample.price_lovelace,
    });
  });

  it("adds ?capability_id=... query param when filtering by capability_id", async () => {
    fetchSpy.mockReturnValue(jsonResponse([makeSampleSupplier()]));
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    await mp.discoverSuppliers({ capability_id: "llm.text.generate.v1" });
    const url = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("capability_id=llm.text.generate.v1");
  });

  it("adds ?sort=price query param when sort:'price' is requested", async () => {
    fetchSpy.mockReturnValue(jsonResponse([makeSampleSupplier()]));
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    await mp.discoverSuppliers({ sort: "price" });
    const url = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("sort=price");
  });

  it("combines capability_id and sort params correctly", async () => {
    fetchSpy.mockReturnValue(jsonResponse([makeSampleSupplier()]));
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    await mp.discoverSuppliers({ capability_id: "llm.text.generate.v1", sort: "price" });
    const url = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("capability_id=llm.text.generate.v1");
    expect(url).toContain("sort=price");
  });

  it("returns [] when the indexer returns an empty list", async () => {
    fetchSpy.mockReturnValue(jsonResponse([]));
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    const result = await mp.discoverSuppliers();
    expect(result).toEqual([]);
  });

  it("throws IndexerError with status code when indexer returns 5xx", async () => {
    fetchSpy.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ error: "internal" }), { status: 503 }))
    );
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    await expect(mp.discoverSuppliers()).rejects.toSatisfy(
      (e: unknown) => e instanceof IndexerError && e.status === 503
    );
  });

  it("throws IndexerError when indexer returns 500", async () => {
    fetchSpy.mockReturnValue(
      Promise.resolve(new Response("server error", { status: 500 }))
    );
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    await expect(mp.discoverSuppliers()).rejects.toBeInstanceOf(IndexerError);
  });

  it("throws IndexerError when indexer returns malformed JSON", async () => {
    fetchSpy.mockReturnValue(
      Promise.resolve(new Response("not json!!", { status: 200 }))
    );
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    await expect(mp.discoverSuppliers()).rejects.toBeInstanceOf(IndexerError);
  });

  it("returns multiple suppliers when indexer returns multiple entries", async () => {
    const s1 = makeSampleSupplier({ supplier_pkh: "a".repeat(56) });
    const s2 = makeSampleSupplier({ supplier_pkh: "b".repeat(56) });
    fetchSpy.mockReturnValue(jsonResponse([s1, s2]));
    const mp = makeMarketplace(fetchSpy as unknown as typeof fetch);
    const result = await mp.discoverSuppliers();
    expect(result).toHaveLength(2);
  });

  it("does not make any network calls during Marketplace construction", () => {
    const mp = new Marketplace({
      chain: new MockChainProvider(),
      indexerUrl: "http://indexer.test",
      walletKey: buildBuyerWalletKey(),
      networkParams: { networkId: 0 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    void mp; // suppress unused
  });
});
