// History reads that passes over every record share (the background scan and the status-list
// builds, through `currentRecord(id, list)` and `currentStatus(id, list)`). A pass reads the tip
// once (`listRecords`) and evaluates every record as of that tip; the reads of the ledger
// (`readHistoryInputs`) are kept between passes, and a pass reads a record again only when its
// token transactions may have changed:
// - Before its first history, a pass reads the outputs that hold the tokens of the listed records
//   now (`ChainSource.assetHolders`, one read for all records). A transaction that mints, moves or
//   burns a token spends or makes such an output, so the same holders mean the same token
//   transactions. A record whose tokens no output holds is always read again.
// - Kept inputs serve a pass when they were read after the pass read its tip, or when the holders
//   that the pass read are the holders that were read before them.
// - Kept inputs that the holders vouch for serve only when their newest transaction has 30
//   confirmations at the pass's tip (Part 1 Section 2): no rollback of a younger block can leave
//   them stale.
// - A read stays in the store only when it has the transaction of each output that held the tokens
//   when the read started. Else the asset index of the ledger source was behind the holders, and the
//   read shows an older ledger. Such a read serves the pass that asked for it, and the next pass
//   reads again.
// Requests (resolveDid, and the record calls without a list) do not use this store.

import type { ChainSource } from "../chain/types.js";
import { readHistoryInputs, type HistoryInputs } from "./history.js";
import { CONFIRMATION_DEPTH, type RegistrySettings } from "./settings.js";

/** What a pass knows when it asks for the inputs of one record. */
export interface PassView {
  /** The store's sequence number when the pass had read its tip (`HistoryStore.mark`). */
  readonly tipMark: number;
  readonly tipHeight: number;
  /** The record's token holders that the pass read; undefined when the pass does not list the record. */
  readonly holders: string | undefined;
}

interface Kept {
  readonly inputs: HistoryInputs;
  /** The sequence number when the read started. */
  readonly mark: number;
  /** The holders read before the read started; undefined when unknown. */
  readonly holders: string | undefined;
}

/**
 * True when the read has the transaction of each output in `holders`, or when there is no holder to
 * check. `holders` is the text of `holdersKey` in resolver.ts: parts that are separated by spaces,
 * each `<policy ID>:<transaction hash>#<output index>@<block height>`. A part in another format
 * does not count as covered.
 */
function covers(inputs: HistoryInputs, holders: string | undefined): boolean {
  if (holders === undefined || holders === "") return true;
  const known = new Set(inputs.txs.map((tx) => tx.txHash));
  return holders.split(" ").every((part) => {
    const from = part.indexOf(":") + 1;
    const to = part.indexOf("#");
    return from > 0 && to > from && known.has(part.slice(from, to));
  });
}

interface Reading {
  readonly mark: number;
  readonly holders: string | undefined;
  readonly inputs: Promise<HistoryInputs>;
}

export class HistoryStore {
  private sequence = 0;
  private readonly kept = new Map<string, Kept>();
  private readonly reading = new Map<string, Reading>();

  /** A sequence number: a later call gets a larger one. A pass takes one after it has read its tip. */
  mark(): number {
    return ++this.sequence;
  }

  /** Forgets the records that a pass no longer lists. */
  retain(vectorIds: ReadonlySet<string>): void {
    for (const id of this.kept.keys()) if (!vectorIds.has(id)) this.kept.delete(id);
  }

  /** The inputs of a record's history for a pass: kept ones when they still apply, else a new read (kept when it `covers` the holders). */
  async inputs(chain: ChainSource, registries: RegistrySettings, vectorId: string, pass: PassView): Promise<HistoryInputs> {
    const kept = this.kept.get(vectorId);
    if (kept && this.serves(kept, pass)) return kept.inputs;
    const running = this.reading.get(vectorId);
    if (running && running.mark > pass.tipMark) return running.inputs;
    const read: Reading = { mark: this.mark(), holders: pass.holders, inputs: readHistoryInputs(chain, registries, vectorId) };
    this.reading.set(vectorId, read);
    try {
      const inputs = await read.inputs;
      const current = this.kept.get(vectorId);
      if (covers(inputs, read.holders) && (!current || current.mark < read.mark)) this.kept.set(vectorId, { inputs, mark: read.mark, holders: read.holders });
      return inputs;
    } finally {
      if (this.reading.get(vectorId) === read) this.reading.delete(vectorId);
    }
  }

  private serves(kept: Kept, pass: PassView): boolean {
    if (kept.mark > pass.tipMark) return true;
    if (pass.holders === undefined || pass.holders === "" || kept.holders !== pass.holders) return false;
    const newest = kept.inputs.txs[kept.inputs.txs.length - 1];
    return newest === undefined || pass.tipHeight - newest.blockHeight >= CONFIRMATION_DEPTH;
  }
}
