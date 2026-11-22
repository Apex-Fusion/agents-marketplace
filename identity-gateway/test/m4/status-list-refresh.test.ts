// The background refresh of the status lists: a timer builds the lists again when they are older than
// the background interval, so that a list is rebuilt without a request, and a reader never gets a list
// that is too old for its validity. The tests use a fake chain, the clock of the harness (`h.now`)
// and fake interval timers: one tick of the timer is REFRESH_TICK_MS of fake time, and the chain
// gets one block in each tick. The lists do not follow the chain here (followMs 0), so that only the
// builds change them; status-list-follow.test.ts covers the follow steps.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BUILD_WAIT_MS, LIST_VALIDITY_MS, MAX_REFRESH_MS, REFRESH_TICK_MS } from "../../src/m4/status-lists.js";
import type { ChainMethod, FakeChain } from "../support/chain.js";
import { LedgerBuilder, identityDatum, idOf, timeAt } from "../support/ledger.js";
import { BLOCK_MS } from "./status-list-support.js";
import { NOW, decodeJwt, nowS, startGateway, stopGateways, type GatewayOptions, type Harness } from "./support.js";

/** The background interval of most tests, and the default of the setting. */
const INTERVAL = 600_000;
/** The default refresh interval of the harness: a request builds lists that are this old. */
const REFRESH = 60_000;
const MINUTE = 60_000;

const IDS = ["one", "two", "three"].map((label) => idOf(`m4 refresh ${label}`));

/** Three agents, each with a status-list index. */
function ledger(): LedgerBuilder {
  const b = new LedgerBuilder();
  IDS.forEach((id, i) => b.register(id, identityDatum(), { height: 100 + 10 * i }));
  return b;
}

/** Makes the read of the policy assets wait while the gate is shut: a build waits at its first read. */
class Gate {
  private shut = false;
  private readonly waiting: Array<() => void> = [];

  constructor(chain: FakeChain) {
    const assets = chain.policyAssets.bind(chain);
    chain.policyAssets = async (policyId) => {
      if (this.shut) await new Promise<void>((resume) => this.waiting.push(resume));
      return assets(policyId);
    };
  }

  shutNow(): void {
    this.shut = true;
  }

  open(): void {
    this.shut = false;
    for (const resume of this.waiting.splice(0)) resume();
  }
}

/** Ledger reads of one kind so far. */
const reads = (h: Harness, method: ChainMethod): number => h.builder.chain.calls.filter((c) => c === method).length;

/** What started each build, in order: "start", "timer" or "request". */
const startsOf = (h: Harness): string[] => h.info.flatMap((line) => /build started \((\w+)\)/.exec(line)?.[1] ?? []);

/** The services of a gateway that the test stops at its end. */
const services: Harness[] = [];

async function gateway(b: LedgerBuilder, options: GatewayOptions = {}): Promise<Harness> {
  const h = await startGateway(b, { backgroundRefreshMs: INTERVAL, followMs: 0, ...options });
  services.push(h);
  return h;
}

/** A gateway whose services have started: the first build runs, and the timer ticks. */
async function startedGateway(b: LedgerBuilder, options: GatewayOptions = {}): Promise<Harness> {
  const h = await gateway(b, options);
  h.services.start();
  return h;
}

/** The height of the tip when the clock is `now`: the block time of the tip is 10 s before the clock, as at the start of the harness. */
const tipAt = (now: number): number => 1000 + Math.floor((now - NOW) / BLOCK_MS);

/** The ledger point (POSIX s) of lists that a build reads at the tip that the chain has now: the block time of that tip. */
const pointS = (h: Harness): number => nowS(timeAt(h.builder.chain.tipInfo.blockHeight));

/** Moves the clock of the services, the chain and the fake timers together, one tick at a time. */
async function advance(h: Harness, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= REFRESH_TICK_MS) {
    const step = Math.min(left, REFRESH_TICK_MS);
    h.now += step;
    h.builder.tip(tipAt(h.now));
    await vi.advanceTimersByTimeAsync(step);
  }
}

/**
 * The value of `promise`, or null when it takes longer than `ms`. A deadline, not a wait: the answer
 * that the test expects comes at once, and the timer only turns a hang (the old behaviour) into a
 * failure. The HTTP stack of the test server needs real timers for this.
 */
async function within<T>(ms: number, promise: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(async () => {
  for (const h of services.splice(0)) h.services.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await stopGateways();
});

describe("the timer", () => {
  test("the first build starts with the services; no build starts while the lists are younger than the interval", async () => {
    const h = await startedGateway(ledger());
    expect(startsOf(h)).toEqual(["start"]);
    expect(h.info[0]).toBe("identity-gateway: status lists: the timer builds them again when they are older than 600 s; a list is valid for 3600 s");
    await h.services.statusLists.idle();
    expect(reads(h, "policyAssets")).toBe(2);
    await advance(h, INTERVAL - REFRESH_TICK_MS);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start"]);
    expect(reads(h, "policyAssets")).toBe(2);
  });

  test("the timer builds the lists again when they are as old as the interval, with no request", async () => {
    const h = await startedGateway(ledger());
    await h.services.statusLists.idle();
    await advance(h, INTERVAL);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start", "timer"]);
    expect(reads(h, "policyAssets")).toBe(4);
    // The first request finds the new lists and starts no build.
    const jwt = await h.services.statusLists.tokenStatusList(0);
    expect(decodeJwt(jwt ?? "").payload.iat).toBe(pointS(h));
    expect(startsOf(h)).toEqual(["start", "timer"]);
    // One interval later, the timer builds again.
    await advance(h, INTERVAL);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start", "timer", "timer"]);
  });

  test("a tick during a build starts no second build; the lists of the first build are as old as its end", async () => {
    const b = ledger();
    const gate = new Gate(b.chain);
    gate.shutNow();
    const h = await startedGateway(b);
    // The first build waits for the ledger while three intervals pass.
    await advance(h, 3 * INTERVAL);
    expect(startsOf(h)).toEqual(["start"]);
    gate.open();
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start"]);
    expect(reads(h, "policyAssets")).toBe(2);
    // The next build starts one interval after the end of the first.
    await advance(h, INTERVAL - REFRESH_TICK_MS);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start"]);
    await advance(h, REFRESH_TICK_MS);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start", "timer"]);
  });

  test("a failed build keeps the lists and does not stop the timer: a refresh interval later, a tick tries again", async () => {
    const b = ledger();
    const h = await startedGateway(b);
    await h.services.statusLists.idle();
    const before = await h.services.statusLists.tokenStatusList(0);
    b.chain.failing.add("policyAssets");
    await advance(h, INTERVAL);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start", "timer"]);
    expect(h.logs.filter((m) => m.includes("status lists not rebuilt"))).toEqual(["identity-gateway: status lists not rebuilt after 0.0 s: Koios policyAssets answered HTTP 503"]);
    // The old lists stay, although they are older than the interval.
    expect(await h.services.statusLists.tokenStatusList(0)).toBe(before);
    // The ledger is back. No build starts before a refresh interval has passed since the failed one.
    b.chain.failing.delete("policyAssets");
    await advance(h, REFRESH - REFRESH_TICK_MS);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start", "timer"]);
    await advance(h, REFRESH_TICK_MS);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start", "timer", "timer"]);
    const after = await h.services.statusLists.tokenStatusList(0);
    expect(after).not.toBe(before);
    expect(decodeJwt(after ?? "").payload.iat).toBe(pointS(h));
  });

  test("stopping the services clears the timer, and the timer does not keep the process alive", async () => {
    const h = await gateway(ledger());
    const created = vi.spyOn(globalThis, "setInterval");
    const timers = vi.getTimerCount();
    h.services.start();
    h.services.start();
    await h.services.statusLists.idle();
    // The status watcher and the list timer: two timers, though start was called twice.
    expect(created.mock.results.map((r) => (r.value as NodeJS.Timeout).hasRef())).toEqual([false, false]);
    expect(vi.getTimerCount() - timers).toBe(2);
    h.services.stop();
    expect(vi.getTimerCount()).toBe(timers);
    // No tick builds any more.
    await advance(h, 2 * INTERVAL);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start"]);
    expect(reads(h, "policyAssets")).toBe(2);
    // The services start again: one new timer pair, and lists that are old get a build.
    h.services.start();
    await advance(h, REFRESH_TICK_MS);
    await h.services.statusLists.idle();
    expect(startsOf(h)).toEqual(["start", "timer"]);
  });
});

describe("a reader and a build that takes longer than a request waits", () => {
  test("a reader gets the last lists at once while a refresh runs, also when the refresh takes minutes", async () => {
    const b = ledger();
    const gate = new Gate(b.chain);
    const h = await startedGateway(b);
    await h.services.statusLists.idle();
    const first = await (await fetch(`${h.url}/status/tsl/0`)).text();
    gate.shutNow();
    // The timer starts a build, which waits for the ledger for 11 minutes, longer than a request waits.
    await advance(h, INTERVAL);
    expect(startsOf(h)).toEqual(["start", "timer"]);
    // The build reads the tip when it starts.
    const startPoint = pointS(h);
    await advance(h, 11 * MINUTE);
    expect(11 * MINUTE).toBeGreaterThan(BUILD_WAIT_MS);
    const during = await within(
      2_000,
      fetch(`${h.url}/status/tsl/0`).then(async (res) => ({ status: res.status, body: await res.text() })),
    );
    expect(during).toEqual({ status: 200, body: first });
    // The build ends: the next reader gets the new lists.
    gate.open();
    await h.services.statusLists.idle();
    const after = await (await fetch(`${h.url}/status/tsl/0`)).text();
    expect(after).not.toBe(first);
    // The lists are as of the tip that the build read when it started, 11 minutes before its end.
    expect(decodeJwt(after).payload.iat).toBe(startPoint);
    expect(startPoint).toBeLessThan(pointS(h));
  });

  test("without valid lists, a request waits for the running build at most BUILD_WAIT_MS; the build goes on, and its lists are kept", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const b = ledger();
    const gate = new Gate(b.chain);
    gate.shutNow();
    const h = await startedGateway(b);
    const lists = h.services.statusLists;
    const answer = lists.tokenStatusList(0).then(
      (jwt) => ({ jwt }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(BUILD_WAIT_MS);
    const failed = await answer;
    expect("error" in failed ? String(failed.error) : "an answer").toBe("Error: the status-list build takes longer than 10 s");
    // The wait does not cancel the build. It ends, and the next reader gets its lists at once.
    gate.open();
    await lists.idle();
    expect(startsOf(h)).toEqual(["start"]);
    expect(h.info.at(-1)).toMatch(/^identity-gateway: status lists: build ended after \d+\.\d s: 3 records$/);
    expect(typeof (await lists.tokenStatusList(0))).toBe("string");
  });
});

describe("the timing rule", () => {
  /**
   * The ends of the builds (fake clock, ms) while `hours` pass; a build takes `buildMs` and ends at a
   * tick. At every tick, the lists that readers get must be valid: a list is valid for
   * LIST_VALIDITY_MS after the block time of the tip that its build read when it started.
   */
  async function simulate(h: Harness, gate: Gate | null, buildMs: number, hours: number, onTick: (elapsed: number) => void = () => undefined): Promise<number[]> {
    const ends: number[] = [];
    let builds = startsOf(h).length;
    let startedAt: number | null = h.now;
    let running = timeAt(tipAt(h.now));
    let served = -Infinity;
    for (let elapsed = 0; elapsed < hours * 3_600_000; elapsed += REFRESH_TICK_MS) {
      onTick(elapsed);
      await advance(h, REFRESH_TICK_MS);
      if (startsOf(h).length > builds) {
        builds = startsOf(h).length;
        startedAt = h.now;
        running = timeAt(tipAt(h.now));
      }
      if (startedAt !== null && h.now - startedAt >= buildMs) {
        gate?.open();
        await h.services.statusLists.idle();
        gate?.shutNow();
        startedAt = null;
      }
      if (h.info.filter((line) => line.includes("build ended")).length > ends.length) {
        ends.push(h.now);
        served = running;
      }
      // The lists of the last finished build are valid now: the ones that readers get.
      if (ends.length > 0) expect(h.now - served, `at ${elapsed / MINUTE} minutes`).toBeLessThan(LIST_VALIDITY_MS);
    }
    return ends;
  }

  test("with builds of 10 minutes, a new build ends every interval, tick and build time, so that the lists are valid at every moment", async () => {
    const buildMs = 10 * MINUTE;
    const b = ledger();
    const gate = new Gate(b.chain);
    gate.shutNow();
    const h = await startedGateway(b);
    const ends = await simulate(h, gate, buildMs, 4);
    expect(ends.length).toBeGreaterThanOrEqual(11);
    const gaps = ends.slice(1).map((end, i) => end - ends[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(INTERVAL + REFRESH_TICK_MS + buildMs);
    expect(Math.max(...gaps)).toBeLessThan(LIST_VALIDITY_MS);
    // Only the start and the timer started builds: nobody asked for a list.
    expect(new Set(startsOf(h))).toEqual(new Set(["start", "timer"]));
  });

  test("an outage of the ledger for half an hour does not let the lists expire: a failed build is tried again once each refresh interval", async () => {
    const b = ledger();
    const h = await startedGateway(b);
    const outage = { from: 25 * MINUTE, to: 55 * MINUTE };
    const ends = await simulate(h, null, 0, 2, (elapsed) => {
      if (elapsed === outage.from) b.chain.failing.add("policyAssets");
      if (elapsed === outage.to) b.chain.failing.delete("policyAssets");
    });
    // The builds end every 10 minutes until the outage. The last good one ends at 20 minutes; the next ends at 55 minutes.
    expect(ends.slice(0, 4).map((end) => (end - ends[0]!) / MINUTE)).toEqual([0, 10, 20, 55]);
    // The first try is due at 30 minutes; one more each minute until the ledger is back at 55 minutes.
    expect(h.logs.filter((m) => m.includes("status lists not rebuilt"))).toHaveLength(25);
  });

  /** The lines that the log has for a build that takes `buildMs` with the settings `options`. */
  async function warnedAfter(buildMs: number, options: GatewayOptions): Promise<string[]> {
    const b = ledger();
    const gate = new Gate(b.chain);
    gate.shutNow();
    const h = await startedGateway(b, options);
    h.now += buildMs;
    gate.open();
    await h.services.statusLists.idle();
    expect(h.info.at(-1)).toBe(`identity-gateway: status lists: build ended after ${(buildMs / 1000).toFixed(1)} s: 3 records`);
    return h.logs;
  }

  test("at the longest interval, builds of 580 s keep a valid list at every moment and are not logged; a build of 600 s is logged", async () => {
    const options = { backgroundRefreshMs: MAX_REFRESH_MS };
    expect(MAX_REFRESH_MS).toBe(2_400_000);
    expect(await warnedAfter(580_000, options)).toEqual([]);
    expect(await warnedAfter(600_000, options)).toEqual([expect.stringContaining("the build took 600.0 s, and the interval is 2400 s")]);
    // The same build of 600 s with the default interval fits in the validity of a list: the warning depends on the interval.
    expect(await warnedAfter(600_000, {})).toEqual([]);
    // The lists do not follow the chain here, so only builds renew them.
    const b = ledger();
    const gate = new Gate(b.chain);
    gate.shutNow();
    const h = await startedGateway(b, options);
    const ends = await simulate(h, gate, 580_000, 8);
    expect(ends.length).toBeGreaterThanOrEqual(9);
    expect(h.logs).toEqual([]);
  });
});
