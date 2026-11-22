/**
 * The answers and the errors that the tests of the Ogmios clients give to an injected `fetch` (ReadOnlyOgmiosProvider,
 * LiveOgmiosProvider, OgmiosLucidProvider and fetchOgmiosRead). An answer is a plain object with the fields that the clients read:
 * `ok`, `status`, `statusText`, `json` and `text`.
 */

/** The answer of a node that fails for a moment. A client tries a read request again after it. */
export const HTTP_500 = { ok: false, status: 500, statusText: "Internal Server Error" };
export const HTTP_502 = { ok: false, status: 502, statusText: "Bad Gateway" };

/** The wait between two tries of a read request, with no real time. A test that expects the final error uses it, and gives the mock an answer for every try. */
export const instantSleep = async (_ms: number): Promise<void> => {};

/** HTTP 200 with the JSON-RPC result `result`. */
export function rpcOk<T>(result: T) {
  return { ok: true, json: () => Promise.resolve({ jsonrpc: "2.0", result }) };
}

/** HTTP 200 with a JSON-RPC error. */
export function rpcError(code: number, message: string, data?: unknown) {
  return { ok: true, json: () => Promise.resolve({ jsonrpc: "2.0", error: { code, message, data } }) };
}

/** An address of a test network. The clients never check its form, only its length. */
export const OGMIOS_TEST_ADDRESS = "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2";

/**
 * One output as Ogmios v6 lists it: the transaction, the index, the address and the lovelace. Ogmios leaves out `datum`,
 * `datumHash` and `script` when the output has none; a test adds the fields that it needs.
 */
export function makeOgmiosUtxo(txId = "a".repeat(64), index = 0, lovelace = 2_000_000, address = OGMIOS_TEST_ADDRESS) {
  return { transaction: { id: txId }, index, address, value: { ada: { lovelace } } };
}

/** What `fetch` rejects with when the timeout of its request passes. */
export function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** What `fetch` rejects with when its request is aborted. */
export function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}
