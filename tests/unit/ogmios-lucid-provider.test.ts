/**
 * ogmios-lucid-provider.test.ts — OgmiosLucidProvider
 *
 * OgmiosLucidProvider gives lucid-evolution its Provider interface with Ogmios JSON-RPC calls (no Kupo) and maps the answers to the
 * shapes that lucid expects. A read request goes through fetchOgmiosRead, which holds the retry rule once; the rule itself is tested in
 * read-only-ogmios-provider.test.ts. This file tests:
 *   A. The reads: the request, the mapped answer, and that each read method reaches fetchOgmiosRead.
 *   B. A call that gets no result: the text of each error.
 *   C. submitTx(): its own code. Success, request shape, and exactly one try for every error.
 *   D. The methods that are stubs.
 *
 * All network calls are mocked via injected fetch. No real Ogmios.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import {
  OgmiosLucidProvider,
  NotSupportedInM1F4Error,
} from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import { makeOgmiosProtocolParams } from "../fixtures/chain-codec/ogmios-protocol-parameters.js";
import {
  HTTP_500,
  OGMIOS_TEST_ADDRESS,
  instantSleep,
  makeOgmiosUtxo,
  rpcError,
  rpcOk,
  timeoutError,
} from "../fixtures/chain-codec/ogmios-http.js";

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
const ADDRESS = OGMIOS_TEST_ADDRESS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeProvider() {
  return new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });
}

// ─── A. The reads: the request, the mapped answer, the retry wiring ────────────

/**
 * Ogmios protocol parameters with a value that differs from the built-in default of each field. A mapping that falls back to its
 * defaults does not give the values of NODE_PARAMETERS.
 */
const NODE_PARAMS = {
  ...makeOgmiosProtocolParams(),
  minFeeCoefficient: 47,
  minFeeConstant: { ada: { lovelace: 155_400 } },
  maxTransactionSize: { bytes: 16_500 },
  maxValueSize: { bytes: 5_100 },
  stakeCredentialDeposit: { ada: { lovelace: 2_100_000 } },
  stakePoolDeposit: { ada: { lovelace: 510_000_000 } },
  delegateRepresentativeDeposit: { ada: { lovelace: 520_000_000 } },
  governanceActionDeposit: { ada: { lovelace: 110_000_000_000 } },
  prices: { memory: "0.0600", steps: "0.0000800" },
  maxExecutionUnitsPerTransaction: { memory: 14_100_000, cpu: 10_100_000_000 },
  coinsPerUtxoByte: { ada: { lovelace: 4_400 } },
  collateralPercentage: 160,
  maxCollateralInputs: 4,
};

const NODE_PARAMETERS = {
  minFeeA: 47,
  minFeeB: 155_400,
  maxTxSize: 16_500,
  maxValSize: 5_100,
  keyDeposit: 2_100_000n,
  poolDeposit: 510_000_000n,
  drepDeposit: 520_000_000n,
  govActionDeposit: 110_000_000_000n,
  priceMem: 0.06,
  priceStep: 0.00008,
  maxTxExMem: 14_100_000n,
  maxTxExSteps: 10_100_000_000n,
  coinsPerUtxoByte: 4_400n,
  collateralPercentage: 160,
  maxCollateralInputs: 4,
  minFeeRefScriptCostPerByte: 15,
  costModels: { PlutusV1: {}, PlutusV2: {}, PlutusV3: {} },
};

const OUT_REF = { txHash: DUMMY_TX_HASH, outputIndex: 1 };
/** The Lucid UTxO that the provider builds from `makeOgmiosUtxo(DUMMY_TX_HASH, 1, 5_000_000)`. */
const LUCID_UTXO = {
  txHash: DUMMY_TX_HASH,
  outputIndex: 1,
  address: ADDRESS,
  assets: { lovelace: 5_000_000n },
  datumHash: null,
  datum: null,
  scriptRef: null,
};
const OUTPUT = makeOgmiosUtxo(DUMMY_TX_HASH, 1, 5_000_000);
const OUT_REF_PARAMS = { outputReferences: [{ transaction: { id: DUMMY_TX_HASH }, index: 1 }] };

interface ReadCase {
  name: string;
  call: (provider: OgmiosLucidProvider) => Promise<unknown>;
  /** The JSON-RPC request that the call sends. */
  method: string;
  params?: unknown;
  /** The `result` of the Ogmios answer, and the value that the call returns for it. */
  answer: unknown;
  value: unknown;
}

const READS: ReadCase[] = [
  {
    name: "getProtocolParameters",
    call: (provider) => provider.getProtocolParameters(),
    method: "queryLedgerState/protocolParameters",
    answer: NODE_PARAMS,
    value: NODE_PARAMETERS,
  },
  {
    name: "getUtxos",
    call: (provider) => provider.getUtxos(ADDRESS),
    method: "queryLedgerState/utxo",
    params: { addresses: [ADDRESS] },
    answer: [OUTPUT],
    value: [LUCID_UTXO],
  },
  {
    name: "getUtxosByOutRef",
    call: (provider) => provider.getUtxosByOutRef([OUT_REF]),
    method: "queryLedgerState/utxo",
    params: OUT_REF_PARAMS,
    answer: [OUTPUT],
    value: [LUCID_UTXO],
  },
  {
    name: "evaluateTx",
    call: (provider) => provider.evaluateTx(DUMMY_TX_CBOR),
    method: "evaluateTransaction",
    params: { transaction: { cbor: DUMMY_TX_CBOR } },
    answer: [{ validator: { purpose: "spend", index: 0 }, budget: { memory: 5000, cpu: 10000 } }],
    value: [{ redeemer_tag: "spend", redeemer_index: 0, ex_units: { mem: 5000, steps: 10000 } }],
  },
  {
    // The poll asks for output 0 of the transaction and is true when any output of the transaction comes back.
    name: "awaitTx",
    call: (provider) => provider.awaitTx(DUMMY_TX_HASH, 500),
    method: "queryLedgerState/utxo",
    params: { outputReferences: [{ transaction: { id: DUMMY_TX_HASH }, index: 0 }] },
    answer: [makeOgmiosUtxo(DUMMY_TX_HASH, 0)],
    value: true,
  },
];

describe("OgmiosLucidProvider — the reads", () => {
  it.each(READS)("$name posts its JSON-RPC request and returns the mapped answer", async ({ call, method, params, answer, value }) => {
    mockFetch.mockResolvedValueOnce(rpcOk(answer));

    await expect(call(makeProvider())).resolves.toEqual(value);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(TEST_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ jsonrpc: "2.0", method, params, id: expect.stringMatching(UUID) });
  });

  // Each method reaches fetchOgmiosRead with its own method name, its timeout and its sleep. The rule itself is tested in
  // read-only-ogmios-provider.test.ts.
  it.each(READS)("$name returns the answer of try 2 after one HTTP 500", async ({ call, method, answer, value }) => {
    const sleep = vi.fn(instantSleep);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(rpcOk(answer));

    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep, timeoutMs: 1234 });
    await expect(call(provider)).resolves.toEqual(value);

    expect(warn.mock.calls).toEqual([[`[ogmios] retry 1/2 method=${method} cause=500`]]);
    expect(sleep.mock.calls).toEqual([[300]]);
    expect(timeout.mock.calls).toEqual([[1234], [1234]]);
  });

  it("returns [] for an address and for references that the node does not list", async () => {
    mockFetch.mockResolvedValue(rpcOk([]));
    const provider = makeProvider();

    await expect(provider.getUtxos(ADDRESS)).resolves.toEqual([]);
    await expect(provider.getUtxosByOutRef([OUT_REF])).resolves.toEqual([]);
  });

  // A real Ogmios gives a list. For any other result the provider gives one default spend budget, so that lucid sets the ex-units of
  // the spend (OgmiosLucidProvider.evaluateTx, the fallback after the list case). Before, a diagnostic test reached this code by chance.
  it("evaluateTx returns one default spend budget when the result is not a list", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({}));

    await expect(makeProvider().evaluateTx(DUMMY_TX_CBOR)).resolves.toEqual([
      { redeemer_tag: "spend", redeemer_index: 0, ex_units: { mem: 1_000_000, steps: 500_000_000 } },
    ]);
  });

  // The live Vector Ogmios answer uses the Ogmios v6 names for two parameters (commit d786fff).
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
});

// ─── B. A call that gets no result ─────────────────────────────────────────────

describe("OgmiosLucidProvider — a call that gets no result throws", () => {
  const UTXO_METHOD = "queryLedgerState/utxo";
  const getProtocolParameters = (provider: OgmiosLucidProvider) => provider.getProtocolParameters();

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // No read method turns such an answer into [] (a caller reads "absent" as "spent"): each throws a plain Error with the text of its
  // last answer, the text that the callers saw before the retry existed (commit 3259ca9).
  it.each([
    {
      name: "getProtocolParameters() after HTTP 400 with a JSON-RPC error body",
      call: getProtocolParameters,
      answer: {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } }),
      },
      message: "Ogmios HTTP error: 400 Bad Request",
      calls: 1,
    },
    {
      name: "getUtxos() after HTTP 200 with a JSON-RPC error",
      call: (provider: OgmiosLucidProvider) => provider.getUtxos(ADDRESS),
      answer: rpcError(3001, "queryLedgerState error"),
      message: `Ogmios RPC error (${UTXO_METHOD}): queryLedgerState error`,
      calls: 1,
    },
    {
      name: "getUtxosByOutRef() after HTTP 200 with no result",
      call: (provider: OgmiosLucidProvider) => provider.getUtxosByOutRef([OUT_REF]),
      answer: { ok: true, json: async () => ({ jsonrpc: "2.0" }) },
      message: `Ogmios RPC response missing 'result' (method=${UTXO_METHOD})`,
      calls: 1,
    },
    {
      name: "evaluateTx() after HTTP 400",
      call: (provider: OgmiosLucidProvider) => provider.evaluateTx(DUMMY_TX_CBOR),
      answer: { ok: false, status: 400, statusText: "Bad Request" },
      message: "Ogmios HTTP error: 400 Bad Request",
      calls: 1,
    },
    {
      name: "evaluateTx() after HTTP 200 with a JSON-RPC error",
      call: (provider: OgmiosLucidProvider) => provider.evaluateTx(DUMMY_TX_CBOR),
      answer: rpcError(3010, "Script execution failure"),
      message: "Ogmios evaluate error: Script execution failure",
      calls: 1,
    },
    {
      name: "getProtocolParameters() after HTTP 500 on all 3 tries",
      call: getProtocolParameters,
      answer: HTTP_500,
      message: "Ogmios HTTP error: 500 Internal Server Error",
      calls: 3,
    },
  ])("$name: the text of the answer, after $calls call(s)", async ({ call, answer, message, calls }) => {
    mockFetch.mockResolvedValue(answer);

    const error = await call(new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep: instantSleep })).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor).toBe(Error);
    expect((error as Error).message).toBe(message);
    expect(mockFetch).toHaveBeenCalledTimes(calls);
  });

  const notJson = new SyntaxError("Unexpected token < in JSON at position 0");
  const timeout = timeoutError();

  it.each([
    {
      name: "getProtocolParameters() on a body that is not JSON",
      call: getProtocolParameters,
      fail: () => mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(notJson) }),
      error: notJson,
    },
    {
      name: "getUtxosByOutRef() on a timeout of fetch",
      call: (provider: OgmiosLucidProvider) => provider.getUtxosByOutRef([OUT_REF]),
      fail: () => mockFetch.mockRejectedValue(timeout),
      error: timeout,
    },
    {
      name: "evaluateTx() on a timeout of fetch",
      call: (provider: OgmiosLucidProvider) => provider.evaluateTx(DUMMY_TX_CBOR),
      fail: () => mockFetch.mockRejectedValue(timeout),
      error: timeout,
    },
  ])("$name: the very error, after 1 call", async ({ call, fail, error }) => {
    fail();

    await expect(call(new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep: instantSleep }))).rejects.toBe(error);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── C. submitTx() ─────────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — submitTx()", () => {
  it("posts submitTransaction with the cbor and a UUID id, and returns result.transaction.id", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));

    await expect(makeProvider().submitTx(DUMMY_TX_CBOR)).resolves.toBe(DUMMY_TX_HASH);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(TEST_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      jsonrpc: "2.0",
      method: "submitTransaction",
      params: { transaction: { cbor: DUMMY_TX_CBOR } },
      id: expect.stringMatching(UUID),
    });
  });

  it("throws on a result without transaction.id", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: {} }));

    await expect(makeProvider().submitTx(DUMMY_TX_CBOR)).rejects.toThrow(
      new Error('Ogmios submit malformed response: missing result.transaction.id (got {"transaction":{}})'),
    );
  });
});

describe("OgmiosLucidProvider — submitTx() makes one call, whatever the error", () => {
  // A submit that got no clear answer may be on chain. A second submit of the same transaction fails with a misleading error, and the
  // caller would treat a transaction that is on chain as failed. So submitTx never tries again (commit 3259ca9).
  const sleep = vi.fn(instantSleep);
  let warn: MockInstance<typeof console.warn>;

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
    ["HTTP 500", HTTP_500, "Ogmios HTTP error: 500 Internal Server Error"],
    ["a JSON-RPC error in HTTP 200", rpcError(3005, "Invalid transaction"), "Ogmios submit error: Invalid transaction"],
  ])("after %s, throws the same error as before", async (_label, answer, message) => {
    mockFetch.mockResolvedValue(answer);

    await expect(
      new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep }).submitTx(DUMMY_TX_CBOR),
    ).rejects.toThrow(new Error(message));

    expectOneTryOnly();
  });

  it.each([
    ["a network error", new TypeError("fetch failed")],
    ["a TimeoutError", timeoutError()],
  ])("after %s, throws that error", async (_label, error) => {
    mockFetch.mockRejectedValue(error);

    await expect(
      new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep }).submitTx(DUMMY_TX_CBOR),
    ).rejects.toBe(error);

    expectOneTryOnly();
  });
});

// ─── D. The methods that are stubs ─────────────────────────────────────────────

describe("OgmiosLucidProvider — the stubs throw NotSupportedInM1F4Error", () => {
  it.each([
    ["getDatum", (provider: OgmiosLucidProvider) => provider.getDatum("a".repeat(64))],
    [
      "getDelegation",
      (provider: OgmiosLucidProvider) => provider.getDelegation("stake_test1up8r5n4v2cqk3c2fqmwepn98a2w0u6fyc8xvzy8qejnkj8sg0wfzv"),
    ],
    ["getUtxosWithUnit", (provider: OgmiosLucidProvider) => provider.getUtxosWithUnit(ADDRESS, "lovelace")],
    ["getUtxoByUnit", (provider: OgmiosLucidProvider) => provider.getUtxoByUnit("policy.asset")],
  ])("%s", async (_method, call) => {
    await expect(call(makeProvider())).rejects.toThrow(NotSupportedInM1F4Error);
  });
});
