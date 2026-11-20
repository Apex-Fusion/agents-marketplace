// The history store (history-store.ts): a history read stays between passes only when the history
// of each registry has the transaction of each output that holds the tokens of that registry. A read
// from an asset index that is behind the list of holders serves its own pass, and the next pass
// reads again.

import { describe, expect, test } from "vitest";
import { VectorResolver } from "../src/resolve/resolver.js";
import { LedgerBuilder, identityDatum, idOf, legacyDatum, timeAt } from "./support/ledger.js";

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

  test.each<[string, "identity" | "legacy", (b: LedgerBuilder, id: string) => { txHash: string }]>([
    [
      // The adoption is the newest transaction. The legacy history has it as the burn, and the identity history as the mint.
      "an identity history that is behind does not pass for the legacy history that has the same transaction",
      "identity",
      (b, id) => {
        b.legacyRegister(id, legacyDatum(), { height: 50 });
        return b.adopt(id, identityDatum(), { height: 1001 });
      },
    ],
    [
      // The move of the token to a wallet is the newest transaction.
      "a legacy history that is behind does not pass for the identity history",
      "legacy",
      (b, id) => {
        b.legacyRegister(id, legacyDatum(), { height: 50 });
        return b.moveOut(id, { height: 1001 });
      },
    ],
  ])("has the transactions of each registry whose token the holders hold: %s", async (_name, behindRegistry, makeNewest) => {
    const b = new LedgerBuilder();
    const id = idOf("store registry");
    const newest = makeNewest(b, id);
    b.tip(1100);
    const behindPolicy = b.settings.registries[behindRegistry]!.policyId;
    let behind = true;
    const read = b.chain.assetTxHashes.bind(b.chain);
    b.chain.assetTxHashes = async (policyId, assetName) => {
      const hashes = await read(policyId, assetName);
      return behind && policyId === behindPolicy ? hashes.filter((hash) => hash !== newest.txHash) : hashes;
    };
    const recordIn = async (resolver: VectorResolver) => resolver.currentRecord(id, await resolver.listRecords());
    const resolver = new VectorResolver(b.chain, b.settings, { log: () => undefined });

    // The first pass has a record without the newest transaction, which is not the record of the ledger.
    const partial = await recordIn(resolver);
    behind = false;
    const fresh = await recordIn(new VectorResolver(b.chain, b.settings, { log: () => undefined }));
    expect(partial).not.toEqual(fresh);
    // The next pass reads the history of that registry again and gives the record of the ledger.
    expect(await recordIn(resolver)).toEqual(fresh);
  });
});
