/**
 * tests/unit/indexer-sse.test.ts — long-lived multiplexed SSE stream tests (M1-D-fix)
 *
 * Tests GET /events?stream=1 using a real ephemeral HTTP server + eventsource client.
 * DO NOT use supertest for these tests — supertest aggressively buffers responses
 * and breaks SSE (the stream never delivers events to the test listener).
 *
 * DELETED (from old degenerate one-shot contract):
 *   - "GET /events?stream=1 returns Content-Type: text/event-stream" (supertest version)
 *   - "GET /events?stream=1 returns Cache-Control: no-cache" (supertest version)
 *   - "SSE event wire format is 'event: <type>\\ndata: <json>\\n\\n'" (format-only stub)
 *   - "SSE payload includes required fields: type, ref, slot" (shape-only stub)
 *   - "chain-event emitted by worker is written to connected SSE client" (listener-count only)
 *   - "createApp wires at least one listener on worker 'chain-event' event" (listener-count only)
 *   - "cache.listEventsAfterSlot is called with the correct slot value (500)" (supertest version)
 *   - "GET /events?stream=1&since_slot=0 triggers replay from slot 0" (supertest version)
 *   - "createApp wires worker 'chain-event' listener — no memory leak after mount"
 *   - "after disconnect, emitting chain-event does not throw"
 * Reason: all of the above encoded a degenerate one-shot SSE contract (res.end() immediately).
 * The new tests require a real long-lived stream.
 *
 * New contract (per M1-D-fix spec):
 *   - Connection stays open until client disconnects
 *   - Initial `: connected` comment heartbeat on connect
 *   - Live chain-events pushed to all open clients as `event: <type>\ndata: <json>\n\n`
 *   - sync-progress pushed as `event: sync-progress\ndata: <json>\n\n`
 *   - Two concurrent clients both receive an event
 *   - Disconnect one client; remaining client still receives events; no error thrown
 *   - Heartbeat comment `: keepalive\n\n` sent every heartbeatMs (configurable, default 25s)
 *   - ?since_slot=N replay sends buffered events with slot > N before live events
 *   - Response headers: Content-Type text/event-stream, Cache-Control no-cache, X-Accel-Buffering no
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "events";
import http from "http";
import EventSource from "eventsource";

import { createApp } from "../../indexer/src/server.js";
import type { IndexerDeps } from "../../indexer/src/server.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parsed SSE line: either a comment, a field:value pair, or a blank dispatch boundary. */
interface ParsedSSELine {
  type: "comment" | "field" | "blank";
  raw: string;
  field?: string;
  value?: string;
}

/**
 * Minimal SSE stream parser over a raw text chunk.
 * Returns each line parsed.
 */
function parseSSELines(chunk: string): ParsedSSELine[] {
  return chunk.split("\n").map((raw) => {
    if (raw.startsWith(":")) return { type: "comment", raw };
    if (raw === "") return { type: "blank", raw };
    const colon = raw.indexOf(":");
    if (colon === -1) return { type: "field", raw, field: raw, value: "" };
    return { type: "field", raw, field: raw.slice(0, colon), value: raw.slice(colon + 1).trimStart() };
  });
}

/** Build a mock IndexerDeps with a configurable heartbeatMs. */
function makeDeps(opts: {
  heartbeatMs?: number;
  eventsAfterSlot?: Array<{ id: number; type: string; slot: number; tx_hash: string; utxo_ref: string; datum_hex: string; metadata_json: string; rolled_back: number }>;
} = {}): { deps: IndexerDeps; workerEmitter: EventEmitter } {
  const workerEmitter = new EventEmitter();
  const eventsAfterSlot = opts.eventsAfterSlot ?? [];

  const cache = {
    listActiveAdvertisements: vi.fn(() => []),
    getAdvertisementByRef: vi.fn(() => null),
    getEscrowByRef: vi.fn(() => null),
    listEscrowsByBuyer: vi.fn(() => []),
    listEscrowsBySupplier: vi.fn(() => []),
    getSupplierStatus: vi.fn(() => null),
    listEventsAfterSlot: vi.fn(() => eventsAfterSlot),
    dbSizeBytes: vi.fn(() => 4096),
  } as unknown as IndexerDeps["cache"];

  const worker = {
    getCurrentSlot: vi.fn(() => 1_000_000),
    getTipSlot: vi.fn(() => 1_001_000),
    on: workerEmitter.on.bind(workerEmitter),
    emit: workerEmitter.emit.bind(workerEmitter),
    off: workerEmitter.off.bind(workerEmitter),
  } as unknown as IndexerDeps["worker"];

  return { deps: { cache, worker }, workerEmitter };
}

/**
 * Start a real ephemeral HTTP server on port 0.
 * Returns { server, port, close }.
 * The server must be closed after each test.
 */
async function startServer(deps: IndexerDeps, heartbeatMs?: number): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const app = createApp(deps, { heartbeatMs: heartbeatMs ?? 25_000 });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  return { server, port: addr.port, close };
}

/**
 * Open an EventSource to the given URL and collect messages until `count`
 * messages have been received or `timeoutMs` elapses.
 * Returns { messages, es } — caller must close the EventSource.
 *
 * onerror is treated as a soft end (server closed the connection before we
 * got `count` messages). Tests assert the message count; if the server closes
 * prematurely the assertion will fail with a meaningful message rather than
 * throwing an unhandled rejection.
 */
function collectMessages(
  url: string,
  count: number,
  timeoutMs = 2000,
): Promise<{ messages: MessageEvent[]; es: EventSource }> {
  return new Promise((resolve) => {
    const messages: MessageEvent[] = [];
    const es = new EventSource(url) as EventSource & { close(): void };

    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve({ messages, es });
      }
    };
    const timer = setTimeout(finish, timeoutMs);

    const onmessage = (ev: MessageEvent) => {
      messages.push(ev);
      if (messages.length >= count) {
        clearTimeout(timer);
        finish();
      }
    };

    es.onmessage = onmessage;
    // Also listen for named events (our events have `event:` fields)
    [
      "PostAdvert", "UpdateAdvert", "RetireAdvert",
      "PostEscrow", "ClaimEscrow", "SubmitEscrow",
      "AcceptEscrow", "ReclaimEscrow", "ReleaseEscrow",
      "sync-progress",
    ].forEach((type) => {
      (es as unknown as EventTarget).addEventListener(type, onmessage as EventListener);
    });

    // Treat onerror as a premature close — resolve with whatever was collected.
    // The calling test will fail on the message count assertion if the server
    // closed before delivering all expected events (RED phase behaviour).
    es.onerror = () => {
      clearTimeout(timer);
      finish();
    };
  });
}

/**
 * Collect raw bytes from an HTTP response until timeoutMs elapses.
 * Used for header verification and raw stream parsing.
 */
function collectRaw(url: string, timeoutMs: number): Promise<{ statusCode?: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      const timer = setTimeout(() => {
        req.destroy();
        resolve({ statusCode: res.statusCode, headers: res.headers as Record<string, string | string[] | undefined>, body });
      }, timeoutMs);
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => { clearTimeout(timer); resolve({ statusCode: res.statusCode, headers: res.headers as Record<string, string | string[] | undefined>, body }); });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    req.on("error", reject);
  });
}

// ─── Test cleanup ────────────────────────────────────────────────────────────

const serversToClose: Array<() => Promise<void>> = [];
const esourcesToClose: EventSource[] = [];

afterEach(async () => {
  for (const es of esourcesToClose.splice(0)) {
    try { (es as unknown as { close(): void }).close(); } catch { /* ignore */ }
  }
  for (const close of serversToClose.splice(0)) {
    await close().catch(() => { /* ignore */ });
  }
  vi.restoreAllMocks();
});

// ─── Response headers ────────────────────────────────────────────────────────

describe("GET /events?stream=1 — response headers", () => {
  it("Content-Type is text/event-stream", async () => {
    const { deps } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const { headers } = await collectRaw(`http://127.0.0.1:${port}/events?stream=1`, 300);
    expect(headers["content-type"]).toMatch(/text\/event-stream/);
  });

  it("Cache-Control is no-cache", async () => {
    const { deps } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const { headers } = await collectRaw(`http://127.0.0.1:${port}/events?stream=1`, 300);
    expect(headers["cache-control"]).toBe("no-cache");
  });

  it("X-Accel-Buffering is no", async () => {
    const { deps } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const { headers } = await collectRaw(`http://127.0.0.1:${port}/events?stream=1`, 300);
    expect(headers["x-accel-buffering"]).toBe("no");
  });
});

// ─── Initial heartbeat comment ───────────────────────────────────────────────

describe("GET /events?stream=1 — initial heartbeat comment", () => {
  it("server sends ': connected' comment immediately on connect", async () => {
    const { deps } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const { body } = await collectRaw(`http://127.0.0.1:${port}/events?stream=1`, 300);
    expect(body).toContain(": connected");
  });
});

// ─── Single client receives live chain-events ─────────────────────────────────

describe("GET /events?stream=1 — single client receives live chain-events", () => {
  it("worker chain-event is forwarded to connected client as named SSE event", async () => {
    const { deps, workerEmitter } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const url = `http://127.0.0.1:${port}/events?stream=1`;
    const collectPromise = collectMessages(url, 1, 1500);

    // Give the EventSource time to connect before emitting
    await new Promise<void>((r) => setTimeout(r, 100));

    workerEmitter.emit("chain-event", {
      type: "PostAdvert",
      ref: "a".repeat(64) + "#0",
      slot: 1_000_000,
    });

    const { messages, es } = await collectPromise;
    esourcesToClose.push(es);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(messages[0].data);
    expect(parsed.type).toBe("PostAdvert");
    expect(parsed.slot).toBe(1_000_000);
  });

  it("multiple chain-events are all received by the client in order", async () => {
    const { deps, workerEmitter } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const url = `http://127.0.0.1:${port}/events?stream=1`;
    const collectPromise = collectMessages(url, 3, 1500);

    await new Promise<void>((r) => setTimeout(r, 100));

    const events = [
      { type: "PostEscrow", ref: "a".repeat(64) + "#0", slot: 1_001_000 },
      { type: "ClaimEscrow", ref: "b".repeat(64) + "#0", slot: 1_001_100 },
      { type: "AcceptEscrow", ref: "c".repeat(64) + "#0", slot: 1_001_200 },
    ];
    for (const ev of events) {
      workerEmitter.emit("chain-event", ev);
    }

    const { messages, es } = await collectPromise;
    esourcesToClose.push(es);

    expect(messages.length).toBe(3);
    expect(JSON.parse(messages[0].data).type).toBe("PostEscrow");
    expect(JSON.parse(messages[1].data).type).toBe("ClaimEscrow");
    expect(JSON.parse(messages[2].data).type).toBe("AcceptEscrow");
  });
});

// ─── Fan-out: two concurrent clients ─────────────────────────────────────────

describe("GET /events?stream=1 — fan-out to multiple clients", () => {
  it("two concurrent clients both receive a single chain-event", async () => {
    const { deps, workerEmitter } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const url = `http://127.0.0.1:${port}/events?stream=1`;
    const p1 = collectMessages(url, 1, 1500);
    const p2 = collectMessages(url, 1, 1500);

    await new Promise<void>((r) => setTimeout(r, 150));

    workerEmitter.emit("chain-event", {
      type: "SubmitEscrow",
      ref: "d".repeat(64) + "#0",
      slot: 1_002_000,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    esourcesToClose.push(r1.es, r2.es);

    expect(r1.messages.length).toBeGreaterThanOrEqual(1);
    expect(r2.messages.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(r1.messages[0].data).type).toBe("SubmitEscrow");
    expect(JSON.parse(r2.messages[0].data).type).toBe("SubmitEscrow");
  });
});

// ─── Client disconnect: no error on subsequent emit ───────────────────────────

describe("GET /events?stream=1 — client disconnect cleanup", () => {
  it("after one client disconnects, remaining client still receives events without error", async () => {
    const { deps, workerEmitter } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const url = `http://127.0.0.1:${port}/events?stream=1`;

    // Open two clients
    const p1 = collectMessages(url, 1, 1500);
    const p2 = collectMessages(url, 2, 1500);

    await new Promise<void>((r) => setTimeout(r, 150));

    // First event — both clients receive it
    workerEmitter.emit("chain-event", {
      type: "PostAdvert",
      ref: "e".repeat(64) + "#0",
      slot: 1_003_000,
    });

    const { messages: m1, es: es1 } = await p1;
    expect(m1.length).toBeGreaterThanOrEqual(1);

    // Disconnect client 1
    (es1 as unknown as { close(): void }).close();

    await new Promise<void>((r) => setTimeout(r, 100));

    // Second event — only client 2 should receive it (no throw for client 1)
    workerEmitter.emit("chain-event", {
      type: "ClaimEscrow",
      ref: "f".repeat(64) + "#0",
      slot: 1_003_100,
    });

    const { messages: m2, es: es2 } = await p2;
    esourcesToClose.push(es2);

    // client 2 must have received both events
    expect(m2.length).toBe(2);
    expect(JSON.parse(m2[1].data).type).toBe("ClaimEscrow");
  });

  it("emitting chain-event with zero clients connected does not throw", async () => {
    const { deps, workerEmitter } = makeDeps();
    const { close } = await startServer(deps);
    serversToClose.push(close);

    // No clients connected
    expect(() => {
      workerEmitter.emit("chain-event", {
        type: "PostAdvert",
        ref: "g".repeat(64) + "#0",
        slot: 1_004_000,
      });
    }).not.toThrow();
  });
});

// ─── Heartbeat keepalive ──────────────────────────────────────────────────────

describe("GET /events?stream=1 — heartbeat keepalive", () => {
  it("server sends at least 2 ': keepalive' comment lines within 120ms with 50ms heartbeatMs", async () => {
    const { deps } = makeDeps();
    // Use a 50ms heartbeat so we can test within a short window
    const { port, close } = await startServer(deps, 50);
    serversToClose.push(close);

    const { body } = await collectRaw(`http://127.0.0.1:${port}/events?stream=1`, 130);
    const keepaliveCount = (body.match(/: keepalive/g) ?? []).length;
    expect(keepaliveCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── ?since_slot=N replay ────────────────────────────────────────────────────

describe("GET /events?since_slot=N — replay before live events", () => {
  it("events with slot > since_slot are replayed before any live events arrive", async () => {
    const storedEvents = [
      { id: 1, type: "PostAdvert",  slot: 3, tx_hash: "a".repeat(64), utxo_ref: "a".repeat(64) + "#0", datum_hex: "aa", metadata_json: "{}", rolled_back: 0 },
      { id: 2, type: "PostEscrow",  slot: 5, tx_hash: "b".repeat(64), utxo_ref: "b".repeat(64) + "#0", datum_hex: "bb", metadata_json: "{}", rolled_back: 0 },
      { id: 3, type: "ClaimEscrow", slot: 7, tx_hash: "c".repeat(64), utxo_ref: "c".repeat(64) + "#0", datum_hex: "cc", metadata_json: "{}", rolled_back: 0 },
    ];
    const { deps } = makeDeps({ eventsAfterSlot: storedEvents });
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    // since_slot=2 → should replay all 3 events (slots 3, 5, 7 are all > 2)
    const collectPromise = collectMessages(
      `http://127.0.0.1:${port}/events?stream=1&since_slot=2`,
      3,
      1500,
    );

    const { messages, es } = await collectPromise;
    esourcesToClose.push(es);

    expect(messages.length).toBe(3);
    expect(JSON.parse(messages[0].data).type).toBe("PostAdvert");
    expect(JSON.parse(messages[1].data).type).toBe("PostEscrow");
    expect(JSON.parse(messages[2].data).type).toBe("ClaimEscrow");
  });

  it("cache.listEventsAfterSlot is called with the correct slot value", async () => {
    const { deps } = makeDeps();
    const spy = vi.spyOn(deps.cache, "listEventsAfterSlot").mockReturnValue([]);
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const { body } = await collectRaw(`http://127.0.0.1:${port}/events?stream=1&since_slot=500`, 300);
    void body; // we only care that the spy was called

    expect(spy).toHaveBeenCalledWith(500);
  });

  it("since_slot=0 triggers replay from slot 0", async () => {
    const { deps } = makeDeps();
    const spy = vi.spyOn(deps.cache, "listEventsAfterSlot").mockReturnValue([]);
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    await collectRaw(`http://127.0.0.1:${port}/events?stream=1&since_slot=0`, 300);
    expect(spy).toHaveBeenCalledWith(0);
  });

  it("replayed events arrive BEFORE a subsequent live chain-event", async () => {
    const stored = [
      { id: 1, type: "PostAdvert", slot: 10, tx_hash: "a".repeat(64), utxo_ref: "a".repeat(64) + "#0", datum_hex: "aa", metadata_json: "{}", rolled_back: 0 },
    ];
    const { deps, workerEmitter } = makeDeps({ eventsAfterSlot: stored });
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const collectPromise = collectMessages(
      `http://127.0.0.1:${port}/events?stream=1&since_slot=5`,
      2,
      1500,
    );

    // Wait for connection + replay to complete, then emit live
    await new Promise<void>((r) => setTimeout(r, 200));
    workerEmitter.emit("chain-event", {
      type: "ClaimEscrow",
      ref: "b".repeat(64) + "#0",
      slot: 100,
    });

    const { messages, es } = await collectPromise;
    esourcesToClose.push(es);

    expect(messages.length).toBe(2);
    // Replayed event must come first
    expect(JSON.parse(messages[0].data).type).toBe("PostAdvert");
    expect(JSON.parse(messages[1].data).type).toBe("ClaimEscrow");
  });
});

// ─── sync-progress event ─────────────────────────────────────────────────────

describe("GET /events?stream=1 — sync-progress forwarding", () => {
  it("worker sync-progress event is forwarded as event: sync-progress", async () => {
    const { deps, workerEmitter } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    const url = `http://127.0.0.1:${port}/events?stream=1`;
    const collectPromise = collectMessages(url, 1, 1500);

    await new Promise<void>((r) => setTimeout(r, 100));

    workerEmitter.emit("sync-progress", {
      slot: 1_000_500,
      tipSlot: 1_001_000,
      percentage: 99.5,
    });

    const { messages, es } = await collectPromise;
    esourcesToClose.push(es);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(messages[0].data);
    expect(parsed.slot).toBe(1_000_500);
  });
});

// ─── SSE wire format contract ─────────────────────────────────────────────────

describe("GET /events?stream=1 — SSE wire format", () => {
  it("each event arrives as 'event: <type>\\ndata: <json>\\n\\n' in the raw stream", async () => {
    const { deps, workerEmitter } = makeDeps();
    const { port, close } = await startServer(deps);
    serversToClose.push(close);

    let rawBody = "";
    const rawDone = new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/events?stream=1`, (res) => {
        res.on("data", (chunk: Buffer) => {
          rawBody += chunk.toString();
          if (rawBody.includes("data: ")) resolve();
        });
      });
      req.on("error", () => resolve());
      setTimeout(() => { req.destroy(); resolve(); }, 1000);
    });

    await new Promise<void>((r) => setTimeout(r, 100));
    workerEmitter.emit("chain-event", {
      type: "PostAdvert",
      ref: "a".repeat(64) + "#0",
      slot: 999,
    });

    await rawDone;

    // Must contain the SSE event lines
    expect(rawBody).toMatch(/event: PostAdvert/);
    expect(rawBody).toMatch(/data: \{.*"type".*"PostAdvert".*\}/);
  });
});
