/**
 * buyer-sdk-discover-suppliers.test.ts — Marketplace.discoverSuppliers() (query, list, IndexerError cases) and the
 * Marketplace lifecycle (no network call at construction; off() and close() detach the progress listeners).
 */

import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { IndexerError, type DiscoverSuppliersOptions, type ProgressEvent } from "../../buyer/src/sdk/types.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { makeSupplierView } from "../fixtures/buyer-side/supplier-views.js";

const INDEXER = "http://indexer.test";

function makeMarketplace(fetchImpl: typeof fetch): Marketplace {
  return new Marketplace({
    chain: new MockChainProvider(),
    indexerUrl: INDEXER,
    walletKey: buildBuyerWalletKey(),
    networkParams: { networkId: 0 },
    _fetch: fetchImpl,
  });
}

describe("Marketplace.discoverSuppliers()", () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
  });

  const QUERIES: Array<[string, DiscoverSuppliersOptions | undefined, string]> = [
    ["no option", undefined, "/suppliers"],
    ["capability_id", { capability_id: "llm.text.generate.v1" }, "/suppliers?capability_id=llm.text.generate.v1"],
    ["sort", { sort: "price" }, "/suppliers?sort=price"],
    [
      "capability_id and sort",
      { capability_id: "llm.text.generate.v1", sort: "price" },
      "/suppliers?capability_id=llm.text.generate.v1&sort=price",
    ],
  ];

  it.each(QUERIES)("asks the indexer with %s", async (_label, options, path) => {
    fetchSpy.mockImplementation(async () => Response.json([]));
    await makeMarketplace(fetchSpy).discoverSuppliers(options);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${INDEXER}${path}`);
  });

  it("returns the suppliers that the indexer lists, in its order, with their fields", async () => {
    const listed = [
      makeSupplierView({ supplier_pkh: "a".repeat(56), price_lovelace: "3000000" }),
      makeSupplierView({ supplier_pkh: "b".repeat(56), price_lovelace: "2000000", status: "working" }),
    ];
    fetchSpy.mockImplementation(async () => Response.json(listed));
    await expect(makeMarketplace(fetchSpy).discoverSuppliers()).resolves.toEqual(listed);
  });

  it.each<[number, string]>([
    [503, JSON.stringify({ error: "internal" })],
    [500, "server error"],
  ])("throws an IndexerError with the status when the indexer answers %i", async (status, body) => {
    fetchSpy.mockImplementation(async () => new Response(body, { status }));
    const error = await makeMarketplace(fetchSpy).discoverSuppliers().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexerError);
    expect((error as IndexerError).status).toBe(status);
  });

  it("throws an IndexerError when the indexer answers 200 with a body that is not JSON", async () => {
    fetchSpy.mockImplementation(async () => new Response("not json!!", { status: 200 }));
    const error = await makeMarketplace(fetchSpy).discoverSuppliers().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexerError);
    expect((error as IndexerError).reason).toBe("malformed_response");
  });
});

describe("Marketplace lifecycle", () => {
  it("makes no network call at construction", async () => {
    const injectedFetch = vi.fn();
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response());
    try {
      makeMarketplace(injectedFetch);
      // A call that the constructor starts later would show after one turn of the event loop.
      await nextTurn();
      expect(injectedFetch).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("off() detaches one progress listener and close() detaches all of them", () => {
    const mp = makeMarketplace(vi.fn());
    const kept: string[] = [];
    const detached: string[] = [];
    const detachedListener = (event: unknown) => detached.push((event as ProgressEvent).type);
    mp.on("progress", (event) => kept.push((event as ProgressEvent).type));
    mp.on("progress", detachedListener);

    mp.emitProgress({ type: "supplier_called" });
    mp.off("progress", detachedListener);
    mp.emitProgress({ type: "receipt_verified" });
    mp.close();
    mp.emitProgress({ type: "escrow_posted" });

    expect(kept).toEqual(["supplier_called", "receipt_verified"]);
    expect(detached).toEqual(["supplier_called"]);
  });
});
