/**
 * gateway-mutex.test.ts — Mutex deadline + queue bound (2026-08-12 freeze fix).
 *
 * Incident: one chain call that never settled, run under a per-key Mutex with
 * no deadline, convoyed every subsequent request on that key silently while
 * /models and /account stayed healthy. The fix gives run() a deadline that
 * abandons the stuck operation (advancing the chain) and a queue bound that
 * rejects new work instead of queueing without limit.
 *
 * Serialization semantics of the original class must be preserved.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Mutex,
  MutexTimeoutError,
  MutexQueueFullError,
} from "../../gateway/src/sdk/registry.js";

afterEach(() => {
  vi.useRealTimers();
});

// ─── Preserved semantics ─────────────────────────────────────────────────────

describe("Mutex — serialization (preserved semantics)", () => {
  it("runs fns strictly one at a time, in order", async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    let firstRunning = false;

    const first = mutex.run(async () => {
      firstRunning = true;
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      firstRunning = false;
    });
    const second = mutex.run(async () => {
      expect(firstRunning).toBe(false);
      order.push(2);
    });

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("a rejecting fn does not poison the chain", async () => {
    const mutex = new Mutex();

    await expect(mutex.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(mutex.run(async () => "alive")).resolves.toBe("alive");
  });
});

// ─── Deadline (the freeze fix) ───────────────────────────────────────────────

describe("Mutex — per-run deadline", () => {
  it("rejects a stuck run with MutexTimeoutError once the deadline passes", async () => {
    vi.useFakeTimers();
    const mutex = new Mutex({ timeoutMs: 1_000 });

    const stuck = mutex.run(() => new Promise<never>(() => {}), "stuck-chain-read");
    // Attach the rejection expectation BEFORE advancing time so the rejection
    // is not treated as unhandled.
    const assertion = expect(stuck).rejects.toBeInstanceOf(MutexTimeoutError);

    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it("queued work proceeds after a stuck run is abandoned (no convoy)", async () => {
    vi.useFakeTimers();
    const mutex = new Mutex({ timeoutMs: 1_000 });

    const stuck = mutex.run(() => new Promise<never>(() => {}), "stuck");
    const stuckAssertion = expect(stuck).rejects.toBeInstanceOf(MutexTimeoutError);
    const queued = mutex.run(async () => "unblocked");

    await vi.advanceTimersByTimeAsync(1_001);
    await stuckAssertion;
    await expect(queued).resolves.toBe("unblocked");
  });

  it("a run that finishes in time is unaffected by the deadline", async () => {
    vi.useFakeTimers();
    const mutex = new Mutex({ timeoutMs: 1_000 });

    const quick = mutex.run(async () => "done");
    await vi.advanceTimersByTimeAsync(1);
    await expect(quick).resolves.toBe("done");
  });
});

// ─── Queue bound ─────────────────────────────────────────────────────────────

describe("Mutex — queue bound", () => {
  it("rejects immediately with MutexQueueFullError when the queue is full", async () => {
    const mutex = new Mutex({ maxQueue: 2 });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = mutex.run(() => gate.then(() => "first"));
    const second = mutex.run(async () => "second");
    const third = mutex.run(async () => "third");

    await expect(third).rejects.toBeInstanceOf(MutexQueueFullError);

    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("slots free up once runs settle", async () => {
    const mutex = new Mutex({ maxQueue: 1 });

    await mutex.run(async () => "a");
    await expect(mutex.run(async () => "b")).resolves.toBe("b");
  });
});
