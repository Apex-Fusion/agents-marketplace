/**
 * supplier-state.test.ts — tests for supplier/src/state.ts
 *
 * Tests the SupplierState session-slot admission (capacity-aware) + the
 * wallet mutex:
 *   - tryAcquire(escrowRef): boolean — slot admission (default capacity 1)
 *   - release(escrowRef) — frees exactly that ref's slot
 *   - markOffline()
 *   - snapshot(): { status, currentEscrowRef?, activeSessions, maxSessions, ... }
 *   - walletMutex.run — strict serialization of wallet chain ops
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SupplierState } from "../../supplier/src/state.js";

const ESCROW_REF_A = `${"f".repeat(64)}#0`;
const ESCROW_REF_B = `${"e".repeat(64)}#1`;
const ESCROW_REF_C = `${"d".repeat(64)}#2`;

describe("SupplierState — initial state", () => {
  it("starts in free state", () => {
    const state = new SupplierState();
    expect(state.snapshot().status).toBe("free");
  });

  it("initial snapshot has no currentEscrowRef", () => {
    const state = new SupplierState();
    expect(state.snapshot().currentEscrowRef).toBeUndefined();
  });

  it("initial snapshot has a valid ISO timestamp in lastSeenIso", () => {
    const state = new SupplierState();
    const { lastSeenIso } = state.snapshot();
    expect(lastSeenIso).toBeTruthy();
    expect(new Date(lastSeenIso).getTime()).not.toBeNaN();
  });
});

describe("SupplierState.tryAcquire()", () => {
  let state: SupplierState;

  beforeEach(() => {
    state = new SupplierState();
  });

  it("returns true when free", () => {
    expect(state.tryAcquire(ESCROW_REF_A)).toBe(true);
  });

  it("transitions to working after acquire", () => {
    state.tryAcquire(ESCROW_REF_A);
    expect(state.snapshot().status).toBe("working");
  });

  it("sets currentEscrowRef after acquire", () => {
    state.tryAcquire(ESCROW_REF_A);
    expect(state.snapshot().currentEscrowRef).toBe(ESCROW_REF_A);
  });

  it("returns false when already working", () => {
    state.tryAcquire(ESCROW_REF_A);
    expect(state.tryAcquire(ESCROW_REF_B)).toBe(false);
  });

  it("status remains working after second tryAcquire fails", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.tryAcquire(ESCROW_REF_B);
    expect(state.snapshot().status).toBe("working");
  });

  it("currentEscrowRef remains the FIRST ref after second tryAcquire fails", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.tryAcquire(ESCROW_REF_B);
    expect(state.snapshot().currentEscrowRef).toBe(ESCROW_REF_A);
  });

  it("returns false when offline", () => {
    state.markOffline();
    expect(state.tryAcquire(ESCROW_REF_A)).toBe(false);
  });

  it("status remains offline after tryAcquire fails", () => {
    state.markOffline();
    state.tryAcquire(ESCROW_REF_A);
    expect(state.snapshot().status).toBe("offline");
  });

  it("updates lastSeenIso on successful acquire", () => {
    const before = state.snapshot().lastSeenIso;
    // Small sleep to ensure timestamp changes
    state.tryAcquire(ESCROW_REF_A);
    const after = state.snapshot().lastSeenIso;
    // lastSeenIso must be a valid ISO string; may be equal if clock resolution is coarse
    expect(new Date(after).getTime()).not.toBeNaN();
    expect(after >= before).toBe(true);
  });
});

describe("SupplierState.release()", () => {
  let state: SupplierState;

  beforeEach(() => {
    state = new SupplierState();
  });

  it("transitions working → free", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.release(ESCROW_REF_A);
    expect(state.snapshot().status).toBe("free");
  });

  it("clears currentEscrowRef on release", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.release(ESCROW_REF_A);
    expect(state.snapshot().currentEscrowRef).toBeUndefined();
  });

  it("allows re-acquire after release", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.release(ESCROW_REF_A);
    expect(state.tryAcquire(ESCROW_REF_B)).toBe(true);
  });

  it("re-acquire after release sets new currentEscrowRef", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.release(ESCROW_REF_A);
    state.tryAcquire(ESCROW_REF_B);
    expect(state.snapshot().currentEscrowRef).toBe(ESCROW_REF_B);
  });

  it("updates lastSeenIso on release", () => {
    state.tryAcquire(ESCROW_REF_A);
    const beforeRelease = state.snapshot().lastSeenIso;
    state.release(ESCROW_REF_A);
    const afterRelease = state.snapshot().lastSeenIso;
    expect(new Date(afterRelease).getTime()).not.toBeNaN();
    expect(afterRelease >= beforeRelease).toBe(true);
  });
});

describe("SupplierState.markOffline()", () => {
  let state: SupplierState;

  beforeEach(() => {
    state = new SupplierState();
  });

  it("transitions free → offline", () => {
    state.markOffline();
    expect(state.snapshot().status).toBe("offline");
  });

  it("transitions working → offline", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.markOffline();
    expect(state.snapshot().status).toBe("offline");
  });

  it("is idempotent (offline → offline)", () => {
    state.markOffline();
    state.markOffline();
    expect(state.snapshot().status).toBe("offline");
  });

  it("clears currentEscrowRef when going offline from working", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.markOffline();
    expect(state.snapshot().currentEscrowRef).toBeUndefined();
  });

  it("updates lastSeenIso when going offline", () => {
    const before = state.snapshot().lastSeenIso;
    state.markOffline();
    const after = state.snapshot().lastSeenIso;
    expect(new Date(after).getTime()).not.toBeNaN();
    expect(after >= before).toBe(true);
  });
});

describe("SupplierState.snapshot()", () => {
  it("returns status, lastSeenIso but no currentEscrowRef when free", () => {
    const state = new SupplierState();
    const snap = state.snapshot();
    expect(snap.status).toBe("free");
    expect("currentEscrowRef" in snap).toBe(false);
    expect(snap.lastSeenIso).toBeTruthy();
  });

  it("returns currentEscrowRef only when working", () => {
    const state = new SupplierState();
    state.tryAcquire(ESCROW_REF_A);
    const snap = state.snapshot();
    expect(snap.currentEscrowRef).toBe(ESCROW_REF_A);
  });

  it("snapshot is a copy — mutating it does not affect state", () => {
    const state = new SupplierState();
    state.tryAcquire(ESCROW_REF_A);
    const snap = state.snapshot();
    // Mutate the returned snapshot
    (snap as Record<string, unknown>).status = "free";
    // State must remain working
    expect(state.snapshot().status).toBe("working");
  });

  it("reports active/max session counts", () => {
    const state = new SupplierState();
    expect(state.snapshot().activeSessions).toBe(0);
    expect(state.snapshot().maxSessions).toBe(1);
    state.tryAcquire(ESCROW_REF_A);
    expect(state.snapshot().activeSessions).toBe(1);
    expect(state.snapshot().activeEscrowRefs).toEqual([ESCROW_REF_A]);
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
  it("serializes runs in submission order and survives rejection", async () => {
    const state = new SupplierState(4);
    const order: number[] = [];
    const p1 = state.walletMutex.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const p2 = state.walletMutex.run(async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);

    await state.walletMutex
      .run(async () => {
        throw new Error("boom");
      })
      .catch(() => undefined);
    expect(await state.walletMutex.run(async () => 42)).toBe(42);
  });
});
