/**
 * indexer-load-field-error.test.ts — the load of the identity outputs at start, when the node sends a broken output.
 *
 * The chain client refuses a whole answer that holds an address, a transaction id, a policy id or an asset name longer than the
 * ledger allows (OutputFieldError). The load at start (IDENTITY_LOAD_AT_START) does not catch it: it stores no row, and the error
 * reaches the entry of the indexer, which writes one line `[indexer] fatal: <message>` and ends with exit code 1, so that Docker
 * starts the process again. No third party can cause this: the ledger holds no such output.
 */

import { describe, expect, it, vi } from "vitest";
import { OutputFieldError } from "../../packages/shared/src/chain/datumGuard.js";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import { loadIdentityOutputs } from "../../indexer/src/identity/backfill.js";

const POLICY = "11".repeat(28);
const ADDRESS = "addr1vyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkdl5mw";
const TOKEN = { [POLICY]: { [`${"ab".repeat(32)}`]: 1 } };

function output(index: number, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction: { id: `${index.toString(16).padStart(2, "0")}${"cd".repeat(31)}` },
    index,
    address: ADDRESS,
    value: { ada: { lovelace: 2_000_000 }, ...TOKEN },
    datum: "d87980",
    datumHash: null,
    script: null,
    ...changes,
  };
}

function cacheAndChain(answer: unknown[]) {
  const cache = { insertUtxoIfAbsent: vi.fn(() => true), transaction: vi.fn((work: () => void) => { work(); }) };
  const fetch = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: answer }), { headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
  return { cache, chain: new ReadOnlyOgmiosProvider({ ogmiosUrl: "http://ogmios.test", fetch }) };
}

describe("loadIdentityOutputs with a broken answer of the node", () => {
  it.each([
    ["an address", { address: `addr1${"q".repeat(1020)}` }, "address is 1025 characters long; the longest address is 1024 characters"],
    ["a transaction id", { transaction: { id: "ab".repeat(33) } }, "transaction id is 66 characters long; the longest transaction id is 64 characters"],
    ["a policy id", { value: { ada: { lovelace: 2_000_000 }, [`${POLICY}00`]: { "": 1 } } }, "policy id is 58 characters long; the longest policy id is 56 characters"],
    ["an asset name", { value: { ada: { lovelace: 2_000_000 }, [POLICY]: { [`${"ab".repeat(33)}`]: 1 } } }, "asset name is 66 characters long; the longest asset name is 64 characters"],
  ])("fails with OutputFieldError for %s that is too long, among good outputs, and stores no row", async (_name, changes, message) => {
    const { cache, chain } = cacheAndChain([output(0), output(1, changes), output(2)]);
    const error = await loadIdentityOutputs({ cache, chain, identityAddress: ADDRESS, policyId: POLICY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutputFieldError);
    expect((error as Error).message).toBe(`Ogmios sent an output whose ${message}`);
    expect(cache.transaction).not.toHaveBeenCalled();
    expect(cache.insertUtxoIfAbsent).not.toHaveBeenCalled();
  });

  it("stores the outputs of a good answer", async () => {
    const { cache, chain } = cacheAndChain([output(0), output(1)]);
    const loaded = await loadIdentityOutputs({ cache, chain, identityAddress: ADDRESS, policyId: POLICY });
    expect(loaded).toEqual({ outputs: 2, inserted: 2 });
    expect(cache.insertUtxoIfAbsent).toHaveBeenCalledTimes(2);
  });
});
