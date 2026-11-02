// Every identifier that resolves, in the ledger order of its first mint, with its status-list index
// (Part 2 Section 8.6): legacy mints before the cutoff slot and identity-registry mints that are not
// adoptions take indices from 0 in ledger order (block height, transaction index, output index). An
// adopted record keeps the index of its legacy mint. A mint gets its index at 30 confirmations.

import type { ChainSource, ChainTip, LedgerTx, PolicyAsset } from "../chain/types.js";
import { ledgerOrder, tokenQuantity, type LedgerSnapshot, type Origin } from "./history.js";
import { CONFIRMATION_DEPTH } from "./settings.js";

export interface FirstMint {
  readonly txId: string;
  readonly blockHash: string;
  readonly blockHeight: number;
  /** Position of the transaction in its block. */
  readonly txIndex: number;
  /** The output that received the minted token. */
  readonly outputIndex: number;
  readonly slot: number;
  readonly confirmations: number;
}

export interface RecordListEntry {
  readonly vectorId: string;
  readonly origin: Origin;
  /** The first mint of the identifier: the legacy mint of a legacy or adopted record. */
  readonly firstMint: FirstMint;
  /** Status-list index; null until the first mint has 30 confirmations. */
  readonly statusListIndex: number | null;
}

export interface RecordList {
  readonly tip: ChainTip;
  /** In ledger order of the first mint. */
  readonly entries: readonly RecordListEntry[];
}

/** The first transaction that minted each asset: the index's mint when it is the only one, else the asset history. */
async function firstMints(chain: ChainSource, policyId: string, assets: readonly PolicyAsset[]): Promise<Map<string, string>> {
  const first = new Map<string, string>();
  for (const asset of assets) {
    if (asset.mintCount <= 1) {
      first.set(asset.assetName, asset.lastMintTx);
      continue;
    }
    const txs = (await chain.transactions(await chain.assetTxHashes(policyId, asset.assetName))).sort(ledgerOrder);
    const mint = txs.find((t) => tokenQuantity(t.mint, policyId, asset.assetName) > 0n);
    if (!mint) throw new Error("the asset index lists a mint that the asset history does not show");
    first.set(asset.assetName, mint.txHash);
  }
  return first;
}

export async function listRecords(chain: ChainSource, snapshot: LedgerSnapshot): Promise<RecordList> {
  const { tip, settings } = snapshot;
  const { identity, legacy, cutoffSlot } = settings.registries;
  const [legacyAssets, identityAssets] = await Promise.all([
    chain.policyAssets(legacy.policyId),
    identity ? chain.policyAssets(identity.policyId) : Promise.resolve([]),
  ]);
  const legacyFirst = await firstMints(chain, legacy.policyId, legacyAssets);
  const identityFirst = identity ? await firstMints(chain, identity.policyId, identityAssets) : new Map<string, string>();

  const hashes = [...new Set([...legacyFirst.values(), ...identityFirst.values()])];
  const txs = new Map((hashes.length ? await chain.transactions(hashes) : []).map((t) => [t.txHash, t]));
  const visible = (hash: string | undefined): LedgerTx | null => {
    const tx = hash === undefined ? undefined : txs.get(hash);
    if (hash !== undefined && !tx) throw new Error("the ledger source listed a mint that it cannot return");
    return tx && tx.blockHeight <= tip.blockHeight ? tx : null;
  };
  const mintOf = (tx: LedgerTx, policyId: string, vectorId: string): FirstMint => {
    const output = tx.outputs.find((o) => tokenQuantity(o.assets, policyId, vectorId) > 0n);
    if (!output) throw new Error("a mint transaction has no output with the minted token");
    return {
      txId: tx.txHash,
      blockHash: tx.blockHash,
      blockHeight: tx.blockHeight,
      txIndex: tx.txIndex,
      outputIndex: output.outputIndex,
      slot: tx.slot,
      confirmations: tip.blockHeight - tx.blockHeight,
    };
  };

  const entries: Array<Omit<RecordListEntry, "statusListIndex">> = [];
  for (const [vectorId, hash] of identityFirst) {
    const tx = visible(hash);
    if (!tx) continue;
    if (tokenQuantity(tx.mint, legacy.policyId, vectorId) < 0n) {
      const legacyTx = visible(legacyFirst.get(vectorId));
      if (!legacyTx) throw new Error("an adoption burned a legacy token without a legacy mint");
      entries.push({ vectorId, origin: "adopted", firstMint: mintOf(legacyTx, legacy.policyId, vectorId) });
    } else {
      entries.push({ vectorId, origin: "native", firstMint: mintOf(tx, identity!.policyId, vectorId) });
    }
  }
  for (const [vectorId, hash] of legacyFirst) {
    if (identityFirst.has(vectorId) && visible(identityFirst.get(vectorId))) continue;
    const tx = visible(hash);
    if (!tx || (cutoffSlot !== null && tx.slot >= cutoffSlot)) continue;
    entries.push({ vectorId, origin: "legacy", firstMint: mintOf(tx, legacy.policyId, vectorId) });
  }

  entries.sort(
    (a, b) =>
      a.firstMint.blockHeight - b.firstMint.blockHeight || a.firstMint.txIndex - b.firstMint.txIndex || a.firstMint.outputIndex - b.firstMint.outputIndex,
  );
  // Confirmed mints precede unconfirmed ones in ledger order, so the indices of confirmed mints never move.
  let next = 0;
  return {
    tip,
    entries: entries.map((e) => ({ ...e, statusListIndex: e.firstMint.confirmations >= CONFIRMATION_DEPTH ? next++ : null })),
  };
}
