/**
 * gateway/src/sdk/registry.ts — per-API-key Marketplace SDK cache + serializer.
 *
 * Each API key is its own custodial wallet, so each gets its own Marketplace
 * instance bound to that wallet's WalletKey. The shared ChainProvider and
 * indexer URL are reused across all keys. A per-key Mutex serializes all
 * on-chain work for one wallet (a single wallet cannot post two escrows from
 * the same UTxO concurrently). The cache is LRU-bounded to cap memory.
 */

import { Marketplace, MemoryTaskHistoryStore } from "@marketplace/buyer/sdk";
import type { LiveOgmiosProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import { open as unseal } from "../crypto/seal.js";
import { deriveWalletKey } from "../wallet.js";
import type { ApiKeyRow } from "../db/store.js";

/** Default per-run deadline. Chain reads and tx submits settle in seconds;
 * anything past this is the 2026-08-12 freeze mode (a fetch that never
 * settles), not a slow success. */
export const DEFAULT_MUTEX_TIMEOUT_MS = 180_000;

/** Default queue bound per mutex. A healthy key drains its queue in seconds;
 * a queue this deep means the head is stuck and callers should fail fast. */
export const DEFAULT_MUTEX_MAX_QUEUE = 64;

/** A run() exceeded its deadline and was abandoned so queued work can proceed. */
export class MutexTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`mutex run '${label}' exceeded ${timeoutMs}ms and was abandoned; queued work proceeds`);
    this.name = "MutexTimeoutError";
  }
}

/** run() was refused because the queue is at its bound (head likely stuck). */
export class MutexQueueFullError extends Error {
  constructor(label: string, depth: number) {
    super(`mutex queue full (${depth} pending) — refusing '${label}'; the head of the queue is likely stuck`);
    this.name = "MutexQueueFullError";
  }
}

function runWithDeadline<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new MutexTimeoutError(label, timeoutMs)), timeoutMs);
    // Node-only nicety: don't hold the process open for a pending deadline.
    timer.unref?.();
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        rejectPromise(e);
      },
    );
  });
}

/**
 * Tiny promise-chain mutex: run(fn) executes fns strictly one at a time —
 * now with a per-run deadline and a queue bound (2026-08-12 freeze fix).
 *
 * On deadline the stuck fn is NOT cancelled (promises aren't); it is
 * abandoned: its run() rejects with MutexTimeoutError and the chain advances.
 * A zombie that settles later can at worst lose a UTxO-contention race with
 * the run that replaced it — strictly better than the alternative, where one
 * stuck chain call convoys every subsequent request on the key forever.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  constructor(private readonly opts: { timeoutMs?: number; maxQueue?: number } = {}) {}

  run<T>(fn: () => Promise<T>, label = "op"): Promise<T> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_MUTEX_TIMEOUT_MS;
    const maxQueue = this.opts.maxQueue ?? DEFAULT_MUTEX_MAX_QUEUE;

    if (this.depth >= maxQueue) {
      return Promise.reject(new MutexQueueFullError(label, this.depth));
    }
    this.depth++;

    // Keep the chain alive even if fn rejects or times out; swallow here so
    // the next run() isn't poisoned by a prior rejection.
    const result = this.tail.then(
      () => runWithDeadline(fn, timeoutMs, label),
      () => runWithDeadline(fn, timeoutMs, label),
    );
    const settled = result.finally(() => {
      this.depth--;
    });
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }
}

export interface KeyContext {
  sdk: Marketplace;
  mutex: Mutex;
  walletKey: WalletKey;
}

export interface SdkRegistryDeps {
  chain: LiveOgmiosProvider;
  indexerUrl: string;
  networkId: 0 | 1;
  masterKeyHex: string;
  max: number;
}

export class SdkRegistry {
  private readonly cache = new Map<string, KeyContext>();

  constructor(private readonly deps: SdkRegistryDeps) {}

  /** Build (or fetch from cache) the per-key SDK context. Decrypts the wallet
   * key in-memory only when first constructing the instance. */
  getContext(keyRow: ApiKeyRow): KeyContext {
    const existing = this.cache.get(keyRow.id);
    if (existing) {
      // LRU bump: re-insert to move to the end of iteration order.
      this.cache.delete(keyRow.id);
      this.cache.set(keyRow.id, existing);
      return existing;
    }

    const privHex = unseal(
      { nonce: keyRow.enc_priv_nonce, ct: keyRow.enc_priv_ct, tag: keyRow.enc_priv_tag },
      this.deps.masterKeyHex,
    );
    const walletKey = deriveWalletKey(privHex, this.deps.networkId);
    const sdk = new Marketplace({
      chain: this.deps.chain,
      indexerUrl: this.deps.indexerUrl,
      walletKey,
      networkParams: { networkId: this.deps.networkId },
      historyStore: new MemoryTaskHistoryStore(),
    });
    const ctx: KeyContext = { sdk, mutex: new Mutex(), walletKey };
    this.cache.set(keyRow.id, ctx);
    this.evictIfNeeded();
    return ctx;
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.deps.max) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
