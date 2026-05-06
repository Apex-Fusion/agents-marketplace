/**
 * tests/unit/__helpers__/MockChainSyncSource.ts — test helper for block streaming.
 *
 * MockChainSyncSource implements ChainSyncSource and replays a pre-built sequence
 * of blocks (or rollback points) synchronously so ChainSyncWorker tests don't need
 * a real WebSocket.
 *
 * This is NOT a fixture (it doesn't build datums); it is test infrastructure.
 * The no-shared-helper rule applies only to datum builders, not to transport mocks.
 *
 * Usage:
 *   const source = new MockChainSyncSource([block1, block2]);
 *   const worker = new ChainSyncWorker({ source, cache, addresses });
 *   await worker.start();
 *   // all blocks are replayed synchronously before start() resolves
 */

import { EventEmitter } from "events";
import type { ChainSyncSource, IndexerBlock, RollbackPoint } from "../../../indexer/src/follower/types.js";

export type MockChainEvent =
  | { kind: "block"; block: IndexerBlock; tipSlot?: number }
  | { kind: "rollback"; point: RollbackPoint };

export class MockChainSyncSource extends EventEmitter implements ChainSyncSource {
  private events: MockChainEvent[];
  private eventIndex: number = 0;
  private started: boolean = false;

  constructor(events: MockChainEvent[]) {
    super();
    this.events = events;
  }

  async start(_intersectAt?: { slot: number; id: string } | null): Promise<void> {
    this.started = true;
    this.emit("connected");
    // Replay all events; the worker calls requestNextBlock() after each.
    // We pre-drain them here by emitting them synchronously.
    this._drainAll();
  }

  stop(): void {
    this.started = false;
  }

  requestNextBlock(): void {
    // The worker calls this after processing each block. In Mock mode the
    // start() call pre-drains all events so this is a no-op.
    // Subclasses that need step-by-step control can override.
  }

  private _drainAll(): void {
    while (this.eventIndex < this.events.length) {
      const ev = this.events[this.eventIndex++];
      if (ev.kind === "block") {
        const tipSlot = ev.tipSlot ?? ev.block.slot + 100;
        this.emit("block", { block: ev.block, tip: { slot: tipSlot } });
      } else {
        this.emit("rollback", { point: ev.point });
      }
    }
  }

  /** Push an additional event after start() has been called (for step-mode tests). */
  pushEvent(ev: MockChainEvent): void {
    this.events.push(ev);
    if (this.started) {
      this.eventIndex = this.events.length - 1;
      this._drainAll();
    }
  }
}
