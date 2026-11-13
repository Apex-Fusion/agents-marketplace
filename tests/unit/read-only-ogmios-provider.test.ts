/**
 * read-only-ogmios-provider.test.ts — RED phase tests for ReadOnlyOgmiosProvider
 *
 * Tests all public methods:
 *   - tip()                → JSON-RPC queryNetwork/tip
 *   - queryUtxo()          → JSON-RPC queryLedgerState/utxo (by ref)
 *   - queryUtxosByAddress()→ JSON-RPC queryLedgerState/utxo (by address)
 *   - evaluateTx()         → JSON-RPC evaluateTransaction
 *   - submitTx()           → throws NotSupportedError
 *   - awaitTx()            → throws NotSupportedError
 *
 * A transient error (HTTP status 500 or higher, network error) is tried again,
 * at most 2 more times: see "a read-only request is tried again" at the end of
 * this file, and the guard for submitTransaction in fetchOgmiosRead.
 *
 * Mock global.fetch per apex-dashboard ogmios-client.test.ts pattern.
 * NO real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import { NotSupportedError } from "../../packages/shared/src/chain/ChainProvider.js";
import { fetchOgmiosRead } from "../../packages/shared/src/chain/ogmiosRetry.js";

// ─── fetch mock setup ─────────────────────────────────────────────────────��──

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TEST_URL = "http://localhost:1337";

// A read request is tried again after a transient error (see the retry tests at
// the end of this file). A test that expects the final error gives the mock an
// answer for every try, and skips the real wait between the tries.
const instantSleep = async (_ms: number): Promise<void> => {};

// ─── Constructor ─────────────────────────────────────────────────────────────

describe("ReadOnlyOgmiosProvider — constructor", () => {
  it("constructs without throwing", () => {
    expect(() => new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL })).not.toThrow();
  });

  it("accepts any ogmiosUrl string", () => {
    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: "https://ogmios.vector.testnet.apexfusion.org" });
    expect(provider).toBeDefined();
  });
});

// ─── tip() ───────────────────────────────────────────────────────────────────

describe("ReadOnlyOgmiosProvider — tip()", () => {
  it("sends a POST request to ogmiosUrl", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        result: { slot: 12345678, id: "a".repeat(64) },
      }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.tip();

    expect(mockFetch).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses JSON-RPC method queryNetwork/tip", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        result: { slot: 12345678, id: "a".repeat(64) },
      }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.tip();

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("queryNetwork/tip");
  });

  it("returns the slot number from the response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        result: { slot: 12345678, id: "a".repeat(64) },
      }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const slot = await provider.tip();
    expect(slot).toBe(12345678);
  });

  it("throws on HTTP error response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL, sleep: instantSleep });
    await expect(provider.tip()).rejects.toThrow("Ogmios HTTP error: 500 Internal Server Error");
  });

  it("throws on network error (fetch rejection)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL, sleep: instantSleep });
    await expect(provider.tip()).rejects.toThrow("ECONNREFUSED");
  });

  it("throws on JSON-RPC error in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request" },
      }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.tip()).rejects.toThrow();
  });
});

// ─── queryUtxo() ─────────────────────────────────────────────────────────────

describe("ReadOnlyOgmiosProvider — queryUtxo()", () => {
  const TEST_REF = { txHash: "a".repeat(64), index: 0 };

  it("sends a POST request to ogmiosUrl", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.queryUtxo(TEST_REF);

    expect(mockFetch).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses JSON-RPC method queryLedgerState/utxo", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.queryUtxo(TEST_REF);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.method).toBe("queryLedgerState/utxo");
  });

  it("includes the txHash and index in params", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.queryUtxo(TEST_REF);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    // Ogmios outputs-by-ref format: { outputReferences: [{transaction: {id}, index}] }
    expect(JSON.stringify(body.params)).toContain(TEST_REF.txHash);
    expect(JSON.stringify(body.params)).toContain(String(TEST_REF.index));
  });

  it("returns null when result array is empty (UTxO spent/never existed)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(TEST_REF);
    expect(result).toBeNull();
  });

  it("returns a Utxo when result array has one entry", async () => {
    const mockOgmiosUtxo = {
      transaction: { id: TEST_REF.txHash },
      index: 0,
      address: "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2",
      value: { ada: { lovelace: 2_000_000 } },
      datumHash: null,
      datum: null,
      script: null,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [mockOgmiosUtxo] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(TEST_REF);
    expect(result).not.toBeNull();
    expect(result!.ref.txHash).toBe(TEST_REF.txHash);
    expect(result!.ref.index).toBe(0);
  });

  it("parses lovelace from ada.lovelace field", async () => {
    const mockOgmiosUtxo = {
      transaction: { id: TEST_REF.txHash },
      index: 0,
      address: "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2",
      value: { ada: { lovelace: 5_000_000 } },
      datum: null,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [mockOgmiosUtxo] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(TEST_REF);
    expect(result!.lovelace).toBe(5_000_000n);
  });

  it("parses inline datum hex when present", async () => {
    const mockOgmiosUtxo = {
      transaction: { id: TEST_REF.txHash },
      index: 0,
      address: "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2",
      value: { ada: { lovelace: 2_000_000 } },
      datum: "d87980",   // CBOR inline datum hex
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [mockOgmiosUtxo] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(TEST_REF);
    expect(result!.datumHex).toBe("d87980");
  });

  it("sets datumHex to null when no inline datum", async () => {
    const mockOgmiosUtxo = {
      transaction: { id: TEST_REF.txHash },
      index: 0,
      address: "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2",
      value: { ada: { lovelace: 2_000_000 } },
      datum: null,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [mockOgmiosUtxo] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(TEST_REF);
    expect(result!.datumHex).toBeNull();
  });

  // Ogmios v6 shape of a reference script; the identity Register reads its reference UTxO through this mapping.
  it.each([
    ["plutus:v3", "5901ab0101002229800aba2aba1", "5901ab0101002229800aba2aba1"],
    ["plutus:v2", "5901ab0101002229800aba2aba1", null],
  ])("maps a %s reference script to scriptRef %s -> %s", async (language, cbor, expected) => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [{
        transaction: { id: TEST_REF.txHash },
        index: 0,
        address: "addr1vyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkdl5mw",
        value: { ada: { lovelace: 59_982_270 } },
        script: { language, cbor },
      }] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(TEST_REF);
    expect(result!.scriptRef).toBe(expected);
  });
});

// ─── queryUtxosByAddress() ────────────────────────────────────────────────────

describe("ReadOnlyOgmiosProvider — queryUtxosByAddress()", () => {
  const TEST_ADDR = "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2";

  it("sends a POST to ogmiosUrl with queryLedgerState/utxo method", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.queryUtxosByAddress(TEST_ADDR);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.method).toBe("queryLedgerState/utxo");
  });

  it("passes the address in params", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.queryUtxosByAddress(TEST_ADDR);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(JSON.stringify(body.params)).toContain(TEST_ADDR);
  });

  it("returns an empty array when result is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: [] }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxosByAddress(TEST_ADDR);
    expect(result).toEqual([]);
  });

  it("returns multiple UTxOs when result has multiple entries", async () => {
    const mockUtxos = [
      {
        transaction: { id: "a".repeat(64) },
        index: 0,
        address: TEST_ADDR,
        value: { ada: { lovelace: 2_000_000 } },
        datum: null,
      },
      {
        transaction: { id: "b".repeat(64) },
        index: 1,
        address: TEST_ADDR,
        value: { ada: { lovelace: 3_000_000 } },
        datum: null,
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", result: mockUtxos }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxosByAddress(TEST_ADDR);
    expect(result).toHaveLength(2);
    expect(result[0].ref.txHash).toBe("a".repeat(64));
    expect(result[1].ref.txHash).toBe("b".repeat(64));
  });
});

// ─── evaluateTx() ─────────────────────────────────────────────────────────────

describe("ReadOnlyOgmiosProvider — evaluateTx()", () => {
  const DUMMY_TX = "84a5008182582000".repeat(4);

  it("sends a POST with JSON-RPC method evaluateTransaction", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        result: { memory: 1000, steps: 2000 },
      }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.evaluateTx(DUMMY_TX);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.method).toBe("evaluateTransaction");
  });

  it("passes the tx CBOR hex in params", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        result: { memory: 1000, steps: 2000 },
      }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await provider.evaluateTx(DUMMY_TX);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(JSON.stringify(body.params)).toContain(DUMMY_TX);
  });

  it("returns {ok: true, cost: {memory, steps}} on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        result: [{ validator: "escrow", budget: { memory: 5000, cpu: 10000 } }],
      }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.evaluateTx(DUMMY_TX);
    expect(result.ok).toBe(true);
  });

  it("returns {ok: false, error: ...} on JSON-RPC error (script failure)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        error: { code: 3010, message: "Script execution failure" },
      }),
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.evaluateTx(DUMMY_TX);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("throws on HTTP 500 error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL, sleep: instantSleep });
    await expect(provider.evaluateTx(DUMMY_TX)).rejects.toThrow("Ogmios HTTP error: 500 Internal Server Error");
  });
});

// ─── submitTx() — throws NotSupportedError ────────────────────────────────────

describe("ReadOnlyOgmiosProvider — submitTx() is not supported", () => {
  it("throws NotSupportedError", async () => {
    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.submitTx("deadbeef")).rejects.toThrow(NotSupportedError);
  });

  it("error message references 'submitTx'", async () => {
    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    let caught: unknown;
    try {
      await provider.submitTx("deadbeef");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotSupportedError);
    expect((caught as NotSupportedError).op).toBe("submitTx");
  });

  it("does NOT call fetch when submitTx is called", async () => {
    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    try { await provider.submitTx("deadbeef"); } catch { /* expected */ }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── awaitTx() — throws NotSupportedError ────────────────────────────────────

describe("ReadOnlyOgmiosProvider — awaitTx() is not supported", () => {
  it("throws NotSupportedError", async () => {
    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.awaitTx("a".repeat(64), 1000)).rejects.toThrow(NotSupportedError);
  });

  it("error message references 'awaitTx'", async () => {
    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    let caught: unknown;
    try {
      await provider.awaitTx("a".repeat(64), 1000);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotSupportedError);
    expect((caught as NotSupportedError).op).toBe("awaitTx");
  });

  it("does NOT call fetch when awaitTx is called", async () => {
    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    try { await provider.awaitTx("a".repeat(64), 100); } catch { /* expected */ }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── Retry of a read-only request after a transient error ─────────────────────
//
// The rule (packages/shared/src/chain/ogmiosRetry.ts): a request whose JSON-RPC
// method is not submitTransaction is tried again, at most 2 more times (3 tries
// in total), after an HTTP status of 500 or higher or a network error. The waits
// are 300 ms and 1,000 ms. These are NOT tried again: an HTTP status below 500,
// an HTTP 200 with a JSON-RPC error, a timeout or an abort, a malformed body.
// After the last try the error is the same as before the retry existed.

const HTTP_500 = { ok: false, status: 500, statusText: "Internal Server Error" };
const HTTP_502 = { ok: false, status: 502, statusText: "Bad Gateway" };

function tipAnswer(slot: number) {
  return {
    ok: true,
    json: () => Promise.resolve({ jsonrpc: "2.0", result: { slot, id: "a".repeat(64) } }),
  };
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

/**
 * Replaces AbortSignal.timeout so that each try gets a signal that a test fires
 * by hand: no real timer and no real wait. Returns the controller of each try
 * (in the order of the tries) and the spy.
 */
function controlTimeoutSignals() {
  const controllers: AbortController[] = [];
  const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  return { controllers, spy };
}

describe("ReadOnlyOgmiosProvider — a read-only request is tried again after a transient error", () => {
  // The URL holds a credential in the path: no warn line may show it.
  const CREDENTIAL_URL = "https://ogmios.example/secret-key-123";
  const sleep = vi.fn(async (_ms: number): Promise<void> => {});
  let warn: MockInstance<typeof console.warn>;

  function makeProvider(extra: { timeoutMs?: number } = {}) {
    return new ReadOnlyOgmiosProvider({ ogmiosUrl: CREDENTIAL_URL, fetch: mockFetch, sleep, ...extra });
  }

  beforeEach(() => {
    sleep.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("tip()", () => {
    it("returns the answer of try 2 after one HTTP 500: 2 calls, 1 warn line", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(tipAnswer(777));

      await expect(makeProvider().tip()).resolves.toBe(777);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([["[ogmios] retry 1/2 method=queryNetwork/tip cause=500"]]);
    });

    it("returns the answer of try 3 after HTTP 500 and HTTP 502: 3 calls, 2 warn lines", async () => {
      mockFetch
        .mockResolvedValueOnce(HTTP_500)
        .mockResolvedValueOnce(HTTP_502)
        .mockResolvedValueOnce(tipAnswer(778));

      await expect(makeProvider().tip()).resolves.toBe(778);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls).toEqual([
        ["[ogmios] retry 1/2 method=queryNetwork/tip cause=500"],
        ["[ogmios] retry 2/2 method=queryNetwork/tip cause=502"],
      ]);
    });

    it.each([500, 502, 503, 504, 520, 522, 524, 599])("tries again after HTTP %i", async (status) => {
      mockFetch.mockResolvedValueOnce({ ok: false, status, statusText: "x" }).mockResolvedValueOnce(tipAnswer(1));

      await expect(makeProvider().tip()).resolves.toBe(1);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([[`[ogmios] retry 1/2 method=queryNetwork/tip cause=${status}`]]);
    });

    it("throws the same error as before after three HTTP 500: 3 calls, 2 warn lines", async () => {
      mockFetch.mockResolvedValue(HTTP_500);

      const error = await makeProvider().tip().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).constructor).toBe(Error);
      expect((error as Error).message).toBe("Ogmios HTTP error: 500 Internal Server Error");
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("throws the error of the last try after HTTP 500, a network error and HTTP 502", async () => {
      mockFetch
        .mockResolvedValueOnce(HTTP_500)
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(HTTP_502);

      await expect(makeProvider().tip()).rejects.toThrow(new Error("Ogmios HTTP error: 502 Bad Gateway"));

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("returns the answer of try 2 after one network error: the warn line names the error class", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(tipAnswer(5));

      await expect(makeProvider().tip()).resolves.toBe(5);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([["[ogmios] retry 1/2 method=queryNetwork/tip cause=TypeError"]]);
    });

    it("names a plain Error with a connection code `Error` in the warn line", async () => {
      const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      mockFetch.mockRejectedValueOnce(reset).mockResolvedValueOnce(tipAnswer(5));

      await expect(makeProvider().tip()).resolves.toBe(5);

      expect(warn.mock.calls).toEqual([["[ogmios] retry 1/2 method=queryNetwork/tip cause=Error"]]);
    });

    it("throws the error object of the last try after three network errors: 3 calls", async () => {
      const errors = [1, 2, 3].map((n) => new TypeError(`fetch failed ${n}`));
      for (const error of errors) mockFetch.mockRejectedValueOnce(error);

      await expect(makeProvider().tip()).rejects.toBe(errors[2]);

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("does not try an HTTP 400 with a JSON-RPC error body again, and keeps the thrown text", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: () => Promise.resolve({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } }),
      });

      await expect(makeProvider().tip()).rejects.toThrow(new Error("Ogmios HTTP error: 400 Bad Request"));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([400, 404, 429, 499])("does not try again after HTTP %i", async (status) => {
      mockFetch.mockResolvedValue({ ok: false, status, statusText: "Client Answer" });

      await expect(makeProvider().tip()).rejects.toThrow(new Error(`Ogmios HTTP error: ${status} Client Answer`));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not try again after HTTP 200 with a JSON-RPC error", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } }),
      });

      await expect(makeProvider().tip()).rejects.toThrow(new Error("Ogmios RPC error: Invalid Request"));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not try again after HTTP 200 with a malformed body", async () => {
      const malformed = new SyntaxError("Unexpected token < in JSON at position 0");
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(malformed) });

      await expect(makeProvider().tip()).rejects.toBe(malformed);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not try again after HTTP 200 with no result", async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ jsonrpc: "2.0" }) });

      await expect(makeProvider().tip()).rejects.toThrow(new Error("Ogmios RPC response missing 'result'"));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a TimeoutError", timeoutError],
      ["an AbortError", abortError],
    ])("does not try again after %s on try 1", async (_label, make) => {
      const error = make();
      mockFetch.mockRejectedValueOnce(error);

      await expect(makeProvider().tip()).rejects.toBe(error);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not try again when the timeout signal of the try fires", async () => {
      const { controllers } = controlTimeoutSignals();
      mockFetch.mockImplementation(async (_url: unknown, init: RequestInit) => {
        // The timeout fires while fetch waits for Ogmios.
        controllers[0].abort(timeoutError());
        throw init.signal!.reason;
      });

      await expect(makeProvider().tip()).rejects.toMatchObject({ name: "TimeoutError" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not try again when the signal of the try fired, whatever the error is", async () => {
      const { controllers } = controlTimeoutSignals();
      mockFetch.mockImplementation(async () => {
        controllers[0].abort(timeoutError());
        // A fetch that reports the timeout as a plain network error.
        throw new TypeError("fetch failed");
      });

      await expect(makeProvider().tip()).rejects.toMatchObject({ name: "TypeError", message: "fetch failed" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("waits 300 ms before try 2 and 1,000 ms before try 3, between the tries", async () => {
      const events: string[] = [];
      const answers = [HTTP_500, HTTP_502, tipAnswer(1)];
      mockFetch.mockImplementation(async () => {
        events.push("fetch");
        return answers[events.filter((e) => e === "fetch").length - 1];
      });
      sleep.mockImplementation(async (ms: number) => { events.push(`sleep ${ms}`); });

      await makeProvider().tip();

      expect(sleep.mock.calls).toEqual([[300], [1000]]);
      expect(events).toEqual(["fetch", "sleep 300", "fetch", "sleep 1000", "fetch"]);
    });

    it("does not wait after the last try", async () => {
      mockFetch.mockResolvedValue(HTTP_500);

      await makeProvider().tip().catch(() => {});

      expect(sleep.mock.calls).toEqual([[300], [1000]]);
    });

    it("sends the same request on each try", async () => {
      mockFetch
        .mockResolvedValueOnce(HTTP_500)
        .mockResolvedValueOnce(HTTP_502)
        .mockResolvedValueOnce(tipAnswer(1));

      await makeProvider().tip();

      const bodies = mockFetch.mock.calls.map((call) => call[1].body);
      expect(typeof bodies[0]).toBe("string");
      expect(new Set(bodies).size).toBe(1);
      for (const [url, init] of mockFetch.mock.calls) {
        expect(url).toBe(CREDENTIAL_URL);
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({ "Content-Type": "application/json" });
      }
    });

    it("gives each try its own timeout signal: try 2 does not start with an aborted signal", async () => {
      const { controllers, spy } = controlTimeoutSignals();
      const signals: AbortSignal[] = [];
      const abortedAtCall: boolean[] = [];
      mockFetch.mockImplementation(async (_url: unknown, init: RequestInit) => {
        signals.push(init.signal!);
        abortedAtCall.push(init.signal!.aborted);
        if (signals.length > 1) return tipAnswer(5);
        // The timeout of try 1 has passed when Ogmios answers with HTTP 500.
        controllers[0].abort(timeoutError());
        return HTTP_500;
      });

      await expect(makeProvider({ timeoutMs: 1234 }).tip()).resolves.toBe(5);

      expect(spy.mock.calls).toEqual([[1234], [1234]]);
      expect(signals).toHaveLength(2);
      expect(signals[0]).not.toBe(signals[1]);
      expect(signals[0].aborted).toBe(true);
      expect(abortedAtCall).toEqual([false, false]);
    });

    it("without an injected sleep, the waits are timers of 300 ms and 1,000 ms", async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(HTTP_500)
          .mockResolvedValueOnce(HTTP_502)
          .mockResolvedValueOnce(tipAnswer(9));
        const result = new ReadOnlyOgmiosProvider({ ogmiosUrl: CREDENTIAL_URL, fetch: mockFetch }).tip();

        await vi.advanceTimersByTimeAsync(299);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(999);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        await expect(result).resolves.toBe(9);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the body of an answer that it drops, and leaves the body of the last answer", async () => {
      const answers = [502, 503, 504].map((status) => new Response("<html>gateway</html>", { status }));
      const cancels = answers.map((answer) => vi.spyOn(answer.body!, "cancel"));
      for (const answer of answers) mockFetch.mockResolvedValueOnce(answer);

      await expect(makeProvider().tip()).rejects.toThrow(new Error("Ogmios HTTP error: 504 "));

      expect(cancels.map((cancel) => cancel.mock.calls.length)).toEqual([1, 1, 0]);
    });

    it("tries again when the body of a dropped answer cannot be cancelled", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: "x", body: { cancel: () => Promise.reject(new Error("locked")) } })
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: "x", body: { cancel: () => { throw new Error("locked"); } } })
        .mockResolvedValueOnce(tipAnswer(3));

      await expect(makeProvider().tip()).resolves.toBe(3);

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("queryUtxo() and queryUtxosByAddress()", () => {
    const REF = { txHash: "c".repeat(64), index: 1 };
    const ADDRESS = "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2";
    const utxo = {
      transaction: { id: REF.txHash },
      index: 1,
      address: ADDRESS,
      value: { ada: { lovelace: 2_000_000 } },
    };

    it("queryUtxo returns the answer of try 2 after one HTTP 500", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: "2.0", result: [utxo] }),
      });

      const result = await makeProvider().queryUtxo(REF);

      expect(result?.ref).toEqual(REF);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([["[ogmios] retry 1/2 method=queryLedgerState/utxo cause=500"]]);
    });

    it("queryUtxosByAddress returns the answer of try 3 after HTTP 500 and a network error", async () => {
      mockFetch
        .mockResolvedValueOnce(HTTP_500)
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ jsonrpc: "2.0", result: [utxo] }) });

      const result = await makeProvider().queryUtxosByAddress(ADDRESS);

      expect(result).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("writes warn lines with no URL, no body and no params", async () => {
      mockFetch
        .mockResolvedValueOnce(HTTP_500)
        .mockResolvedValueOnce(HTTP_502)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ jsonrpc: "2.0", result: [] }) });

      await makeProvider().queryUtxosByAddress(ADDRESS);

      expect(warn.mock.calls).toEqual([
        ["[ogmios] retry 1/2 method=queryLedgerState/utxo cause=500"],
        ["[ogmios] retry 2/2 method=queryLedgerState/utxo cause=502"],
      ]);
      const written = JSON.stringify(warn.mock.calls);
      expect(written).not.toContain("secret-key-123");
      expect(written).not.toContain("ogmios.example");
      expect(written).not.toContain(ADDRESS);
      expect(written).not.toContain("jsonrpc");
    });
  });

  describe("evaluateTx()", () => {
    const DUMMY_TX = "84a5008182582000".repeat(4);
    const evaluated = {
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        result: [{ validator: "escrow", budget: { memory: 5000, cpu: 10000 } }],
      }),
    };

    it("returns the answer of try 2 after one HTTP 500: 2 calls", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(evaluated);

      const result = await makeProvider().evaluateTx(DUMMY_TX);

      expect(result).toEqual({ ok: true, cost: { memory: 5000, steps: 10000 } });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([["[ogmios] retry 1/2 method=evaluateTransaction cause=500"]]);
      expect(sleep.mock.calls).toEqual([[300]]);
    });

    it("returns the answer of try 2 after one network error", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(evaluated);

      await expect(makeProvider().evaluateTx(DUMMY_TX)).resolves.toMatchObject({ ok: true });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("sends the same body on each try", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(HTTP_502).mockResolvedValueOnce(evaluated);

      await makeProvider().evaluateTx(DUMMY_TX);

      const bodies = mockFetch.mock.calls.map((call) => call[1].body);
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0]).method).toBe("evaluateTransaction");
    });

    it("throws the same error as before after three HTTP 500: 3 calls", async () => {
      mockFetch.mockResolvedValue(HTTP_500);

      await expect(makeProvider().evaluateTx(DUMMY_TX)).rejects.toThrow(
        new Error("Ogmios HTTP error: 500 Internal Server Error"),
      );

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("does not try an HTTP 400 again", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request" });

      await expect(makeProvider().evaluateTx(DUMMY_TX)).rejects.toThrow(new Error("Ogmios HTTP error: 400 Bad Request"));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns {ok: false} for a JSON-RPC error in HTTP 200 and does not try again", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: "2.0", error: { code: 3010, message: "Script execution failure" } }),
      });

      await expect(makeProvider().evaluateTx(DUMMY_TX)).resolves.toEqual({
        ok: false,
        error: "code=3010 Script execution failure",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not try again after a timeout", async () => {
      const error = timeoutError();
      mockFetch.mockRejectedValueOnce(error);

      await expect(makeProvider().evaluateTx(DUMMY_TX)).rejects.toBe(error);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

// ─── fetchOgmiosRead — the submitTransaction guard ────────────────────────────
//
// Neither submit path calls fetchOgmiosRead. The helper still gives a request
// with the method submitTransaction exactly one try, so that a caller who routes
// a submit through it by mistake cannot send the same transaction twice.

describe("fetchOgmiosRead — submitTransaction has exactly one try", () => {
  const sleep = vi.fn(async (_ms: number): Promise<void> => {});
  const call = (method: string) => fetchOgmiosRead({
    fetch: mockFetch,
    url: TEST_URL,
    method,
    body: "{}",
    timeoutMs: 1000,
    sleep,
  });

  beforeEach(() => {
    sleep.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns the HTTP 500 answer of the one try", async () => {
    mockFetch.mockResolvedValue(HTTP_500);

    await expect(call("submitTransaction")).resolves.toBe(HTTP_500);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws the network error of the one try", async () => {
    const error = new TypeError("fetch failed");
    mockFetch.mockRejectedValue(error);

    await expect(call("submitTransaction")).rejects.toBe(error);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws the timeout error of the one try", async () => {
    const error = timeoutError();
    mockFetch.mockRejectedValue(error);

    await expect(call("submitTransaction")).rejects.toBe(error);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "queryNetwork/tip",
    "queryLedgerState/utxo",
    "queryLedgerState/protocolParameters",
    "evaluateTransaction",
  ])("gives %s 3 tries", async (method) => {
    mockFetch.mockResolvedValue(HTTP_500);

    await expect(call(method)).resolves.toBe(HTTP_500);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[300], [1000]]);
  });
});
