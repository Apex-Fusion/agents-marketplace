// An in-memory ChainSource. It answers like the Koios + Ogmios source: asset histories from outputs
// and mints, transactions by hash, datums by hash, block witnesses by height, the policy asset index,
// the outputs that hold an asset now.

import { assetKey, type AssetId, type BlockWitnesses, type ChainSource, type ChainTip, type GenesisParameters, type LedgerTx, type PolicyAsset } from "../../src/chain/types.js";
import { ledgerOrder } from "../../src/resolve/history.js";
import { VECTOR_MAINNET } from "../../src/resolve/settings.js";

export type ChainMethod = keyof ChainSource;

export class FakeChain implements ChainSource {
  tipInfo: ChainTip = { blockHeight: 0, blockHash: "00".repeat(32), slot: 0 };
  genesisInfo: GenesisParameters = { ...VECTOR_MAINNET };
  readonly txs: LedgerTx[] = [];
  /** Vkey witnesses by transaction hash. */
  readonly witnesses = new Map<string, string[]>();
  /** Datums that the source knows by hash (witness-set datums). */
  readonly datumStore = new Map<string, string>();
  /** Methods called, in call order. */
  readonly calls: ChainMethod[] = [];
  /** The block heights that blockWitnesses read, in read order. */
  readonly blocksRead: number[] = [];
  /** Methods that fail. */
  readonly failing = new Set<ChainMethod>();
  /** Transactions that `transactions()` does not return although the asset history lists them. */
  readonly hidden = new Set<string>();

  private enter(method: ChainMethod): void {
    this.calls.push(method);
    if (this.failing.has(method)) throw new Error(`Koios ${method} answered HTTP 503`);
  }

  async tip(): Promise<ChainTip> {
    this.enter("tip");
    return this.tipInfo;
  }

  async genesis(): Promise<GenesisParameters> {
    this.enter("genesis");
    return this.genesisInfo;
  }

  async assetTxHashes(policyId: string, assetName: string): Promise<string[]> {
    this.enter("assetTxHashes");
    const holds = (assets: LedgerTx["mint"]) => assets.some((a) => a.policyId === policyId && a.assetName === assetName);
    // Newest first, as Koios answers.
    return this.txs
      .filter((t) => holds(t.mint) || t.outputs.some((o) => holds(o.assets)))
      .sort((a, b) => ledgerOrder(b, a))
      .map((t) => t.txHash);
  }

  async transactions(txHashes: readonly string[]): Promise<LedgerTx[]> {
    this.enter("transactions");
    return this.txs.filter((t) => txHashes.includes(t.txHash) && !this.hidden.has(t.txHash));
  }

  async datums(datumHashes: readonly string[]): Promise<Map<string, string>> {
    this.enter("datums");
    return new Map(datumHashes.flatMap((h) => (this.datumStore.has(h) ? [[h, this.datumStore.get(h)!] as const] : [])));
  }

  async blockWitnesses(blockHeights: readonly number[]): Promise<BlockWitnesses[]> {
    this.enter("blockWitnesses");
    return blockHeights.map((blockHeight) => {
      this.blocksRead.push(blockHeight);
      const inBlock = this.txs.filter((t) => t.blockHeight === blockHeight).sort((a, b) => a.txIndex - b.txIndex);
      if (!inBlock.length) throw new Error("no block at this height");
      return {
        blockHash: inBlock[0]!.blockHash,
        transactions: inBlock.map((t) => ({ txHash: t.txHash, vkeys: this.witnesses.get(t.txHash) ?? [] })),
      };
    });
  }

  async policyAssets(policyId: string): Promise<PolicyAsset[]> {
    this.enter("policyAssets");
    const mints = new Map<string, LedgerTx[]>();
    for (const t of [...this.txs].sort(ledgerOrder)) {
      for (const a of t.mint) if (a.policyId === policyId && a.quantity > 0n) mints.set(a.assetName, [...(mints.get(a.assetName) ?? []), t]);
    }
    const { systemStart, slotLength } = this.genesisInfo;
    return [...mints]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([assetName, txs]) => ({ assetName, mintCount: txs.length, lastMintTx: txs[txs.length - 1]!.txHash, createdAt: systemStart + txs[0]!.slot * slotLength }));
  }

  async assetHolders(assets: readonly AssetId[]): Promise<Map<string, string[]>> {
    this.enter("assetHolders");
    const wanted = new Set(assets.map(assetKey));
    const spent = new Set(this.txs.flatMap((t) => t.inputs.map((i) => `${i.txHash}#${i.outputIndex}`)));
    const holders = new Map<string, string[]>();
    for (const t of this.txs) {
      for (const o of t.outputs) {
        const ref = `${t.txHash}#${o.outputIndex}`;
        if (spent.has(ref)) continue;
        for (const a of o.assets) {
          const key = assetKey(a);
          if (wanted.has(key) && a.quantity > 0n) holders.set(key, [...(holders.get(key) ?? []), `${ref}@${t.blockHeight}`]);
        }
      }
    }
    return holders;
  }
}
