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
import { LedgerBuilder, identityDatum, idOf, legacyDatum, slotAt, timeAt } from "../support/ledger.js";
import { tombstoneOf } from "../support/resolve.js";
import { BLOCK_MS, child, clockAt, decode, hold, listsOn, revocation, sameLists, bslBits, tslValue, type DecodedLists, type ServiceOptions } from "./status-list-support.js";
import { decodeJwt, nowS, text } from "./support.js";

/** The background interval of the tests. A full build is due when the last one ended this long ago. */
const INTERVAL = 600_000;
const id = (label: string): string => idOf(`m4 follow ${label}`);
/** What a request gets when the newest ledger point that the service has is older than the validity of a list. */
const TIP_TOO_OLD = `no valid status lists: the ledger tip is older than ${LIST_VALIDITY_MS / 1000} s`;

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

  /** The ledger point of the lists (POSIX s): `iat` of Token Status List 0. It signs no Bitstring Status List and unpacks no list. */
  async point(): Promise<number> {
    return Number(decodeJwt(text(await this.lists.tokenStatusList(0))).payload.iat);
  }

  /** The Token Status List values of the records at these indices. It decodes the Token Status Lists only: one signing less for each list. */
  async values(indices: readonly number[]): Promise<number[]> {
    const lists = await decode(this.lists, "token");
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

/** The mint of a record leaves the chain (a rollback of more than 30 blocks). */
function removeMint(b: LedgerBuilder, assetName: string): void {
  const mint = b.chain.txs.find((tx) => tx.mint.some((m) => m.assetName === assetName));
  if (mint === undefined) throw new Error("the mint is in the ledger");
  b.chain.txs.splice(b.chain.txs.indexOf(mint), 1);
}

/** The log line of a misfit: the follow steps cannot go on from the lists, and a full build repairs them. */
const misfit = (why: string): string => `identity-gateway: status lists: the records do not fit the lists (${why}); the lists do not change until a full build ends`;

/** Makes the first read of the policy assets wait: `reached` ends when that read comes, and `release` lets it go on. */
function holdFirstRead(chain: FakeChain): { reached: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const policyAssets = chain.policyAssets.bind(chain);
  let held = 0;
  chain.policyAssets = async (policyId) => {
    // Only the first read waits.
    if (held++ === 0) {
      arrive();
      await waiting;
    }
    return policyAssets(policyId);
  };
  return { reached, release: () => release() };
}

/**
 * The ticks of a walk over the 30 confirmations that check the lists: at 0 and 1 confirmations, and at 28 or more. The value changes at 30
 * (CONFIRMATION_DEPTH). At the ticks between, the value is the one of the tick before, so the walk runs them with no decode.
 */
const isCheckedTick = (confirmations: number): boolean => confirmations <= 1 || confirmations >= CONFIRMATION_DEPTH - 2;

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

  test("a revoked record shows as a suspension until its block has 30 confirmations, then as a revocation", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];

    const height = rig.tip + 1;
    b.update(B, tombstoneOf(identityDatum(), revocation(height)), { height });
    for (let k = 0; k <= CONFIRMATION_DEPTH + 2; k++) {
      await rig.tick();
      const confirmations = rig.tip - height;
      expect(confirmations).toBe(k);
      if (!isCheckedTick(k)) continue;
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
      if (!isCheckedTick(k)) continue;
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
      if (!isCheckedTick(k)) continue;
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
      if (!isCheckedTick(k)) continue;
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
    // The ledger source shows the same tip for an hour: the steps and the builds read it, and the lists stay as they are. The clock jumps to
    // two points of that hour, and one tick runs at each. The first point is 10 minutes after the ledger point: a build is due there. The
    // second point is two ticks before the end of the validity.
    for (const before of [point + 600_000, validUntil - 2 * REFRESH_TICK_MS]) {
      rig.clock.now = before;
      await rig.idleTick();
      expect(typeof (await rig.lists.tokenStatusList(0)), `${rig.clock.now - point} ms after the ledger point`).toBe("string");
      expect(typeof (await rig.lists.bitstringStatusList(0)), `${rig.clock.now - point} ms after the ledger point`).toBe("string");
    }
    expect(rig.starts()).toEqual(["start", "timer", "timer"]);
    expect(rig.clock.now).toBe(validUntil - REFRESH_TICK_MS);
    // The tick that reaches the end of the validity: no list is valid, and the service says so.
    await rig.idleTick();
    expect(rig.clock.now).toBe(validUntil);
    await expect(rig.lists.tokenStatusList(0)).rejects.toThrow(TIP_TOO_OLD);
    await expect(rig.lists.bitstringStatusList(0)).rejects.toThrow(TIP_TOO_OLD);
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
    await expect(rig.lists.tokenStatusList(0)).rejects.toThrow(TIP_TOO_OLD);
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
    expect("error" in result ? String(result.error) : "an answer").toBe(`Error: ${TIP_TOO_OLD}`);
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

  test("the ledger point never goes back when the ledger source changes to a block with an earlier block time or a lower height", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    await rig.tick();
    const first = await rig.decoded();

    // The chain forks: the tip is another block 1001, 7 s before the first one. A step and a full build read it. The lists stay as they are.
    b.chain.tipInfo = { blockHeight: 1001, blockHash: "cd".repeat(32), slot: slotAt(1001) - 7 };
    await rig.idleTick();
    sameLists(await rig.decoded(), first, "after a step at the tip of the fork");
    await rig.lists.refresh();
    sameLists(await rig.decoded(), first, "after a full build at the tip of the fork");
    // The new fork has block 1002, which is 4 s before block 1001 of the first fork. A higher block is not a later ledger point.
    b.chain.tipInfo = { blockHeight: 1002, blockHash: "ce".repeat(32), slot: slotAt(1001) - 4 };
    await rig.idleTick();
    sameLists(await rig.decoded(), first, "after a step at block 1002 of the new fork");
    // Block 1003 of the new fork is 3 s after block 1001 of the first fork: the lists follow.
    b.chain.tipInfo = { blockHeight: 1003, blockHash: "cf".repeat(32), slot: slotAt(1001) + 3 };
    await rig.idleTick();
    const point = timeAt(1001) + 3_000;
    const later = await rig.decoded();
    expect(later.iat).toBe(nowS(point));
    expect(later.exp).toBe(nowS(point) + LIST_VALIDITY_MS / 1000);
    expect(later.validFrom).toBe(formatTime(point));
    expect(later.validUntil).toBe(formatTime(point + LIST_VALIDITY_MS));
    // A full build reads a tip with a lower block height and a later block time. The lists keep the higher block.
    b.chain.tipInfo = { blockHeight: 1002, blockHash: "d0".repeat(32), slot: slotAt(1001) + 10 };
    await rig.lists.refresh();
    sameLists(await rig.decoded(), later, "after a full build at a lower block height");
  });

  test("a tip with a block time more than a minute after the clock is a failed read: nothing is published, the log has one line for each refresh interval, and the real tip is followed", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    await rig.tick();
    const first = await rig.decoded();

    // Block 1002 has a hold on B. The ledger source shows a tip for it with a block time one day after the clock.
    b.update(B, identityDatum({ status: hold(timeAt(1002) + 3_600_000) }), { height: 1002 });
    b.chain.tipInfo = { blockHeight: 1002, blockHash: "ee".repeat(32), slot: slotAt(1001) + 86_400 };
    // Seven steps fail. The log has the first one and the one 60 s later.
    for (let k = 0; k < 7; k++) await rig.idleTick();
    expect(rig.logs).toEqual([
      "identity-gateway: status lists not followed after 0.0 s: the block time of the ledger tip is 86380.0 s after the clock",
      "identity-gateway: status lists not followed after 0.0 s: the block time of the ledger tip is 86320.0 s after the clock",
    ]);
    // The lists are as before. The request finds them unread for 80 s, and the build that it starts fails on the same tip.
    sameLists(await rig.decoded(), first, "after seven failed steps");
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start", "request"]);
    expect(rig.logs).toHaveLength(3);
    expect(rig.logs[2]).toBe("identity-gateway: status lists not rebuilt after 0.0 s: the block time of the ledger tip is 86320.0 s after the clock");
    expect(await rig.values([ia, ib])).toEqual([0, 0]);

    // The real tip: the hold shows at the next step.
    rig.moveTo(1002);
    await rig.idleTick();
    expect(await rig.values([ia, ib])).toEqual([0, 2]);
    expect((await rig.decoded()).iat).toBe(nowS(timeAt(1002)));
  });

  test("a tip 59 or 60 s after the clock is read, and a tip 61 s after the clock is a failed read, for a step and for a build", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    await rig.tick();
    // The clock is 10 s after block 1001, so a tip is `seconds` after the clock when its slot is 10 + `seconds` after that block.
    const tipAhead = (height: number, seconds: number) => ({ blockHeight: height, blockHash: "ee".repeat(32), slot: slotAt(1001) + 10 + seconds });
    b.chain.tipInfo = tipAhead(1002, 61);
    await expect(rig.lists.follow()).rejects.toThrow("the block time of the ledger tip is 61.0 s after the clock");
    await expect(rig.lists.refresh()).rejects.toThrow("the block time of the ledger tip is 61.0 s after the clock");
    // The ledger point of a step is 59 s after the clock, and the ledger point of a build is 60 s after it.
    b.chain.tipInfo = tipAhead(1002, 59);
    await rig.lists.follow();
    expect((await rig.decoded()).iat).toBe(nowS(rig.clock.now + 59_000));
    b.chain.tipInfo = tipAhead(1003, 60);
    await rig.lists.refresh();
    expect((await rig.decoded()).iat).toBe(nowS(rig.clock.now + 60_000));
  });

  test("lists that expired are replaced by the next state, also when it has a lower block height: one tip with an impossible height does not freeze the lists for good", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    await rig.tick();
    // One tip has the block height 2,000,000 and the block time of block 1001. A block time that is not earlier is published.
    b.chain.tipInfo = { blockHeight: 2_000_000, blockHash: "ff".repeat(32), slot: slotAt(1001) };
    await rig.idleTick();
    // The real chain goes on. Block 1002 has a hold on B. A full build reads the real tip, but its lists have a lower block height.
    b.update(B, identityDatum({ status: hold(timeAt(1002) + 100 * LIST_VALIDITY_MS) }), { height: 1002 });
    rig.moveTo(1002);
    await rig.lists.refresh();
    expect(await rig.values([ia, ib])).toEqual([0, 0]);
    // The lists that readers have stay until they expire, an hour after block 1001. The tip and the clock jump to the tick before that, and
    // a tick runs there: a build is due, and a step runs.
    const expiry = timeAt(1001) + LIST_VALIDITY_MS;
    rig.moveTo(1001 + (LIST_VALIDITY_MS - 3 * REFRESH_TICK_MS) / BLOCK_MS);
    await rig.tick();
    expect(rig.clock.now).toBe(expiry - REFRESH_TICK_MS);
    expect(await rig.values([ia, ib])).toEqual([0, 0]);
    // The first step after that replaces them, and the hold shows.
    await rig.tick(2);
    expect(rig.clock.now).toBeGreaterThanOrEqual(expiry);
    expect(await rig.values([ia, ib])).toEqual([0, 2]);
    expect((await rig.decoded()).iat).toBeGreaterThan(nowS(timeAt(1001)));
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
    const ticks = 60;
    const points: number[] = [await rig.point()];
    gate.shut();
    let ends = 0;
    for (let k = 0; k < ticks; k++) {
      await rig.tickSteps();
      // A new hold in the next block, at times; a hold lasts 60 blocks, so holds also end by their time.
      if (k % 7 === 0) b.update(k % 2 ? A : B, identityDatum({ status: hold(timeAt(rig.tip + 1) + 600_000) }), { height: rig.tip + 1 });
      points.push(await rig.point());
      // The build that waits for the gate ends at some tick: after 9 ticks, then after 11, and so on.
      if (k % (9 + (ends % 3) * 2) === 8) {
        gate.open();
        await rig.lists.idle();
        points.push(await rig.point());
        gate.shut();
        ends++;
      }
    }
    gate.open();
    await rig.lists.idle();
    points.push(await rig.point());
    expect(rig.starts().length).toBeGreaterThan(5);
    expect(points.length).toBeGreaterThan(ticks);
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
  ])("when %s, the first step that sees it logs it and starts a full build, and the build gives the lists of the ledger", async (_name, position, why) => {
    const [A, B, C] = ["a", "b", "c"].map(id) as [string, string, string];
    const b = roots(A, B, C);
    const rig = await new Rig(b).start();
    const ids = [A, B, C];
    // The mint of one record leaves the chain (a rollback of more than 30 blocks).
    removeMint(b, ids[position]!);

    // The first step after that finds the mismatch. The build starts at once: 10 s after the last build, with no wait for a refresh interval.
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "repair"]);
    expect(rig.logs).toEqual([misfit(why)]);
    const rest = ids.filter((_, i) => i !== position);
    const indices = await indicesOf(rig, rest);
    expect(indices).toEqual([0, 1]);
    expect(await rig.lists.indexOf(ids[position]!)).toBeNull();
    expect(await rig.values([0, 1, 2])).toEqual([0, 0, 0]);
    // The steps go on from the build.
    await rig.tick(2);
    expect(rig.starts()).toEqual(["start", "repair"]);
  });

  test("a step logs a misfit when it first sees it, also while a build runs, and then once for each refresh interval", async () => {
    const { b, B, L } = slowLedger();
    const rig = await new Rig(b).start();
    const gate = gateOn(b.chain, L);
    gate.shut();
    // The timer starts a build, and it waits for the read of the burned record.
    await rig.tickSteps(INTERVAL / REFRESH_TICK_MS);
    expect(rig.starts()).toEqual(["start", "timer"]);
    // The mint of B leaves the chain while the build runs.
    removeMint(b, B);

    // The first step that sees it logs it. It starts no second build.
    await rig.tickSteps();
    expect(rig.logs).toEqual([misfit("a record left the list")]);
    // The misfit stands. The log has one line for each refresh interval: none after 50 s, one after 60 s.
    await rig.tickSteps(5);
    expect(rig.logs).toHaveLength(1);
    await rig.tickSteps();
    expect(rig.logs).toHaveLength(2);
    expect(rig.starts()).toEqual(["start", "timer"]);

    // The running build ends with the records that it read at its start (it still has B). The next step starts the repair at once.
    gate.open();
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start", "timer"]);
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "timer", "repair"]);
    expect(rig.logs).toHaveLength(2);
    expect(await rig.lists.indexOf(B)).toBeNull();
  });

  test("a repair build that fails is tried again after a refresh interval, not at every tick", async () => {
    const { b, A, B, L } = slowLedger();
    const rig = await new Rig(b).start();
    // A step does not read the burned record, but a full build does: the read fails, so no build can end.
    let broken = true;
    const read = b.chain.assetTxHashes.bind(b.chain);
    b.chain.assetTxHashes = async (policyId, assetName) => {
      if (broken && assetName === L) throw new Error("Koios assetTxHashes answered HTTP 503");
      return read(policyId, assetName);
    };
    removeMint(b, B);

    // The first step that sees the misfit starts the build, and the build fails.
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "repair"]);
    expect(rig.logs.filter((line) => line.includes("status lists not rebuilt"))).toHaveLength(1);
    // The misfit stands, but the next try waits for a refresh interval after the failed one started: 50 s later there is none, 60 s later there is one.
    await rig.tick(5);
    expect(rig.starts()).toEqual(["start", "repair"]);
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "repair", "repair"]);
    // The read works again. The next try is a refresh interval later, and it repairs the lists.
    broken = false;
    await rig.tick(5);
    expect(rig.starts()).toEqual(["start", "repair", "repair"]);
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "repair", "repair", "repair"]);
    expect(await rig.lists.indexOf(B)).toBeNull();
    // The burned record has the first index and shows as revoked; A is active.
    expect(await rig.values([0, 1])).toEqual([1, 0]);
    // The last build ended well: a new misfit is repaired at the next step, with no wait.
    removeMint(b, A);
    await rig.tick();
    expect(rig.starts()).toEqual(["start", "repair", "repair", "repair", "repair"]);
    expect(await rig.lists.indexOf(A)).toBeNull();
    expect(await rig.values([0])).toEqual([1]);
  });

  test("a step that started before a build and finds a misfit does not start a second build", async () => {
    const [A, B, C] = ["a", "b", "c"].map(id) as [string, string, string];
    const b = roots(A, B, C);
    const rig = await new Rig(b).start();
    // The mint of C leaves the chain. A step starts and waits for the asset index.
    removeMint(b, C);
    rig.moveTo(rig.tip + 1);
    const held = holdFirstRead(b.chain);
    const step = rig.lists.follow();
    await held.reached;
    // A full build ends while the step waits. Its lists have no C. A refresh interval has passed since it started.
    await rig.lists.refresh();
    rig.clock.now += 60_000;
    held.release();
    await step;
    // The step read the records of the ledger, and the build has the same records: nothing is left to repair.
    expect(rig.starts()).toEqual(["start", "call"]);
    expect(rig.logs).toEqual([]);
    expect(await rig.lists.indexOf(C)).toBeNull();
    await rig.tick(2);
    expect(rig.starts()).toEqual(["start", "call"]);
    expect(rig.logs).toEqual([]);
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

  test("a failed read of a record ends the step with no change, and the next step reads again", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    const first = await rig.lists.tokenStatusList(0);

    const height = rig.tip + 1;
    b.update(B, identityDatum({ status: hold(timeAt(height) + 3_600_000) }), { height });
    b.chain.failing.add("transactions");
    await rig.tick();
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain("Koios transactions answered HTTP 503");
    expect(await rig.lists.tokenStatusList(0)).toBe(first);
    b.chain.failing.delete("transactions");
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

  test("with a follow interval of 300 s, a request between two steps starts no build; after two follow intervals without a read it does", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    // The timer build is far away, so only a request can start a build here.
    const rig = await new Rig(b, { followMs: 300_000, refreshMs: 60_000, backgroundRefreshMs: 1_800_000 }).start();
    // The lists are 120 s old, and the next step is at 300 s: the lists count as read.
    await rig.tick(12);
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start"]);
    // The steps fail from now on. The lists count as read for 600 s, which is two follow intervals.
    b.chain.failing.add("assetHolders");
    await rig.tick(47);
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start"]);
    await rig.tick();
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start", "request"]);
  });

  test("with the default follow interval, a request starts no build until the lists were last read one refresh interval ago", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b, { refreshMs: 60_000 }).start();
    // The steps work for 100 s, and then they fail.
    await rig.tick(10);
    b.chain.failing.add("assetHolders");
    // The last good step was 30 s ago: that is less than the refresh interval, so a request starts no build.
    await rig.tick(3);
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start"]);
    // The last good step was 60 s ago: a request starts a build.
    await rig.tick(3);
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start", "request"]);
  });

  test("a tip that stays the same counts as a read: while the steps read it, a request starts no build", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const rig = await new Rig(roots(A, B), { refreshMs: 60_000 }).start();
    // The tip does not move for 80 s, which is longer than the refresh interval. Each step reads it and finds nothing new.
    for (let k = 0; k < 8; k++) await rig.idleTick();
    expect(typeof (await rig.lists.tokenStatusList(0))).toBe("string");
    await rig.lists.idle();
    expect(rig.starts()).toEqual(["start"]);
  });

  test("a history read that Koios gives without the newest transaction of a record does not stay: the next step reads again and the hold shows", async () => {
    const [A, B] = ["a", "b"].map(id) as [string, string];
    const b = roots(A, B);
    const rig = await new Rig(b).start();
    const [ia, ib] = (await indicesOf(rig, [A, B])) as [number, number];
    // Koios lists the transactions of B without the hold, but the holder list already has the output of the hold.
    const holdTx = b.update(B, identityDatum({ status: hold(timeAt(1004) + 3_600_000) }), { height: 1001 });
    let behind = true;
    const read = b.chain.assetTxHashes.bind(b.chain);
    b.chain.assetTxHashes = async (policyId, assetName) => {
      const hashes = await read(policyId, assetName);
      return behind ? hashes.filter((hash) => hash !== holdTx.txHash) : hashes;
    };
    await rig.tick();
    expect(await rig.values([ia, ib])).toEqual([0, 0]);
    // Koios has caught up. The step reads the history of B again, because the first read did not stay.
    behind = false;
    await rig.tick();
    expect(await rig.values([ia, ib])).toEqual([0, 2]);
    await agree(rig, [A, B]);
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
    const held = holdFirstRead(b.chain);
    const step = rig.lists.follow();
    await held.reached;
    await rig.lists.refresh();
    expect(await rig.values([ia, ir])).toEqual([0, 0]);
    held.release();
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
