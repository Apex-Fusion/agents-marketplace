// The controller key of a legacy version (Part 1 Section 8.1). The legacy registry stores only the
// owner key hash. The key is the newest vkey witness whose key hash is the owner hash, among the
// counted transactions of the record's own token, up to the last one that the base version owns.
// Koios shows no witnesses, so they come from the blocks (ChainSource.blockWitnesses).

import type { BlockWitnesses } from "../chain/types.js";
import { keyHash } from "../codec/keys.js";
import { ledgerOrder, type PlacedTx, type RecordHistory, type Version } from "./history.js";

const ED25519_KEY = /^[0-9a-f]{64}$/;

/** Reads the witnesses of the block at a height; the result must be the block with this hash. */
export type BlockWitnessReader = (blockHeight: number, blockHash: string) => Promise<BlockWitnesses>;

export async function findLegacyKey(
  history: RecordHistory,
  base: Version,
  ownerHash: string,
  counts: (at: PlacedTx) => boolean,
  readBlock: BlockWitnessReader,
): Promise<string | null> {
  const owned = base.owned.filter((o) => counts(o.at));
  const last = owned[owned.length - 1];
  if (!last) return null;
  const candidates = history.legacyTxs.filter((p) => counts(p) && ledgerOrder(p.tx, last.at.tx) <= 0).reverse();
  let block: BlockWitnesses | null = null;
  for (const { tx } of candidates) {
    if (block?.blockHash !== tx.blockHash) block = await readBlock(tx.blockHeight, tx.blockHash);
    const signed = block.transactions.find((w) => w.txHash === tx.txHash);
    if (!signed) throw new Error("a block does not contain a transaction that the asset history places in it");
    const key = signed.vkeys.find((k) => ED25519_KEY.test(k) && keyHash(k) === ownerHash);
    if (key) return key;
  }
  return null;
}
