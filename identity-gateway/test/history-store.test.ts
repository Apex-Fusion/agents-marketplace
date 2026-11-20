// The history store (history-store.ts): a history read stays between passes only when it has the
// transaction of each output that holds the tokens. A read from an asset index that is behind the
// list of holders serves its own pass, and the next pass reads again.

import { describe, expect, test } from "vitest";
import { VectorResolver } from "../src/resolve/resolver.js";
import { LedgerBuilder, identityDatum, idOf, timeAt } from "./support/ledger.js";

const A = idOf("store a");
const B = idOf("store b");

/** A hold by the controller that lasts far beyond the tests. */
const longHold = { type: "Suspended" as const, holds: [{ by: { type: "ControllerSet" as const }, reason: 6, since: timeAt(100), until: timeAt(100_000) }] };

/** Two active records, and a tip that is 99 blocks after the hold on B (block 1001). */
function ledger(): { b: LedgerBuilder; holdTxHash: string } {
  const b = new LedgerBuilder();
  b.register(A, identityDatum(), { height: 100 });
  b.register(B, identityDatum(), { height: 110 });
  const holdTx = b.update(B, identityDatum({ status: longHold }), { height: 1001 });
  b.tip(1100);
  return { b, holdTxHash: holdTx.txHash };
}

/** The effective status of B in a new pass. */
async function statusOfB(resolver: VectorResolver): Promise<string | undefined> {
  const list = await resolver.listRecords();
  const lookup = await resolver.currentStatus(B, list);
  return lookup.found ? lookup.effective.status : undefined;
}

describe("a history read that a pass keeps", () => {
  test("has the transaction of each output that holds the tokens: a read without the hold on B serves one pass only, and the next pass reads again", async () => {
    const { b, holdTxHash } = ledger();
    const resolver = new VectorResolver(b.chain, b.settings, { log: () => undefined });
    const reads = (): number => b.chain.calls.filter((c) => c === "assetTxHashes").length;

    // The asset index is behind the holders: it lists the transactions of B without the hold. The output of the hold is in the holders.
    let behind = true;
    const read = b.chain.assetTxHashes.bind(b.chain);
    b.chain.assetTxHashes = async (policyId, assetName) => {
      const hashes = await read(policyId, assetName);
      return behind && assetName === B ? hashes.filter((hash) => hash !== holdTxHash) : hashes;
    };

    // The first pass has no hold to see.
    expect(await statusOfB(resolver)).toBe("active");
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThan(0);

    // The asset index has the hold now. The next pass must read B again and show the hold.
    behind = false;
    expect(await statusOfB(resolver)).toBe("suspended");
    expect(reads()).toBe(2 * afterFirst);

    // That read has every transaction that the holders name: the pass after it reads nothing.
    expect(await statusOfB(resolver)).toBe("suspended");
    expect(reads()).toBe(2 * afterFirst);
  });

  test("is read again at each pass while the asset index stays behind", async () => {
    const { b, holdTxHash } = ledger();
    const resolver = new VectorResolver(b.chain, b.settings, { log: () => undefined });
    const reads = (): number => b.chain.calls.filter((c) => c === "assetTxHashes").length;
    const read = b.chain.assetTxHashes.bind(b.chain);
    b.chain.assetTxHashes = async (policyId, assetName) => {
      const hashes = await read(policyId, assetName);
      return assetName === B ? hashes.filter((hash) => hash !== holdTxHash) : hashes;
    };
    expect(await statusOfB(resolver)).toBe("active");
    const afterFirst = reads();
    expect(await statusOfB(resolver)).toBe("active");
    expect(await statusOfB(resolver)).toBe("active");
    expect(reads()).toBe(3 * afterFirst);
  });
});
