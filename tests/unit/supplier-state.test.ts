/**
 * supplier-state.test.ts — tests for supplier/src/state.ts
 *
 * Tests the SupplierState session-slot admission (capacity-aware) + the
 * wallet mutex:
 *   - tryAcquire(escrowRef): boolean — slot admission (default capacity 1)
 *   - release(escrowRef) — frees exactly that ref's slot
 *   - markOffline() — clears every slot and refuses new acquires
 *   - snapshot(): { status, currentEscrowRef?, activeEscrowRefs, activeSessions, maxSessions, lastSeenIso }
 *   - walletMutex.run — strict serialization of wallet chain ops
 *
 * The one-slot tests run on a fake clock. Each test walks one transition and
 * asserts the whole snapshot. So the exact lastSeenIso shows which calls touch
 * it: the constructor, an acquire, a release of a held ref and markOffline.
 * A refused acquire does not touch it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SupplierState } from "../../supplier/src/state.js";

const ESCROW_REF_A = `${"f".repeat(64)}#0`;
const ESCROW_REF_B = `${"e".repeat(64)}#1`;
const ESCROW_REF_C = `${"d".repeat(64)}#2`;

// Fake-clock times. A touch stores the time of the call, so each step has its own value.
const T0 = "2026-11-22T08:00:00.000Z";
const T1 = "2026-11-22T08:00:01.000Z";
const T2 = "2026-11-22T08:00:02.000Z";
const T3 = "2026-11-22T08:00:03.000Z";

describe("SupplierState — one slot", () => {
  let state: SupplierState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    state = new SupplierState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts free with no ref held", () => {
    expect(state.snapshot()).toStrictEqual({
      status: "free",
      activeEscrowRefs: [],
      activeSessions: 0,
      maxSessions: 1,
      lastSeenIso: T0,
    });
  });

  it("acquire takes the slot: free → working, and the ref is the current one", () => {
    vi.setSystemTime(T1);
    expect(state.tryAcquire(ESCROW_REF_A)).toBe(true);
    expect(state.snapshot()).toStrictEqual({
      status: "working",
      currentEscrowRef: ESCROW_REF_A,
      activeEscrowRefs: [ESCROW_REF_A],
      activeSessions: 1,
      maxSessions: 1,
      lastSeenIso: T1,
    });
  });

  it("a second acquire is refused and changes nothing", () => {
    vi.setSystemTime(T1);
    state.tryAcquire(ESCROW_REF_A);
    const held = state.snapshot();

    vi.setSystemTime(T2);
    expect(state.tryAcquire(ESCROW_REF_B)).toBe(false);
    expect(state.snapshot()).toStrictEqual(held);
  });

  it("release frees the slot: working → free, and the slot can be taken again", () => {
    vi.setSystemTime(T1);
    state.tryAcquire(ESCROW_REF_A);

    vi.setSystemTime(T2);
    state.release(ESCROW_REF_A);
    expect(state.snapshot()).toStrictEqual({
      status: "free",
      activeEscrowRefs: [],
      activeSessions: 0,
      maxSessions: 1,
      lastSeenIso: T2,
    });

    vi.setSystemTime(T3);
    expect(state.tryAcquire(ESCROW_REF_B)).toBe(true);
    expect(state.snapshot()).toStrictEqual({
      status: "working",
      currentEscrowRef: ESCROW_REF_B,
      activeEscrowRefs: [ESCROW_REF_B],
      activeSessions: 1,
      maxSessions: 1,
      lastSeenIso: T3,
    });
  });

  it("markOffline from free: offline, refuses every acquire, and is idempotent", () => {
    vi.setSystemTime(T1);
    state.markOffline();
    const offline = {
      status: "offline",
      activeEscrowRefs: [],
      activeSessions: 0,
      maxSessions: 1,
      lastSeenIso: T1,
    };
    expect(state.snapshot()).toStrictEqual(offline);

    expect(state.tryAcquire(ESCROW_REF_A)).toBe(false);
    state.markOffline();
    expect(state.snapshot()).toStrictEqual(offline);
  });

  it("markOffline from working drops the held ref", () => {
    vi.setSystemTime(T1);
    state.tryAcquire(ESCROW_REF_A);

    vi.setSystemTime(T2);
    state.markOffline();
    expect(state.snapshot()).toStrictEqual({
      status: "offline",
      activeEscrowRefs: [],
      activeSessions: 0,
      maxSessions: 1,
      lastSeenIso: T2,
    });
  });

  it("snapshot is a copy — changing it does not change the state", () => {
    state.tryAcquire(ESCROW_REF_A);
    const before = state.snapshot();

    // Change the returned snapshot: the value field and the ref array.
    const snap = state.snapshot();
    snap.status = "free";
    snap.activeEscrowRefs.push(ESCROW_REF_B);

    expect(state.snapshot()).toStrictEqual(before);
  });
});

describe("SupplierState — capacity > 1", () => {
  let state: SupplierState;

  beforeEach(() => {
    state = new SupplierState(2);
  });

  it("stays free until every slot is taken (free-until-full)", () => {
    expect(state.tryAcquire(ESCROW_REF_A)).toBe(true);
    expect(state.snapshot().status).toBe("free");
    expect(state.snapshot().activeSessions).toBe(1);
    expect("currentEscrowRef" in state.snapshot()).toBe(false);

    expect(state.tryAcquire(ESCROW_REF_B)).toBe(true);
    expect(state.snapshot().status).toBe("working");
    expect(state.snapshot().currentEscrowRef).toBe(ESCROW_REF_A); // oldest
  });

  it("rejects the N+1th acquire", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.tryAcquire(ESCROW_REF_B);
    expect(state.tryAcquire(ESCROW_REF_C)).toBe(false);
  });

  it("rejects a duplicate ref while held", () => {
    state.tryAcquire(ESCROW_REF_A);
    expect(state.tryAcquire(ESCROW_REF_A)).toBe(false);
  });

  it("release frees exactly that ref's slot", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.tryAcquire(ESCROW_REF_B);
    state.release(ESCROW_REF_A);
    expect(state.snapshot().status).toBe("free");
    expect(state.snapshot().activeEscrowRefs).toEqual([ESCROW_REF_B]);
    expect(state.tryAcquire(ESCROW_REF_C)).toBe(true);
  });

  it("release of an unheld ref is a no-op", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.release(ESCROW_REF_B);
    expect(state.snapshot().activeSessions).toBe(1);
  });

  it("markOffline clears all slots and refuses new acquires", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.tryAcquire(ESCROW_REF_B);
    state.markOffline();
    expect(state.snapshot().status).toBe("offline");
    expect(state.snapshot().activeSessions).toBe(0);
    expect(state.tryAcquire(ESCROW_REF_C)).toBe(false);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new SupplierState(0)).toThrow();
  });
});

describe("SupplierState.walletMutex", () => {
  /**
   * A promise that the test resolves by hand. It makes the order of the runs exact, with no timer.
   * Node 20 has no Promise.withResolvers.
   */
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("runs one job at a time, in submission order", async () => {
    const { walletMutex } = new SupplierState();
    const events: string[] = [];
    const started = deferred();
    const gate = deferred();

    const first = walletMutex.run(async () => {
      events.push("first:start");
      started.resolve();
      await gate.promise;
      events.push("first:end");
    });
    const second = walletMutex.run(async () => {
      events.push("second:start");
    });

    // While the first job holds the lock, the second job has not started.
    await started.promise;
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("a rejected job reaches its caller and does not block the next job", async () => {
    const { walletMutex } = new SupplierState();

    await expect(
      walletMutex.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(walletMutex.run(async () => 42)).resolves.toBe(42);
  });
});
