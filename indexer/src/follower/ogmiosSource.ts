/**
 * indexer/src/follower/ogmiosSource.ts — Ogmios WebSocket ChainSyncSource.
 *
 * Production implementation of ChainSyncSource over an Ogmios v6 WebSocket.
 * Worker tests inject MockChainSyncSource; the source tests run this class
 * against a local WebSocket server that answers like Ogmios.
 *
 * Each Ogmios v6 block is converted to an IndexerBlock (ogmiosBlock.ts) before
 * it is emitted: failed transactions are left out and spend redeemers are
 * keyed by the spent output.
 *
 * Intersection. At each connect the source sends all points that the worker
 * saved (the last applied blocks, newest first) to findIntersection. The node
 * answers with the newest point on its chain, and the first nextBlock rolls
 * back to that point. So a rollback of fewer blocks than the saved points
 * resumes by itself, also when it happens while the source is disconnected.
 * When the node finds none of the points (IntersectionNotFound), the source
 * emits "no-intersection" and asks again after `intersectionRetryMs`. It never
 * replaces a saved list with the origin: that would drop the indexed history.
 *
 * Tips. Ogmios reports the node's tip in each chain-sync answer. The source
 * also asks queryNetwork/tip every `tipPollMs` on the same connection (Ogmios
 * answers it while a nextBlock request waits at the tip), so the worker knows
 * the chain tip when chain-sync does not move.
 *
 * Adapted from apex-dashboard/server/ws-transport.ts.
 */

import { EventEmitter } from "events";
import type { ChainPoint, ChainSyncSource, ChainTip, RollbackPoint } from "./types.js";
import { fromOgmiosBlock } from "./ogmiosBlock.js";
import { parseOgmiosMessage } from "./ogmiosJson.js";

const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 90_000;
const DEFAULT_TIP_POLL_MS = 30_000;
const DEFAULT_INTERSECTION_RETRY_MS = 30_000;
/** Ogmios v6 findIntersection error: IntersectionNotFound. */
const INTERSECTION_NOT_FOUND = 1000;
const OPEN = 1;

interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}

type WsCtor = new (url: string) => MinimalWebSocket;

let _WsCtor: WsCtor | null = null;
async function loadWs(): Promise<WsCtor> {
  if (_WsCtor) return _WsCtor;
  const mod = await import("ws");
  const m = mod as unknown as { WebSocket?: WsCtor; default?: WsCtor };
  _WsCtor = m.WebSocket ?? m.default ?? (mod as unknown as WsCtor);
  return _WsCtor;
}

/** The parts of an Ogmios v6 JSON-RPC answer that the source reads. */
interface OgmiosMessage {
  method?: string;
  result?: {
    direction?: "forward" | "backward";
    block?: unknown;
    point?: unknown;
    intersection?: unknown;
    tip?: unknown;
    slot?: unknown;
    id?: unknown;
  };
  error?: { code?: number; message?: string; data?: { tip?: unknown } };
}

/** A block point or tip of the Ogmios v6 JSON; null for "origin" or a malformed value. */
function toPoint(raw: unknown): ChainPoint | null {
  const p = raw as { slot?: unknown; id?: unknown } | null | undefined;
  return typeof p === "object" && p !== null && typeof p.slot === "number" && typeof p.id === "string"
    ? { slot: p.slot, id: p.id }
    : null;
}

export interface OgmiosSourceOpts {
  /**
   * Watchdog timeout (ms). If no response arrives from Ogmios within this
   * window after a chain-sync request was sent, the WebSocket is force-closed
   * so the reconnect path can re-establish the chain-sync stream from the
   * saved points. Defaults to 90_000. Set to 0 to disable.
   *
   * Rationale: Ogmios WebSockets can half-die (TCP socket alive, server
   * stops pushing nextBlock responses). The indexer would otherwise sit
   * idle indefinitely with `ogmios_status: "connected"` reported as true.
   */
  responseTimeoutMs?: number;
  /** Interval (ms) of the queryNetwork/tip request on the open connection. Defaults to 30_000. 0: off. */
  tipPollMs?: number;
  /** Wait (ms) before findIntersection is sent again after IntersectionNotFound. Defaults to 30_000. */
  intersectionRetryMs?: number;
}

export class OgmiosSource extends EventEmitter implements ChainSyncSource {
  private url: string;
  private ws: MinimalWebSocket | null = null;
  private backoff: number = INITIAL_BACKOFF;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed: boolean = false;
  private points: () => ChainPoint[] = () => [];
  private responseTimeoutMs: number;
  private responseWatchdog: ReturnType<typeof setTimeout> | null = null;
  private tipPollMs: number;
  private tipPoll: ReturnType<typeof setInterval> | null = null;
  private intersectionRetryMs: number;
  private intersectionRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(ogmiosUrl: string, opts: OgmiosSourceOpts = {}) {
    super();
    this.url = ogmiosUrl;
    this.responseTimeoutMs = opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.tipPollMs = opts.tipPollMs ?? DEFAULT_TIP_POLL_MS;
    this.intersectionRetryMs = opts.intersectionRetryMs ?? DEFAULT_INTERSECTION_RETRY_MS;
  }

  async start(points: () => ChainPoint[]): Promise<void> {
    this.closed = false;
    this.points = points;
    this.startTipPoll();
    await this.connect();
    this.sendFindIntersection();
  }

  stop(): void {
    this.closed = true;
    this.clearWatchdog();
    this.clearIntersectionRetry();
    if (this.tipPoll) {
      clearInterval(this.tipPoll);
      this.tipPoll = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  requestNextBlock(): void {
    if (!this.ws || this.ws.readyState !== OPEN) {
      // Not yet ready — drop silently; reconnect logic will resume.
      return;
    }
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "nextBlock" }));
    this.armWatchdog();
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    const Ctor = await loadWs();
    return new Promise<void>((resolve, reject) => {
      const socket = new Ctor(this.url);
      this.ws = socket;
      let settled = false;
      socket.onopen = () => {
        this.backoff = INITIAL_BACKOFF;
        settled = true;
        this.emit("connected");
        resolve();
      };
      socket.onmessage = (ev) => this.handleMessage(ev.data);
      socket.onerror = (ev) => {
        const err = new Error(ev.message ?? "WebSocket error");
        this.emit("error", err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      socket.onclose = (ev) => {
        this.clearWatchdog();
        // The next connect sends findIntersection anyway.
        this.clearIntersectionRetry();
        this.emit("disconnected");
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed: ${ev.code} ${ev.reason}`));
        }
        if (!this.closed) this.scheduleReconnect();
      };
    });
  }

  private sendFindIntersection(): void {
    this.clearIntersectionRetry();
    if (!this.ws || this.ws.readyState !== OPEN) return;
    // An empty list is a new database: start at the origin. A saved list
    // never falls back to the origin, so a node that rejects every saved
    // point cannot reset the indexed history.
    const saved = this.points();
    const points: Array<ChainPoint | "origin"> = saved.length > 0 ? saved : ["origin"];
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "findIntersection",
      params: { points },
    }));
    this.armWatchdog();
  }

  private handleMessage(data: string): void {
    let msg: OgmiosMessage;
    try {
      msg = parseOgmiosMessage(data) as OgmiosMessage;
    } catch (err) {
      // Watchdog stays armed — a stream of unparseable garbage triggers reconnect.
      this.emit("error", err);
      return;
    }

    if (msg.method === "queryNetwork/tip") {
      // A failed tip query is left out: the worker reports the age of the last tip.
      const tip = toPoint(msg.result);
      if (tip) this.emit("tip", tip);
      return;
    }

    if (msg.method === "findIntersection" && msg.error?.code === INTERSECTION_NOT_FOUND) {
      this.clearWatchdog();
      this.emit("no-intersection", { tip: toPoint(msg.error.data?.tip) });
      this.scheduleIntersectionRetry();
      return;
    }

    if (msg.error) {
      // Leave the watchdog armed so a stuck Ogmios error path still recycles
      // the connection rather than wedging the follower.
      this.emit("error", new Error(msg.error.message ?? "Ogmios error"));
      return;
    }

    // A chain-sync answer clears the watchdog. The next requestNextBlock()
    // or sendFindIntersection() arms it again.
    if (msg.method === "findIntersection") {
      this.clearWatchdog();
      const raw = msg.result?.intersection;
      const point: RollbackPoint | null = raw === "origin" ? "origin" : toPoint(raw);
      if (!point) {
        this.dropMalformed("findIntersection answer without an intersection point");
        return;
      }
      this.emit("intersection", { point, tip: toPoint(msg.result?.tip) });
      this.requestNextBlock();
      return;
    }

    if (msg.method === "nextBlock") {
      this.clearWatchdog();
      const r = msg.result;
      const tip: ChainTip | null = toPoint(r?.tip);
      if (r?.direction === "forward" && r.block) {
        this.emit("block", { block: fromOgmiosBlock(r.block), tip });
      } else if (r?.direction === "backward") {
        const point: RollbackPoint | null = r.point === "origin" ? "origin" : toPoint(r.point);
        if (!point) {
          this.dropMalformed("nextBlock rollback without a point");
          return;
        }
        this.emit("rollback", { point, tip });
      }
    }
  }

  /**
   * An answer that breaks the Ogmios v6 schema: report it and connect again,
   * so chain-sync restarts from the saved points.
   */
  private dropMalformed(reason: string): void {
    this.emit("error", new Error(`Ogmios: ${reason}; reconnecting`));
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      _WsCtor = null;
      this.connect()
        .then(() => this.sendFindIntersection())
        .catch((err) => this.emit("error", err));
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  private scheduleIntersectionRetry(): void {
    this.clearIntersectionRetry();
    this.intersectionRetry = setTimeout(() => {
      this.intersectionRetry = null;
      this.sendFindIntersection();
    }, this.intersectionRetryMs);
  }

  private clearIntersectionRetry(): void {
    if (this.intersectionRetry) {
      clearTimeout(this.intersectionRetry);
      this.intersectionRetry = null;
    }
  }

  private startTipPoll(): void {
    if (this.tipPoll || this.tipPollMs <= 0) return;
    this.tipPoll = setInterval(() => {
      if (this.ws && this.ws.readyState === OPEN) {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "queryNetwork/tip" }));
      }
    }, this.tipPollMs);
    this.tipPoll.unref?.();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.responseTimeoutMs <= 0) return;
    this.responseWatchdog = setTimeout(() => {
      this.responseWatchdog = null;
      console.warn(
        `[OgmiosSource] no response from Ogmios in ${this.responseTimeoutMs}ms — forcing reconnect`,
      );
      // Closing the socket triggers onclose → scheduleReconnect, which
      // re-runs findIntersection from the saved points.
      if (this.ws) {
        try {
          this.ws.close();
        } catch {
          // ignore — close() should be idempotent on any sane WebSocket impl
        }
      }
    }, this.responseTimeoutMs);
  }

  private clearWatchdog(): void {
    if (this.responseWatchdog) {
      clearTimeout(this.responseWatchdog);
      this.responseWatchdog = null;
    }
  }
}
