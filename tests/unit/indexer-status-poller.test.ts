/**
 * tests/unit/indexer-status-poller.test.ts — StatusPoller: one poll cycle of the listed suppliers.
 *
 * fetch is stubbed with vi.stubGlobal and tickOnce() runs one cycle. A supplier that gives no good status body is stored as "offline".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { StatusPoller } from "../../indexer/src/poller/statusPoller.js";
import { SqliteCache, type AdvertRow, type SupplierStatusRow } from "../../indexer/src/db/cache.js";
import { makeAdvertRow } from "../fixtures/indexer-side/rows.js";
import {
  STATUS_FREE,
  STATUS_WORKING,
  STATUS_WRONG_SHAPE,
} from "../fixtures/indexer-side/sample-suppliers.js";
import { INDEXER_SUPPLIER_ENDPOINT, INDEXER_SUPPLIER_PKH } from "../fixtures/indexer-side/sample-blocks.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFetchMock(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
}

/** A StatusPoller over a stub cache that lists `adverts`. `upserts` holds each supplier_status row that the poller writes. */
function pollerOver(adverts: AdvertRow[]) {
  const upserts: SupplierStatusRow[] = [];
  const cache = {
    listActiveAdvertisements: () => adverts,
    upsertSupplierStatus: (row: SupplierStatusRow) => { upserts.push(row); },
  } as unknown as SqliteCache;
  return { poller: new StatusPoller({ cache, pollIntervalMs: 0 }), upserts };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Polling ──────────────────────────────────────────────────────────────────

describe("StatusPoller — polling", () => {
  it("polls GET /status at the endpoint of each listed supplier", async () => {
    const otherEndpoint = "https://supplier2.example.com";
    const fetchMock = makeFetchMock(STATUS_FREE);
    vi.stubGlobal("fetch", fetchMock);
    const { poller } = pollerOver([
      makeAdvertRow({ utxo_ref: `${"a".repeat(64)}#0`, supplier_pkh: INDEXER_SUPPLIER_PKH, endpoint_url: INDEXER_SUPPLIER_ENDPOINT }),
      makeAdvertRow({ utxo_ref: `${"b".repeat(64)}#0`, supplier_pkh: "1".repeat(56), endpoint_url: otherEndpoint }),
    ]);
    await poller.tickOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(`${INDEXER_SUPPLIER_ENDPOINT}/status`, expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenCalledWith(`${otherEndpoint}/status`, expect.objectContaining({ method: "GET" }));
  });

  it.each([
    ["free", STATUS_FREE, null],
    ["working", STATUS_WORKING, STATUS_WORKING.current_escrow_ref],
  ] as const)("stores the status row of a %s supplier", async (status, body, currentEscrowRef) => {
    vi.stubGlobal("fetch", makeFetchMock(body));
    const advert = makeAdvertRow();
    const { poller, upserts } = pollerOver([advert]);
    await poller.tickOnce();
    expect(upserts).toEqual([{
      supplier_pkh: advert.supplier_pkh,
      advert_ref: advert.utxo_ref,
      status,
      last_seen_iso: body.last_seen,
      current_escrow_ref: currentEscrowRef,
      polled_at: expect.any(Number),
    }]);
  });

  it("polls the listed adverts only: a retired advert is not polled and gets no status row", async () => {
    const cache = new SqliteCache(":memory:");
    const fetchMock = makeFetchMock(STATUS_FREE);
    vi.stubGlobal("fetch", fetchMock);
    const poller = new StatusPoller({ cache, pollIntervalMs: 0 });
    const retired = makeAdvertRow({
      utxo_ref: `${"b".repeat(64)}#0`,
      supplier_pkh: "1".repeat(56),
      endpoint_url: "https://retired.example.com",
      status: "Retired",
    });
    cache.upsertAdvertisement(retired);

    // Only a retired advert: nothing is listed, so nothing is polled.
    await poller.tickOnce();
    expect(fetchMock).not.toHaveBeenCalled();

    const listed = makeAdvertRow({ utxo_ref: `${"a".repeat(64)}#0`, endpoint_url: "https://listed.example.com" });
    cache.upsertAdvertisement(listed);
    await poller.tickOnce();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://listed.example.com/status"]);
    expect(cache.getSupplierStatus(listed.supplier_pkh)).toMatchObject({ status: "free", advert_ref: listed.utxo_ref });
    expect(cache.getSupplierStatus(retired.supplier_pkh)).toBeNull();
    cache.close();
  });
});

// ─── Offline ──────────────────────────────────────────────────────────────────

describe("StatusPoller — a supplier without a good status body is stored as offline", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["503 response", () => makeFetchMock({}, false, 503)],
    ["network error (fetch throws ECONNREFUSED)", () => vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))],
    [
      "malformed JSON body (json() throws)",
      () => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } }),
    ],
    ["wrong-shape body (missing status field)", () => makeFetchMock(STATUS_WRONG_SHAPE)],
  ])("%s → status row marked offline", async (_name, makeFetch) => {
    vi.stubGlobal("fetch", makeFetch());
    const advert = makeAdvertRow();
    const { poller, upserts } = pollerOver([advert]);
    await poller.tickOnce();
    expect(upserts).toEqual([
      expect.objectContaining({ supplier_pkh: advert.supplier_pkh, advert_ref: advert.utxo_ref, status: "offline", current_escrow_ref: null }),
    ]);
  });
});
