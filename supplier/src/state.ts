/**
 * supplier/src/state.ts — In-process single-slot concurrency lock.
 *
 * SupplierState tracks whether the node is free, working, or offline.
 * Cross-process coordination is M1-D; this is purely in-memory.
 *
 * Methods:
 *   tryAcquire(escrowRef): boolean  — atomic test-and-set; returns false unless free
 *   release()                       — transition working → free (no-op from free/offline)
 *   markOffline()                   — transition any state → offline; idempotent
 *   snapshot()                      — current status snapshot (defensive copy)
 *
 * Invariants:
 *   - currentEscrowRef is set IFF status === "working"
 *   - markOffline() clears currentEscrowRef
 *   - tryAcquire never overwrites a held lock
 *   - lastSeenIso updates on every state-changing operation
 */

export type SupplierStatus = "free" | "working" | "offline";

export interface SupplierSnapshot {
  status: SupplierStatus;
  currentEscrowRef?: string;
  lastSeenIso: string;
}

export class SupplierState {
  private status: SupplierStatus = "free";
  private currentEscrowRef: string | undefined = undefined;
  private lastSeenIso: string = new Date().toISOString();

  private touch(): void {
    // ISO 8601 with millisecond resolution. Coarse clocks may produce equal
    // values in tight succession — tests use >= rather than strict greater.
    this.lastSeenIso = new Date().toISOString();
  }

  tryAcquire(escrowRef: string): boolean {
    if (this.status !== "free") return false;
    this.status = "working";
    this.currentEscrowRef = escrowRef;
    this.touch();
    return true;
  }

  release(): void {
    if (this.status === "working") {
      this.status = "free";
      this.currentEscrowRef = undefined;
      this.touch();
    }
  }

  markOffline(): void {
    this.status = "offline";
    this.currentEscrowRef = undefined;
    this.touch();
  }

  snapshot(): SupplierSnapshot {
    // Omit currentEscrowRef key entirely when not working so
    // ('currentEscrowRef' in snap) === false (matches test expectation).
    if (this.status === "working" && this.currentEscrowRef !== undefined) {
      return {
        status: this.status,
        currentEscrowRef: this.currentEscrowRef,
        lastSeenIso: this.lastSeenIso,
      };
    }
    return {
      status: this.status,
      lastSeenIso: this.lastSeenIso,
    };
  }
}
