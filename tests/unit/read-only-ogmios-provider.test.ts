/**
 * read-only-ogmios-provider.test.ts — ReadOnlyOgmiosProvider and fetchOgmiosRead
 *
 * ReadOnlyOgmiosProvider asks Ogmios (JSON-RPC over HTTP POST) for the tip, the UTxOs and the evaluation of a transaction. Its
 * submitTx() and awaitTx() throw NotSupportedError.
 *
 * The retry rule of a read request lives once, in packages/shared/src/chain/ogmiosRetry.ts (`fetchOgmiosRead`). The last section of
 * this file tests the rule there, with one table of tries. The sections before it test that each method of this provider reaches the
 * rule and maps the answer. live-ogmios-provider.test.ts and ogmios-lucid-provider.test.ts test only that their methods reach it too.
 *
 * Mock global.fetch per apex-dashboard ogmios-client.test.ts pattern. NO real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import { NotSupportedError } from "../../packages/shared/src/chain/ChainProvider.js";
import { fetchOgmiosRead } from "../../packages/shared/src/chain/ogmiosRetry.js";
import {
  HTTP_500,
  HTTP_502,
  OGMIOS_TEST_ADDRESS,
  abortError,
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
const REF = { txHash: "c".repeat(64), index: 1 };
const ADDRESS = OGMIOS_TEST_ADDRESS;
const DUMMY_TX = "84a5008182582000".repeat(4);

// ─── The read methods: the request, the mapped answer, the retry wiring ───────

// Ogmios v6 leaves out `datum`, `datumHash` and `script` when an output has none. The provider reads a null the same way.
const OUTPUT = makeOgmiosUtxo(REF.txHash, 1);
const OUTPUT_WITH_NULLS = { ...makeOgmiosUtxo(REF.txHash, 1), datumHash: null, datum: null, script: null };
const OUTPUT_WITH_DATUM = { ...makeOgmiosUtxo("d".repeat(64), 0, 5_000_000), datum: "d87980" };
/** The `Utxo` that the provider builds from OUTPUT, and from OUTPUT_WITH_NULLS. */
const UTXO = { ref: REF, address: ADDRESS, lovelace: 2_000_000n, assets: {}, datumHex: null, scriptRef: null };
const UTXO_WITH_DATUM = {
  ref: { txHash: "d".repeat(64), index: 0 },
  address: ADDRESS,
  lovelace: 5_000_000n,
  assets: {},
  datumHex: "d87980",
  scriptRef: null,
};

interface ReadCase {
  name: string;
  call: (provider: ReadOnlyOgmiosProvider) => Promise<unknown>;
  /** The JSON-RPC request that the call sends. */
  method: string;
  params?: unknown;
  /** The `result` of the Ogmios answer, and the value that the call returns for it. */
  answer: unknown;
  value: unknown;
}

const READS: ReadCase[] = [
  {
    name: "tip",
    call: (provider) => provider.tip(),
    method: "queryNetwork/tip",
    answer: { slot: 12345678, id: "a".repeat(64) },
    value: 12345678,
  },
  {
    name: "queryUtxo",
    call: (provider) => provider.queryUtxo(REF),
    method: "queryLedgerState/utxo",
    params: { outputReferences: [{ transaction: { id: REF.txHash }, index: 1 }] },
    answer: [OUTPUT_WITH_NULLS],
    value: UTXO,
  },
  {
    name: "queryUtxosByAddress",
    call: (provider) => provider.queryUtxosByAddress(ADDRESS),
    method: "queryLedgerState/utxo",
    params: { addresses: [ADDRESS] },
    answer: [OUTPUT, OUTPUT_WITH_DATUM],
    value: [UTXO, UTXO_WITH_DATUM],
  },
  {
    name: "evaluateTx",
    call: (provider) => provider.evaluateTx(DUMMY_TX),
    method: "evaluateTransaction",
    params: { transaction: { cbor: DUMMY_TX } },
    answer: [{ validator: "escrow", budget: { memory: 5000, cpu: 10000 } }],
    value: { ok: true, cost: { memory: 5000, steps: 10000 } },
  },
];

describe("ReadOnlyOgmiosProvider — the read methods", () => {
  it.each(READS)("$name posts its JSON-RPC request and returns the mapped answer", async ({ call, method, params, answer, value }) => {
    mockFetch.mockResolvedValueOnce(rpcOk(answer));

    await expect(call(new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL }))).resolves.toEqual(value);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(TEST_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ jsonrpc: "2.0", method, params, id: 1 });
  });

  // Each method reaches fetchOgmiosRead with its own JSON-RPC method, its timeout and its sleep. The rule itself is tested at the end.
  it.each(READS)("$name returns the answer of try 2 after one HTTP 500", async ({ call, method, answer, value }) => {
    const sleep = vi.fn(instantSleep);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(rpcOk(answer));

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch, sleep, timeoutMs: 1234 });
    await expect(call(provider)).resolves.toEqual(value);

    expect(warn.mock.calls).toEqual([[`[ogmios] retry 1/2 method=${method} cause=500`]]);
    expect(sleep.mock.calls).toEqual([[300]]);
    expect(timeout.mock.calls).toEqual([[1234], [1234]]);
  });

  it("returns null for a reference that the node does not list, and [] for an address with no output", async () => {
    mockFetch.mockResolvedValue(rpcOk([]));
    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });

    await expect(provider.queryUtxo(REF)).resolves.toBeNull();
    await expect(provider.queryUtxosByAddress(ADDRESS)).resolves.toEqual([]);
  });

  // Ogmios v6 shape of a reference script; the identity Register reads its reference UTxO through this mapping (commit 3105fa7).
  it.each([
    ["plutus:v3", "5901ab0101002229800aba2aba1", "5901ab0101002229800aba2aba1"],
    ["plutus:v2", "5901ab0101002229800aba2aba1", null],
  ])("maps a %s reference script to scriptRef %s -> %s", async (language, cbor, expected) => {
    mockFetch.mockResolvedValueOnce(rpcOk([{
      transaction: { id: REF.txHash },
      index: 0,
      address: "addr1vyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkdl5mw",
      value: { ada: { lovelace: 59_982_270 } },
      script: { language, cbor },
    }]));

    const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL });
    const result = await provider.queryUtxo(REF);
    expect(result!.scriptRef).toBe(expected);
  });

  it.each([
    ["a budget object", rpcOk({ memory: 1000, steps: 2000 }), { ok: true, cost: { memory: 1000, steps: 2000 } }],
    [
      "a JSON-RPC error (script failure)",
      rpcError(3010, "Script execution failure"),
      { ok: false, error: "code=3010 Script execution failure" },
    ],
  ])("evaluateTx() maps %s and asks once", async (_label, answer, expected) => {
    mockFetch.mockResolvedValue(answer);

    await expect(new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL }).evaluateTx(DUMMY_TX)).resolves.toEqual(expected);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── A call that gets no result ───────────────────────────────────────────────

describe("ReadOnlyOgmiosProvider — a call that gets no result throws", () => {
  const tip = (provider: ReadOnlyOgmiosProvider) => provider.tip();

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // A caller reads "absent" as "spent", so no read method turns such an answer into null or []. Each throws a plain Error with the
  // text of its last answer: the text that the callers saw before the retry existed (commit 3259ca9).
  it.each([
    {
      name: "tip() after HTTP 400 with a JSON-RPC error body",
      call: tip,
      answer: {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: () => Promise.resolve({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } }),
      },
      message: "Ogmios HTTP error: 400 Bad Request",
      calls: 1,
    },
    {
      name: "queryUtxo() after HTTP 200 with a JSON-RPC error",
      call: (provider: ReadOnlyOgmiosProvider) => provider.queryUtxo(REF),
      answer: rpcError(-32600, "Invalid Request"),
      message: "Ogmios RPC error: Invalid Request",
      calls: 1,
    },
    {
      name: "queryUtxosByAddress() after HTTP 200 with no result",
      call: (provider: ReadOnlyOgmiosProvider) => provider.queryUtxosByAddress(ADDRESS),
      answer: { ok: true, json: () => Promise.resolve({ jsonrpc: "2.0" }) },
      message: "Ogmios RPC response missing 'result'",
      calls: 1,
    },
    {
      name: "evaluateTx() after HTTP 400",
      call: (provider: ReadOnlyOgmiosProvider) => provider.evaluateTx(DUMMY_TX),
      answer: { ok: false, status: 400, statusText: "Bad Request" },
      message: "Ogmios HTTP error: 400 Bad Request",
      calls: 1,
    },
    {
      name: "tip() after HTTP 500 on all 3 tries",
      call: tip,
      answer: HTTP_500,
      message: "Ogmios HTTP error: 500 Internal Server Error",
      calls: 3,
    },
  ])("$name: the text of the answer, after $calls call(s)", async ({ call, answer, message, calls }) => {
    mockFetch.mockResolvedValue(answer);

    const error = await call(new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL, sleep: instantSleep })).then(
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
      name: "tip() on a body that is not JSON",
      call: tip,
      fail: () => mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(notJson) }),
      error: notJson,
    },
    {
      name: "tip() on a timeout of fetch",
      call: tip,
      fail: () => mockFetch.mockRejectedValue(timeout),
      error: timeout,
    },
    {
      name: "evaluateTx() on a timeout of fetch",
      call: (provider: ReadOnlyOgmiosProvider) => provider.evaluateTx(DUMMY_TX),
      fail: () => mockFetch.mockRejectedValue(timeout),
      error: timeout,
    },
  ])("$name: the very error, after 1 call", async ({ call, fail, error }) => {
    fail();

    await expect(call(new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL, sleep: instantSleep }))).rejects.toBe(error);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── submitTx() and awaitTx() throw NotSupportedError ─────────────────────────

describe("ReadOnlyOgmiosProvider — submitTx() and awaitTx() are not supported", () => {
  it.each([
    ["submitTx", (provider: ReadOnlyOgmiosProvider) => provider.submitTx("deadbeef")],
    ["awaitTx", (provider: ReadOnlyOgmiosProvider) => provider.awaitTx("a".repeat(64), 1000)],
  ])("%s throws NotSupportedError and does not call fetch", async (op, call) => {
    const error = await call(new ReadOnlyOgmiosProvider({ ogmiosUrl: TEST_URL })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as NotSupportedError).op).toBe(op);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── fetchOgmiosRead: the retry rule of a read request ────────────────────────
//
// The rule (packages/shared/src/chain/ogmiosRetry.ts): a request whose JSON-RPC method is not submitTransaction has at most 3 tries,
// with a wait of 300 ms and then 1,000 ms. The next try starts after an HTTP status of 500 or higher, or a network error. These end
// the call: an HTTP status below 500 (an HTTP 200 with a JSON-RPC error or a bad body is such an answer: the caller reads the body),
// a timeout, an abort. After the last try the call returns the last answer or throws the last error, so that the caller reports what
// it reported before the retry existed. A submitTransaction request has exactly one try. Commit 3259ca9.

describe("fetchOgmiosRead — the retry rule", () => {
  // The URL holds a credential in the path: no warn line may show it.
  const CREDENTIAL_URL = "https://ogmios.example/secret-key-123";
  const METHOD = "queryNetwork/tip";
  const BODY = JSON.stringify({ jsonrpc: "2.0", method: METHOD, id: 1 });
  const WAITS = [300, 1000];
  const sleep = vi.fn(instantSleep);
  let warn: MockInstance<typeof console.warn>;

  function read(method = METHOD, timeoutMs = 1000) {
    return fetchOgmiosRead({ fetch: mockFetch, url: CREDENTIAL_URL, method, body: BODY, timeoutMs, sleep });
  }

  beforeEach(() => {
    sleep.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  /**
   * Replaces AbortSignal.timeout so that each try gets a signal that a test fires by hand: no real timer and no real wait. Returns
   * the controller of each try (in the order of the tries) and the spy.
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

  const OK = { ok: true, status: 200, statusText: "OK" };
  // An HTTP 200 answer is returned at once, whatever its body: the caller reads the body, so the rule never sees a JSON-RPC error.
  const OK_WITH_BAD_BODY = { ...OK, json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON at position 0")) };
  const HTTP_499 = { ok: false, status: 499, statusText: "Client Closed Request" };
  const HTTP_599 = { ok: false, status: 599, statusText: "Network Connect Timeout" };
  const networkErrors = [1, 2, 3].map((n) => new TypeError(`fetch failed ${n}`));
  const timeout = timeoutError();
  const abort = abortError();

  interface Tries {
    title: string;
    method?: string;
    /** What `fetch` does on each try, in order: an Error is thrown, any other value is the answer. */
    answers: object[];
    /** The call returns this very answer, or throws this very error. */
    returns?: object;
    throws?: object;
    /** The cause in the warn line of each new try. The call makes `causes.length + 1` tries and waits before each new one. */
    causes: string[];
  }

  const TRIES: Tries[] = [
    { title: "HTTP 500, then an answer", answers: [HTTP_500, OK], returns: OK, causes: ["500"] },
    { title: "HTTP 500, HTTP 502, then an answer", answers: [HTTP_500, HTTP_502, OK], returns: OK, causes: ["500", "502"] },
    {
      title: "HTTP 500 on all 3 tries: returns the last answer, and does not wait after it",
      answers: [HTTP_500, HTTP_500, HTTP_502],
      returns: HTTP_502,
      causes: ["500", "500"],
    },
    { title: "HTTP 599 is a transient error: one new try", answers: [HTTP_599, OK], returns: OK, causes: ["599"] },
    { title: "HTTP 499 is an answer: no new try", answers: [HTTP_499], returns: HTTP_499, causes: [] },
    { title: "HTTP 200 is an answer, whatever its body: no new try", answers: [OK_WITH_BAD_BODY], returns: OK_WITH_BAD_BODY, causes: [] },
    {
      title: "a network error, then an answer: the warn line names the error class",
      answers: [networkErrors[0], OK],
      returns: OK,
      causes: ["TypeError"],
    },
    {
      title: "a network error on all 3 tries: throws the error of the last try",
      answers: networkErrors,
      throws: networkErrors[2],
      causes: ["TypeError", "TypeError"],
    },
    {
      title: "HTTP 500, a network error, HTTP 502: the 3 tries count both kinds",
      answers: [HTTP_500, networkErrors[0], HTTP_502],
      returns: HTTP_502,
      causes: ["500", "TypeError"],
    },
    { title: "a TimeoutError on try 1: no new try", answers: [timeout], throws: timeout, causes: [] },
    { title: "an AbortError on try 1: no new try", answers: [abort], throws: abort, causes: [] },
    {
      title: "submitTransaction after HTTP 500: one try, returns that answer",
      method: "submitTransaction",
      answers: [HTTP_500],
      returns: HTTP_500,
      causes: [],
    },
    {
      title: "submitTransaction after a network error: one try, throws that error",
      method: "submitTransaction",
      answers: [networkErrors[0]],
      throws: networkErrors[0],
      causes: [],
    },
    {
      title: "submitTransaction after a TimeoutError: one try, throws that error",
      method: "submitTransaction",
      answers: [timeout],
      throws: timeout,
      causes: [],
    },
  ];

  it.each(TRIES)("$title", async ({ method = METHOD, answers, returns, throws, causes }) => {
    const events: string[] = [];
    const queue = [...answers];
    mockFetch.mockImplementation(async () => {
      events.push("fetch");
      const answer = queue.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    });
    sleep.mockImplementation(async (ms: number) => {
      events.push(`sleep ${ms}`);
    });

    const outcome = await read(method).then(
      (value) => ({ kind: "returned", value }),
      (error: unknown) => ({ kind: "thrown", value: error }),
    );

    expect(outcome.kind).toBe(throws === undefined ? "returned" : "thrown");
    expect(outcome.value).toBe(throws ?? returns);
    // Each new try comes after the wait of its number, and nothing waits after the last try.
    expect(events).toEqual([...WAITS.slice(0, causes.length).flatMap((ms) => ["fetch", `sleep ${ms}`]), "fetch"]);
    expect(warn.mock.calls).toEqual(causes.map((cause, i) => [`[ogmios] retry ${i + 1}/2 method=${method} cause=${cause}`]));
  });

  it.each([
    ["the reason of the signal", (signal: AbortSignal): unknown => signal.reason],
    ["a plain network error", (): unknown => new TypeError("fetch failed")],
  ])("does not try again when the timeout signal of the try fired and fetch throws %s", async (_label, makeError) => {
    const { controllers } = controlTimeoutSignals();
    let thrown: unknown;
    mockFetch.mockImplementation(async (_url: unknown, init: RequestInit) => {
      // The timeout passes while fetch waits for Ogmios.
      controllers[0].abort(timeoutError());
      thrown = makeError(init.signal!);
      throw thrown;
    });

    const error = await read().catch((e: unknown) => e);

    expect(error).toBe(thrown);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends the same request on each try", async () => {
    mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(HTTP_502).mockResolvedValueOnce(OK);

    await read();

    expect(mockFetch.mock.calls.map(([url, init]) => [url, init.method, init.headers, init.body])).toEqual(
      Array(3).fill([CREDENTIAL_URL, "POST", { "Content-Type": "application/json" }, BODY]),
    );
  });

  it("gives each try its own timeout signal: try 2 does not start with an aborted signal", async () => {
    const { controllers, spy } = controlTimeoutSignals();
    const signals: AbortSignal[] = [];
    const abortedAtCall: boolean[] = [];
    mockFetch.mockImplementation(async (_url: unknown, init: RequestInit) => {
      signals.push(init.signal!);
      abortedAtCall.push(init.signal!.aborted);
      if (signals.length > 1) return OK;
      // The timeout of try 1 has passed when Ogmios answers with HTTP 500.
      controllers[0].abort(timeoutError());
      return HTTP_500;
    });

    await expect(read(METHOD, 1234)).resolves.toBe(OK);

    expect(spy.mock.calls).toEqual([[1234], [1234]]);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0].aborted).toBe(true);
    expect(abortedAtCall).toEqual([false, false]);
  });

  it("without an injected sleep, the waits are timers of 300 ms and 1,000 ms", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValueOnce(HTTP_500).mockResolvedValueOnce(HTTP_502).mockResolvedValueOnce(OK);
      const result = fetchOgmiosRead({ fetch: mockFetch, url: CREDENTIAL_URL, method: METHOD, body: BODY, timeoutMs: 1000 });

      await vi.advanceTimersByTimeAsync(299);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      await expect(result).resolves.toBe(OK);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the body of each answer that it drops, and leaves the body of the last answer", async () => {
    const answers = [502, 503, 504].map((status) => new Response("<html>gateway</html>", { status }));
    const cancels = answers.map((answer) => vi.spyOn(answer.body!, "cancel"));
    for (const answer of answers) mockFetch.mockResolvedValueOnce(answer);

    await expect(read()).resolves.toBe(answers[2]);

    expect(cancels.map((cancel) => cancel.mock.calls.length)).toEqual([1, 1, 0]);
  });

  it("tries again when the body of a dropped answer cannot be cancelled", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "x", body: { cancel: () => Promise.reject(new Error("locked")) } })
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "x", body: { cancel: () => { throw new Error("locked"); } } })
      .mockResolvedValueOnce(OK);

    await expect(read()).resolves.toBe(OK);

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("writes warn lines with no URL, no body, no params and no error text", async () => {
    const leak = Object.assign(new Error(`read ECONNRESET ${CREDENTIAL_URL}`), { code: "ECONNRESET" });
    mockFetch.mockResolvedValueOnce(HTTP_500).mockRejectedValueOnce(leak).mockResolvedValueOnce(OK);
    const body = JSON.stringify({ jsonrpc: "2.0", method: "queryLedgerState/utxo", params: { addresses: [ADDRESS] }, id: 1 });

    await fetchOgmiosRead({ fetch: mockFetch, url: CREDENTIAL_URL, method: "queryLedgerState/utxo", body, timeoutMs: 1000, sleep });

    // The class of a plain Error with a connection code is `Error`.
    expect(warn.mock.calls).toEqual([
      ["[ogmios] retry 1/2 method=queryLedgerState/utxo cause=500"],
      ["[ogmios] retry 2/2 method=queryLedgerState/utxo cause=Error"],
    ]);
    const written = JSON.stringify(warn.mock.calls);
    for (const secret of ["secret-key-123", "ogmios.example", ADDRESS, "jsonrpc", "ECONNRESET"]) {
      expect(written).not.toContain(secret);
    }
  });
});
