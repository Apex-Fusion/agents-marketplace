/**
 * tests/unit/indexer-status-poller.test.ts — StatusPoller tests (Category C)
 *
 * Mocks fetch via vi.stubGlobal. Tests use tickOnce() to control poll timing.
 * All tests RED — StatusPoller constructor throws "not implemented — M1-D-green".
 * Tests construct StatusPoller directly; the stub throws, causing Vitest to mark them FAIL.
 * When Catherine implements StatusPoller, these tests verify actual polling behaviour.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { StatusPoller } from "../../indexer/src/poller/statusPoller.js";
import { SqliteCache } from "../../indexer/src/db/cache.js";
import {
  STATUS_FREE,
  STATUS_WORKING,
  STATUS_WRONG_SHAPE,
} from "../fixtures/indexer-side/sample-suppliers.js";
import {
  buildAdvertDatumHex,
  INDEXER_SUPPLIER_PKH,
  INDEXER_SUPPLIER_ENDPOINT,
} from "../fixtures/indexer-side/sample-blocks.js";
import type { AdvertRow } from "../../indexer/src/db/cache.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sampleActiveAdvert(overrides: Partial<AdvertRow> = {}): Omit<AdvertRow, "id"> {
  return {
    utxo_ref: "a".repeat(64) + "#0",
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: INDEXER_SUPPLIER_ENDPOINT,
    detail_uri: "ipfs://QmTest",
    detail_hash: "b".repeat(64),
    advertised_at: 1_750_000_000_000,
    status: "Active",
    created_slot: 1_000_000,
    datum_hex: buildAdvertDatumHex(),
    rolled_back: 0,
    ...overrides,
  };
}

function makeFetchMock(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
}

// ─── Basic construction — RED ─────────────────────────────────────────────────
// These tests construct StatusPoller directly without wrapping.
// The stub throws, failing the test (RED).

describe("StatusPoller — construction", () => {
  it("StatusPoller can be constructed with a mock cache and pollIntervalMs=0", () => {
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => []),
      upsertSupplierStatus: vi.fn(),
      getSupplierStatus: vi.fn(() => null),
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    expect(poller).toBeDefined();
  });

  it("StatusPoller exposes a tickOnce() method for testing", () => {
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => []),
      upsertSupplierStatus: vi.fn(),
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    expect(typeof poller.tickOnce).toBe("function");
  });
});

// ─── Basic polling — RED ──────────────────────────────────────────────────────

describe("StatusPoller — basic polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tickOnce polls each Active supplier endpoint_url/status via GET", async () => {
    const fetchMock = makeFetchMock(STATUS_FREE);
    vi.stubGlobal("fetch", fetchMock);
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: vi.fn(),
      getSupplierStatus: vi.fn(() => null),
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(INDEXER_SUPPLIER_ENDPOINT + "/status"),
      expect.anything(),
    );
  });

  it("tickOnce writes supplier_status row with status=free after successful free poll", async () => {
    vi.stubGlobal("fetch", makeFetchMock(STATUS_FREE));
    const upsertSpy = vi.fn();
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: upsertSpy,
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();
    const call = upsertSpy.mock.calls[0][0];
    expect(call.status).toBe("free");
    expect(typeof call.last_seen_iso).toBe("string");
  });

  it("tickOnce writes working status with current_escrow_ref when supplier is working", async () => {
    vi.stubGlobal("fetch", makeFetchMock(STATUS_WORKING));
    const upsertSpy = vi.fn();
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: upsertSpy,
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();
    const call = upsertSpy.mock.calls[0][0];
    expect(call.status).toBe("working");
    expect(typeof call.current_escrow_ref).toBe("string");
  });

  it("fetch is called with HTTP GET method (or default GET — no POST)", async () => {
    const fetchMock = makeFetchMock(STATUS_FREE);
    vi.stubGlobal("fetch", fetchMock);
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: vi.fn(),
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    const callArgs = fetchMock.mock.calls[0];
    // Either no method (default GET) or explicit GET
    if (callArgs[1]?.method !== undefined) {
      expect(callArgs[1].method.toUpperCase()).toBe("GET");
    }
    // If no options passed, it defaults to GET — that's fine
  });
});

// ─── Error handling — RED ─────────────────────────────────────────────────────

describe("StatusPoller — error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("supplier 503 response → upsertSupplierStatus called with status=offline", async () => {
    vi.stubGlobal("fetch", makeFetchMock({}, false, 503));
    const upsertSpy = vi.fn();
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: upsertSpy,
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();
    expect(upsertSpy.mock.calls[0][0].status).toBe("offline");
  });

  it("network error (fetch throws ECONNREFUSED) → status row marked offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const upsertSpy = vi.fn();
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: upsertSpy,
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();
    expect(upsertSpy.mock.calls[0][0].status).toBe("offline");
  });

  it("malformed JSON body (json() throws) → status row marked offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    }));
    const upsertSpy = vi.fn();
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: upsertSpy,
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();
    expect(upsertSpy.mock.calls[0][0].status).toBe("offline");
  });

  it("wrong-shape body (missing status field) → status row marked offline", async () => {
    vi.stubGlobal("fetch", makeFetchMock(STATUS_WRONG_SHAPE));
    const upsertSpy = vi.fn();
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: upsertSpy,
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();
    expect(upsertSpy.mock.calls[0][0].status).toBe("offline");
  });
});

// ─── Retired suppliers not polled — RED ───────────────────────────────────────

describe("StatusPoller — Retired suppliers not polled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Retired advertisement is NOT included in poll cycle (fetch not called)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => []),  // returns [] — Retired not returned by listActiveAdvertisements
      upsertSupplierStatus: vi.fn(),
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Mix of Active and Retired: only Active suppliers polled (fetch called exactly once)", async () => {
    const fetchMock = makeFetchMock(STATUS_FREE);
    vi.stubGlobal("fetch", fetchMock);
    // listActiveAdvertisements returns only 1 Active advert (Retired excluded by cache query)
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [sampleActiveAdvert()]),
      upsertSupplierStatus: vi.fn(),
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Multiple suppliers — RED ─────────────────────────────────────────────────

describe("StatusPoller — multiple suppliers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls each Active supplier at their own endpoint_url/status", async () => {
    const pkh2 = "1".repeat(56);
    const ep2 = "https://supplier2.example.com";
    const fetchMock = makeFetchMock(STATUS_FREE);
    vi.stubGlobal("fetch", fetchMock);
    const mockCache = {
      listActiveAdvertisements: vi.fn(() => [
        sampleActiveAdvert({ utxo_ref: "a".repeat(64) + "#0", supplier_pkh: INDEXER_SUPPLIER_PKH, endpoint_url: INDEXER_SUPPLIER_ENDPOINT }),
        sampleActiveAdvert({ utxo_ref: "b".repeat(64) + "#0", supplier_pkh: pkh2, endpoint_url: ep2 }),
      ]),
      upsertSupplierStatus: vi.fn(),
    } as unknown as SqliteCache;
    const poller = new StatusPoller({ cache: mockCache, pollIntervalMs: 0 });
    await poller.tickOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calledUrls = fetchMock.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
    expect(calledUrls.some((u: string) => u.includes(INDEXER_SUPPLIER_ENDPOINT))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes(ep2))).toBe(true);
  });
});
