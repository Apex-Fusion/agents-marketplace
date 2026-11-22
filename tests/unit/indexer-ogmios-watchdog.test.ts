/**
 * tests/unit/indexer-ogmios-watchdog.test.ts — the response watchdog of OgmiosSource.
 *
 * Covers `indexer/src/follower/ogmiosSource.ts`, `armWatchdog` (a chain-sync request that gets no answer within
 * `responseTimeoutMs` closes the socket) and the reconnect that follows (`onclose`, `scheduleReconnect`, `sendFindIntersection`).
 * This is the failure of the live incident behind `indexer-routes.test.ts` (healthz lag): Ogmios keeps the TCP connection
 * but sends no more chain-sync answers. Every other source test passes `responseTimeoutMs: 0`, which switches the watchdog off.
 *
 * The source runs against FakeOgmiosServer. At the tip the fake server leaves a nextBlock request unanswered, as Ogmios does
 * while it waits for the next block; here the wait never ends.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { OgmiosSource } from "../../indexer/src/follower/ogmiosSource.js";
import { FakeOgmiosServer, type FakeBlock } from "./__helpers__/FakeOgmiosServer.js";

const tipBlock: FakeBlock = {
  type: "praos",
  era: "conway",
  id: "a".repeat(64),
  ancestor: "genesis",
  height: 1,
  slot: 1_010,
  transactions: [],
};
const saved = { slot: tipBlock.slot, id: tipBlock.id };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("OgmiosSource — response watchdog", () => {
  it("closes a connection whose nextBlock request gets no answer, connects again and sends findIntersection from the saved points", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await FakeOgmiosServer.start([tipBlock]);
    cleanups.push(() => server.close());
    const source = new OgmiosSource(server.url, { responseTimeoutMs: 50, tipPollMs: 0, reconnectBackoffMs: 5 });
    cleanups.push(() => source.stop());
    const connection: string[] = [];
    source.on("connected", () => connection.push("connected"));
    source.on("disconnected", () => connection.push("disconnected"));
    source.on("error", () => {});
    // The worker asks for the next block after each answer. Here it asks once, after the rollback to the saved point.
    source.on("rollback", () => source.requestNextBlock());

    await source.start(() => [saved]);
    await vi.waitFor(() => expect(server.intersectRequests.length).toBeGreaterThanOrEqual(2), { timeout: 5_000, interval: 5 });

    // The saved points go out again after the forced reconnect: chain-sync restarts from where the follower stands.
    expect(server.intersectRequests.slice(0, 2)).toEqual([[saved], [saved]]);
    expect(connection.slice(0, 3)).toEqual(["connected", "disconnected", "connected"]);
  });
});
