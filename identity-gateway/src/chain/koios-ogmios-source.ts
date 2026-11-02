// ChainSource backed by Koios (indexes: asset history, transactions, datums, blocks, genesis) and
// Ogmios (block contents, for the vkey witnesses that Koios does not expose).

import type {
  KoiosAsset,
  KoiosBlockRow,
  KoiosClient,
  KoiosDatumRow,
  KoiosGenesisRow,
  KoiosPolicyAssetMintRow,
  KoiosTipRow,
  KoiosTxInfoRow,
  KoiosTxRefRow,
} from "./koios.js";
import { fetchBlockAfter } from "./ogmios.js";
import type { Asset, BlockWitnesses, ChainSource, ChainTip, GenesisParameters, LedgerTx, PolicyAsset } from "./types.js";

const TX_INFO_BATCH = 50;
const DATUM_BATCH = 50;

export interface KoiosOgmiosSourceOptions {
  koios: KoiosClient;
  /** Ogmios WebSocket URL, for example wss://ogmios.vector.mainnet.apexfusion.org */
  ogmiosUrl: string;
  ogmiosTimeoutMs?: number;
}

const assetsOf = (list: KoiosAsset[] | null | undefined): Asset[] =>
  (list ?? []).map((a) => ({ policyId: a.policy_id, assetName: a.asset_name ?? "", quantity: BigInt(a.quantity) }));

function integer(value: string | number, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Koios genesis: ${what} is not an integer`);
  return n;
}

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

  async genesis(): Promise<GenesisParameters> {
    const [row] = await this.koios.get<KoiosGenesisRow[]>("genesis");
    if (!row) throw new Error("Koios genesis answered no rows");
    return {
      networkMagic: integer(row.networkmagic, "networkmagic"),
      systemStart: integer(row.systemstart, "systemstart"),
      slotLength: integer(row.slotlength, "slotlength"),
      securityParam: integer(row.securityparam, "securityparam"),
    };
  }

  async assetTxHashes(policyId: string, assetName: string): Promise<string[]> {
    const rows = await this.koios.postAll<KoiosTxRefRow>(
      "asset_txs",
      { _asset_policy: policyId, _asset_name: assetName, _history: true },
      "tx_hash.asc",
    );
    return [...new Set(rows.map((r) => r.tx_hash))];
  }

  async transactions(txHashes: readonly string[]): Promise<LedgerTx[]> {
    const out: LedgerTx[] = [];
    for (let i = 0; i < txHashes.length; i += TX_INFO_BATCH) {
      // _scripts and _bytecode make Koios include the inline datum CBOR of each output.
      const rows = await this.koios.post<KoiosTxInfoRow[]>("tx_info", {
        _tx_hashes: txHashes.slice(i, i + TX_INFO_BATCH),
        _inputs: true,
        _assets: true,
        _scripts: true,
        _bytecode: true,
      });
      for (const r of rows) {
        out.push({
          txHash: r.tx_hash,
          blockHash: r.block_hash,
          blockHeight: r.block_height,
          txIndex: r.tx_block_index,
          slot: r.absolute_slot,
          inputs: r.inputs.map((x) => ({ txHash: x.tx_hash, outputIndex: x.tx_index, address: x.payment_addr.bech32, assets: assetsOf(x.asset_list) })),
          outputs: r.outputs.map((x) => {
            if (x.inline_datum && !x.inline_datum.bytes) throw new Error("Koios tx_info returned an inline datum without its bytes");
            return {
              outputIndex: x.tx_index,
              address: x.payment_addr.bech32,
              lovelace: BigInt(x.value),
              assets: assetsOf(x.asset_list),
              inlineDatum: x.inline_datum?.bytes?.toLowerCase() ?? null,
              datumHash: x.datum_hash?.toLowerCase() ?? null,
              hasReferenceScript: x.reference_script !== null && x.reference_script !== undefined,
            };
          }),
          mint: assetsOf(r.assets_minted),
        });
      }
    }
    return out;
  }

  async datums(datumHashes: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (let i = 0; i < datumHashes.length; i += DATUM_BATCH) {
      const rows = await this.koios.post<KoiosDatumRow[]>("datum_info", { _datum_hashes: datumHashes.slice(i, i + DATUM_BATCH) });
      for (const r of rows) if (r.bytes) found.set(r.datum_hash.toLowerCase(), r.bytes.toLowerCase());
    }
    return found;
  }

  async blockWitnesses(blockHeight: number): Promise<BlockWitnesses> {
    const rows = await this.koios.get<KoiosBlockRow[]>(
      `blocks?block_height=in.(${blockHeight - 1},${blockHeight})&select=hash,abs_slot,block_height`,
    );
    const previous = rows.find((r) => r.block_height === blockHeight - 1);
    const target = rows.find((r) => r.block_height === blockHeight);
    if (!previous || !target) throw new Error("Koios blocks: a requested block height is missing");
    const block = await fetchBlockAfter(this.options.ogmiosUrl, { slot: previous.abs_slot, id: previous.hash }, this.options.ogmiosTimeoutMs);
    if (block.id !== target.hash) throw new Error("Ogmios returned another block than Koios lists at the same height");
    return {
      blockHash: block.id,
      transactions: (block.transactions ?? []).map((tx) => ({
        txHash: tx.id,
        vkeys: (tx.signatories ?? []).filter((s) => s.chainCode === undefined).map((s) => s.key.toLowerCase()),
      })),
    };
  }

  async policyAssets(policyId: string): Promise<PolicyAsset[]> {
    const rows = await this.koios.getAll<KoiosPolicyAssetMintRow>(
      `policy_asset_mints?_asset_policy=${policyId}&select=asset_name,minting_tx_hash,mint_cnt`,
      "asset_name.asc",
    );
    return rows.map((r) => ({ assetName: r.asset_name ?? "", mintCount: r.mint_cnt, lastMintTx: r.minting_tx_hash }));
  }
}
