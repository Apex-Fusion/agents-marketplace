/**
 * tests/unit/indexer-status-poller-timeout.test.ts — the 5 s limit of one status poll.
 *
 * Covers `indexer/src/poller/statusPoller.ts`, `pollOne`: the request carries an AbortSignal that aborts after
 * STATUS_POLL_TIMEOUT_MS (5,000 ms). A supplier that never answers is written as `offline`; the poll does not hang.
 * Every other test of the poller answers at once, so none of them reaches this limit.
 *
 * Fake timers drive the clock. The stub of `fetch` answers after a delay, or never, and rejects when its signal aborts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SqliteCache } from "../../indexer/src/db/cache.js";
import { StatusPoller } from "../../indexer/src/poller/statusPoller.js";
import { STATUS_WORKING } from "../fixtures/indexer-side/sample-suppliers.js";

const STATUS_POLL_TIMEOUT_MS = 5_000;
const ADVERT = {
  utxo_ref: `${"a".repeat(64)}#0`,
  supplier_pkh: "b".repeat(56),
  endpoint_url: "https://supplier.example.com",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A poller over a cache with one Active advert; returns the rows that it writes. */
function pollerWithOneAdvert(): { poller: StatusPoller; written: Array<Record<string, unknown>> } {
  const written: Array<Record<string, unknown>> = [];
  const cache = {
    listActiveAdvertisements: () => [ADVERT],
    upsertSupplierStatus: (row: Record<string, unknown>) => written.push(row),
  } as unknown as SqliteCache;
  return { poller: new StatusPoller({ cache, pollIntervalMs: 0 }), written };
}

/** Stub `fetch`: answer with `body` after `delayMs`, or never when `delayMs` is null. An aborted request rejects. */
function stubFetch(delayMs: number | null, body: unknown): { signal: () => AbortSignal | undefined } {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
      if (delayMs !== null) setTimeout(() => resolve(Response.json(body)), delayMs);
    })),
  );
  return { signal: () => signal };
}

describe("StatusPoller — the limit of one poll", () => {
  it("aborts a request that gets no answer after 5,000 ms and writes the supplier as offline", async () => {
    vi.useFakeTimers();
    const request = stubFetch(null, null);
    const { poller, written } = pollerWithOneAdvert();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const tick = poller.tickOnce();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_TIMEOUT_MS - 1);
    expect(request.signal()?.aborted).toBe(false);
    expect(written).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await tick;

    expect(request.signal()?.aborted).toBe(true);
    expect(written).toEqual([
      expect.objectContaining({
        supplier_pkh: ADVERT.supplier_pkh,
        advert_ref: ADVERT.utxo_ref,
        status: "offline",
        current_escrow_ref: null,
      }),
    ]);
  });

  it("keeps the answer of a supplier that is slow but inside the limit", async () => {
    vi.useFakeTimers();
    const request = stubFetch(STATUS_POLL_TIMEOUT_MS - 100, STATUS_WORKING);
    const { poller, written } = pollerWithOneAdvert();

    const tick = poller.tickOnce();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_TIMEOUT_MS - 100);
    await tick;

    expect(request.signal()?.aborted).toBe(false);
    expect(written).toEqual([
      expect.objectContaining({ status: "working", current_escrow_ref: STATUS_WORKING.current_escrow_ref }),
    ]);
  });
});
