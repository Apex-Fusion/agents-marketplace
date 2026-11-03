// Passes over every record (resolver.ts, history-store.ts): `currentRecord(id, list)` and
// `currentStatus(id, list)` read every record as of the list's tip, with the results of fresh reads.
// Ledger reads are kept between passes; a pass reads a record again when its token holders changed,
// when its newest transaction has fewer than 30 confirmations, or when no output holds its tokens.

import { describe, expect, test } from "vitest";
import { PassFailed, VectorResolver } from "../src/resolve/resolver.js";
import type { ChainMethod } from "./support/chain.js";
import { CONTROLLER_2, LedgerBuilder, PARTY_KEY, identityDatum, idOf, keySigner, legacyDatum, timeAt } from "./support/ledger.js";
import { tombstoneOf } from "./support/resolve.js";

const ACTIVE = idOf("pass active");
const OTHER = idOf("pass other");
const CHILD = idOf("pass child");
const LEGACY_ID = idOf("pass legacy");
const DEREGISTERED = idOf("pass deregistered");

function ledger(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.legacyRegister(LEGACY_ID, legacyDatum(), { height: 50 });
  b.legacyRegister(DEREGISTERED, legacyDatum(), { height: 60 });
  b.legacyDeregister(DEREGISTERED, { height: 70 });
  b.register(ACTIVE, identityDatum(), { height: 100 });
  b.register(OTHER, identityDatum(), { height: 110 });
  b.register(CHILD, identityDatum({ lineage: { type: "Subagent", parent: ACTIVE, parentEpoch: 0, depth: 1 }, endpoint: new Uint8Array(), controller: CONTROLLER_2 }), { height: 120 });
  return b;
}

const revoked = (height: number) =>
  tombstoneOf(identityDatum(), { type: "Revoked", by: keySigner(PARTY_KEY), reason: 3, at: timeAt(height), invalidFrom: null, successor: null });
const count = (b: LedgerBuilder, method: ChainMethod): number => b.chain.calls.filter((c) => c === method).length;
/** History reads: each reads the transactions of both tokens. */
const historyReads = (b: LedgerBuilder): number => count(b, "assetTxHashes") / 2;
const resolverFor = (b: LedgerBuilder): VectorResolver => new VectorResolver(b.chain, b.settings, { log: () => undefined });

/** One pass with the history reads that it made, and the records that fresh reads (a new resolver, no list) give at the same tip. */
async function passAndFresh(b: LedgerBuilder, resolver: VectorResolver) {
  const before = historyReads(b);
  const list = await resolver.listRecords();
  const pass = await Promise.all(list.entries.map((e) => resolver.currentRecord(e.vectorId, list)));
  const reads = historyReads(b) - before;
  const fresh = resolverFor(b);
  return { list, pass, reads, fresh: await Promise.all(list.entries.map((e) => fresh.currentRecord(e.vectorId))) };
}

describe("passes", () => {
  test("a pass reads the tip once and each history once, and gives the records of fresh reads", async () => {
    const b = ledger();
    const resolver = resolverFor(b);
    const list = await resolver.listRecords();
    const records = await Promise.all(list.entries.map((e) => resolver.currentRecord(e.vectorId, list)));
    expect(list.entries.map((e) => e.vectorId).sort()).toEqual([ACTIVE, OTHER, CHILD, LEGACY_ID, DEREGISTERED].sort());
    // CHILD's parent ACTIVE is read once, for both.
    expect([count(b, "tip"), count(b, "assetHolders"), historyReads(b)]).toEqual([1, 1, 5]);
    const fresh = resolverFor(b);
    expect(records).toEqual(await Promise.all(list.entries.map((e) => fresh.currentRecord(e.vectorId))));
  });

  test("a later pass reads again only records whose holders changed, whose newest transaction is young, or whose tokens no output holds", async () => {
    const b = ledger();
    const resolver = resolverFor(b);
    expect((await passAndFresh(b, resolver)).reads).toBe(5);

    // A new block: DEREGISTERED is read again (no output holds its token), nothing else.
    b.tip(1001);
    let run = await passAndFresh(b, resolver);
    expect(run.pass).toEqual(run.fresh);
    expect(run.reads).toBe(1);

    // OTHER is revoked at height 1002: it is read again while its newest transaction has fewer than 30 confirmations.
    b.update(OTHER, revoked(1002), { height: 1002 });
    for (const [tip, reads] of [
      [1010, 2],
      [1020, 2],
      [1040, 1],
    ] as const) {
      b.tip(tip);
      run = await passAndFresh(b, resolver);
      expect(run.pass, `tip ${tip}`).toEqual(run.fresh);
      expect(run.reads, `tip ${tip}`).toBe(reads);
    }
    const other = run.pass[run.list.entries.findIndex((e) => e.vectorId === OTHER)];
    expect(other?.found && other.record.effective.status).toBe("revoked");
  });

  test("a read that started before a pass read its tip does not serve that pass", async () => {
    const b = ledger();
    const resolver = resolverFor(b);
    const early = await resolver.listRecords();
    // The first pass's read of OTHER lists the token transactions now, and then waits.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let held = true;
    let waiting = 0;
    const assetTxHashes = b.chain.assetTxHashes.bind(b.chain);
    b.chain.assetTxHashes = async (policyId, assetName) => {
      const hashes = await assetTxHashes(policyId, assetName);
      if (held) {
        waiting++;
        await gate;
      }
      return hashes;
    };
    const earlyStatus = resolver.currentStatus(OTHER, early);
    await expect.poll(() => waiting).toBe(2);
    held = false;

    // OTHER is revoked; a second pass reads its tip after that, while the early read still waits.
    b.update(OTHER, revoked(1002), { height: 1002 });
    b.tip(1040);
    const late = await resolver.listRecords();
    expect(await resolver.currentStatus(OTHER, late)).toEqual({ found: true, effective: { status: "revoked", reason: null } });
    open();
    expect(await earlyStatus).toEqual({ found: true, effective: { status: "active", reason: null } });
    // A third pass uses the second pass's read, not the early one.
    const third = await resolver.listRecords();
    const reads = historyReads(b);
    expect(await resolver.currentStatus(OTHER, third)).toEqual({ found: true, effective: { status: "revoked", reason: null } });
    expect(historyReads(b)).toBe(reads);
  });

  test("a copy of a list gives its tip, without the reads of a pass", async () => {
    const b = ledger();
    const resolver = resolverFor(b);
    const list = await resolver.listRecords();
    const copy = { ...list };
    b.tip(1001);
    const lookup = await resolver.currentRecord(ACTIVE, copy);
    expect(lookup.found && lookup.record.tip).toEqual(list.tip);
    expect([count(b, "tip"), count(b, "assetHolders")]).toEqual([1, 0]);
  });

  test("a failed holder read fails every record of the pass with PassFailed, without further reads", async () => {
    const b = ledger();
    const resolver = resolverFor(b);
    b.chain.failing.add("assetHolders");
    const list = await resolver.listRecords();
    const outcomes = await Promise.allSettled(list.entries.map((e) => resolver.currentStatus(e.vectorId, list)));
    expect(outcomes.map((o) => o.status === "rejected" && o.reason instanceof PassFailed)).toEqual(list.entries.map(() => true));
    expect([count(b, "assetHolders"), count(b, "assetTxHashes")]).toEqual([1, 0]);
    // The next pass reads the holders again.
    b.chain.failing.delete("assetHolders");
    const next = await resolver.listRecords();
    expect(await resolver.currentStatus(ACTIVE, next)).toEqual({ found: true, effective: { status: "active", reason: null } });
  });
});
