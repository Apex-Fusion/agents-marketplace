/**
 * ogmios-lucid-provider.test.ts — RED phase tests for OgmiosLucidProvider
 *
 * Verifies that OgmiosLucidProvider satisfies the lucid-evolution Provider
 * interface by issuing the correct Ogmios JSON-RPC calls and parsing
 * responses into the shapes lucid expects.
 *
 * All network calls are mocked via injected fetch. No real Ogmios.
 *
 * Coverage:
 *   A. getProtocolParameters
 *   B. getUtxos(address)
 *   C. getUtxosByOutRef([{txHash, outputIndex}])
 *   D. submitTx
 *   E. awaitTx
 *   F. getDatum
 *   G. Stubbed: getDelegation, getUtxosWithUnit, getUtxoByUnit
 *   H. Adversarial: HTTP 5xx, JSON-RPC error, malformed response
 *   I. Retry of a read request after a transient error; submitTx is never
 *      tried again
 *
 * M1-F-4 RED — tests fail until Catherine implements OgmiosLucidProvider.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import {
  OgmiosLucidProvider,
  NotSupportedInM1F4Error,
} from "../../packages/shared/src/chain/OgmiosLucidProvider.js";

// ─── fetch mock setup ──────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TEST_URL = "http://localhost:1337";
const DUMMY_TX_HASH = "a".repeat(64);
const DUMMY_TX_CBOR = "84a500818258200000000000000000000000000000000000000000000000000000000000000000000d80a0f5f6";
const DUMMY_ADDRESS = "addr_test1vrmee5s2tqcxcgnhel8ddyjta77s76xftcsc0qcdwpajpdgjdd5nn";

// A read request is tried again after a transient error (see the retry tests at
// the end of this file). A test that expects the final error gives the mock an
// answer for every try, and skips the real wait between the tries.
const instantSleep = async (_ms: number): Promise<void> => {};

function rpcOk<T>(result: T) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", result }),
  };
}

function rpcError(code: number, message: string, data?: unknown) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", error: { code, message, data } }),
  };
}

function makeOgmiosProtocolParams() {
  return {
    minFeeCoefficient: 44,
    minFeeConstant: { ada: { lovelace: 155381 } },
    maxTransactionSize: { bytes: 16384 },
    maxValueSize: { bytes: 5000 },
    stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
    stakePoolDeposit: { ada: { lovelace: 500000000 } },
    monetaryExpansion: "0.003",
    treasuryExpansion: "0.2",
    minStakePoolCost: { ada: { lovelace: 340000000 } },
    prices: { memory: "0.0577", steps: "0.0000721" },
    maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
    coinsPerUtxoByte: { ada: { lovelace: 4310 } },
    collateralPercentage: 150,
    maxCollateralInputs: 3,
    plutusCostModels: {
      "plutus:v1": {},
      "plutus:v2": {},
      "plutus:v3": {},
    },
    minFeeReferenceScripts: { base: 15 },
    governanceActionDeposit: { ada: { lovelace: 100000000000 } },
    delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
  };
}

function makeOgmiosUtxo(txId = DUMMY_TX_HASH, index = 0, lovelace = 5_000_000) {
  return {
    transaction: { id: txId },
    index,
    address: DUMMY_ADDRESS,
    value: { ada: { lovelace } },
    datum: null,
    datumHash: null,
    script: null,
  };
}

// ─── A. getProtocolParameters ──────────────────────────────────────────────────

describe("OgmiosLucidProvider — getProtocolParameters()", () => {
  it("posts queryLedgerState/protocolParameters to ogmiosUrl", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.getProtocolParameters().catch(() => {});

    expect(mockFetch).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("queryLedgerState/protocolParameters");
  });

  it("returns a ProtocolParameters with minFeeA as a number", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.minFeeA).toBe("number");
  });

  it("returns a ProtocolParameters with minFeeB as a number", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.minFeeB).toBe("number");
  });

  it("returns coinsPerUtxoByte as bigint", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.coinsPerUtxoByte).toBe("bigint");
  });

  it("returns priceMem and priceStep as numbers", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.priceMem).toBe("number");
    expect(typeof params.priceStep).toBe("number");
  });

  it("reads the Ogmios v6 names for the CPU price and the min-UTxO coefficient", async () => {
    // The live Vector Ogmios answer: no `prices` and no `coinsPerUtxoByte`. The
    // values differ from the built-in defaults, so a fallback to them fails.
    const { prices: _prices, coinsPerUtxoByte: _coins, ...rest } = makeOgmiosProtocolParams();
    const live = { ...rest, scriptExecutionPrices: { memory: "600/10000", cpu: "800/10000000" }, minUtxoDepositCoefficient: 4400 };
    mockFetch.mockResolvedValueOnce(rpcOk(live));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(params.priceMem).toBeCloseTo(0.06, 12);
    expect(params.priceStep).toBeCloseTo(0.00008, 12);
    expect(params.coinsPerUtxoByte).toBe(4400n);
  });

  it("returns maxTxSize as a number", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.maxTxSize).toBe("number");
  });

  it("returns costModels as a non-null object", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(params.costModels).toBeDefined();
    expect(typeof params.costModels).toBe("object");
  });

  it("throws on HTTP 5xx", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep: instantSleep });

    await expect(provider.getProtocolParameters()).rejects.toThrow("Ogmios HTTP error: 500 Internal Server Error");
  });
});

// ─── B. getUtxos(address) ─────────────────────────────────────────────────────

describe("OgmiosLucidProvider — getUtxos(address)", () => {
  it("posts queryLedgerState/utxo with addresses param", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.getUtxos(DUMMY_ADDRESS).catch(() => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("queryLedgerState/utxo");
    expect(JSON.stringify(body.params)).toContain(DUMMY_ADDRESS);
  });

  it("returns empty array when no UTxOs at address", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(result).toEqual([]);
  });

  it("returns UTxO array with txHash as string", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(result).toHaveLength(1);
    expect(result[0].txHash).toBe(DUMMY_TX_HASH);
  });

  it("returns UTxO with outputIndex as number", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 2)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(result[0].outputIndex).toBe(2);
  });

  it("returns UTxO with assets.lovelace as bigint", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0, 3_000_000)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(typeof result[0].assets.lovelace).toBe("bigint");
    expect(result[0].assets.lovelace).toBe(3_000_000n);
  });

  it("returns UTxO with address matching the queried address", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(result[0].address).toBe(DUMMY_ADDRESS);
  });
});

// ─── C. getUtxosByOutRef ──────────────────────────────────────────────────────

describe("OgmiosLucidProvider — getUtxosByOutRef()", () => {
  it("posts queryLedgerState/utxo with outputReferences param", async () => {
    const ref = { txHash: DUMMY_TX_HASH, outputIndex: 0 };
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.getUtxosByOutRef([ref]).catch(() => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("queryLedgerState/utxo");
    expect(JSON.stringify(body.params)).toContain(DUMMY_TX_HASH);
  });

  it("returns empty array when outRef not on chain", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxosByOutRef([{ txHash: DUMMY_TX_HASH, outputIndex: 0 }]);

    expect(result).toEqual([]);
  });

  it("returns the matching UTxO when found", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 1)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxosByOutRef([{ txHash: DUMMY_TX_HASH, outputIndex: 1 }]);

    expect(result).toHaveLength(1);
    expect(result[0].outputIndex).toBe(1);
  });
});

// ─── D. submitTx ──────────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — submitTx()", () => {
  it("posts submitTransaction with the cbor in params", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.submitTx(DUMMY_TX_CBOR).catch(() => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("submitTransaction");
    expect(JSON.stringify(body.params)).toContain(DUMMY_TX_CBOR);
  });

  it("returns the txHash from result.transaction.id", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const hash = await provider.submitTx(DUMMY_TX_CBOR);

    expect(hash).toBe(DUMMY_TX_HASH);
  });

  it("throws on Ogmios JSON-RPC error (invalid transaction)", async () => {
    mockFetch.mockResolvedValueOnce(rpcError(3005, "Invalid transaction"));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.submitTx(DUMMY_TX_CBOR)).rejects.toThrow();
  });

  it("throws on HTTP 503", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.submitTx(DUMMY_TX_CBOR)).rejects.toThrow();
  });
});

// ─── E. awaitTx ───────────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — awaitTx()", () => {
  it("returns true when UTxO with matching txHash found on first poll", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.awaitTx(DUMMY_TX_HASH, 500);

    expect(result).toBe(true);
  });

  it("polls queryLedgerState/utxo with the txHash as outputReference", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.awaitTx(DUMMY_TX_HASH, 500).catch(() => {});

    if (mockFetch.mock.calls.length > 0) {
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.method).toBe("queryLedgerState/utxo");
      expect(JSON.stringify(body.params)).toContain(DUMMY_TX_HASH);
    } else {
      // RED: stub didn't reach fetch
      expect(mockFetch).toHaveBeenCalled();
    }
  });
});

// ─── F. getDatum ───────────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — getDatum()", () => {
  it("throws when datum hash cannot be resolved (no inline datum lookup)", async () => {
    // getDatum is rarely called by lucid; we stub it to throw a descriptive error
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(
      provider.getDatum("a".repeat(64)),
    ).rejects.toThrow();
  });
});

// ─── G. Stubbed methods ────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — stubbed methods (NotSupportedInM1F4Error)", () => {
  it("getDelegation throws NotSupportedInM1F4Error", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(
      provider.getDelegation("stake_test1up8r5n4v2cqk3c2fqmwepn98a2w0u6fyc8xvzy8qejnkj8sg0wfzv"),
    ).rejects.toThrow(NotSupportedInM1F4Error);
  });

  it("getUtxosWithUnit throws NotSupportedInM1F4Error", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(
      provider.getUtxosWithUnit(DUMMY_ADDRESS, "lovelace"),
    ).rejects.toThrow(NotSupportedInM1F4Error);
  });

  it("getUtxoByUnit throws NotSupportedInM1F4Error", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(
      provider.getUtxoByUnit("policy.asset"),
    ).rejects.toThrow(NotSupportedInM1F4Error);
  });
});

// ─── H. Adversarial ──────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — adversarial responses", () => {
  it("getProtocolParameters throws on malformed (null) response body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0" }),  // no result
    });
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.getProtocolParameters()).rejects.toThrow();
  });

  it("getUtxos throws on JSON-RPC error response", async () => {
    mockFetch.mockResolvedValueOnce(rpcError(3001, "queryLedgerState error"));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.getUtxos(DUMMY_ADDRESS)).rejects.toThrow();
  });

  it("submitTx throws on malformed result (missing transaction.id)", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: {} }));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.submitTx(DUMMY_TX_CBOR)).rejects.toThrow();
  });
});

// ─── I. Retry of a read request after a transient error ───────────────────────
//
// Every read request (UTxO queries, protocol parameters, evaluateTransaction, the
// awaitTx poll) goes through the rule of packages/shared/src/chain/ogmiosRetry.ts:
// at most 3 tries, a wait of 300 ms and then 1,000 ms, only for an HTTP status of
// 500 or higher or a network error, never after a timeout or an abort. After the
// last try the error is the same as before. submitTransaction is NEVER tried again.

const HTTP_500 = { ok: false, status: 500, statusText: "Internal Server Error" };
const HTTP_502 = { ok: false, status: 502, statusText: "Bad Gateway" };

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

describe("OgmiosLucidProvider — a read request is tried again after a transient error", () => {
  // The URL holds a credential in the path: no warn line may show it.
  const CREDENTIAL_URL = "https://ogmios.example/secret-key-123";
  const sleep = vi.fn(async (_ms: number): Promise<void> => {});
  let warn: MockInstance<typeof console.warn>;

  function makeProvider(extra: { timeoutMs?: number } = {}) {
    return new OgmiosLucidProvider({ ogmiosUrl: CREDENTIAL_URL, fetch: mockFetch, sleep, ...extra });
  }

  beforeEach(() => {
    sleep.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("getProtocolParameters()", () => {
    const METHOD = "queryLedgerState/protocolParameters";

    it("returns the answer of try 2 after one HTTP 500: 2 calls, 1 warn line", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));

      const params = await makeProvider().getProtocolParameters();

      expect(params.minFeeA).toBe(44);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([[`[ogmios] retry 1/2 method=${METHOD} cause=500`]]);
      expect(sleep.mock.calls).toEqual([[300]]);
    });

    it("returns the answer of try 3 after HTTP 500 and HTTP 502: 3 calls, 2 warn lines, waits 300 ms and 1,000 ms", async () => {
      mockFetch
        .mockResolvedValueOnce(HTTP_500)
        .mockResolvedValueOnce(HTTP_502)
        .mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));

      await makeProvider().getProtocolParameters();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls).toEqual([
        [`[ogmios] retry 1/2 method=${METHOD} cause=500`],
        [`[ogmios] retry 2/2 method=${METHOD} cause=502`],
      ]);
      expect(sleep.mock.calls).toEqual([[300], [1000]]);
    });

    it("throws the same error as before after three HTTP 500: 3 calls", async () => {
      mockFetch.mockResolvedValue(HTTP_500);

      const error = await makeProvider().getProtocolParameters().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).constructor).toBe(Error);
      expect((error as Error).message).toBe("Ogmios HTTP error: 500 Internal Server Error");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("returns the answer of try 2 after one network error", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));

      await expect(makeProvider().getProtocolParameters()).resolves.toMatchObject({ minFeeA: 44 });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([[`[ogmios] retry 1/2 method=${METHOD} cause=TypeError`]]);
    });

    it("throws the error object of the last try after three network errors", async () => {
      const errors = [1, 2, 3].map((n) => new TypeError(`fetch failed ${n}`));
      for (const error of errors) mockFetch.mockRejectedValueOnce(error);

      await expect(makeProvider().getProtocolParameters()).rejects.toBe(errors[2]);

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("does not try an HTTP 400 with a JSON-RPC error body again, and keeps the thrown text", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } }),
      });

      await expect(makeProvider().getProtocolParameters()).rejects.toThrow(
        new Error("Ogmios HTTP error: 400 Bad Request"),
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not try again after HTTP 200 with a JSON-RPC error, and keeps the thrown text", async () => {
      mockFetch.mockResolvedValue(rpcError(3001, "queryLedgerState error"));

      await expect(makeProvider().getProtocolParameters()).rejects.toThrow(
        new Error(`Ogmios RPC error (${METHOD}): queryLedgerState error`),
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not try again after HTTP 200 with no result", async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ jsonrpc: "2.0" }) });

      await expect(makeProvider().getProtocolParameters()).rejects.toThrow(
        new Error(`Ogmios RPC response missing 'result' (method=${METHOD})`),
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not try again after HTTP 200 with a malformed body", async () => {
      const malformed = new SyntaxError("Unexpected token < in JSON at position 0");
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(malformed) });

      await expect(makeProvider().getProtocolParameters()).rejects.toBe(malformed);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ["a TimeoutError", timeoutError],
      ["an AbortError", abortError],
    ])("does not try again after %s on try 1", async (_label, make) => {
      const error = make();
      mockFetch.mockRejectedValue(error);

      await expect(makeProvider().getProtocolParameters()).rejects.toBe(error);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("sends the same request body on each try", async () => {
      mockFetch
        .mockResolvedValueOnce(HTTP_500)
        .mockResolvedValueOnce(HTTP_502)
        .mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));

      await makeProvider().getProtocolParameters();

      const bodies = mockFetch.mock.calls.map((call) => call[1].body);
      expect(typeof bodies[0]).toBe("string");
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0]).method).toBe(METHOD);
    });

    it("gives each try its own timeout signal, with the timeout of the provider", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));

      await makeProvider({ timeoutMs: 1234 }).getProtocolParameters();

      expect(timeout.mock.calls).toEqual([[1234], [1234]]);
      const [first, second] = mockFetch.mock.calls.map((call) => call[1].signal as AbortSignal);
      expect(first).not.toBe(second);
    });

    it("writes warn lines that hold no URL, body or params", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(HTTP_502).mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));

      await makeProvider().getProtocolParameters();

      const written = JSON.stringify(warn.mock.calls);
      expect(written).not.toContain("secret-key-123");
      expect(written).not.toContain("ogmios.example");
      expect(written).not.toContain("jsonrpc");
    });
  });

  describe("getUtxos() and getUtxosByOutRef()", () => {
    it("getUtxos returns the answer of try 3 after HTTP 500 and a network error", async () => {
      mockFetch
        .mockResolvedValueOnce(HTTP_500)
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));

      const result = await makeProvider().getUtxos(DUMMY_ADDRESS);

      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe(DUMMY_TX_HASH);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls).toEqual([
        ["[ogmios] retry 1/2 method=queryLedgerState/utxo cause=500"],
        ["[ogmios] retry 2/2 method=queryLedgerState/utxo cause=TypeError"],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(DUMMY_ADDRESS);
    });

    it("getUtxosByOutRef returns the answer of try 2 after one HTTP 502", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_502).mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 1)]));

      const result = await makeProvider().getUtxosByOutRef([{ txHash: DUMMY_TX_HASH, outputIndex: 1 }]);

      expect(result).toHaveLength(1);
      expect(result[0].outputIndex).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("getUtxos does not try an HTTP 404 again", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });

      await expect(makeProvider().getUtxos(DUMMY_ADDRESS)).rejects.toThrow(new Error("Ogmios HTTP error: 404 Not Found"));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("evaluateTx()", () => {
    const evaluated = () => rpcOk([{ validator: { purpose: "spend", index: 0 }, budget: { memory: 5000, cpu: 10000 } }]);

    it("returns the answer of try 2 after one HTTP 500: 2 calls", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(evaluated());

      const result = await makeProvider().evaluateTx(DUMMY_TX_CBOR);

      expect(result).toEqual([{ redeemer_tag: "spend", redeemer_index: 0, ex_units: { mem: 5000, steps: 10000 } }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([["[ogmios] retry 1/2 method=evaluateTransaction cause=500"]]);
      expect(sleep.mock.calls).toEqual([[300]]);
    });

    it("returns the answer of try 2 after one network error", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(evaluated());

      await expect(makeProvider().evaluateTx(DUMMY_TX_CBOR)).resolves.toHaveLength(1);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("sends the same body on each try", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(HTTP_502).mockResolvedValueOnce(evaluated());

      await makeProvider().evaluateTx(DUMMY_TX_CBOR);

      const bodies = mockFetch.mock.calls.map((call) => call[1].body);
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0]).method).toBe("evaluateTransaction");
    });

    it("throws the same error as before after three HTTP 500: 3 calls", async () => {
      mockFetch.mockResolvedValue(HTTP_500);

      await expect(makeProvider().evaluateTx(DUMMY_TX_CBOR)).rejects.toThrow(
        new Error("Ogmios HTTP error: 500 Internal Server Error"),
      );

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("does not try an HTTP 400 again", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request" });

      await expect(makeProvider().evaluateTx(DUMMY_TX_CBOR)).rejects.toThrow(new Error("Ogmios HTTP error: 400 Bad Request"));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not try again after HTTP 200 with a JSON-RPC error, and keeps the thrown text", async () => {
      mockFetch.mockResolvedValue(rpcError(3010, "Script execution failure"));

      await expect(makeProvider().evaluateTx(DUMMY_TX_CBOR)).rejects.toThrow(
        new Error("Ogmios evaluate error: Script execution failure"),
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not try again after a timeout", async () => {
      const error = timeoutError();
      mockFetch.mockRejectedValue(error);

      await expect(makeProvider().evaluateTx(DUMMY_TX_CBOR)).rejects.toBe(error);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("awaitTx()", () => {
    it("tries the poll again inside the read call: HTTP 500, then the transaction is found", async () => {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));

      await expect(makeProvider().awaitTx(DUMMY_TX_HASH, 500)).resolves.toBe(true);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([["[ogmios] retry 1/2 method=queryLedgerState/utxo cause=500"]]);
      expect(sleep.mock.calls).toEqual([[300]]);
    });
  });
});

describe("OgmiosLucidProvider — submitTx() is never tried again", () => {
  // A submit that got no clear answer may be on chain: one try, whatever the error.
  const sleep = vi.fn(async (_ms: number): Promise<void> => {});
  let warn: MockInstance<typeof console.warn>;

  function makeProvider() {
    return new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep });
  }

  /** One try only: no call to fetch after the first, nothing waited, nothing written. */
  function expectOneTryOnly() {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    sleep.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("makes one call after HTTP 500, and throws the same error as before", async () => {
    mockFetch.mockResolvedValue(HTTP_500);

    await expect(makeProvider().submitTx(DUMMY_TX_CBOR)).rejects.toThrow(
      new Error("Ogmios HTTP error: 500 Internal Server Error"),
    );

    expectOneTryOnly();
  });

  it.each([502, 503, 504, 522, 524])("makes one call after HTTP %i", async (status) => {
    mockFetch.mockResolvedValue({ ok: false, status, statusText: "x" });

    await expect(makeProvider().submitTx(DUMMY_TX_CBOR)).rejects.toThrow(new Error(`Ogmios HTTP error: ${status} x`));

    expectOneTryOnly();
  });

  it("makes one call after a network error, and throws that error", async () => {
    const error = new TypeError("fetch failed");
    mockFetch.mockRejectedValue(error);

    await expect(makeProvider().submitTx(DUMMY_TX_CBOR)).rejects.toBe(error);

    expectOneTryOnly();
  });

  it.each([
    ["a TimeoutError", timeoutError],
    ["an AbortError", abortError],
  ])("makes one call after %s, and throws that error", async (_label, make) => {
    const error = make();
    mockFetch.mockRejectedValue(error);

    await expect(makeProvider().submitTx(DUMMY_TX_CBOR)).rejects.toBe(error);

    expectOneTryOnly();
  });

  it("makes one call after HTTP 200 with a JSON-RPC error, and throws the same error as before", async () => {
    mockFetch.mockResolvedValue(rpcError(3005, "Invalid transaction"));

    await expect(makeProvider().submitTx(DUMMY_TX_CBOR)).rejects.toThrow(
      new Error("Ogmios submit error: Invalid transaction"),
    );

    expectOneTryOnly();
  });
});
