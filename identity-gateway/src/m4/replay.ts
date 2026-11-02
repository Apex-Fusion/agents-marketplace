// Single-use values: JWT IDs of subject tokens, client assertions and proofs (each kept at least
// until its token expires), DPoP proof IDs (RFC 9449 Section 11.1), and the gateway nonces of the
// X.509-SVID endpoint. Both stores fail closed when they are full: they refuse new values instead
// of dropping values that could then be replayed.

import { randomBytes } from "node:crypto";

/** A store is full; the request can be retried later. */
export class CapacityError extends Error {
  constructor(what: string) {
    super(`too many ${what} in use; try again later`);
  }
}

const PRUNE_INTERVAL_MS = 60_000;

export class SingleUseStore {
  private readonly entries = new Map<string, number>();
  private lastPrune = 0;

  constructor(private readonly max = 1_000_000) {}

  /** Records `key` until `expiresAt` (POSIX ms). False when the key is already recorded: a replay. */
  use(key: string, expiresAt: number, now: number): boolean {
    this.pruneSometimes(now);
    const known = this.entries.get(key);
    if (known !== undefined && known > now) return false;
    if (this.entries.size >= this.max) {
      this.prune(now);
      if (this.entries.size >= this.max) throw new CapacityError("single-use token IDs");
    }
    this.entries.set(key, expiresAt);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  private pruneSometimes(now: number): void {
    if (now - this.lastPrune >= PRUNE_INTERVAL_MS) this.prune(now);
  }

  private prune(now: number): void {
    this.lastPrune = now;
    for (const [key, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(key);
  }
}

export type NonceCheck = "ok" | "unknown" | "expired";

/** Gateway nonces: 256 random bits each, usable once, for at most `lifetimeMs` after issue. */
export class NonceStore {
  private readonly issued = new Map<string, number>();

  constructor(
    readonly lifetimeMs: number,
    private readonly max = 100_000,
  ) {}

  issue(now: number): string {
    if (this.issued.size >= this.max) {
      for (const [nonce, at] of this.issued) if (at + this.lifetimeMs <= now) this.issued.delete(nonce);
      if (this.issued.size >= this.max) throw new CapacityError("nonces");
    }
    const nonce = randomBytes(32).toString("base64url");
    this.issued.set(nonce, now);
    return nonce;
  }

  /** Uses the nonce up. "unknown": never issued, or already used. "expired": older than the lifetime. */
  consume(nonce: string, now: number): NonceCheck {
    const at = this.issued.get(nonce);
    if (at === undefined) return "unknown";
    this.issued.delete(nonce);
    return now - at > this.lifetimeMs ? "expired" : "ok";
  }
}
