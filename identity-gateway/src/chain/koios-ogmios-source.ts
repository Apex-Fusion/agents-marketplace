// ChainSource backed by Koios (indexes: asset history, UTxOs, credentials, blocks) and Ogmios
// (block contents, for the vkey witnesses Koios does not expose).

import type { KoiosClient, KoiosAsset, KoiosAssetUtxoRow, KoiosBlockRow, KoiosTipRow, KoiosTxInfoRow, KoiosTxRefRow } from "./koios.js";
import { fetchBlockAfter } from "./ogmios.js";
import type { Asset, ChainSource, ChainTip, LedgerTx, TxPointer, TxWitnesses, UnspentOutput } from "./types.js";

const TX_INFO_BATCH = 50;

export interface KoiosOgmiosSourceOptions {
  koios: KoiosClient;
  /** Ogmios WebSocket URL, for example wss://ogmios.vector.mainnet.apexfusion.org */
  ogmiosUrl: string;
  ogmiosTimeoutMs?: number;
}

const assetsOf = (list: KoiosAsset[] | null | undefined): Asset[] =>
  (list ?? []).map((a) => ({ policyId: a.policy_id, assetName: a.asset_name ?? "", quantity: BigInt(a.quantity) }));

export class KoiosOgmiosChainSource implements ChainSource {
  private readonly koios: KoiosClient;

  constructor(private readonly options: KoiosOgmiosSourceOptions) {
    this.koios = options.koios;
  }

  async tip(): Promise<ChainTip> {
    const [row] = await this.koios.get<KoiosTipRow[]>("tip");
    if (!row) throw new Error("Koios tip answered no rows");
    return { blockHeight: row.block_height, blockHash: row.hash, slot: row.abs_slot };
  }

  async utxosWithAsset(policyId: string, assetName: string): Promise<UnspentOutput[]> {
    const rows = await this.koios.postAll<KoiosAssetUtxoRow>(
      "asset_utxos",
      { _asset_list: [[policyId, assetName]], _extended: true },
      "tx_hash.asc,tx_index.asc",
    );
    return rows.map((r) => ({
      txHash: r.tx_hash,
      outputIndex: r.tx_index,
      address: r.address,
      assets: assetsOf(r.asset_list),
      datumHex: r.inline_datum?.bytes || null,
    }));
  }

  async assetTxHashes(policyId: string, assetName: string): Promise<string[]> {
    const rows = await this.koios.postAll<KoiosTxRefRow>(
      "asset_txs",
      { _asset_policy: policyId, _asset_name: assetName, _history: true },
      "tx_hash.asc",
    );
    return [...new Set(rows.map((r) => r.tx_hash))];
  }

  async transactions(txHashes: string[]): Promise<LedgerTx[]> {
    const out: LedgerTx[] = [];
    for (let i = 0; i < txHashes.length; i += TX_INFO_BATCH) {
      const rows = await this.koios.post<KoiosTxInfoRow[]>("tx_info", {
        _tx_hashes: txHashes.slice(i, i + TX_INFO_BATCH),
        _inputs: true,
        _assets: true,
      });
      for (const r of rows) {
        out.push({
          txHash: r.tx_hash,
          blockHash: r.block_hash,
          blockHeight: r.block_height,
          blockIndex: r.tx_block_index,
          slot: r.absolute_slot,
          blockTime: r.tx_timestamp,
          inputs: r.inputs.map((x) => ({ txHash: x.tx_hash, outputIndex: x.tx_index, address: x.payment_addr.bech32, assets: assetsOf(x.asset_list) })),
          outputs: r.outputs.map((x) => ({ outputIndex: x.tx_index, address: x.payment_addr.bech32, assets: assetsOf(x.asset_list) })),
          mint: assetsOf(r.assets_minted),
        });
      }
    }
    return out;
  }

  async paymentCredentialTxs(keyHash: string): Promise<TxPointer[]> {
    const rows = await this.koios.postAll<KoiosTxRefRow>("credential_txs", { _payment_credentials: [keyHash] }, "tx_hash.asc");
    return rows.map((r) => ({ txHash: r.tx_hash, blockHeight: r.block_height }));
  }

  async blockWitnesses(blockHeight: number): Promise<TxWitnesses[]> {
    const rows = await this.koios.get<KoiosBlockRow[]>(
      `blocks?block_height=in.(${blockHeight - 1},${blockHeight})&select=hash,abs_slot,block_height`,
    );
    const previous = rows.find((r) => r.block_height === blockHeight - 1);
    const target = rows.find((r) => r.block_height === blockHeight);
    if (!previous || !target) throw new Error(`Koios has no blocks at heights ${blockHeight - 1} and ${blockHeight}`);
    const block = await fetchBlockAfter(this.options.ogmiosUrl, { slot: previous.abs_slot, id: previous.hash }, this.options.ogmiosTimeoutMs);
    if (block.id !== target.hash) {
      throw new Error(`block ${blockHeight}: Ogmios returned ${block.id}, Koios has ${target.hash}`);
    }
    return (block.transactions ?? []).map((tx) => ({
      txHash: tx.id,
      vkeys: (tx.signatories ?? []).filter((s) => s.chainCode === undefined).map((s) => s.key.toLowerCase()),
    }));
  }
}
