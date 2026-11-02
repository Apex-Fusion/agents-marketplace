// The controller key of a legacy version (Part 1 Section 8.1). The legacy registry stores only the
// owner key hash. The key is the newest vkey witness whose key hash is the owner hash, among the
// counted transactions of the record's own token, up to the last one that the base version owns.
// Koios shows no witnesses, so they come from the blocks (ChainSource.blockWitnesses).
//
// The work is bounded (Part 1 Section 9: the work of a request is limited to the history of one
// record, and a resolver SHOULD cache it):
// - The search reads the blocks of the searched transactions in windows, newest first: 1 block, then
//   2, 4 and so on up to 64. Each window is one ledger read (one Ogmios session). So the usual case,
//   an owner who signed the newest transaction, reads one block, and a long history costs few reads.
// - The vkey witnesses of each searched transaction are kept by block hash and transaction ID (least
//   recently used entries go first). A block hash names the content of the block, so a later search
//   reads only blocks that it has not read before.
// - A result is kept by record, last owned output (block hash and transaction ID) and owner hash once
//   that output has 30 confirmations. The block hash fixes every earlier block too, so the result
//   cannot change.
// - Searches with the same key share one read, and at most 4 window reads run at the same time.

import type { ChainSource, LedgerTx } from "../chain/types.js";
import { keyHash } from "../codec/keys.js";
import { ledgerOrder, type PlacedTx, type RecordHistory, type Version } from "./history.js";
import { CONFIRMATION_DEPTH } from "./settings.js";

const ED25519_KEY = /^[0-9a-f]{64}$/;
/** The largest window of blocks that one ledger read covers. */
export const MAX_WINDOW_BLOCKS = 64;

/** A map that keeps at most `max` entries; the least recently used entry goes first. */
class Lru<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** Runs at most `max` tasks at the same time; the others wait in call order. */
class Limiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.max) this.running++;
    else await new Promise<void>((start) => this.waiting.push(start));
    try {
      return await task();
    } finally {
      // A waiting task takes over the slot; else the slot is free.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

export interface LegacyKeySearchOptions {
  /** Transactions whose vkey witnesses are kept. Default 16,384. */
  readonly witnessCacheSize?: number;
  /** Search results that are kept. Default 4,096. */
  readonly resultCacheSize?: number;
  /** Window reads that run at the same time. Default 4. */
  readonly concurrentReads?: number;
}

/**
 * The legacy key search with its caches. Resolvers that read the same chain source can share one
 * instance, and so one cache and one limit on concurrent reads.
 */
export class LegacyKeySearch {
  private readonly witnesses: Lru<readonly string[]>;
  private readonly results: Lru<{ readonly key: string | null }>;
  private readonly searches = new Map<string, Promise<string | null>>();
  private readonly reads: Limiter;

  constructor(
    private readonly chain: Pick<ChainSource, "blockWitnesses">,
    options: LegacyKeySearchOptions = {},
  ) {
    this.witnesses = new Lru(options.witnessCacheSize ?? 16_384);
    this.results = new Lru(options.resultCacheSize ?? 4_096);
    this.reads = new Limiter(options.concurrentReads ?? 4);
  }

  /**
   * The key of `ownerHash` for the base version under the selection's `counts`, or null when no
   * counted transaction up to the last owned output has a witness of it. A failed read throws.
   */
  find(history: RecordHistory, base: Version, ownerHash: string, counts: (at: PlacedTx) => boolean): Promise<string | null> {
    const owned = base.owned.filter((o) => counts(o.at));
    const last = owned[owned.length - 1];
    if (!last) return Promise.resolve(null);
    const lastTx = last.at.tx;
    const cacheKey = [history.vectorId, lastTx.blockHash, lastTx.txHash, ownerHash].join("\n");
    const known = this.results.get(cacheKey);
    if (known) return Promise.resolve(known.key);
    const running = this.searches.get(cacheKey);
    if (running) return running;

    // The counted transactions up to the last owned output, newest first.
    const candidates = history.legacyTxs.filter((p) => counts(p) && ledgerOrder(p.tx, lastTx) <= 0).map((p) => p.tx);
    candidates.reverse();
    const search = this.search(candidates, ownerHash);
    this.searches.set(cacheKey, search);
    // The result is kept before the shared search is dropped, so that no second search starts in between.
    void search
      .then(
        (key) => {
          if (last.at.confirmations >= CONFIRMATION_DEPTH) this.results.set(cacheKey, { key });
        },
        () => undefined,
      )
      .finally(() => {
        if (this.searches.get(cacheKey) === search) this.searches.delete(cacheKey);
      });
    return search;
  }

  private async search(candidates: readonly LedgerTx[], ownerHash: string): Promise<string | null> {
    let window = 1;
    let start = 0;
    while (start < candidates.length) {
      // The next transactions, newest first, up to `window` blocks that the cache does not hold.
      const vkeys = new Map<LedgerTx, readonly string[]>();
      const unread: LedgerTx[] = [];
      const blocks = new Set<string>();
      let end = start;
      for (; end < candidates.length; end++) {
        const tx = candidates[end]!;
        const cached = this.witnesses.get(`${tx.blockHash}:${tx.txHash}`);
        if (cached !== undefined) {
          vkeys.set(tx, cached);
          continue;
        }
        if (!blocks.has(tx.blockHash)) {
          if (blocks.size === window) break;
          blocks.add(tx.blockHash);
        }
        unread.push(tx);
      }
      if (unread.length > 0) for (const [tx, keys] of await this.read(unread)) vkeys.set(tx, keys);
      for (let i = start; i < end; i++) {
        const key = vkeys.get(candidates[i]!)!.find((k) => ED25519_KEY.test(k) && keyHash(k) === ownerHash);
        if (key !== undefined) return key;
      }
      start = end;
      window = Math.min(window * 2, MAX_WINDOW_BLOCKS);
    }
    return null;
  }

  /** Reads the blocks of the transactions in one ledger read and keeps the witnesses of each transaction. */
  private async read(txs: readonly LedgerTx[]): Promise<Map<LedgerTx, readonly string[]>> {
    const heights = [...new Set(txs.map((t) => t.blockHeight))].sort((a, b) => a - b);
    const blocks = await this.reads.run(() => this.chain.blockWitnesses(heights));
    if (blocks.length !== heights.length) throw new Error("the ledger source returned another number of blocks than the resolver asked for");
    const byHeight = new Map(heights.map((h, i) => [h, blocks[i]!]));
    const found = new Map<LedgerTx, readonly string[]>();
    for (const tx of txs) {
      const block = byHeight.get(tx.blockHeight)!;
      if (block.blockHash !== tx.blockHash) throw new Error("the block at a height changed while the resolver read it");
      const signed = block.transactions.find((w) => w.txHash === tx.txHash);
      if (!signed) throw new Error("a block does not contain a transaction that the asset history places in it");
      found.set(tx, signed.vkeys);
      this.witnesses.set(`${tx.blockHash}:${tx.txHash}`, signed.vkeys);
    }
    return found;
  }
}
