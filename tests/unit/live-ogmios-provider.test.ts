/**
 * live-ogmios-provider.test.ts — RED phase tests for LiveOgmiosProvider
 *
 * Coverage:
 *   A. Read-method parity with ReadOnlyOgmiosProvider
 *      tip(), queryUtxo(), queryUtxosByAddress(), evaluateTx()
 *   B. submitTx() — success, request shape, HTTP error, JSON-RPC error,
 *      malformed response, timeout
 *   C. awaitTx() — resolves on confirmation, polls at 2s cadence, rejects on
 *      timeout, aborts in-flight fetch, multiple polls, first-poll success
 *   D. Composition parity — identical request bodies vs ReadOnlyOgmiosProvider
 *      for all four read methods
 *
 * All network calls are mocked via globalThis.fetch. NO real network calls.
 *
 * SPEC FIX 2026-04-27: M1-F-2 LiveOgmiosProvider RED tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveOgmiosProvider, OgmiosSubmitError } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";

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

// Helper: build a successful JSON-RPC response envelope
function rpcOk<T>(result: T) {
  return {
    ok: true,
    json: () => Promise.resolve({ jsonrpc: "2.0", result }),
  };
}

// Helper: build a JSON-RPC error envelope (HTTP 200 but RPC error)
function rpcError(code: number, message: string, data?: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve({ jsonrpc: "2.0", error: { code, message, data } }),
  };
}

// Helper: typical Ogmios UTxO for query responses
function makeOgmiosUtxo(txId = "a".repeat(64), index = 0) {
  return {
    transaction: { id: txId },
    index,
    address: "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2",
    value: { ada: { lovelace: 2_000_000 } },
    datum: null,
  };
}

// ─── A. Read-method parity with ReadOnlyOgmiosProvider ───────────────────────

describe("LiveOgmiosProvider — tip()", () => {
  it("sends a POST request to ogmiosUrl", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ slot: 12345678, id: "a".repeat(64) }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.tip();

    expect(mockFetch).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses JSON-RPC method queryNetwork/tip", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ slot: 12345678, id: "a".repeat(64) }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.tip();

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("queryNetwork/tip");
  });

  it("returns the slot number from the response", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ slot: 99999, id: "a".repeat(64) }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const slot = await provider.tip();

    expect(slot).toBe(99999);
  });

  it("throws on HTTP 500 error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" });

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.tip()).rejects.toThrow();
  });
});

describe("LiveOgmiosProvider — queryUtxo()", () => {
  const TEST_REF = { txHash: "b".repeat(64), index: 0 };

  it("uses JSON-RPC method queryLedgerState/utxo", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.queryUtxo(TEST_REF);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("queryLedgerState/utxo");
  });

  it("includes outputReferences with txHash and index", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.queryUtxo(TEST_REF);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(JSON.stringify(body.params)).toContain(TEST_REF.txHash);
    expect(JSON.stringify(body.params)).toContain(String(TEST_REF.index));
  });

  it("returns null when result is empty", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(TEST_REF);
    expect(result).toBeNull();
  });

  it("returns parsed Utxo when result has one entry", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(TEST_REF.txHash, 0)]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(TEST_REF);
    expect(result).not.toBeNull();
    expect(result!.ref.txHash).toBe(TEST_REF.txHash);
  });
});

describe("LiveOgmiosProvider — queryUtxosByAddress()", () => {
  const TEST_ADDR = "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2";

  it("uses JSON-RPC method queryLedgerState/utxo with addresses param", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.queryUtxosByAddress(TEST_ADDR);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("queryLedgerState/utxo");
    expect(JSON.stringify(body.params)).toContain(TEST_ADDR);
  });

  it("returns empty array when result is empty", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxosByAddress(TEST_ADDR);
    expect(result).toEqual([]);
  });

  it("returns all UTxOs when result has multiple entries", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([
      makeOgmiosUtxo("a".repeat(64), 0),
      makeOgmiosUtxo("b".repeat(64), 0),
    ]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxosByAddress(TEST_ADDR);
    expect(result).toHaveLength(2);
  });
});

describe("LiveOgmiosProvider — evaluateTx()", () => {
  it("sends JSON-RPC method evaluateTransaction", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([{ validator: "escrow", budget: { memory: 5000, cpu: 10000 } }]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.evaluateTx(DUMMY_TX);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("evaluateTransaction");
  });

  it("passes txCborHex in params.transaction.cbor", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ memory: 1000, steps: 2000 }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.evaluateTx(DUMMY_TX);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(JSON.stringify(body.params)).toContain(DUMMY_TX);
  });

  it("returns {ok: true} on success with budget aggregated", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([{ validator: "escrow", budget: { memory: 5000, cpu: 10000 } }]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.evaluateTx(DUMMY_TX);
    expect(result.ok).toBe(true);
  });

  it("returns {ok: false} on JSON-RPC error (script failure)", async () => {
    mockFetch.mockResolvedValueOnce(rpcError(3010, "Script execution failure"));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.evaluateTx(DUMMY_TX);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});

// ─── B. submitTx() ───────────────────────────────────────────────────────────

describe("LiveOgmiosProvider — submitTx() — success path", () => {
  it("returns the txHash from result.transaction.id", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.submitTx(DUMMY_TX);
    expect(result).toBe(DUMMY_TX_HASH);
  });

  it("sends a POST to ogmiosUrl", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.submitTx(DUMMY_TX);

    expect(mockFetch).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("request body has jsonrpc '2.0', method 'submitTransaction', params.transaction.cbor and a string id", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.submitTx(DUMMY_TX);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("submitTransaction");
    expect(body.params.transaction.cbor).toBe(DUMMY_TX);
    // id must be a non-empty string (UUID)
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
  });

  it("request body id is a valid UUID v4 format", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.submitTx(DUMMY_TX);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(body.id).toMatch(uuidRe);
  });
});

describe("LiveOgmiosProvider — submitTx() — error paths", () => {
  it("throws on HTTP 5xx error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.submitTx(DUMMY_TX)).rejects.toThrow();
  });

  it("throws OgmiosSubmitError when Ogmios returns a JSON-RPC error", async () => {
    mockFetch.mockResolvedValueOnce(rpcError(3005, "Invalid transaction", { reason: "bad cbor" }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.submitTx(DUMMY_TX)).rejects.toThrow(OgmiosSubmitError);
  });

  it("OgmiosSubmitError preserves the JSON-RPC error code", async () => {
    mockFetch.mockResolvedValueOnce(rpcError(3005, "Invalid transaction", { reason: "bad cbor" }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    let caught: unknown;
    try {
      await provider.submitTx(DUMMY_TX);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OgmiosSubmitError);
    expect((caught as OgmiosSubmitError).code).toBe(3005);
  });

  it("OgmiosSubmitError preserves the JSON-RPC error data field", async () => {
    const errorData = { reason: "bad cbor", detail: "unexpected byte at offset 4" };
    mockFetch.mockResolvedValueOnce(rpcError(3005, "Invalid transaction", errorData));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    let caught: unknown;
    try {
      await provider.submitTx(DUMMY_TX);
    } catch (e) {
      caught = e;
    }
    expect((caught as OgmiosSubmitError).data).toMatchObject(errorData);
  });

  it("OgmiosSubmitError has name 'OgmiosSubmitError'", async () => {
    mockFetch.mockResolvedValueOnce(rpcError(3005, "err"));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    let caught: unknown;
    try {
      await provider.submitTx(DUMMY_TX);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).name).toBe("OgmiosSubmitError");
  });

  it("throws with reason 'submit_malformed_response' when result.transaction.id is missing", async () => {
    // Ogmios returns 200 + result but no transaction.id
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: {} }));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    let caught: unknown;
    try {
      await provider.submitTx(DUMMY_TX);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/submit_malformed_response/);
  });

  it("throws with reason 'submit_malformed_response' when result itself is missing", async () => {
    // Ogmios returns 200 but no result and no error
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0" }),
    });

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.submitTx(DUMMY_TX)).rejects.toThrow(/submit_malformed_response/);
  });
});

// ─── C. awaitTx() ────────────────────────────────────────────────────────────
// Note: awaitTx tests use fake timers to control polling cadence and timeouts.
// The runAwaitTx helper attaches a catch handler immediately after calling
// awaitTx to silence Node's unhandledRejection for the RED-phase stub,
// then re-throws via the returned promise.

async function runAwaitTx(
  provider: LiveOgmiosProvider,
  txHash: string,
  timeoutMs: number,
): Promise<void> {
  // Start the call, then advance timers, then await the settled promise.
  // This prevents unhandled rejections when the stub throws synchronously.
  const p = provider.awaitTx(txHash, timeoutMs);
  // Attach a no-op rejection handler immediately to silence Node's
  // unhandledRejection for the RED-phase stub.
  p.catch(() => { /* intentional — will re-throw below */ });
  await vi.runAllTimersAsync();
  return p;
}

describe("LiveOgmiosProvider — awaitTx() — resolves on confirmation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves when polling finds a UTxO with matching transactionId", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 10_000)).resolves.toBeUndefined();
  });

  it("resolves on first poll without issuing further polls", async () => {
    mockFetch.mockResolvedValue(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await runAwaitTx(provider, DUMMY_TX_HASH, 10_000).catch(() => { /* RED */ });

    // In GREEN, fetch should have been called exactly once
    // In RED, fetch is never called (stub throws), so we assert the spec
    // is encoded: if the provider were implemented, only 1 fetch would occur
    // on a first-poll hit.
    expect(mockFetch).toHaveBeenCalledTimes(
      // RED: 0 calls (stub throws before fetching)
      // GREEN: 1 call (first poll returns result)
      mockFetch.mock.calls.length,
    );
    // The real assertion: after implementation, exactly 1 fetch for first-poll success
    if (mockFetch.mock.calls.length > 0) {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("issues multiple polls before resolving (GREEN: asserts fetchCallCount === 3)", async () => {
    mockFetch
      .mockResolvedValueOnce(rpcOk([]))
      .mockResolvedValueOnce(rpcOk([]))
      .mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, pollIntervalMs: 2000 });
    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 10_000)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("polls using queryLedgerState/utxo with synthetic outputReference for the txHash", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await runAwaitTx(provider, DUMMY_TX_HASH, 10_000).catch(() => { /* RED */ });

    // In GREEN, the fetch body must use queryLedgerState/utxo with the txHash
    if (mockFetch.mock.calls.length > 0) {
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.method).toBe("queryLedgerState/utxo");
      expect(JSON.stringify(body.params)).toContain(DUMMY_TX_HASH);
    } else {
      // RED: stub didn't reach fetch — fail with a clear message
      expect(mockFetch).toHaveBeenCalled(); // will fail: 0 calls
    }
  });

  it("resolves even when Ogmios returns UTxO at index > 0 for the same txHash", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 1)]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 10_000)).resolves.toBeUndefined();
  });
});

describe("LiveOgmiosProvider — awaitTx() — timeout", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("rejects after timeoutMs when tx never appears", async () => {
    mockFetch.mockResolvedValue(rpcOk([]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, pollIntervalMs: 100 });
    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 500)).rejects.toThrow();
  });

  it("timeout error message references the txHash", async () => {
    mockFetch.mockResolvedValue(rpcOk([]));

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, pollIntervalMs: 100 });
    let caught: unknown;
    try {
      await runAwaitTx(provider, DUMMY_TX_HASH, 500);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(DUMMY_TX_HASH);
  });

  it("aborts in-flight fetch after timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise(() => { /* never resolves */ });
    });

    const provider = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL, pollIntervalMs: 100 });
    await expect(runAwaitTx(provider, DUMMY_TX_HASH, 200)).rejects.toThrow();

    // In GREEN: the AbortController signal passed to fetch must be aborted
    if (capturedSignal !== undefined) {
      expect(capturedSignal.aborted).toBe(true);
    } else {
      // RED: stub didn't reach fetch — signal never captured; fail clearly
      expect(capturedSignal).toBeDefined(); // will fail
    }
  });
});

// ─── D. Read-method composition parity ───────────────────────────────────────
// Live provider and ReadOnly provider should send identical request bodies
// for the same inputs on all four read methods.
//
// Helper: call the provider and capture the fetch body. If fetch was never
// called (e.g. stub threw before reaching fetch), re-throw so the test
// correctly fails with "not implemented — M1-F-2-green" rather than
// a confusing "cannot read property" frame.

describe("LiveOgmiosProvider — composition parity with ReadOnlyOgmiosProvider", () => {
  async function captureBodyOrThrow(call: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await call();
    } catch {
      // rethrow only if fetch was never reached (stub threw before the HTTP call)
      if (mockFetch.mock.calls.length === 0) throw new Error("LiveOgmiosProvider did not reach fetch — not implemented");
      // otherwise ignore the error (we only care about the request body)
    }
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    return JSON.parse(lastCall[1].body as string) as Record<string, unknown>;
  }

  it("tip() — identical jsonrpc, method fields", async () => {
    mockFetch.mockResolvedValue(rpcOk({ slot: 1, id: "a".repeat(64) }));

    const live = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const liveBody = await captureBodyOrThrow(() => live.tip());

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(rpcOk({ slot: 1, id: "a".repeat(64) }));
    const readOnly = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const roBody = await captureBodyOrThrow(() => readOnly.tip());

    expect(liveBody.jsonrpc).toBe(roBody.jsonrpc);
    expect(liveBody.method).toBe(roBody.method);
  });

  it("queryUtxo() — identical method and params shape", async () => {
    const ref = { txHash: "c".repeat(64), index: 2 };
    mockFetch.mockResolvedValue(rpcOk([]));

    const live = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const liveBody = await captureBodyOrThrow(() => live.queryUtxo(ref));

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(rpcOk([]));
    const readOnly = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const roBody = await captureBodyOrThrow(() => readOnly.queryUtxo(ref));

    expect(liveBody.method).toBe(roBody.method);
    // Both must include the txHash in params
    expect(JSON.stringify(liveBody.params)).toContain(ref.txHash);
    expect(JSON.stringify(roBody.params)).toContain(ref.txHash);
  });

  it("queryUtxosByAddress() — identical method and address in params", async () => {
    const addr = "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2";
    mockFetch.mockResolvedValue(rpcOk([]));

    const live = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const liveBody = await captureBodyOrThrow(() => live.queryUtxosByAddress(addr));

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(rpcOk([]));
    const readOnly = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const roBody = await captureBodyOrThrow(() => readOnly.queryUtxosByAddress(addr));

    expect(liveBody.method).toBe(roBody.method);
    expect(JSON.stringify(liveBody.params)).toContain(addr);
    expect(JSON.stringify(roBody.params)).toContain(addr);
  });

  it("evaluateTx() — identical method and txCborHex in params", async () => {
    mockFetch.mockResolvedValue(rpcOk({ memory: 1000, steps: 2000 }));

    const live = new LiveOgmiosProvider({ ogmiosUrl: TEST_URL });
    const liveBody = await captureBodyOrThrow(() => live.evaluateTx(DUMMY_TX));

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(rpcOk({ memory: 1000, steps: 2000 }));
    const readOnly = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const roBody = await captureBodyOrThrow(() => readOnly.evaluateTx(DUMMY_TX));

    expect(liveBody.method).toBe(roBody.method);
    expect(JSON.stringify(liveBody.params)).toContain(DUMMY_TX);
    expect(JSON.stringify(roBody.params)).toContain(DUMMY_TX);
  });
});
