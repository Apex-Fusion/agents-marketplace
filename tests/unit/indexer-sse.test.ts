/**
 * tests/unit/indexer-sse.test.ts — the long-lived event stream, GET /events (M1-D-fix).
 *
 * A real HTTP server, a real in-memory cache, and the `eventsource` client. Not supertest: it buffers the response, so an open
 * stream never delivers. A test never sleeps. It waits for the connection to open (the route attaches its listeners to the
 * worker before the client sees the headers), then for each message or comment.
 *
 * Contract:
 *   - the stream stays open until the client leaves; the first frame is the comment `: connected`;
 *   - `?since_slot=N` replays the stored events with slot > N before any live event;
 *   - each worker `chain-event` and `sync-progress` goes to every open client, as `event: <type>\ndata: <json>\n\n`;
 *   - a keepalive comment `: keepalive` goes out every `heartbeatMs`;
 *   - a client that left gets no event, and its listeners leave the worker.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import EventSource from "eventsource";

import { SqliteCache } from "../../indexer/src/db/cache.js";
import { createApp } from "../../indexer/src/server.js";
import type { IndexerDeps } from "../../indexer/src/server.js";

// ─── Harness ──────────────────────────────────────────────────────────────────

/** The three events that the cache holds (slots 3, 5, 7). */
const STORED = [
  { type: "PostAdvert", slot: 3, digit: "1" },
  { type: "PostEscrow", slot: 5, digit: "2" },
  { type: "ClaimEscrow", slot: 7, digit: "3" },
].map(({ type, slot, digit }) => ({
  type,
  slot,
  tx_hash: digit.repeat(64),
  utxo_ref: `${digit.repeat(64)}#0`,
  datum_hex: "aa",
  metadata_json: "{}",
  rolled_back: 0,
}));

/** The worker is a bare emitter: the route only calls `on`, `off` and `emit` on it. */
function makeDeps(): { deps: IndexerDeps; worker: EventEmitter } {
  const cache = new SqliteCache(":memory:");
  cleanups.push(() => cache.close());
  for (const event of STORED) cache.appendEvent(event);
  const worker = new EventEmitter();
  return { deps: { cache, worker: worker as unknown as IndexerDeps["worker"] }, worker };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** Serve the app on an ephemeral port; returns the URL of the stream. */
async function startServer(deps: IndexerDeps, heartbeatMs = 25_000): Promise<string> {
  const server = http.createServer(createApp(deps, { heartbeatMs }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/events?stream=1`;
}

const EVENT_TYPES = ["PostAdvert", "PostEscrow", "ClaimEscrow", "AcceptEscrow", "sync-progress"];
const WAIT = { timeout: 2_000, interval: 5 };

interface Client {
  /** Each message in arrival order: the event name and the parsed data. */
  messages: Array<{ type: string; data: unknown }>;
  /** Resolves when `count` messages arrived. */
  received(count: number): Promise<void>;
  close(): void;
}

/** Open the stream with an EventSource. Resolves when the server accepted it: its listeners are on the worker by then. */
function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(url);
    cleanups.push(() => source.close());
    const messages: Client["messages"] = [];
    for (const type of EVENT_TYPES) {
      (source as unknown as EventTarget).addEventListener(type, ((event: MessageEvent) => {
        messages.push({ type: event.type, data: JSON.parse(event.data) });
      }) as EventListener);
    }
    source.onerror = () => reject(new Error("the event stream did not open"));
    source.onopen = () =>
      resolve({
        messages,
        received: (count) =>
          vi.waitFor(() => {
            if (messages.length < count) throw new Error(`${messages.length} of ${count} messages arrived`);
          }, WAIT),
        close: () => source.close(),
      });
  });
}

interface RawStream {
  statusCode?: number;
  headers: IncomingHttpHeaders;
  /** Everything that the server has written so far. */
  body(): string;
}

/** Open the stream with a plain HTTP request. Resolves at the response headers; the body grows as the server writes. */
function openRaw(url: string): Promise<RawStream> {
  return new Promise((resolve, reject) => {
    let body = "";
    const req = http.get(url, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      resolve({ statusCode: res.statusCode, headers: res.headers, body: () => body });
    });
    cleanups.push(() => req.destroy());
    req.on("error", reject);
  });
}

const event = (type: string, ref: string, slot: number) => ({ type, ref: `${ref.repeat(64)}#0`, slot });

// ─── The stream ───────────────────────────────────────────────────────────────

describe("GET /events", () => {
  it("opens a long-lived text/event-stream and sends ': connected' first", async () => {
    const raw = await openRaw(await startServer(makeDeps().deps));

    await vi.waitFor(() => expect(raw.body()).toContain(": connected\n\n"), WAIT);

    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(raw.headers["cache-control"]).toBe("no-cache");
    expect(raw.headers["x-accel-buffering"]).toBe("no");
    expect(raw.body().startsWith(": connected\n\n")).toBe(true);
  });

  it("sends every worker chain-event to every open client, named by its type, in order", async () => {
    const { deps, worker } = makeDeps();
    const url = await startServer(deps);
    const first = await connect(url);
    const second = await connect(url);

    const events = [
      event("PostEscrow", "a", 1_001_000),
      event("ClaimEscrow", "b", 1_001_100),
      event("AcceptEscrow", "c", 1_001_200),
    ];
    for (const e of events) worker.emit("chain-event", e);
    await Promise.all([first.received(3), second.received(3)]);

    const expected = events.map((e) => ({ type: e.type, data: e }));
    expect(first.messages).toEqual(expected);
    expect(second.messages).toEqual(expected);
  });

  it.each([
    { name: "currentSlot, the shape that the worker emits", emitted: { currentSlot: 500, tipSlot: 1_000 } },
    { name: "slot, the older shape", emitted: { slot: 500, tipSlot: 1_000 } },
  ])("forwards a worker sync-progress as event: sync-progress ($name)", async ({ emitted }) => {
    const { deps, worker } = makeDeps();
    const client = await connect(await startServer(deps));

    worker.emit("sync-progress", emitted);
    await client.received(1);

    expect(client.messages).toEqual([
      { type: "sync-progress", data: { type: "sync-progress", slot: 500, tipSlot: 1_000, percentage: 50 } },
    ]);
  });

  it("stops sending to a client that left and removes its listeners; the other client keeps its stream", async () => {
    const { deps, worker } = makeDeps();
    const url = await startServer(deps);
    // createApp keeps one listener of its own for each event.
    const base = { chain: worker.listenerCount("chain-event"), progress: worker.listenerCount("sync-progress") };
    const leaving = await connect(url);
    const staying = await connect(url);
    expect(worker.listenerCount("chain-event")).toBe(base.chain + 2);
    expect(worker.listenerCount("sync-progress")).toBe(base.progress + 2);

    leaving.close();
    await vi.waitFor(() => expect(worker.listenerCount("chain-event")).toBe(base.chain + 1), WAIT);
    worker.emit("chain-event", event("ClaimEscrow", "f", 1_003_100));
    await staying.received(1);

    expect(staying.messages).toEqual([{ type: "ClaimEscrow", data: event("ClaimEscrow", "f", 1_003_100) }]);
    expect(leaving.messages).toEqual([]);

    staying.close();
    await vi.waitFor(() => {
      expect(worker.listenerCount("chain-event")).toBe(base.chain);
      expect(worker.listenerCount("sync-progress")).toBe(base.progress);
    }, WAIT);
  });

  it("sends a ': keepalive' comment every heartbeatMs", async () => {
    const raw = await openRaw(await startServer(makeDeps().deps, 10));

    await vi.waitFor(() => expect(raw.body().match(/: keepalive\n\n/g) ?? []).toHaveLength(2), WAIT);

    expect(raw.body().startsWith(": connected\n\n: keepalive\n\n: keepalive\n\n")).toBe(true);
  });
});

// ─── Replay ───────────────────────────────────────────────────────────────────

describe("GET /events?since_slot=N", () => {
  it.each([
    { query: "", replayed: [] as string[] },
    { query: "&since_slot=0", replayed: ["PostAdvert", "PostEscrow", "ClaimEscrow"] },
    { query: "&since_slot=5", replayed: ["ClaimEscrow"] },
  ])("replays the stored events with slot > N before any live event (query '$query')", async ({ query, replayed }) => {
    const { deps, worker } = makeDeps();
    const client = await connect(`${await startServer(deps)}${query}`);

    // The route writes the replay before it joins the live stream, so a live event that follows `open` comes last.
    worker.emit("chain-event", event("AcceptEscrow", "d", 100));
    await client.received(replayed.length + 1);

    expect(client.messages.map((m) => m.type)).toEqual([...replayed, "AcceptEscrow"]);
    const stored = STORED.filter((e) => replayed.includes(e.type));
    expect(client.messages.slice(0, replayed.length).map((m) => m.data)).toEqual(
      stored.map((e) => ({ type: e.type, ref: e.utxo_ref, slot: e.slot, txHash: e.tx_hash })),
    );
  });
});
