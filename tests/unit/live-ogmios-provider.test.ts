/**
 * live-ogmios-provider.test.ts — LiveOgmiosProvider
 *
 * LiveOgmiosProvider implements the whole ChainProvider interface against Ogmios. Its four read methods forward to an inner
 * ReadOnlyOgmiosProvider (LiveOgmiosProvider.ts, constructor and read methods). read-only-ogmios-provider.test.ts tests those reads
 * and the retry rule of a read request. This file tests:
 *   A. The forwarding: each read sends the request of ReadOnlyOgmiosProvider and returns its value; the options `timeoutMs` and
 *      `sleep` reach the inner provider.
 *   B. submitTx(): its own code. Success, request shape, error mapping, and exactly one try for every error.
 *   C. awaitTx(): its own code. Polls, timeout, abort, and no retry level inside its poll loop.
 *
 * All network calls are mocked via globalThis.fetch. NO real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { LiveOgmiosProvider, OgmiosSubmitError } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import type { ChainProvider } from "../../packages/shared/src/chain/ChainProvider.js";
import {
  HTTP_500,
  OGMIOS_TEST_ADDRESS,
  instantSleep,
  makeOgmiosUtxo,
  rpcError,
  rpcOk,
  timeoutError,
} from "../fixtures/chain-codec/ogmios-http.js";

// ─── fetch mock setup ─────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TEST_URL = "http://localhost:1337";
const DUMMY_TX = "84a5008182582000".repeat(4);
const DUMMY_TX_HASH = "a".repeat(64);

// ─── A. The reads: forwarding to ReadOnlyOgmiosProvider ───────────────────────

describe("LiveOgmiosProvider — the reads forward to ReadOnlyOgmiosProvider", () => {
  const REF = { txHash: "b".repeat(64), index: 2 };

  // Each read runs through both providers, and the requests and the values must be equal. A Live provider that gets its own read code
  // (other ids, other params, other mapping) fails this table.
  it.each([
    { name: "tip", call: (provider: ChainProvider) => provider.tip(), answer: { slot: 99999, id: "a".repeat(64) } },
    { name: "queryUtxo", call: (provider: ChainProvider) => provider.queryUtxo(REF), answer: [makeOgmiosUtxo(REF.txHash, 2)] },
    {
      name: "queryUtxosByAddress",
      call: (provider: ChainProvider) => provider.queryUtxosByAddress(OGMIOS_TEST_ADDRESS),
      answer: [makeOgmiosUtxo("a".repeat(64), 0), makeOgmiosUtxo("b".repeat(64), 0, 3_000_000)],
    },
    {
      name: "evaluateTx",
      call: (provider: ChainProvider) => provider.evaluateTx(DUMMY_TX),
      answer: [{ validator: "escrow", budget: { memory: 5000, cpu: 10000 } }],
    },
  ])("$name sends the request of ReadOnlyOgmiosProvider and returns its value", async ({ call, answer }) => {
    const runs: Array<{ value: unknown; requests: unknown[][] }> = [];
    for (const Provider of [LiveOgmiosProvider, ReadOnlyOgmiosProvider]) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValue(rpcOk(answer));
      const value = await call(new Provider({ ogmiosUrl: TEST_URL }));
      runs.push({ value, requests: mockFetch.mock.calls.map(([url, init]) => [url, init.method, init.headers, init.body]) });
    }

    expect(runs[0].requests).toHaveLength(1);
    expect(runs[0]).toEqual(runs[1]);
  });

  it("passes its timeout and its sleep to the inner read-only provider", async () => {
    const sleep = vi.fn(instantSleep);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(rpcOk({ slot: 777, id: "a".repeat(64) }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep, timeoutMs: 1234 });
    await expect(provider.tip()).resolves.toBe(777);

    expect(sleep.mock.calls).toEqual([[300]]);
    expect(timeout.mock.calls).toEqual([[1234], [1234]]);
  });
});

// ─── B. submitTx() ───────────────────────────────────────────────────────────

describe("LiveOgmiosProvider — submitTx()", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("posts submitTransaction with the cbor and a UUID id, and returns result.transaction.id", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));

    await expect(new LiveOgmiosProvider({ ogmiosUrl: TEST_URL }).submitTx(DUMMY_TX)).resolves.toBe(DUMMY_TX_HASH);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(TEST_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      jsonrpc: "2.0",
      method: "submitTransaction",
      params: { transaction: { cbor: DUMMY_TX } },
      id: expect.stringMatching(UUID),
    });
  });

  it.each([
    [
      "no transaction.id",
      rpcOk({ transaction: {} }),
      'submit_malformed_response: Ogmios did not return result.transaction.id (got {"transaction":{}})',
    ],
    [
      "no result",
      { ok: true, json: () => Promise.resolve({ jsonrpc: "2.0" }) },
      "submit_malformed_response: Ogmios did not return result.transaction.id (got undefined)",
    ],
  ])("throws submit_malformed_response for an answer with %s", async (_label, answer, message) => {
    mockFetch.mockResolvedValueOnce(answer);

    await expect(new LiveOgmiosProvider({ ogmiosUrl: TEST_URL }).submitTx(DUMMY_TX)).rejects.toThrow(new Error(message));
  });
});

describe("LiveOgmiosProvider — submitTx() makes one call, whatever the error", () => {
  // A submit that got no clear answer may be on chain. A second submit of the same transaction fails with a misleading error, and the
  // caller would treat a transaction that is on chain as failed. So submitTx never tries again (commit 3259ca9).
  const sleep = vi.fn(instantSleep);
  let warn: MockInstance<typeof console.warn>;

  function makeProvider() {
    return new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep });
  }

  beforeEach(() => {
    sleep.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  /** One try only: no call to fetch after the first, nothing waited, nothing written. */
  function expectOneTryOnly() {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  }

  it.each([
    [
      "HTTP 500: the text of the error holds the body",
      { ok: false, status: 500, statusText: "Internal Server Error", text: () => Promise.resolve("upstream down") },
      "Ogmios HTTP error: 500 Internal Server Error :: upstream down",
    ],
    [
      "HTTP 503 with a body that cannot be read",
      { ok: false, status: 503, statusText: "Service Unavailable", text: () => Promise.reject(new Error("socket closed")) },
      "Ogmios HTTP error: 503 Service Unavailable :: ",
    ],
  ])("after %s", async (_label, answer, message) => {
    mockFetch.mockResolvedValue(answer);

    await expect(makeProvider().submitTx(DUMMY_TX)).rejects.toThrow(new Error(message));

    expectOneTryOnly();
  });

  it.each([
    ["a network error", new TypeError("fetch failed")],
    ["a TimeoutError", timeoutError()],
  ])("after %s, throws that error", async (_label, error) => {
    mockFetch.mockRejectedValue(error);

    await expect(makeProvider().submitTx(DUMMY_TX)).rejects.toBe(error);

    expectOneTryOnly();
  });

  it("after a JSON-RPC error, throws OgmiosSubmitError with its name, message, code and data", async () => {
    const data = { reason: "bad cbor", detail: "unexpected byte at offset 4" };
    mockFetch.mockResolvedValue(rpcError(3005, "Invalid transaction", data));

    const error = await makeProvider().submitTx(DUMMY_TX).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OgmiosSubmitError);
    expect(error).toMatchObject({ name: "OgmiosSubmitError", message: "Invalid transaction", code: 3005, data });
    expectOneTryOnly();
  });
});

// ─── C. awaitTx() ────────────────────────────────────────────────────────────
// awaitTx tests use fake timers to control the polling cadence and the timeout.

async function runAwaitTx(provider: LiveOgmiosProvider, txHash: string, timeoutMs: number): Promise<void> {
  const call = provider.awaitTx(txHash, timeoutMs);
  // Attach a handler at once: the call can reject while the timers run, before the caller awaits it.
  call.catch(() => {});
  await vi.runAllTimersAsync();
  return call;
}

describe("LiveOgmiosProvider — awaitTx()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves on the first poll that lists the transaction, after one request for its output reference", async () => {
    mockFetch.mockResolvedValue(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });

    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 10_000)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      method: "queryLedgerState/utxo",
      params: { outputReferences: [{ transaction: { id: DUMMY_TX_HASH }, index: 0 }] },
    });
  });

  it("polls again until a poll lists the transaction", async () => {
    mockFetch
      .mockResolvedValueOnce(rpcOk([]))
      .mockResolvedValueOnce(rpcOk([]))
      .mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, pollIntervalMs: 2000 });

    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 10_000)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("resolves when Ogmios lists the output at an index above 0 for the same transaction", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 1)]));
    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });

    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 10_000)).resolves.toBeUndefined();
  });

  it("rejects after timeoutMs when the transaction never appears, and the error names the hash", async () => {
    mockFetch.mockResolvedValue(rpcOk([]));
    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, pollIntervalMs: 100 });

    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 500)).rejects.toThrow(
      `awaitTx_timeout: tx ${DUMMY_TX_HASH} not observed within 500ms`,
    );
  });

  it("aborts the fetch of the poll after the timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise(() => { /* never resolves */ });
    });
    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, pollIntervalMs: 100 });

    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 200)).rejects.toThrow(/awaitTx_timeout/);

    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("LiveOgmiosProvider — awaitTx() has no retry level inside its poll loop", () => {
  // The poll loop is the retry: an HTTP 500 answer ends one poll with `false`, and the next poll starts after pollIntervalMs.
  // Nothing is tried again inside a poll (commit 3259ca9).
  const sleep = vi.fn(instantSleep);
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sleep.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls again after the interval when a poll answers HTTP 500, and finds the transaction", async () => {
    mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep, pollIntervalMs: 2000 });

    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 10_000)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("makes one fetch for each poll while Ogmios answers HTTP 500: 4 polls, 4 fetches", async () => {
    mockFetch.mockResolvedValue(HTTP_500);
    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep, pollIntervalMs: 100 });

    // Polls at 0, 100, 200 and 300 ms; the timeout at 350 ms ends the call.
    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 350)).rejects.toThrow(/awaitTx_timeout/);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
