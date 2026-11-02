// Every identifier that resolves, in the ledger order of its first mint, with its status-list index
// (Part 2 Section 8.6): legacy mints before the cutoff slot and identity-registry mints that are not
// adoptions take indices from 0 in ledger order (block height, transaction index, output index). An
// adopted record keeps the index of its legacy mint. A mint gets its index at 30 confirmations.
//
// The work of a build is bounded (Part 1 Section 9): a first mint with 30 confirmations is kept
// between builds (it does not change), and a legacy asset that the asset index shows as first minted
// at or after the cutoff slot is skipped before its mint is read (it gets no index), unless the
// identity registry has the same name (an adoption keeps the index of its legacy mint).

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

/** What the index needs of a first mint. */
interface MintFacts extends Omit<FirstMint, "confirmations"> {
  /** The mint also burns the legacy token of the same name: an adoption. */
  readonly burnsLegacy: boolean;
}

/** First mints with 30 confirmations, by policy and asset name, kept between builds. */
export type FirstMintCache = Map<string, MintFacts>;

function mintFacts(tx: LedgerTx, policyId: string, assetName: string, legacyPolicyId: string): MintFacts {
  const output = tx.outputs.find((o) => tokenQuantity(o.assets, policyId, assetName) > 0n);
  if (!output) throw new Error("a mint transaction has no output with the minted token");
  return {
    txId: tx.txHash,
    blockHash: tx.blockHash,
    blockHeight: tx.blockHeight,
    txIndex: tx.txIndex,
    outputIndex: output.outputIndex,
    slot: tx.slot,
    burnsLegacy: policyId !== legacyPolicyId && tokenQuantity(tx.mint, legacyPolicyId, assetName) < 0n,
  };
}

interface PolicyAssets {
  readonly policyId: string;
  readonly assets: readonly PolicyAsset[];
}

/**
 * The first mint of each asset: kept from an earlier build, or read (the index's mint when it is the
 * only one, else the asset history). The mint transactions of all policies are read together.
 */
async function firstMints(chain: ChainSource, tip: ChainTip, legacyPolicyId: string, policies: readonly PolicyAssets[], cache: FirstMintCache): Promise<Map<string, MintFacts>[]> {
  const found = policies.map(() => new Map<string, MintFacts>());
  const toRead: Array<{ readonly policy: number; readonly assetName: string; readonly txHash: string }> = [];
  for (const [p, { policyId, assets }] of policies.entries()) {
    for (const asset of assets) {
      const kept = cache.get(`${policyId}.${asset.assetName}`);
      // A later mint of the same name leaves the first one unchanged; with one mint, it must be the listed one.
      if (kept && (asset.mintCount > 1 || kept.txId === asset.lastMintTx)) {
        found[p]!.set(asset.assetName, kept);
      } else if (asset.mintCount <= 1) {
        toRead.push({ policy: p, assetName: asset.assetName, txHash: asset.lastMintTx });
      } else {
        const txs = (await chain.transactions(await chain.assetTxHashes(policyId, asset.assetName))).sort(ledgerOrder);
        const mint = txs.find((t) => tokenQuantity(t.mint, policyId, asset.assetName) > 0n);
        if (!mint) throw new Error("the asset index lists a mint that the asset history does not show");
        found[p]!.set(asset.assetName, mintFacts(mint, policyId, asset.assetName, legacyPolicyId));
      }
    }
  }
  const hashes = [...new Set(toRead.map((r) => r.txHash))];
  const txs = new Map((hashes.length ? await chain.transactions(hashes) : []).map((t) => [t.txHash, t]));
  for (const { policy, assetName, txHash } of toRead) {
    const tx = txs.get(txHash);
    if (!tx) throw new Error("the ledger source listed a mint that it cannot return");
    found[policy]!.set(assetName, mintFacts(tx, policies[policy]!.policyId, assetName, legacyPolicyId));
  }

  // Keep the confirmed mints of the assets that the index lists now, and only those.
  const listed = new Set<string>();
  for (const [p, { policyId }] of policies.entries()) {
    for (const [assetName, mint] of found[p]!) {
      const key = `${policyId}.${assetName}`;
      listed.add(key);
      if (tip.blockHeight - mint.blockHeight >= CONFIRMATION_DEPTH) cache.set(key, mint);
    }
  }
  for (const key of cache.keys()) if (!listed.has(key)) cache.delete(key);
  return found;
}

export async function listRecords(chain: ChainSource, snapshot: LedgerSnapshot, cache: FirstMintCache = new Map()): Promise<RecordList> {
  const { tip, settings } = snapshot;
  const { identity, legacy, cutoffSlot } = settings.registries;
  const [legacyAssets, identityAssets] = await Promise.all([
    chain.policyAssets(legacy.policyId),
    identity ? chain.policyAssets(identity.policyId) : Promise.resolve([]),
  ]);
  const identityNames = new Set(identityAssets.map((a) => a.assetName));
  // The block time of the cutoff slot, POSIX seconds: an asset created at or after it was minted at or after the cutoff slot.
  const cutoffTime = cutoffSlot === null ? null : settings.network.systemStart + cutoffSlot * settings.network.slotLength;
  const beforeCutoff = legacyAssets.filter((a) => cutoffTime === null || a.createdAt === null || a.createdAt < cutoffTime || identityNames.has(a.assetName));
  const policies = [{ policyId: legacy.policyId, assets: beforeCutoff }, ...(identity ? [{ policyId: identity.policyId, assets: identityAssets }] : [])];
  const [legacyFirst = new Map<string, MintFacts>(), identityFirst = new Map<string, MintFacts>()] = await firstMints(chain, tip, legacy.policyId, policies, cache);

  /** A mint in a block after the tip came in after the tip was read: the list describes the tip. */
  const visible = (mint: MintFacts | undefined): MintFacts | null => (mint && mint.blockHeight <= tip.blockHeight ? mint : null);
  const firstMintOf = ({ burnsLegacy: _, ...mint }: MintFacts): FirstMint => ({ ...mint, confirmations: tip.blockHeight - mint.blockHeight });

  const entries: Array<Omit<RecordListEntry, "statusListIndex">> = [];
  for (const [vectorId, mint] of identityFirst) {
    if (!visible(mint)) continue;
    if (mint.burnsLegacy) {
      const legacyMint = visible(legacyFirst.get(vectorId));
      if (!legacyMint) throw new Error("an adoption burned a legacy token without a legacy mint");
      entries.push({ vectorId, origin: "adopted", firstMint: firstMintOf(legacyMint) });
    } else {
      entries.push({ vectorId, origin: "native", firstMint: firstMintOf(mint) });
    }
  }
  for (const [vectorId, mint] of legacyFirst) {
    if (visible(identityFirst.get(vectorId))) continue;
    const legacyMint = visible(mint);
    if (!legacyMint || (cutoffSlot !== null && legacyMint.slot >= cutoffSlot)) continue;
    entries.push({ vectorId, origin: "legacy", firstMint: firstMintOf(legacyMint) });
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
