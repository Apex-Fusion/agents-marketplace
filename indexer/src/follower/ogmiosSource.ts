/**
 * indexer/src/follower/ogmiosSource.ts — Ogmios WebSocket ChainSyncSource.
 *
 * Production implementation of ChainSyncSource over an Ogmios WebSocket.
 * Tests inject MockChainSyncSource instead, so this implementation is exercised
 * end-to-end only in M1-F lifecycle tests.
 *
 * Adapted from apex-dashboard/server/ws-transport.ts.
 */

import { EventEmitter } from "events";
import type { ChainSyncSource, IndexerBlock, RollbackPoint } from "./types.js";

const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 90_000;

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

export interface OgmiosSourceOpts {
  /**
   * Watchdog timeout (ms). If no response arrives from Ogmios within this
   * window after a request was sent, the WebSocket is force-closed so the
   * existing reconnect path can re-establish the chain-sync stream from the
   * saved cursor. Defaults to 90_000. Set to 0 to disable.
   *
   * Rationale: Ogmios WebSockets can half-die (TCP socket alive, server
   * stops pushing nextBlock responses). The indexer would otherwise sit
   * idle indefinitely with `ogmios_status: "connected"` reported as true.
   */
  responseTimeoutMs?: number;
}

export class OgmiosSource extends EventEmitter implements ChainSyncSource {
  private url: string;
  private ws: MinimalWebSocket | null = null;
  private backoff: number = INITIAL_BACKOFF;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed: boolean = false;
  private intersectAt: { slot: number; id: string } | null = null;
  private responseTimeoutMs: number;
  private responseWatchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(ogmiosUrl: string, opts: OgmiosSourceOpts = {}) {
    super();
    this.url = ogmiosUrl;
    this.responseTimeoutMs = opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  }

  async start(intersectAt?: { slot: number; id: string } | null): Promise<void> {
    this.closed = false;
    this.intersectAt = intersectAt ?? null;
    await this.connect();
    this.sendFindIntersection();
  }

  stop(): void {
    this.closed = true;
    this.clearWatchdog();
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
    const OPEN = 1;
    if (!this.ws || this.ws.readyState !== OPEN) {
      // Not yet ready — drop silently; reconnect logic will resume.
      return;
    }
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "nextBlock" }));
    this.armWatchdog();
  }

  updateIntersect(point: { slot: number; id: string }): void {
    this.intersectAt = point;
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
    const OPEN = 1;
    if (!this.ws || this.ws.readyState !== OPEN) return;
    const points: Array<{ slot: number; id: string } | "origin"> = this.intersectAt
      ? [this.intersectAt, "origin"]
      : ["origin"];
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "findIntersection",
      params: { points },
    }));
    this.armWatchdog();
  }

  private handleMessage(data: string): void {
    let msg: { method?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(data);
    } catch (err) {
      // Watchdog stays armed — a stream of unparseable garbage triggers reconnect.
      this.emit("error", err);
      return;
    }
    if (msg.error) {
      // Same: leave watchdog armed so a stuck Ogmios error path still recycles
      // the connection rather than wedging the follower.
      this.emit("error", new Error(msg.error.message ?? "Ogmios error"));
      return;
    }
    // Well-formed protocol message received — clear the watchdog. It will be
    // re-armed by the next requestNextBlock() / sendFindIntersection() send.
    if (msg.method) {
      this.clearWatchdog();
    }
    if (msg.method === "findIntersection") {
      this.emit("intersection", msg.result);
      // Pipeline: kick off some next-block requests
      this.requestNextBlock();
      return;
    }
    if (msg.method === "nextBlock") {
      const r = msg.result as {
        direction?: "forward" | "backward";
        block?: IndexerBlock;
        tip?: { slot: number; id: string };
        point?: RollbackPoint | string;
      };
      if (r?.direction === "forward" && r.block) {
        this.emit("block", { block: r.block, tip: r.tip });
      } else if (r?.direction === "backward") {
        let point: RollbackPoint = { slot: 0, id: "origin" };
        if (r.point && typeof r.point === "object") {
          point = r.point;
        }
        this.emit("rollback", { point });
      }
    }
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

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.responseTimeoutMs <= 0) return;
    this.responseWatchdog = setTimeout(() => {
      this.responseWatchdog = null;
      console.warn(
        `[OgmiosSource] no response from Ogmios in ${this.responseTimeoutMs}ms — forcing reconnect`,
      );
      // Closing the socket triggers onclose → scheduleReconnect, which
      // re-runs findIntersection from the cached intersectAt point.
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
