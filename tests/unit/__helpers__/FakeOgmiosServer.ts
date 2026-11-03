/**
 * tests/unit/__helpers__/FakeOgmiosServer.ts — a local WebSocket server that
 * answers chain-sync like Ogmios v6, for one chain that the test controls.
 *
 *   findIntersection — the first point of the request that is on the chain
 *                      (same slot and id; "origin" always matches) wins;
 *                      otherwise error 1000 "No intersection found." with the tip
 *                      (the answers that Vector mainnet Ogmios gave on 2026-11-03)
 *   nextBlock        — first a rollback to the intersection, then the blocks
 *                      after it; at the tip the request waits
 *   queryNetwork/tip — the tip
 *
 * switchTo(chain) replaces the chain and drops the open connections: a fork
 * that happens while the follower is disconnected.
 *
 * This is transport infrastructure, not a datum fixture.
 */

import { once, type EventEmitter } from "node:events";
import { createRequire } from "node:module";

const { WebSocketServer } = createRequire(new URL("../../../indexer/package.json", import.meta.url))("ws");

/** The parts of an Ogmios v6 Block<Praos> that the indexer reads. */
export interface FakeBlock {
  type: "praos";
  era: "conway";
  id: string;
  ancestor: string;
  height: number;
  slot: number;
  transactions: Array<{ id: string }>;
}

export type FakePoint = { slot: number; id: string } | "origin";

interface Socket {
  on(event: "message", listener: (data: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
}

interface Session {
  /** Index of the last block sent; -1: the origin. */
  cursor: number;
  rollbackTo: FakePoint | null;
}

export class FakeOgmiosServer {
  /** The `points` of each findIntersection request, in order. */
  readonly intersectRequests: FakePoint[][] = [];
  /** The `ws` WebSocketServer: "listening" and "connection" events. */
  private readonly server: EventEmitter & { address(): { port: number }; close(cb: () => void): void };
  private readonly sockets = new Set<Socket>();

  private constructor(private chain: FakeBlock[]) {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server.on("connection", (socket: Socket) => this.accept(socket));
  }

  static async start(chain: FakeBlock[]): Promise<FakeOgmiosServer> {
    const fake = new FakeOgmiosServer(chain);
    await once(fake.server, "listening");
    return fake;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server.address().port}`;
  }

  tip(): { slot: number; id: string; height: number } | "origin" {
    const last = this.chain.at(-1);
    return last ? { slot: last.slot, id: last.id, height: last.height } : "origin";
  }

  /** Replace the chain and drop the connections (the follower reconnects). */
  switchTo(chain: FakeBlock[]): void {
    this.chain = chain;
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }

  /**
   * Add blocks that only the tip reports show: a waiting nextBlock gets no
   * answer (a chain-sync stream that stopped while the chain goes on).
   */
  growTipOnly(blocks: FakeBlock[]): void {
    this.chain = [...this.chain, ...blocks];
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const session: Session = { cursor: -1, rollbackTo: null };
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { method: string; params?: { points?: FakePoint[] } };
      const reply = this.answer(session, request);
      if (reply) socket.send(JSON.stringify({ jsonrpc: "2.0", method: request.method, ...reply }));
    });
  }

  private answer(session: Session, request: { method: string; params?: { points?: FakePoint[] } }): object | null {
    const tip = this.tip();
    if (request.method === "queryNetwork/tip") {
      return { result: tip === "origin" ? "origin" : { slot: tip.slot, id: tip.id } };
    }
    if (request.method === "findIntersection") {
      const points = request.params?.points ?? [];
      this.intersectRequests.push(points);
      for (const point of points) {
        const index = point === "origin" ? -1 : this.chain.findIndex((b) => b.slot === point.slot && b.id === point.id);
        if (point === "origin" || index >= 0) {
          session.cursor = index;
          session.rollbackTo = point;
          return { result: { intersection: point, tip } };
        }
      }
      return { error: { code: 1000, message: "No intersection found.", data: { tip } } };
    }
    if (request.method === "nextBlock") {
      if (session.rollbackTo !== null) {
        const point = session.rollbackTo;
        session.rollbackTo = null;
        return { result: { direction: "backward", point, tip } };
      }
      if (session.cursor + 1 < this.chain.length) {
        session.cursor += 1;
        return { result: { direction: "forward", block: this.chain[session.cursor], tip } };
      }
      return null; // at the tip: Ogmios answers when the next block comes
    }
    return { error: { code: -32601, message: `unknown method ${request.method}` } };
  }
}
