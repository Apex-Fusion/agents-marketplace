/**
 * gateway/src/sdk/registry.ts — per-API-key Marketplace SDK cache + serializer.
 *
 * Marketplace instances are LRU-cached. Wallet mutexes and guarded providers
 * live in a separate identity-stable map, so SDK eviction cannot create a
 * second writer for a wallet whose old context still has work in flight.
 */

import { Marketplace, MemoryTaskHistoryStore } from "@marketplace/buyer/sdk";
import type { LiveOgmiosProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import { open as unseal } from "../crypto/seal.js";
import { deriveWalletKey } from "../wallet.js";
import type { ApiKeyRow, GatewayStore } from "../db/store.js";
import { WalletTransactionGuard } from "./walletTransactions.js";

/** Caller deadline for wallet operations. An overdue operation retains the
 * mutex until it actually settles. Paid one-shot phases disable this caller
 * deadline and use the SDK and chain-confirmation budgets instead. */
export const DEFAULT_MUTEX_TIMEOUT_MS = 180_000;

/** Default queue bound per mutex. A healthy key drains its queue in seconds;
 * a queue this deep means the head is stuck and callers should fail fast. */
export const DEFAULT_MUTEX_MAX_QUEUE = 64;

/** The caller deadline elapsed. The underlying operation still owns the mutex. */
export class MutexTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`mutex run '${label}' exceeded ${timeoutMs}ms; the wallet operation is still running`);
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

function notifyAtDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new MutexTimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

interface MutexOptions {
  timeoutMs?: number;
  maxQueue?: number;
  beforeRun?: () => Promise<void>;
  runInContext?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Promise-chain mutex. A deadline only stops the caller from waiting. The
 * chain tail and queue depth follow the real operation until it settles, so a
 * timed-out wallet operation can never overlap its successor.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  constructor(private readonly opts: MutexOptions = {}) {}

  run<T>(fn: () => Promise<T>, label = "op", timeoutMs = this.opts.timeoutMs ?? DEFAULT_MUTEX_TIMEOUT_MS): Promise<T> {
    const maxQueue = this.opts.maxQueue ?? DEFAULT_MUTEX_MAX_QUEUE;

    if (this.depth >= maxQueue) {
      return Promise.reject(new MutexQueueFullError(label, this.depth));
    }
    this.depth++;

    let resolveCaller: ((value: T | PromiseLike<T>) => void) | undefined;
    let rejectCaller: ((reason?: unknown) => void) | undefined;
    const caller = timeoutMs === 0 ? undefined : new Promise<T>((resolve, reject) => {
      resolveCaller = resolve;
      rejectCaller = reject;
    });
    const invoke = (): Promise<T> => {
      const execution = (async () => {
        await this.opts.beforeRun?.();
        return this.opts.runInContext === undefined
          ? fn()
          : this.opts.runInContext(fn);
      })();
      if (resolveCaller !== undefined && rejectCaller !== undefined) {
        notifyAtDeadline(execution, timeoutMs, label).then(resolveCaller, rejectCaller);
      }
      return execution;
    };
    const operation = this.tail.then(invoke, invoke);
    const settled = operation.finally(() => {
      this.depth--;
    });
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return caller ?? settled;
  }
}

export interface KeyContext {
  sdk: Marketplace;
  mutex: Mutex;
  walletKey: WalletKey;
  chain: LiveOgmiosProvider;
  reconcilePendingWalletTransaction(): Promise<void>;
}

export interface SdkRegistryDeps {
  chain: LiveOgmiosProvider;
  store: GatewayStore;
  indexerUrl: string;
  networkId: 0 | 1;
  masterKeyHex: string;
  max: number;
  fetchFn?: typeof globalThis.fetch;
}

interface StableWalletState {
  keyId: string;
  mutex: Mutex;
  guard: WalletTransactionGuard;
}

export class SdkRegistry {
  private readonly cache = new Map<string, KeyContext>();
  private readonly walletStates = new Map<string, StableWalletState>();

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
    const walletState = this.getWalletState(keyRow.id, walletKey.pubKeyHash);
    const sdk = new Marketplace({
      chain: walletState.guard.chain,
      indexerUrl: this.deps.indexerUrl,
      walletKey,
      networkParams: { networkId: this.deps.networkId },
      historyStore: new MemoryTaskHistoryStore(),
      _fetch: this.deps.fetchFn,
    });
    const ctx: KeyContext = {
      sdk,
      mutex: walletState.mutex,
      walletKey,
      chain: walletState.guard.chain,
      reconcilePendingWalletTransaction: () => walletState.guard.reconcilePendingWalletTransaction(),
    };
    this.cache.set(keyRow.id, ctx);
    this.evictIfNeeded();
    return ctx;
  }

  private getWalletState(keyId: string, walletPkh: string): StableWalletState {
    const existing = this.walletStates.get(walletPkh);
    if (existing !== undefined) {
      if (existing.keyId !== keyId) {
        throw new Error(`custodial wallet ${walletPkh} is assigned to more than one API key`);
      }
      return existing;
    }

    const guard = new WalletTransactionGuard({
      keyId,
      chain: this.deps.chain,
      store: this.deps.store,
    });
    const state: StableWalletState = {
      keyId,
      guard,
      mutex: new Mutex({
        beforeRun: () => guard.reconcilePendingWalletTransaction(),
        runInContext: (operation) => guard.runInScope(operation),
      }),
    };
    this.walletStates.set(walletPkh, state);
    return state;
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.deps.max) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
