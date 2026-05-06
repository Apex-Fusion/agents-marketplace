/**
 * tests/unit/indexer-boot.test.ts — boot / integration smoke tests (Category G)
 *
 * Tests createApp wiring and worker/shutdown behaviour.
 * All tests RED — createApp throws "not implemented — M1-D-green".
 * Tests call createApp() directly; the stub throws, causing Vitest to mark them FAIL.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";

import { createApp } from "../../indexer/src/server.js";
import type { IndexerDeps } from "../../indexer/src/server.js";

function makeMockDeps(): IndexerDeps {
  const workerEmitter = new EventEmitter();
  const cache = {
    listActiveAdvertisements: vi.fn(() => []),
    getAdvertisementByRef: vi.fn(() => null),
    getEscrowByRef: vi.fn(() => null),
    listEscrowsByBuyer: vi.fn(() => []),
    listEscrowsBySupplier: vi.fn(() => []),
    getSupplierStatus: vi.fn(() => null),
    listEventsAfterSlot: vi.fn(() => []),
    dbSizeBytes: vi.fn(() => 4096),
    close: vi.fn(),
  } as unknown as IndexerDeps["cache"];

  const worker = {
    getCurrentSlot: vi.fn(() => 0),
    getTipSlot: vi.fn(() => 0),
    start: vi.fn(),
    stop: vi.fn(),
    on: workerEmitter.on.bind(workerEmitter),
    emit: workerEmitter.emit.bind(workerEmitter),
    off: workerEmitter.off.bind(workerEmitter),
    listenerCount: workerEmitter.listenerCount.bind(workerEmitter),
  } as unknown as IndexerDeps["worker"];

  return { cache, worker };
}

// ─── Route wiring ─────────────────────────────────────────────────────────────

describe("createApp — route wiring", () => {
  it("createApp returns an Express Application instance (not undefined)", () => {
    const app = createApp(makeMockDeps());
    // An Express Application should be a function
    expect(typeof app).toBe("function");
  });

  it("createApp does not throw when called with valid deps", () => {
    expect(() => createApp(makeMockDeps())).not.toThrow();
  });

  it("createApp accepts a second call with fresh deps (no singleton state)", () => {
    const app1 = createApp(makeMockDeps());
    const app2 = createApp(makeMockDeps());
    expect(app1).not.toBe(app2);
  });

  it("worker.on is called at least once during createApp (event wiring)", () => {
    const deps = makeMockDeps();
    const onSpy = vi.spyOn(deps.worker, "on");
    createApp(deps);
    expect(onSpy).toHaveBeenCalled();
  });

  it("createApp wires chain-event listener on worker", () => {
    const deps = makeMockDeps();
    createApp(deps);
    // After wiring, the EventEmitter should have at least one listener for chain-event
    const emitter = deps.worker as unknown as EventEmitter;
    expect(emitter.listenerCount("chain-event")).toBeGreaterThan(0);
  });
});

// ─── Worker event listener wiring ────────────────────────────────────────────

describe("Worker + SSE — event listener wiring", () => {
  it("worker.on('chain-event') has at least one listener after createApp", () => {
    const deps = makeMockDeps();
    createApp(deps);
    const emitter = deps.worker as unknown as EventEmitter;
    expect(emitter.listenerCount("chain-event")).toBeGreaterThan(0);
  });

  it("worker.on('sync-progress') listener is wired by createApp", () => {
    const deps = makeMockDeps();
    createApp(deps);
    const emitter = deps.worker as unknown as EventEmitter;
    expect(emitter.listenerCount("sync-progress")).toBeGreaterThan(0);
  });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

describe("Graceful shutdown", () => {
  it("worker.stop() method exists and is callable (interface contract)", () => {
    const deps = makeMockDeps();
    // This doesn't need createApp — just checks the interface contract
    expect(typeof deps.worker.stop).toBe("function");
    expect(() => deps.worker.stop()).not.toThrow();
  });

  it("cache.close() method exists and is callable (interface contract)", () => {
    const deps = makeMockDeps();
    expect(typeof deps.cache.close).toBe("function");
    expect(() => deps.cache.close()).not.toThrow();
  });

  it("createApp does not call worker.stop() or cache.close() on construction", () => {
    const deps = makeMockDeps();
    const stopSpy = vi.spyOn(deps.worker, "stop");
    const closeSpy = vi.spyOn(deps.cache, "close");
    createApp(deps);
    // Shutdown must NOT be triggered just by constructing the app
    expect(stopSpy).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
