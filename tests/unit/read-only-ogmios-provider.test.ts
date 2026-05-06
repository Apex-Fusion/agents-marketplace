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
 * Mock global.fetch per apex-dashboard ogmios-client.test.ts pattern.
 * NO real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import { NotSupportedError } from "../../packages/shared/src/chain/ChainProvider.js";

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
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.tip()).rejects.toThrow();
  });

  it("throws on network error (fetch rejection)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
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
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    await expect(provider.evaluateTx(DUMMY_TX)).rejects.toThrow();
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
