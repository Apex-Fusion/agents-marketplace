/**
 * indexer/src/routes/events.ts — long-lived multiplexed SSE stream.
 *
 * Clients connect to GET /events?stream=1 and receive a text/event-stream
 * response that stays open until they disconnect. Each marketplace event is
 * sent as:
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * Optional: ?since_slot=N — replays buffered events from cache with slot > N
 * BEFORE the connection joins the live worker stream. Both replayed and live
 * events serialize to the same ChainEventPayload shape (note: `ref`, not
 * `utxo_ref`).
 *
 * Optional: ?limit=N — caps the replay to the most recent N buffered events
 * (chronological ASC). When combined with `since_slot`, the slot filter runs
 * first and `limit` then trims to the most recent N matches. Useful for the
 * indexer-ui EventsLog seed: `?stream=1&limit=10` to start with the last 10
 * historical events and stream live additions from there.
 *
 * Heartbeat: every `heartbeatMs` ms (default 25 s) the server writes a
 * `: keepalive\n\n` SSE comment frame to all open connections, keeping the
 * connection alive through proxies and revealing dead clients eagerly.
 *
 * Per-connection listeners are attached to the worker's EventEmitter on
 * connect and removed on `close` so disconnected clients neither receive
 * future events nor cause "write after end" errors.
 */

import { Router, type Request, type Response } from "express";
import type { EventEmitter } from "events";
import type { SqliteCache } from "../db/cache.js";

export interface EventsDeps {
  cache: SqliteCache;
  /**
   * Milliseconds between SSE keepalive heartbeat comment frames.
   * Default: 25_000 (25 s). Tests may pass a low value (e.g. 50ms) to verify
   * heartbeat behaviour without waiting wall-clock seconds.
   */
  heartbeatMs?: number;
}

interface ChainEventPayload {
  type: string;
  ref: string;
  slot: number;
  txHash?: string;
  address?: string;
}

interface SyncProgressPayload {
  type: "sync-progress";
  slot: number;
  tipSlot?: number;
  percentage?: number;
}

/**
 * Builds a router exposing GET /events. Each request opens a long-lived
 * SSE stream. Replay-then-live ordering is preserved.
 *
 * Returns the router; tests/shutdown can close the underlying HTTP server
 * to drain connections.
 */
export function eventsRouter(workerEmitter: EventEmitter, deps: EventsDeps): {
  router: Router;
} {
  const router = Router();
  const heartbeatMs = deps.heartbeatMs ?? 25_000;

  router.get("/events", (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Initial connect comment — primes the stream so clients (and proxies)
    // see the response start immediately.
    res.write(": connected\n\n");

    // ─── Replay (synchronous; must complete before joining live stream) ──
    const sinceSlotRaw = req.query.since_slot;
    const limitRaw = req.query.limit;
    const limit = parsePositiveInt(limitRaw);
    const sinceSlot = parseNonNegativeInt(sinceSlotRaw);

    if (sinceSlot !== null || limit !== null) {
      try {
        let past: ReturnType<typeof deps.cache.listEventsAfterSlot>;
        if (sinceSlot !== null) {
          past = deps.cache.listEventsAfterSlot(sinceSlot);
          if (limit !== null && past.length > limit) {
            // Keep the most recent `limit` matches; preserve chronological ASC.
            past = past.slice(past.length - limit);
          }
        } else {
          past = deps.cache.listRecentEvents(limit!);
        }
        for (const ev of past) {
          const payload: ChainEventPayload = {
            type: ev.type,
            ref: ev.utxo_ref,
            slot: ev.slot,
            txHash: ev.tx_hash,
          };
          writeSafely(res, `event: ${ev.type}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      } catch (err) {
        console.warn(
          `[events] replay failed (since_slot=${sinceSlotRaw}, limit=${limitRaw}): ${(err as Error).message}`,
        );
      }
    }

    // ─── Live: per-connection listeners on the worker emitter ────────────
    const onChainEvent = (payload: ChainEventPayload): void => {
      const safe: ChainEventPayload = {
        type: payload.type,
        ref: payload.ref,
        slot: payload.slot,
        txHash: payload.txHash,
        address: payload.address,
      };
      writeSafely(res, `event: ${payload.type}\ndata: ${JSON.stringify(safe)}\n\n`);
    };

    const onSyncProgress = (payload: { currentSlot?: number; slot?: number; tipSlot?: number }): void => {
      // Worker emits { currentSlot, tipSlot }; older code shape was { slot, tipSlot }.
      // Map both to `slot` on the wire so the UI's EventsLog doesn't render "slot 0".
      const slot = payload.currentSlot ?? payload.slot ?? 0;
      const tipSlot = payload.tipSlot ?? 0;
      const safe: SyncProgressPayload = {
        type: "sync-progress",
        slot,
        tipSlot,
        percentage: tipSlot > 0 ? Math.min(100, Math.round((slot / tipSlot) * 100)) : 0,
      };
      writeSafely(res, `event: sync-progress\ndata: ${JSON.stringify(safe)}\n\n`);
    };

    workerEmitter.on("chain-event", onChainEvent);
    workerEmitter.on("sync-progress", onSyncProgress);

    // ─── Heartbeat keepalive ─────────────────────────────────────────────
    const heartbeat = setInterval(() => {
      writeSafely(res, ": keepalive\n\n");
    }, heartbeatMs);
    // Don't keep the Node event loop alive solely for the heartbeat.
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === "function") {
      (heartbeat as unknown as { unref: () => void }).unref();
    }

    // ─── Cleanup on disconnect ───────────────────────────────────────────
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      workerEmitter.off("chain-event", onChainEvent);
      workerEmitter.off("sync-progress", onSyncProgress);
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  return { router };
}

function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Best-effort write to an SSE response. If the underlying socket is gone
 * (e.g. client just disconnected and cleanup hasn't fired yet), swallow the
 * error so we don't tear down the process.
 */
function writeSafely(res: Response, chunk: string): void {
  try {
    if (res.writableEnded || res.destroyed) return;
    res.write(chunk);
  } catch {
    // Connection already closed; the close handler will clean up.
  }
}
