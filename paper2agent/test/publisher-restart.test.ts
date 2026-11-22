/**
 * A supplier child that ends by itself starts again, with the back-off of the publisher. A stop by the publisher starts
 * nothing. The children are local stand-ins, and time moves only when a test moves it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { PaperPublisherStore } from "../src/publisher-store.js";
import { AUTH, JOB_ID, cleanup, manualTime, publishRelease, tick, until,
  type LaunchHook, type PublisherOptions, type Release } from "./publisher-fixtures.js";

const unhandled: unknown[] = [];
const noteRejection = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", noteRejection);
});

afterEach(async () => {
  process.off("unhandledRejection", noteRejection);
  await cleanup();
  vi.useRealTimers();
});

/** The publication that every case restores: one slot, published once. */
let release: Release;
beforeAll(async () => { release = await publishRelease(); });
afterAll(() => { release?.drop(); });

/** The second child reports another advert, so the publisher stops it after its identity check. */
const wrongAdvert: LaunchHook = (launch, index) => {
  if (index === 1) launch.env.ADVERT_REF = `${"0".repeat(64)}#0`;
};

/** The second child exits during startup. */
const exitAtStart: LaunchHook = (launch, index) => {
  if (index === 1) launch.exit(1);
};

/** A published slot with one ready child: the publication is restored, so a case does not publish again. */
async function publishedSlot(options: PublisherOptions = {}) {
  const fixture = await release.open(options);
  await fixture.service.idle();
  expect(fixture.launches).toHaveLength(1);
  expect((await capability(fixture.app)).status).toBe(200);
  return fixture;
}

/** The slot answers through the proxy, or the proxy refuses. */
const capability = (app: Express) => request(app).get("/tools/slot-a/capability");

/** Lets queued work run. A check that nothing happens needs it. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 100; turn++) await tick();
}

describe("restart of a supplier child that ends by itself", () => {
  it("starts a new child for the same advert at once, without a request", async () => {
    const logs: string[] = [];
    const { app, service, launches } = await publishedSlot({ log: (line) => logs.push(line) });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();
    expect(logs).toContain("supplier for target slot-a exited with code 1");
    expect(launches[1]!.env.ADVERT_REF).toBe(launches[0]!.env.ADVERT_REF);
    expect(launches[0]!.signals).toEqual([]);
    const reply = await capability(app);
    expect([reply.status, reply.body.advert_ref]).toEqual([200, launches[0]!.env.ADVERT_REF]);
    await settle();
    expect(launches).toHaveLength(2);
  });

  it("starts a new child when the first child of a restarted publisher exits during its start", async () => {
    const exitAtOpen: LaunchHook = (launch, index) => {
      if (index === 0) launch.exit(1);
    };
    const { app, service, launches } = await release.open({ onLaunch: exitAtOpen });
    await until(() => launches.length === 2);
    await service.idle();
    expect((await capability(app)).status).toBe(200);
    await settle();
    expect(launches).toHaveLength(2);
  });

  it("does nothing at the end of the back-off when the slot serves again", async () => {
    const time = manualTime();
    const { app, service, chain, launches } = await publishedSlot({ now: time.now, schedule: time.schedule });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();
    launches[1]!.exit(1);
    await settle();
    expect(time.waiting()).toEqual([30_000]);

    // A refresh starts the child again before the attempt is due.
    expect((await request(app).get(`/publications/${JOB_ID}`).set(AUTH)).status).toBe(200);
    await until(() => launches.length === 3);
    await service.idle();
    const reads = vi.spyOn(chain, "queryUtxo");
    time.advance(30_000);
    time.runDue();
    await settle();
    expect(reads).not.toHaveBeenCalled();
    expect(launches).toHaveLength(3);
    expect(time.timers()).toEqual([{ delay: 30_000, cancelled: false, fired: true }]);
  });

  it("starts nothing and sets no timer while a start runs", async () => {
    const time = manualTime();
    let answer!: () => void;
    const slowStart: LaunchHook = (launch, index) => {
      if (index === 1) launch.readyGate = new Promise<void>((resolve) => { answer = resolve; });
    };
    const { app, service, launches } = await publishedSlot({ now: time.now, schedule: time.schedule, onLaunch: slowStart });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    try {
      // The new child does not answer yet. Requests meet it inside the back-off.
      time.advance(10_000);
      for (let count = 0; count < 3; count++) expect((await capability(app)).status).toBe(503);
      await settle();
      expect(launches).toHaveLength(2);
      expect(time.timers()).toEqual([]);
    } finally {
      answer();
    }
    await service.idle();
    expect((await capability(app)).status).toBe(200);
    expect(time.timers()).toEqual([]);
  });

  it("waits for the end of the back-off after a second exit, then starts one child", async () => {
    const time = manualTime();
    const { app, service, launches } = await publishedSlot({ now: time.now, schedule: time.schedule });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();
    // The first exit waits for nothing.
    expect(time.timers()).toEqual([]);

    time.advance(12_000);
    launches[1]!.exit(1);
    await settle();
    expect(launches).toHaveLength(2);
    expect(time.waiting()).toEqual([18_000]);

    // Requests inside the interval leave the one attempt as it is.
    for (let count = 0; count < 3; count++) {
      const refused = await capability(app);
      expect([refused.status, refused.body.reason]).toEqual([503, "supplier_unavailable"]);
    }
    expect(time.timers()).toHaveLength(1);

    time.advance(17_999);
    time.runDue();
    await settle();
    expect(launches).toHaveLength(2);

    time.advance(1);
    time.runDue();
    await until(() => launches.length === 3);
    await service.idle();
    expect((await capability(app)).status).toBe(200);
    await settle();
    expect(launches).toHaveLength(3);
    expect(time.timers()).toEqual([{ delay: 18_000, cancelled: false, fired: true }]);
  });

  it("starts nothing for a child that the publisher stops after its identity check", async () => {
    const time = manualTime();
    const logs: string[] = [];
    const { service, launches } = await publishedSlot({ now: time.now, schedule: time.schedule, log: (line) => logs.push(line),
      onLaunch: wrongAdvert });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();
    await settle();
    expect(launches[1]!.signals).toEqual(["SIGTERM"]);
    expect(logs).toContainEqual(expect.stringMatching(/^supplier for publication \S+ is not serving: The started supplier does not serve the published advert/));
    expect(launches).toHaveLength(2);
    expect(time.timers()).toEqual([]);
  });

  it("starts nothing when close stops the child", async () => {
    const time = manualTime();
    const { service, launches } = await publishedSlot({ now: time.now, schedule: time.schedule });
    await service.close();
    await settle();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.signals).toEqual(["SIGTERM"]);
    expect(time.timers()).toEqual([]);
  });

  it("leaves one attempt for the end of the back-off when requests meet a slot without a child", async () => {
    const time = manualTime();
    const { app, service, launches } = await publishedSlot({ now: time.now, schedule: time.schedule, onLaunch: wrongAdvert });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();
    await settle();
    expect(time.timers()).toEqual([]);

    time.advance(10_000);
    for (let count = 0; count < 3; count++) expect((await capability(app)).status).toBe(503);
    expect(time.waiting()).toEqual([20_000]);

    time.advance(20_000);
    time.runDue();
    await until(() => launches.length === 3);
    await service.idle();
    expect((await capability(app)).status).toBe(200);
  });

  it("starts nothing for a child that exits while the publisher closes", async () => {
    const time = manualTime();
    const { service, launches } = await publishedSlot({ now: time.now, schedule: time.schedule });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();

    // The new child holds the drain open. It exits inside the back-off: an open publisher would set a timer.
    launches[1]!.activeSessions = 1;
    const closing = service.close();
    await until(() => launches[1]!.statusPolls >= 2);
    launches[1]!.exit(1);
    await closing;
    await settle();
    expect(launches).toHaveLength(2);
    expect(time.timers()).toEqual([]);
  });

  it("cancels the pending attempt when the publisher closes", async () => {
    const time = manualTime();
    const { service, launches } = await publishedSlot({ now: time.now, schedule: time.schedule });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();
    launches[1]!.exit(1);
    await settle();
    expect(time.waiting()).toEqual([30_000]);

    await service.close();
    expect(time.timers()).toEqual([{ delay: 30_000, cancelled: true, fired: false }]);
    time.advance(30_000);
    time.runDue();
    await settle();
    expect(launches).toHaveLength(2);
  });

  it("holds a pending attempt in the default timer, and the close of the publisher releases it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { service, launches } = await publishedSlot();
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();
    vi.advanceTimersByTime(12_345);
    launches[1]!.exit(1);
    await settle();
    expect(launches).toHaveLength(2);
    // The attempt waits in the default timer. The close of the publisher cancels it, so one timer less is pending.
    const pending = vi.getTimerCount();
    await service.close();
    expect(vi.getTimerCount()).toBe(pending - 1);
  });

  it("logs a child that does not become ready and tries again at the end of the back-off", async () => {
    const time = manualTime();
    const logs: string[] = [];
    const { app, service, launches } = await publishedSlot({ now: time.now, schedule: time.schedule, log: (line) => logs.push(line),
      onLaunch: exitAtStart });
    launches[0]!.exit(1);
    await until(() => launches.length === 2);
    await service.idle();
    await settle();
    expect(logs).toContainEqual(expect.stringMatching(/^supplier for publication \S+ is not serving: The supplier exited during startup \(code 1\)/));
    // The exit of the new child waits for the end of the back-off that its start began.
    expect(time.waiting()).toEqual([30_000]);
    expect(logs).toContain("supplier for target slot-a restarts in 30 s");
    expect(unhandled).toEqual([]);

    time.advance(30_000);
    time.runDue();
    await until(() => launches.length === 3);
    await service.idle();
    expect((await capability(app)).status).toBe(200);
    await settle();
    expect(launches).toHaveLength(3);
    expect(unhandled).toEqual([]);
  });

  it("logs a restart that cannot read the store, and the next request starts the child", async () => {
    const logs: string[] = [];
    const { app, service, launches } = await publishedSlot({ log: (line) => logs.push(line) });
    vi.spyOn(PaperPublisherStore.prototype, "slotHolder").mockImplementationOnce(() => { throw new Error("disk I/O error"); });
    launches[0]!.exit(1);
    await settle();
    expect(logs).toContain("supplier for target slot-a does not restart: disk I/O error");
    expect(unhandled).toEqual([]);
    expect(launches).toHaveLength(1);

    expect((await capability(app)).status).toBe(503);
    await until(() => launches.length === 2);
    await service.idle();
    expect((await capability(app)).status).toBe(200);
  });
});
