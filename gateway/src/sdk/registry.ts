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

/** Tiny promise-chain mutex: run(fn) executes fns strictly one at a time. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive even if fn rejects; swallow here so the next
    // run() isn't poisoned by a prior rejection.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
