// The status lists follow the chain: a timer reads the changes of the chain into the lists, so that a
// changed bit does not wait for a build of every record. The tests use a fake ledger, the clock of the
// service and fake interval timers: one tick of the timer is REFRESH_TICK_MS of fake time, and the
// chain gets one block in each tick (the blocks of the test ledger are 10 s apart). The rules of the
// resolver (30 confirmations, holds, the status of a parent) give the expected bits, and each test
// that follows a change checks that the lists and the resolver agree.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { currentLane } from "../../src/chain/limiter.js";
import { LIST_VALIDITY_MS, REFRESH_TICK_MS, STATUS, statusValue, type StatusLists } from "../../src/m4/status-lists.js";
import { VectorResolver } from "../../src/resolve/resolver.js";
import { CONFIRMATION_DEPTH } from "../../src/resolve/settings.js";
import { formatTime } from "../../src/resolve/time.js";
import type { ChainMethod, FakeChain } from "../support/chain.js";
import { LedgerBuilder, identityDatum, idOf, legacyDatum, timeAt } from "../support/ledger.js";
import { tombstoneOf } from "../support/resolve.js";
import { child, clockAt, decode, hold, listsOn, retirement, revocation, bslBits, tslValue, type DecodedLists, type ServiceOptions } from "./status-list-support.js";
import { nowS } from "./support.js";

/** The background interval of the tests. A full build is due when the last one ended this long ago. */
const INTERVAL = 600_000;
const id = (label: string): string => idOf(`m4 follow ${label}`);

/** A status-list service with a fake ledger, a clock, its logs, and the record reads that it makes. */
class Rig {
  readonly clock = { now: clockAt(1000) };
  readonly logs: string[] = [];
  readonly info: string[] = [];
  /** The asset names of the record reads (`assetTxHashes`), in call order: two for each record that a pass reads. */
  readonly records: string[] = [];
  readonly lists: StatusLists;

  constructor(
    readonly b: LedgerBuilder,
    options: Partial<ServiceOptions> = {},
  ) {
    const read = b.chain.assetTxHashes.bind(b.chain);
    b.chain.assetTxHashes = async (policyId, assetName) => {
      this.records.push(assetName);
      return read(policyId, assetName);
    };
    this.lists = listsOn(b, { clock: this.clock, logs: this.logs, info: this.info, backgroundRefreshMs: INTERVAL, ...options });
    rigs.push(this);
  }

  get tip(): number {
    return this.b.chain.tipInfo.blockHeight;
  }

  /** The chain has blocks up to `height`, and the clock is 10 s after the last one. */
  moveTo(height: number): void {
    this.b.tip(height);
    this.clock.now = clockAt(height);
  }

  /** The services start: the first build runs and ends. */
  async start(): Promise<this> {
    this.lists.start();
    await this.lists.idle();
    return this;
  }

  /** `n` ticks of the timer. The chain has one more block at each tick, and the work of a tick ends before the next one. */
  async tick(n = 1): Promise<void> {
    for (let k = 0; k < n; k++) {
      this.moveTo(this.tip + 1);
      await vi.advanceTimersByTimeAsync(REFRESH_TICK_MS);
      await this.lists.idle();
    }
  }

  /** Like `tick`, but it waits only for the follow step of the tick: a full build that waits for a gate goes on. */
  async tickSteps(n = 1): Promise<void> {
    for (let k = 0; k < n; k++) {
      this.moveTo(this.tip + 1);
      await vi.advanceTimersByTimeAsync(REFRESH_TICK_MS);
      await this.lists.follow();
    }
  }

  /** A tick of the timer without a new block: only the clock moves. */
  async idleTick(): Promise<void> {
    this.clock.now += REFRESH_TICK_MS;
    await vi.advanceTimersByTimeAsync(REFRESH_TICK_MS);
    await this.lists.idle();
  }

  /** The position in the ledger calls, for `callsSince`. */
  mark(): number {
    return this.b.chain.calls.length;
  }

  callsSince(mark: number): Partial<Record<ChainMethod, number>> {
    const counts: Partial<Record<ChainMethod, number>> = {};
    for (const call of this.b.chain.calls.slice(mark)) counts[call] = (counts[call] ?? 0) + 1;
    return counts;
  }

  /** What started each build, in order: "start", "timer", "request" or "repair". */
  starts(): string[] {
    return this.info.flatMap((line) => /build started \((\w+)\)/.exec(line)?.[1] ?? []);
  }

  decoded(): Promise<DecodedLists> {
    return decode(this.lists);
  }

  /** The Token Status List values of the records at these indices. */
  async values(indices: readonly number[]): Promise<number[]> {
    const lists = await this.decoded();
    return indices.map((i) => tslValue(lists, i));
  }
}

const rigs: Rig[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  for (const rig of rigs.splice(0)) rig.lists.stop();
  vi.useRealTimers();
});

/** Roots that are registered at heights 100, 110, ... and a rig for them. */
function roots(...ids: string[]): LedgerBuilder {
  const b = new LedgerBuilder();
  ids.forEach((root, i) => b.register(root, identityDatum(), { height: 100 + 10 * i }));
  return b;
}

/** The status-list indices of records (they never move). */
async function indicesOf(rig: Rig, ids: readonly string[]): Promise<number[]> {
  return Promise.all(
    ids.map(async (record) => {
      const index = await rig.lists.indexOf(record);
      if (index === null) throw new Error("the record has no status-list index");
      return index;
    }),
  );
}

/** The bits of the lists are the effective status of each record in the resolver, by the request path of another resolver. */
async function agree(rig: Rig, ids: readonly string[]): Promise<void> {
  const resolver = new VectorResolver(rig.b.chain, rig.b.settings, { log: () => undefined });
  const lists = await rig.decoded();
  for (const record of ids) {
    const index = await rig.lists.indexOf(record);
    if (index === null) continue;
    const lookup = await resolver.currentStatus(record);
    const expected = lookup.found ? statusValue(lookup.effective.status) : STATUS.suspended;
    expect(tslValue(lists, index), `Token Status List of ${record.slice(0, 8)} at tip ${rig.tip}`).toBe(expected);
    expect(bslBits(lists, index), `Bitstring Status List of ${record.slice(0, 8)} at tip ${rig.tip}`).toEqual(
      expected === STATUS.invalid ? [1, 0] : expected === STATUS.suspended ? [0, 1] : [0, 0],
    );
  }
}

/** Makes the read of one record wait while the gate is shut. */
function gateOn(chain: FakeChain, assetName: string): { shut(): void; open(): void } {
  let gate: Promise<void> | null = null;
  let release: () => void = () => undefined;
  const read = chain.assetTxHashes.bind(chain);
  chain.assetTxHashes = async (policyId, name) => {
    if (name === assetName && gate !== null) await gate;
    return read(policyId, name);
  };
  return {
    shut() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open() {
      release();
      gate = null;
    },
  };
}

describe("a follow step", () => {
  test("a suspension shows at the first tick after its block is the tip, and no full build runs", async () => {
    const [A, B, C] = ["a", "b", "c"].map(id) as [string, string, string];
    const b = roots(A, B, C);
    const rig = await new Rig(b).start();
    const [ia, ib, ic] = await indicesOf(rig, [A, B, C]);
    expect(await rig.values([ia!, ib!, ic!])).toEqual([0, 0, 0]);

    // The hold is in block 1002. At tip 1001 the lists do not show it; at tip 1002 they do.
    b.update(B, identityDatum({ status: hold(timeAt(1002) + 3_600_000) }), { height: 1002 });
    await rig.tick();
    expect(rig.tip).toBe(1001);
    expect(await rig.values([ia!, ib!, ic!])).toEqual([0, 0, 0]);
    await rig.tick();
    expect(rig.tip).toBe(1002);
    expect(await rig.values([ia!, ib!, ic!])).toEqual([0, 2, 0]);
    expect(bslBits(await rig.decoded(), ib!)).toEqual([0, 1]);
    expect(rig.starts()).toEqual(["start"]);
    expect(rig.info.at(-1)).toBe("identity-gateway: status lists: followed to block 1002 after 0.0 s: 1 of 3 records changed");
    await agree(rig, [A, B, C]);
  });

  test("an idle tick reads the tip, both asset indexes and the holders, and no record; a change reads only the changed record", async () => {
    const [A, B, C] = ["a", "b", "c"].map(id) as [string, string, string];
    const b = roots(A, B, C);
    const rig = await new Rig(b).start();

    let mark = rig.mark();
    await rig.tick();
    expect(rig.callsSince(mark)).toEqual({ tip: 1, policyAssets: 2, assetHolders: 1 });

    // A change in the block of the next tick: the asset history and the transactions of that record, and no other read.
    const height = rig.tip + 1;
    b.update(B, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    mark = rig.mark();
    const reads = rig.records.length;
    await rig.tick();
    expect(rig.callsSince(mark)).toEqual({ tip: 1, policyAssets: 2, assetHolders: 1, assetTxHashes: 2, transactions: 1 });
    expect(new Set(rig.records.slice(reads))).toEqual(new Set([B]));

    // A transaction with fewer than 30 confirmations is read again at each tick; after that, no record is read.
    await rig.tick(CONFIRMATION_DEPTH);
    expect(rig.tip - height).toBe(CONFIRMATION_DEPTH);
    expect(new Set(rig.records.slice(reads))).toEqual(new Set([B]));
    const settled = rig.records.length;
    mark = rig.mark();
    await rig.tick(5);
    expect(rig.records.length).toBe(settled);
    expect(rig.callsSince(mark)).toEqual({ tip: 5, policyAssets: 10, assetHolders: 5 });
  });

  test.each([
    ["revoked", revocation],
    ["retired", retirement],
  ])("a record that is %s shows as a suspension until its block has 30 confirmations, then as a revocation", async (_name, ending) => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];

    const height = rig.tip + 1;
    b.update(B, tombstoneOf(identityDatum(), ending(height)), { height });
    for (let k = 0; k <= CONFIRMATION_DEPTH + 2; k++) {
      await rig.tick();
      const confirmations = rig.tip - height;
      expect(confirmations).toBe(k);
      const lists = await rig.decoded();
      const expected = confirmations < CONFIRMATION_DEPTH ? STATUS.suspended : STATUS.invalid;
      expect(tslValue(lists, ib), `${confirmations} confirmations`).toBe(expected);
      // The suspension bit is cleared when the revocation bit is set.
      expect(bslBits(lists, ib), `${confirmations} confirmations`).toEqual(expected === STATUS.invalid ? [1, 0] : [0, 1]);
      expect(tslValue(lists, ia)).toBe(STATUS.valid);
      await agree(rig, [A, B]);
    }
    expect(rig.starts()).toEqual(["start"]);
  });

  test("the lift of a hold shows after 30 confirmations, not before", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = new LedgerBuilder();
    b.register(A, identityDatum({ status: hold(timeAt(100_000)) }), { height: 100 });
    b.register(B, identityDatum(), { height: 110 });
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    expect(await rig.values([ia, ib])).toEqual([2, 0]);

    const height = rig.tip + 1;
    b.update(A, identityDatum(), { height });
    for (let k = 0; k <= CONFIRMATION_DEPTH + 1; k++) {
      await rig.tick();
      const expected = rig.tip - height < CONFIRMATION_DEPTH ? STATUS.suspended : STATUS.valid;
      expect(await rig.values([ia]), `${rig.tip - height} confirmations`).toEqual([expected]);
      await agree(rig, [A, B]);
    }
  });

  test("a hold that ends by its time stops at the first tip with a block time at or after that time, with no transaction", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = new LedgerBuilder();
    b.register(A, identityDatum(), { height: 100 });
    b.register(B, identityDatum({ status: hold(timeAt(1005)) }), { height: 110 });
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    expect(await rig.values([ia, ib])).toEqual([0, 2]);
    while (rig.tip < 1004) await rig.tick();
    expect(await rig.values([ib])).toEqual([2]);
    await rig.tick();
    expect(rig.tip).toBe(1005);
    expect(await rig.values([ib])).toEqual([0]);
    await agree(rig, [A, B]);
  });

  test("a party that has no right time yet makes a record suspended until the block time, and its end makes it suspended again", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = new LedgerBuilder();
    b.register(A, identityDatum(), { height: 100 });
    // No Accountable Party covers the time before block 1004 and after block 1008.
    const covers = identityDatum({ parties: [{ ...identityDatum().parties[0]!, notBefore: timeAt(1004), notAfter: timeAt(1008) }] });
    b.register(B, covers, { height: 110 });
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    expect(await rig.values([ia, ib])).toEqual([0, 2]);
    const seen: number[] = [];
    while (rig.tip < 1010) {
      await rig.tick();
      seen.push((await rig.values([ib]))[0]!);
      await agree(rig, [A, B]);
    }
    // Tips 1001 to 1010.
    expect(seen).toEqual([2, 2, 2, 0, 0, 0, 0, 0, 2, 2]);
  });
});

describe("a subagent follows its parent", () => {
  /** A root P, its subagent C, and C's subagent G, registered at heights 100, 110 and 120; a root X that nothing changes. */
  function family(): { b: LedgerBuilder; P: string; C: string; G: string; X: string } {
    const [P, C, G, X] = ["p", "c", "g", "x"].map(id) as [string, string, string, string];
    const b = new LedgerBuilder();
    b.register(P, identityDatum(), { height: 100 });
    b.register(C, child(P, 1), { height: 110 });
    b.register(G, child(C, 2), { height: 120 });
    b.register(X, identityDatum(), { height: 130 });
    return { b, P, C, G, X };
  }

  test("a hold on the parent suspends its subagents at the same tick", async () => {
    const { b, P, C, G, X } = family();
    const rig = await new Rig(b).start();
    const [ip, ic, ig, ix] = (await indicesOf(rig, [P, C, G, X])) as [number, number, number, number];
    expect(await rig.values([ip, ic, ig, ix])).toEqual([0, 0, 0, 0]);

    const height = rig.tip + 1;
    b.update(P, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    await rig.tick();
    expect(await rig.values([ip, ic, ig, ix])).toEqual([2, 2, 2, 0]);
    const resolver = new VectorResolver(b.chain, b.settings, { log: () => undefined });
    const lookup = await resolver.currentRecord(G);
    expect(lookup.found && lookup.record.effective).toEqual({ status: "suspended", reason: "parentSuspended" });
    await agree(rig, [P, C, G, X]);
  });

  test("the end of the parent shows its subagents as suspended until the 30th confirmation, then as revoked", async () => {
    const { b, P, C, G, X } = family();
    const rig = await new Rig(b).start();
    const [ip, ic, ig, ix] = (await indicesOf(rig, [P, C, G, X])) as [number, number, number, number];

    const height = rig.tip + 1;
    b.update(P, tombstoneOf(identityDatum(), revocation(height)), { height });
    for (let k = 0; k <= CONFIRMATION_DEPTH + 1; k++) {
      await rig.tick();
      const expected = rig.tip - height < CONFIRMATION_DEPTH ? STATUS.suspended : STATUS.invalid;
      expect(await rig.values([ip, ic, ig, ix]), `${rig.tip - height} confirmations`).toEqual([expected, expected, expected, STATUS.valid]);
      await agree(rig, [P, C, G, X]);
    }
  });

  test("a new subagent epoch of the parent ends its subagents after 30 confirmations, and the parent stays valid", async () => {
    const { b, P, C, G, X } = family();
    const rig = await new Rig(b).start();
    const [ip, ic, ig, ix] = (await indicesOf(rig, [P, C, G, X])) as [number, number, number, number];

    const height = rig.tip + 1;
    b.update(P, identityDatum({ subagentEpoch: 1 }), { height });
    for (let k = 0; k <= CONFIRMATION_DEPTH + 1; k++) {
      await rig.tick();
      const expected = rig.tip - height < CONFIRMATION_DEPTH ? STATUS.suspended : STATUS.invalid;
      expect(await rig.values([ip, ic, ig, ix]), `${rig.tip - height} confirmations`).toEqual([STATUS.valid, expected, expected, STATUS.valid]);
      await agree(rig, [P, C, G, X]);
    }
  });
});

describe("new records and final records", () => {
  test("a record gets its index at 30 confirmations and is read then, also when it is suspended from its first block", async () => {
    const [A, N, M] = ["a", "n", "m"].map(id) as [string, string, string];
    const b = roots(A);
    const rig = await new Rig(b).start();
    const [ia] = await indicesOf(rig, [A]);

    b.register(N, identityDatum({ status: hold(timeAt(100_000)) }), { height: 1001 });
    b.register(M, identityDatum(), { height: 1002 });
    while (rig.tip < 1000 + CONFIRMATION_DEPTH) {
      await rig.tick();
      expect(await rig.lists.indexOf(N), `tip ${rig.tip}`).toBeNull();
    }
    // The mint of N is in block 1001: at tip 1031 it has 30 confirmations.
    await rig.tick();
    expect(rig.tip).toBe(1031);
    const mark = rig.mark();
    const [inN] = await indicesOf(rig, [N]);
    // The step made the index: the lookup of a reader reads nothing.
    expect(rig.callsSince(mark)).toEqual({});
    expect(inN).toBe(ia! + 1);
    expect(await rig.lists.indexOf(M)).toBeNull();
    expect(await rig.values([ia!, inN!])).toEqual([0, 2]);
    await rig.tick();
    const [inM] = await indicesOf(rig, [M]);
    expect(inM).toBe(inN! + 1);
    expect(await rig.values([ia!, inN!, inM!])).toEqual([0, 2, 0]);
    expect(rig.starts()).toEqual(["start"]);
    await agree(rig, [A, N, M]);
  });

  test("a follow step does not read a record with a final status; a full build reads the burned record again", async () => {
    const [A, B, R, L] = ["a", "b", "r", "l"].map(id) as [string, string, string, string];
    const b = roots(A, B);
    b.register(R, identityDatum(), { height: 130 });
    b.update(R, tombstoneOf(identityDatum(), revocation(140)), { height: 140 });
    b.legacyRegister(L, legacyDatum(), { height: 50 });
    b.legacyDeregister(L, { height: 60 });
    const rig = await new Rig(b).start();
    const [ia, ib, ir, il] = (await indicesOf(rig, [A, B, R, L])) as [number, number, number, number];
    expect(await rig.values([ia, ib, ir, il])).toEqual([0, 0, 1, 1]);

    let reads = rig.records.length;
    await rig.tick(5);
    expect(rig.records.slice(reads)).toEqual([]);

    reads = rig.records.length;
    await rig.lists.refresh();
    expect(new Set(rig.records.slice(reads))).toEqual(new Set([L]));
    expect(await rig.values([ia, ib, ir, il])).toEqual([0, 0, 1, 1]);
  });
});

describe("what the lists claim", () => {
  test("iat and validFrom are the block time of the tip that a step read; exp and validUntil are an hour later", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const rig = await new Rig(roots(A, B)).start();
    for (let k = 0; k < 3; k++) {
      const lists = await rig.decoded();
      const point = timeAt(rig.tip);
      expect(lists.iat).toBe(nowS(point));
      expect(lists.exp).toBe(nowS(point) + LIST_VALIDITY_MS / 1000);
      expect(lists.validFrom).toBe(formatTime(point));
      expect(lists.validUntil).toBe(formatTime(point + LIST_VALIDITY_MS));
      await rig.tick();
    }
    // The ledger point is the tip: it is 10 s before the clock of the service.
    expect(nowS(timeAt(rig.tip))).toBe(nowS(rig.clock.now) - 10);
  });

  test("the lists stay the same while the tip stays the same", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const rig = await new Rig(roots(A, B)).start();
    await rig.tick();
    const first = await rig.lists.tokenStatusList(0);
    const mark = rig.mark();
    await rig.idleTick();
    await rig.idleTick();
    expect(await rig.lists.tokenStatusList(0)).toBe(first);
    // Each step reads the tip and the asset indexes, and then it sees that the tip is the old one.
    expect(rig.callsSince(mark)).toEqual({ tip: 2, policyAssets: 4 });
  });

  test("a list is not served after its validity, also when the steps go on at an old tip", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const rig = await new Rig(roots(A, B)).start();
    const point = timeAt(rig.tip);
    const validUntil = point + LIST_VALIDITY_MS;
    let first: string | null = null;
    // The ledger source shows the same tip for an hour: the steps read it, and the lists stay as they are.
    while (rig.clock.now + REFRESH_TICK_MS < validUntil) {
      await rig.idleTick();
      if (rig.clock.now === point + 600_000 + 10_000) first = await rig.lists.tokenStatusList(0);
    }
    expect(first).not.toBeNull();
    expect(rig.clock.now).toBe(validUntil - REFRESH_TICK_MS);
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    expect(typeof (await rig.lists.bitstringStatusList(0))).toBe("string");
    // The tick that reaches the end of the validity: no list is valid, and the service says so.
    await rig.idleTick();
    expect(rig.clock.now).toBe(validUntil);
    await expect(rig.lists.tokenStatusList(0)).rejects.toThrow(/no valid status lists/);
    await expect(rig.lists.bitstringStatusList(0)).rejects.toThrow(/no valid status lists/);
    // A tip that moves makes valid lists again at the next step.
    await rig.tick();
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
  });

  test("readers get no list from a build that read an old tip when the tip is older than the validity", async () => {
    const [A] = ["a"].map(id) as [string];
    const b = roots(A);
    // The ledger source is an hour and a minute behind the clock when the first build starts.
    const rig = new Rig(b);
    rig.clock.now += LIST_VALIDITY_MS + 60_000;
    rig.lists.start();
    await rig.lists.idle();
    await expect(rig.lists.tokenStatusList(0)).rejects.toThrow(/no valid status lists/);
  });

  test("a reader that waits for a build gets no lists when the build read a tip older than the validity", async () => {
    const [A] = ["a"].map(id) as [string];
    const b = roots(A);
    const rig = new Rig(b);
    rig.clock.now += LIST_VALIDITY_MS + 60_000;
    // The first build waits for the asset index while a reader asks for a list.
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policyAssets = b.chain.policyAssets.bind(b.chain);
    b.chain.policyAssets = async (policyId) => {
      await waiting;
      return policyAssets(policyId);
    };
    rig.lists.start();
    const answer = rig.lists.tokenStatusList(0).then(
      (jwt) => ({ jwt }),
      (error: unknown) => ({ error }),
    );
    release();
    const result = await answer;
    expect("error" in result ? String(result.error) : "an answer").toBe(`Error: no valid status lists: the ledger tip is older than ${LIST_VALIDITY_MS / 1000} s`);
  });

  test("a tip that is lower than the last one changes nothing; a tip with the same height and another hash is read", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    await rig.tick(3);
    expect(rig.tip).toBe(1003);
    const point = (await rig.decoded()).iat;

    // The ledger source is a block behind: the step reads the tip and the asset indexes, and then it stops.
    b.update(B, identityDatum({ status: hold(timeAt(1004) + 3_600_000) }), { height: 1004 });
    rig.moveTo(1002);
    const mark = rig.mark();
    await rig.idleTick();
    expect(rig.callsSince(mark)).toEqual({ tip: 1, policyAssets: 2 });
    expect((await rig.decoded()).iat).toBe(point);
    expect(await rig.values([ia, ib])).toEqual([0, 0]);

    // Block 1004 is the tip: the hold shows.
    rig.moveTo(1004);
    await rig.idleTick();
    expect(await rig.values([ia, ib])).toEqual([0, 2]);

    // Another block 1004 (the chain changed its last block) has a hold on A: it shows, at the same ledger point.
    b.update(A, identityDatum({ status: hold(timeAt(1004) + 3_600_000) }), { height: 1004, txIndex: 1 });
    b.chain.tipInfo = { ...b.chain.tipInfo, blockHash: "ab".repeat(32) };
    await rig.idleTick();
    expect(await rig.values([ia, ib])).toEqual([2, 2]);
    expect((await rig.decoded()).iat).toBe(nowS(timeAt(1004)));
  });
});

describe("a build and the follow steps", () => {
  /** Two active records and a burned legacy record: a full build reads the burned one again, the follow steps do not. */
  function slowLedger(): { b: LedgerBuilder; A: string; B: string; L: string } {
    const [A, B, L] = ["a", "b", "l"].map(id) as [string, string, string];
    const b = roots(A, B);
    b.legacyRegister(L, legacyDatum(), { height: 50 });
    b.legacyDeregister(L, { height: 60 });
    return { b, A, B, L };
  }

  test("a build that ends after newer steps does not take them back; the next step goes on from the build", async () => {
    const { b, A, B, L } = slowLedger();
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    const gate = gateOn(b.chain, L);
    gate.shut();

    // The timer starts a build when the lists are as old as the interval; it waits for the burned record.
    await rig.tickSteps(INTERVAL / REFRESH_TICK_MS);
    expect(rig.starts()).toEqual(["start", "timer"]);
    const startPoint = timeAt(rig.tip);
    // While it waits, the steps go on: a hold on A shows.
    const height = rig.tip + 1;
    b.update(A, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    await rig.tickSteps(3);
    expect(await rig.values([ia, ib])).toEqual([2, 0]);
    const during = await rig.decoded();
    expect(during.iat).toBe(nowS(timeAt(rig.tip)));
    expect(during.iat).toBeGreaterThan(nowS(startPoint));

    // The build ends. It read the tip when it started, before the hold. Readers keep the newer lists.
    gate.open();
    await rig.lists.idle();
    expect(rig.info.at(-1)).toMatch(/^identity-gateway: status lists: build ended after \d+\.\d s: 3 records$/);
    const after = await rig.decoded();
    expect(await rig.values([ia, ib])).toEqual([2, 0]);
    expect(after.iat).toBe(during.iat);

    // The next step starts from the build and reads the records again that can change: the hold shows again, at a newer tip.
    await rig.tick();
    expect(await rig.values([ia, ib])).toEqual([2, 0]);
    expect((await rig.decoded()).iat).toBeGreaterThan(during.iat);
    await agree(rig, [A, B]);
  });

  test("the ledger point of the lists never goes back, whatever order the builds and the steps end in", async () => {
    const { b, A, B, L } = slowLedger();
    // A build starts as soon as a refresh interval has passed since the end of the last one.
    const rig = await new Rig(b, { backgroundRefreshMs: 60_000 }).start();
    const gate = gateOn(b.chain, L);
    const points: number[] = [(await rig.decoded()).iat];
    gate.shut();
    let ends = 0;
    for (let k = 0; k < 150; k++) {
      await rig.tickSteps();
      // A new hold in the next block, at times; a hold lasts 60 blocks, so holds also end by their time.
      if (k % 7 === 0) b.update(k % 2 ? A : B, identityDatum({ status: hold(timeAt(rig.tip + 1) + 600_000) }), { height: rig.tip + 1 });
      points.push((await rig.decoded()).iat);
      // The build that waits for the gate ends at some tick: after 9 ticks, then after 11, and so on.
      if (k % (9 + (ends % 3) * 2) === 8) {
        gate.open();
        await rig.lists.idle();
        points.push((await rig.decoded()).iat);
        gate.shut();
        ends++;
      }
    }
    gate.open();
    await rig.lists.idle();
    points.push((await rig.decoded()).iat);
    expect(rig.starts().length).toBeGreaterThan(5);
    expect(points.length).toBeGreaterThan(150);
    expect(points).toEqual([...points].sort((x, y) => x - y));
    await agree(rig, [A, B]);
  });

  test("a record with a final status that comes back (a rollback of more than 30 blocks) is repaired by the next full build", async () => {
    const [A, R] = ["a", "r"].map(id) as [string, string];
    const b = roots(A);
    b.register(R, identityDatum(), { height: 130 });
    const end = b.update(R, tombstoneOf(identityDatum(), revocation(140)), { height: 140 });
    const rig = await new Rig(b).start();
    const [ia, ir] = (await indicesOf(rig, [A, R])) as [number, number];
    expect(await rig.values([ia, ir])).toEqual([0, 1]);

    // The block with the end of R leaves the chain. A follow step does not read a record that is final.
    b.chain.txs.splice(b.chain.txs.indexOf(end), 1);
    await rig.tick(INTERVAL / REFRESH_TICK_MS - 1);
    expect(await rig.values([ir])).toEqual([1]);
    expect(rig.starts()).toEqual(["start"]);
    // The timer starts the full build, and it reads R again.
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "timer"]);
    expect(await rig.values([ia, ir])).toEqual([0, 0]);
    await agree(rig, [A, R]);
  });

  test.each([
    ["a record leaves the list", 2, "a record left the list"],
    ["an index changes", 0, "an index changed"],
  ])("when %s, the step starts a full build when one may start, and the build gives the lists of the ledger", async (_name, position, why) => {
    const [A, B, C] = ["a", "b", "c"].map(id) as [string, string, string];
    const b = roots(A, B, C);
    const rig = await new Rig(b).start();
    const ids = [A, B, C];
    // The mint of one record leaves the chain (a rollback of more than 30 blocks).
    const mint = b.chain.txs.find((tx) => tx.mint.some((m) => m.assetName === ids[position]));
    if (mint === undefined) throw new Error("the mint is in the ledger");
    b.chain.txs.splice(b.chain.txs.indexOf(mint), 1);

    // The step finds the mismatch at each tick, and the build waits for a refresh interval after the first one.
    await rig.tick(5);
    expect(rig.starts()).toEqual(["start"]);
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "repair"]);
    expect(rig.logs).toEqual([`identity-gateway: status lists: the records do not fit the lists (${why}); a full build starts`]);
    const rest = ids.filter((_, i) => i !== position);
    const indices = await indicesOf(rig, rest);
    expect(indices).toEqual([0, 1]);
    expect(await rig.lists.indexOf(ids[position]!)).toBeNull();
    expect(await rig.values([0, 1, 2])).toEqual([0, 0, 0]);
    // The steps go on from the build.
    await rig.tick(2);
    expect(rig.starts()).toEqual(["start", "repair"]);
  });
});

describe("the ledger reads of a step", () => {
  test("go in the background lane, after the reads of requests", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const lanes: string[] = [];
    const tip = b.chain.tip.bind(b.chain);
    b.chain.tip = async () => {
      lanes.push(currentLane());
      return tip();
    };
    const policyAssets = b.chain.policyAssets.bind(b.chain);
    b.chain.policyAssets = async (policyId) => {
      lanes.push(currentLane());
      return policyAssets(policyId);
    };
    const assetHolders = b.chain.assetHolders.bind(b.chain);
    b.chain.assetHolders = async (assets) => {
      lanes.push(currentLane());
      return assetHolders(assets);
    };
    const rig = await new Rig(b).start();
    const height = rig.tip + 1;
    b.update(B, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    await rig.tick(3);
    expect(lanes.length).toBeGreaterThan(10);
    expect(new Set(lanes)).toEqual(new Set(["background"]));
    // A read that no build or step makes is in the lane of requests.
    await b.chain.tip();
    expect(lanes.at(-1)).toBe("request");
  });
});

describe("failures", () => {
  test("follow() throws when a read fails, and logs the failure", async () => {
    const [A] = ["a"].map(id) as [string];
    const rig = await new Rig(roots(A)).start();
    rig.b.chain.failing.add("assetHolders");
    rig.moveTo(rig.tip + 1);
    await expect(rig.lists.follow()).rejects.toThrow("the pass could not read the token holders: Koios assetHolders answered HTTP 503");
    expect(rig.logs).toEqual(["identity-gateway: status lists not followed after 0.0 s: the pass could not read the token holders: Koios assetHolders answered HTTP 503"]);
  });

  test("a Koios failure keeps the last lists and logs once for each refresh interval; the step after the outage catches up", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    const first = await rig.lists.tokenStatusList(0);
    const point = (await rig.decoded()).iat;

    b.chain.failing.add("assetHolders");
    const height = rig.tip + 1;
    b.update(A, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    await rig.tick(5);
    // Five ticks, 50 s: the lists are the last lists, the log has one line.
    expect(await rig.lists.tokenStatusList(0)).toBe(first);
    const failure = "identity-gateway: status lists not followed after 0.0 s: the pass could not read the token holders: Koios assetHolders answered HTTP 503";
    expect(rig.logs).toEqual([failure]);
    expect(rig.starts()).toEqual(["start"]);

    // After a refresh interval without a read, a request starts a build, and it fails too. The lists stay.
    await rig.tick(2);
    expect(await rig.lists.tokenStatusList(0)).toBe(first);
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start", "request"]);
    expect(rig.logs.filter((line) => line.includes("not rebuilt"))).toHaveLength(1);
    expect(rig.logs.filter((line) => line.includes("not followed"))).toHaveLength(2);
    expect((await rig.decoded()).iat).toBe(point);

    // The ledger is back: the next tick shows the hold, with the newer ledger point.
    b.chain.failing.delete("assetHolders");
    await rig.tick();
    expect(await rig.values([ia, ib])).toEqual([2, 0]);
    expect((await rig.decoded()).iat).toBe(nowS(timeAt(rig.tip)));
    expect(rig.info.at(-1)).toBe(`identity-gateway: status lists: followed to block ${rig.tip} after 0.0 s: 1 of 2 records changed`);
    await agree(rig, [A, B]);
  });

  test("a full build repairs the lists when the steps cannot read: a request that finds old lists starts it between two ticks", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    const first = await rig.lists.tokenStatusList(0);

    // The ledger source fails: the steps fail, and the lists stay. After 70 s, a request starts a build, which fails too.
    b.chain.failing.add("assetHolders");
    const height = rig.tip + 1;
    b.update(A, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    await rig.tick(7);
    expect(await rig.lists.tokenStatusList(0)).toBe(first);
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start", "request"]);
    expect(rig.logs.filter((line) => line.includes("not rebuilt"))).toHaveLength(1);
    expect(await rig.values([ia, ib])).toEqual([0, 0]);

    // The ledger source is back, and no tick has come yet. A refresh interval after the failed build, the next request starts the build.
    b.chain.failing.delete("assetHolders");
    rig.clock.now += 60_000;
    expect(await rig.lists.tokenStatusList(0)).toBe(first);
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start", "request", "request"]);
    expect(await rig.values([ia, ib])).toEqual([2, 0]);
    await agree(rig, [A, B]);
  });

  test("a build that cannot read the genesis values stops before its long reads, and the next build reads them again", async () => {
    const [A] = ["a"].map(id) as [string];
    const b = roots(A);
    const rig = new Rig(b);
    b.chain.failing.add("genesis");
    await expect(rig.lists.refresh()).rejects.toThrow("Koios genesis answered HTTP 503");
    expect(b.chain.calls).toEqual(["genesis"]);
    expect(rig.logs).toEqual(["identity-gateway: status lists not rebuilt after 0.0 s: Koios genesis answered HTTP 503"]);
    b.chain.failing.delete("genesis");
    rig.clock.now += 60_000;
    await rig.lists.refresh();
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
  });

  test.each<[string, ChainMethod]>([
    ["the tip", "tip"],
    ["the asset index", "policyAssets"],
    ["a record", "transactions"],
  ])("a failed read of %s ends the step with no change, and the next step reads again", async (_name, method) => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    const first = await rig.lists.tokenStatusList(0);

    const height = rig.tip + 1;
    b.update(B, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    b.chain.failing.add(method);
    await rig.tick();
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(`Koios ${method} answered HTTP 503`);
    expect(await rig.lists.tokenStatusList(0)).toBe(first);
    b.chain.failing.delete(method);
    await rig.tick();
    expect(await rig.values([ia, ib])).toEqual([0, 2]);
    await agree(rig, [A, B]);
  });

  test("while the steps work, a request starts no build; the lists are as old as the last step", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const rig = await new Rig(roots(A, B), { refreshMs: 60_000 }).start();
    for (let k = 0; k < 40; k++) {
      await rig.tick();
      expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    }
    expect(rig.starts()).toEqual(["start"]);
  });

  test("without steps, a request that finds lists older than the refresh interval starts a build, as before", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const rig = await new Rig(roots(A, B), { refreshMs: 60_000, followMs: 0 }).start();
    await rig.tick(5);
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    expect(rig.starts()).toEqual(["start"]);
    await rig.tick();
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start", "request"]);
  });

  test("a step that started from the state before a build does not undo the build: a record that the build repairs stays repaired", async () => {
    const [A, R] = ["a", "r"].map(id) as [string, string];
    const b = roots(A);
    b.register(R, identityDatum(), { height: 130 });
    const end = b.update(R, tombstoneOf(identityDatum(), revocation(140)), { height: 140 });
    const rig = await new Rig(b).start();
    const [ia, ir] = (await indicesOf(rig, [A, R])) as [number, number];
    expect(await rig.values([ia, ir])).toEqual([0, 1]);

    // The end of R leaves the chain. A step does not read R, because R is final; a full build does.
    b.chain.txs.splice(b.chain.txs.indexOf(end), 1);
    rig.moveTo(rig.tip + 1);
    // A step starts and waits for the asset index. The full build runs and ends while it waits.
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrive: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const policyAssets = b.chain.policyAssets.bind(b.chain);
    let held = 0;
    b.chain.policyAssets = async (policyId) => {
      // Only the first read of the step waits.
      if (held++ === 0) {
        arrive();
        await waiting;
      }
      return policyAssets(policyId);
    };
    const step = rig.lists.follow();
    await reached;
    await rig.lists.refresh();
    expect(await rig.values([ia, ir])).toEqual([0, 0]);
    release();
    await step;
    // The step read from the state before the build, in which R is final. It must not give R its old status again.
    expect(await rig.values([ia, ir])).toEqual([0, 0]);
    await rig.tick(2);
    expect(await rig.values([ia, ir])).toEqual([0, 0]);
    expect(rig.logs).toEqual([]);
    await agree(rig, [A, R]);
  });

  test("follow() reads nothing before the first build has ended, and two calls share one step", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = new Rig(b);
    await rig.lists.follow();
    expect(b.chain.calls).toEqual([]);
    await rig.start();
    const mark = rig.mark();
    rig.moveTo(rig.tip + 1);
    await Promise.all([rig.lists.follow(), rig.lists.follow()]);
    expect(rig.callsSince(mark)).toEqual({ tip: 1, policyAssets: 2, assetHolders: 1 });
  });
});

describe("the setting", () => {
  test("every tick reads the changes by default; the first lines of the log say so", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const rig = await new Rig(roots(A, B)).start();
    expect(rig.info.slice(0, 2)).toEqual([
      "identity-gateway: status lists: the timer builds them again when they are older than 600 s; a list is valid for 3600 s",
      "identity-gateway: status lists: they follow the chain: the timer reads the changes every 10 s",
    ]);
    const mark = rig.mark();
    await rig.tick(3);
    expect(rig.callsSince(mark)).toEqual({ tip: 3, policyAssets: 6, assetHolders: 3 });
  });

  test("a follow interval of 30 s reads the changes at every third tick", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b, { followMs: 30_000 }).start();
    const [, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    expect(rig.info[1]).toBe("identity-gateway: status lists: they follow the chain: the timer reads the changes every 30 s");
    const height = rig.tip + 1;
    b.update(B, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    const mark = rig.mark();
    await rig.tick(2);
    expect(rig.callsSince(mark)).toEqual({});
    expect(await rig.values([ib])).toEqual([0]);
    await rig.tick();
    expect(rig.callsSince(mark)).toMatchObject({ tip: 1, policyAssets: 2, assetHolders: 1 });
    expect(await rig.values([ib])).toEqual([2]);
  });

  test("an interval of 0 turns the steps off: only a build changes the lists", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    // A request builds lists that are as old as the interval, so no request starts a build before the timer.
    const rig = await new Rig(b, { followMs: 0, refreshMs: INTERVAL }).start();
    const [, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    expect(rig.info[1]).toBe("identity-gateway: status lists: they do not follow the chain: only a build changes them");
    const height = rig.tip + 1;
    b.update(B, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    await rig.tick(INTERVAL / REFRESH_TICK_MS - 1);
    expect(await rig.values([ib])).toEqual([0]);
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "timer"]);
    expect(await rig.values([ib])).toEqual([2]);
  });

  test("the Token Status List entry of an agent with a held token reads SUSPENDED at the next step", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const held = new Set<string>();
    const rig = await new Rig(roots(A, B), { heldEntries: () => held }).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    expect(await rig.values([ia, ib])).toEqual([0, 0]);
    held.add(B);
    await rig.tick();
    const lists = await rig.decoded();
    expect([tslValue(lists, ia), tslValue(lists, ib)]).toEqual([0, 2]);
    // The Bitstring Status List has no held entries.
    expect(bslBits(lists, ib)).toEqual([0, 0]);
  });
});
