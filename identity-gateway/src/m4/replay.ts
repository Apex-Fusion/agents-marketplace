// Single-use values: JWT IDs of subject tokens, client assertions and proofs (each kept at least
// until its token expires), DPoP proof IDs (RFC 9449 Section 11.1), and the gateway nonces of the
// X.509-SVID endpoint. The store fails closed when it is full: it refuses new values instead of
// dropping values that could then be replayed. So that it stays usable (Part 2 Section 8.6):
// - a value goes into the store only after the request authenticated (a signature by an
//   authentication key of a registered agent verified), never for a request that failed before;
// - the store keeps a 128-bit SHA-256 digest of each value, so an entry has the same small size
//   whatever the length of the value;
// - the gateway issues nonces without storing them (NonceStore).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
    const digest = createHash("sha256").update(key, "utf8").digest("base64url").slice(0, 22);
    const known = this.entries.get(digest);
    if (known !== undefined && known > now) return false;
    if (this.entries.size >= this.max) {
      this.prune(now);
      if (this.entries.size >= this.max) throw new CapacityError("single-use token IDs");
    }
    this.entries.set(digest, expiresAt);
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

/** A nonce: 8 bytes of issue time (POSIX ms), 16 random bytes and a 16-byte tag; 54 base64url characters. */
const NONCE = /^[A-Za-z0-9_-]{54}$/;

/**
 * Gateway nonces, usable once, for at most `lifetimeMs` after issue. A nonce carries its issue time,
 * 128 random bits and an HMAC-SHA-256 tag (RFC 2104, cut to 128 bits as Section 5 allows) under a key
 * that the process draws at start. Issuing stores nothing, so callers that are not authenticated
 * cannot exhaust anything; `used` keeps a nonce only after an authenticated request uses it, until
 * the nonce expires. A restart makes the earlier nonces unknown, as before.
 */
export class NonceStore {
  private readonly key = randomBytes(32);

  constructor(
    readonly lifetimeMs: number,
    private readonly used: SingleUseStore,
  ) {}

  issue(now: number): string {
    const body = Buffer.alloc(24);
    body.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(now))), 0);
    randomBytes(16).copy(body, 8);
    return Buffer.concat([body, this.tag(body)]).toString("base64url");
  }

  /** Uses the nonce up. "unknown": not issued by this process, or already used. "expired": older than the lifetime. */
  consume(nonce: string, now: number): NonceCheck {
    if (!NONCE.test(nonce)) return "unknown";
    const bytes = Buffer.from(nonce, "base64url");
    // Only the canonical text of the bytes counts, so that one nonce has one text.
    if (bytes.length !== 40 || bytes.toString("base64url") !== nonce) return "unknown";
    const body = bytes.subarray(0, 24);
    if (!timingSafeEqual(bytes.subarray(24), this.tag(body))) return "unknown";
    const issuedAt = Number(body.readBigUInt64BE(0));
    if (issuedAt > now) return "unknown";
    if (now - issuedAt > this.lifetimeMs) return "expired";
    return this.used.use(`nonce\n${nonce}`, issuedAt + this.lifetimeMs + 1, now) ? "ok" : "unknown";
  }

  private tag(body: Buffer): Buffer {
    return createHmac("sha256", this.key).update(body).digest().subarray(0, 16);
  }
}
