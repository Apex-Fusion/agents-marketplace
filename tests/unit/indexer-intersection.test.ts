/**
 * tests/unit/indexer-intersection.test.ts — intersection points, recovery after
 * a rollback during a disconnect, a lost intersection, and honest health.
 *
 * The follower (OgmiosSource + ChainSyncWorker + SqliteCache) runs against
 * FakeOgmiosServer: Ogmios v6 chain-sync over a local WebSocket. Each block
 * holds one PostAdvert, so the adverts show which blocks the database holds.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

import { INTERSECTION_POINTS, SqliteCache } from "../../indexer/src/db/cache.js";
import { OgmiosSource, type OgmiosSourceOpts } from "../../indexer/src/follower/ogmiosSource.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import { createApp } from "../../indexer/src/server.js";
import { FakeOgmiosServer, type FakeBlock } from "./__helpers__/FakeOgmiosServer.js";
import {
  ADVERT_SCRIPT_ADDRESS,
  ESCROW_SCRIPT_ADDRESS,
  buildPostAdvertTx,
} from "../fixtures/indexer-side/sample-blocks.js";

const ADDRESSES = { advertAddress: ADVERT_SCRIPT_ADDRESS, escrowAddress: ESCROW_SCRIPT_ADDRESS };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `chain` with `count` more blocks of `branch`: slot 1000 + 10 × height, one PostAdvert each. */
function extend(chain: FakeBlock[], branch: string, count: number): FakeBlock[] {
  const out = [...chain];
  for (let i = 0; i < count; i++) {
    const parent = out.at(-1);
    const height = (parent?.height ?? 0) + 1;
    out.push({
      type: "praos",
      era: "conway",
      id: sha256(`${branch}:${height}`),
      ancestor: parent?.id ?? "genesis",
      height,
      slot: 1_000 + 10 * height,
      transactions: [buildPostAdvertTx({ txId: sha256(`${branch}:${height}:tx`) })],
    });
  }
  return out;
}

const pointOf = (b: FakeBlock) => ({ slot: b.slot, id: b.id });
const savedPointOf = (b: FakeBlock) => ({ slot: b.slot, blockHash: b.id });
const advertRefOf = (b: FakeBlock) => `${b.transactions[0]!.id}#0`;
const newestFirst = (chain: FakeBlock[]) => [...chain].reverse();

/**
 * Wait for a state of the follower. The follower runs over a real local
 * WebSocket and reconnects after its real 1 s backoff, so the test waits for
 * the condition rather than driving fake timers.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  await vi.waitFor(() => {
    if (!condition()) throw new Error(`waiting for ${what}`);
  }, { timeout: 10_000, interval: 10 });
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startServer(chain: FakeBlock[]): Promise<FakeOgmiosServer> {
  const server = await FakeOgmiosServer.start(chain);
  cleanups.push(() => server.close());
  return server;
}

interface Follower {
  cache: SqliteCache;
  worker: ChainSyncWorker;
  errors: string[];
}

/** A follower of `server`. The worker is stopped after the test; the cache is closed when `own`. */
function follower(server: FakeOgmiosServer, cache: SqliteCache, opts: OgmiosSourceOpts = {}, own = true): Follower {
  const source = new OgmiosSource(server.url, { responseTimeoutMs: 0, tipPollMs: 0, intersectionRetryMs: 20, ...opts });
  const worker = new ChainSyncWorker({ source, cache, networkId: 0, addresses: ADDRESSES });
  const errors: string[] = [];
  worker.on("error", (err: { message: string }) => errors.push(err.message));
  cleanups.push(() => {
    worker.stop();
    if (own) cache.close();
  });
  return { cache, worker, errors };
}

async function syncedTo(f: Follower, block: FakeBlock, what: string): Promise<void> {
  await until(() => f.cache.getCursor()?.blockHash === block.id, what);
}

// ─── Point list ───────────────────────────────────────────────────────────────

describe("intersection points (save, restore, order)", () => {
  it("saves the points of the last INTERSECTION_POINTS applied blocks, newest first", () => {
    const cache = new SqliteCache(":memory:");
    const chain = extend([], "a", INTERSECTION_POINTS + 30);
    for (const b of chain) cache.saveCursor(b.slot, b.id);

    const points = cache.getIntersectionPoints();
    expect(points).toHaveLength(INTERSECTION_POINTS);
    expect(points).toEqual(newestFirst(chain).slice(0, INTERSECTION_POINTS).map(savedPointOf));
    expect(points[0]).toEqual(cache.getCursor());
    cache.close();
  });

  it("restores the points after a restart and sends them newest first to findIntersection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "indexer-points-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "indexer.db");
    const chain = extend([], "a", 30);
    const server = await startServer(chain);

    const first = follower(server, new SqliteCache(path));
    await first.worker.start();
    await syncedTo(first, chain.at(-1)!, "the first sync");
    const saved = first.cache.getIntersectionPoints();
    expect(saved).toEqual(newestFirst(chain).map(savedPointOf));
    first.worker.stop();
    first.cache.close();

    const cache = new SqliteCache(path);
    expect(cache.getIntersectionPoints()).toEqual(saved);
    const second = follower(server, cache);
    await second.worker.start();
    await until(() => server.intersectRequests.length === 2, "the findIntersection after the restart");
    expect(server.intersectRequests[0]).toEqual(["origin"]);
    expect(server.intersectRequests[1]).toEqual(newestFirst(chain).map(pointOf));
  });
});

// ─── Rollback during a disconnect ─────────────────────────────────────────────

describe("intersection after a rollback during a disconnect", () => {
  it.each([1, 50])("resumes by itself after a rollback of %i block(s)", async (depth) => {
    const main = extend([], "a", 60);
    const server = await startServer(main);
    const f = follower(server, new SqliteCache(":memory:"));
    await f.worker.start();
    await syncedTo(f, main.at(-1)!, "the sync of the first branch");

    // While the follower is disconnected, the last `depth` blocks leave the chain.
    const kept = main.slice(0, main.length - depth);
    const orphaned = main.slice(kept.length);
    const fork = extend(kept, "b", depth + 2);
    server.switchTo(fork);
    await syncedTo(f, fork.at(-1)!, "the sync of the fork");

    // The follower sent all its saved points, newest first; the node found the last common block.
    expect(server.intersectRequests.at(-1)).toEqual(newestFirst(main).map(pointOf));
    expect(f.errors).toEqual([]);
    for (const b of orphaned) expect(f.cache.getAdvertisementByRef(advertRefOf(b))).toBeNull();
    expect(f.cache.listEventsAfterSlot(0).map((e) => e.utxo_ref)).toEqual(fork.map(advertRefOf));
    expect(f.cache.getUnspentUtxos(ADVERT_SCRIPT_ADDRESS).map((u) => u.ref).sort()).toEqual(fork.map(advertRefOf).sort());
    expect(f.cache.getIntersectionPoints()).toEqual(newestFirst(fork).map(savedPointOf));
    expect(f.worker.getHealth()).toMatchObject({ state: "following", syncSlot: fork.at(-1)!.slot, tip: pointOf(fork.at(-1)!) });
  });
});

// ─── Lost intersection ────────────────────────────────────────────────────────

/** A follower synced to 120 blocks, then a fork that leaves none of its saved points on the chain. */
async function lostIntersection(): Promise<{ server: FakeOgmiosServer; f: Follower; main: FakeBlock[]; fork: FakeBlock[]; switchedAt: number }> {
  const main = extend([], "a", 120);
  const server = await startServer(main);
  const f = follower(server, new SqliteCache(":memory:"));
  await f.worker.start();
  await syncedTo(f, main.at(-1)!, "the sync of the first branch");

  const fork = extend(main.slice(0, main.length - INTERSECTION_POINTS - 1), "b", INTERSECTION_POINTS + 3);
  const switchedAt = server.intersectRequests.length;
  server.switchTo(fork);
  await until(() => server.intersectRequests.length >= switchedAt + 3, "three findIntersection attempts");
  return { server, f, main, fork, switchedAt };
}

describe("no intersection", () => {
  it("gives ok:false and one error naming RESYNC_FROM_*, keeps the data, and never falls back to the origin", async () => {
    const { server, f, main, fork, switchedAt } = await lostIntersection();
    const app = createApp({ cache: f.cache, worker: f.worker });

    const saved = newestFirst(main).slice(0, INTERSECTION_POINTS).map(pointOf);
    for (const points of server.intersectRequests.slice(switchedAt)) expect(points).toEqual(saved);
    expect(server.intersectRequests.slice(1).some((points) => points.includes("origin"))).toBe(false);

    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toContain("RESYNC_FROM_SLOT and RESYNC_FROM_BLOCK_HASH");
    expect(f.errors[0]).toContain(`newest: slot ${main.at(-1)!.slot}, block ${main.at(-1)!.id}`);

    const tip = fork.at(-1)!;
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      follower: "no_intersection",
      ogmios_status: "connected",
      sync_slot: main.at(-1)!.slot,
      tip_slot: tip.slot,
      lag_slots: tip.slot - main.at(-1)!.slot,
    });
    expect(res.body.error).toBe(f.errors[0]);

    expect(f.cache.getCursor()).toEqual(savedPointOf(main.at(-1)!));
    expect(f.cache.listEventsAfterSlot(0).map((e) => e.utxo_ref)).toEqual(main.map(advertRefOf));
  });

  it("RESYNC_FROM_* at a block of the current chain recovers the follower", async () => {
    const { server, f, main, fork } = await lostIntersection();
    f.worker.stop();

    // The operator sets RESYNC_FROM_* to the last common block and restarts the indexer.
    const common = fork[main.length - INTERSECTION_POINTS - 2]!;
    expect(main[main.length - INTERSECTION_POINTS - 2]!.id).toBe(common.id);
    expect(f.cache.applyResync({ slot: common.slot, blockHash: common.id })).toBe(true);
    const g = follower(server, f.cache, {}, false);
    await g.worker.start();
    await syncedTo(g, fork.at(-1)!, "the sync of the fork");

    expect(server.intersectRequests.at(-1)).toEqual([pointOf(common)]);
    expect(g.errors).toEqual([]);
    expect(g.worker.getHealth().state).toBe("following");
    expect(f.cache.listEventsAfterSlot(0).map((e) => e.utxo_ref)).toEqual(fork.map(advertRefOf));
    const app = createApp({ cache: g.cache, worker: g.worker });
    expect((await request(app).get("/healthz")).body).toMatchObject({ ok: true, follower: "following", lag_slots: 0 });
  });
});

// ─── Health lag ───────────────────────────────────────────────────────────────

describe("health lag", () => {
  it("queryNetwork/tip moves the tip while chain-sync waits; ok turns false over MAX_SYNC_LAG_SLOTS", async () => {
    const main = extend([], "a", 5);
    const server = await startServer(main);
    const f = follower(server, new SqliteCache(":memory:"), { tipPollMs: 20 });
    await f.worker.start();
    await syncedTo(f, main.at(-1)!, "the sync");
    const app = createApp({ cache: f.cache, worker: f.worker }, { maxSyncLagSlots: 600 });
    expect((await request(app).get("/healthz")).body).toMatchObject({ ok: true, lag_slots: 0, follower: "following" });

    // The chain goes on 610 slots; chain-sync delivers nothing.
    const later = extend(main, "a", 61).slice(main.length);
    server.growTipOnly(later);
    await until(() => f.worker.getHealth().tip?.slot === later.at(-1)!.slot, "a queryNetwork/tip report");
    expect((await request(app).get("/healthz")).body).toMatchObject({
      ok: false,
      follower: "following",
      sync_slot: main.at(-1)!.slot,
      tip_slot: later.at(-1)!.slot,
      lag_slots: 610,
      max_sync_lag_slots: 600,
    });
  });
});
