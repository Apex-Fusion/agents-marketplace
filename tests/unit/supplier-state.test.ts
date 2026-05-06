/**
 * supplier-state.test.ts — RED phase tests for supplier/src/state.ts
 *
 * Tests the SupplierState in-process slot lock:
 *   - tryAcquire(escrowRef): boolean — atomic test-and-set
 *   - release()
 *   - markOffline()
 *   - snapshot(): { status, currentEscrowRef?, lastSeenIso }
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SupplierState } from "../../supplier/src/state.js";

const ESCROW_REF_A = `${"f".repeat(64)}#0`;
const ESCROW_REF_B = `${"e".repeat(64)}#1`;

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
    state.release();
    expect(state.snapshot().status).toBe("free");
  });

  it("clears currentEscrowRef on release", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.release();
    expect(state.snapshot().currentEscrowRef).toBeUndefined();
  });

  it("allows re-acquire after release", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.release();
    expect(state.tryAcquire(ESCROW_REF_B)).toBe(true);
  });

  it("re-acquire after release sets new currentEscrowRef", () => {
    state.tryAcquire(ESCROW_REF_A);
    state.release();
    state.tryAcquire(ESCROW_REF_B);
    expect(state.snapshot().currentEscrowRef).toBe(ESCROW_REF_B);
  });

  it("updates lastSeenIso on release", () => {
    state.tryAcquire(ESCROW_REF_A);
    const beforeRelease = state.snapshot().lastSeenIso;
    state.release();
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
});
