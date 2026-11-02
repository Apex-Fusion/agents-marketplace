// The JSON form of a vector file. Quantities are decimal strings; every other value is as the
// resolver reads it from its ledger source (Part 1 Section 7).

import type { Asset, LedgerTx } from "../../src/chain/types.js";
import type { ResolverSettings } from "../../src/resolve/settings.js";
import { FakeChain } from "../support/chain.js";

interface AssetJson {
  policyId: string;
  assetName: string;
  quantity: string;
}

export interface TransactionJson {
  txHash: string;
  blockHash: string;
  blockHeight: number;
  txIndex: number;
  slot: number;
  inputs: Array<{ txHash: string; outputIndex: number; address: string; assets: AssetJson[] }>;
  outputs: Array<{
    outputIndex: number;
    address: string;
    lovelace: string;
    assets: AssetJson[];
    inlineDatum: string | null;
    datumHash: string | null;
    hasReferenceScript: boolean;
  }>;
  mint: AssetJson[];
  /** Ed25519 public keys of the vkey witnesses. */
  vkeyWitnesses: string[];
}

export interface VectorFile {
  name: string;
  description: string;
  specification: string;
  /** How to compare a result with the expected one. */
  comparison: string;
  settings: ResolverSettings;
  ledger: {
    tip: { blockHeight: number; blockHash: string; slot: number };
    transactions: TransactionJson[];
    /** Datums that the ledger source knows by hash (not inline). */
    datums: Record<string, string>;
  };
  requests: Array<{
    did: string;
    options: Record<string, string>;
    httpStatus: number;
    result: unknown;
  }>;
}

const assetsToJson = (assets: readonly Asset[]): AssetJson[] => assets.map((a) => ({ policyId: a.policyId, assetName: a.assetName, quantity: a.quantity.toString() }));
const assetsFromJson = (assets: readonly AssetJson[]): Asset[] => assets.map((a) => ({ policyId: a.policyId, assetName: a.assetName, quantity: BigInt(a.quantity) }));

export function ledgerToJson(chain: FakeChain): VectorFile["ledger"] {
  const txs = [...chain.txs].sort((a, b) => a.blockHeight - b.blockHeight || a.txIndex - b.txIndex);
  return {
    tip: { ...chain.tipInfo },
    transactions: txs.map((t) => ({
      txHash: t.txHash,
      blockHash: t.blockHash,
      blockHeight: t.blockHeight,
      txIndex: t.txIndex,
      slot: t.slot,
      inputs: t.inputs.map((i) => ({ txHash: i.txHash, outputIndex: i.outputIndex, address: i.address, assets: assetsToJson(i.assets) })),
      outputs: t.outputs.map((o) => ({
        outputIndex: o.outputIndex,
        address: o.address,
        lovelace: o.lovelace.toString(),
        assets: assetsToJson(o.assets),
        inlineDatum: o.inlineDatum,
        datumHash: o.datumHash,
        hasReferenceScript: o.hasReferenceScript,
      })),
      mint: assetsToJson(t.mint),
      vkeyWitnesses: chain.witnesses.get(t.txHash) ?? [],
    })),
    datums: Object.fromEntries(chain.datumStore),
  };
}

export function chainFromJson(ledger: VectorFile["ledger"]): FakeChain {
  const chain = new FakeChain();
  chain.tipInfo = { ...ledger.tip };
  for (const t of ledger.transactions) {
    const tx: LedgerTx = {
      txHash: t.txHash,
      blockHash: t.blockHash,
      blockHeight: t.blockHeight,
      txIndex: t.txIndex,
      slot: t.slot,
      inputs: t.inputs.map((i) => ({ ...i, assets: assetsFromJson(i.assets) })),
      outputs: t.outputs.map((o) => ({ ...o, lovelace: BigInt(o.lovelace), assets: assetsFromJson(o.assets) })),
      mint: assetsFromJson(t.mint),
    };
    chain.txs.push(tx);
    if (t.vkeyWitnesses.length) chain.witnesses.set(t.txHash, t.vkeyWitnesses);
  }
  for (const [hash, cbor] of Object.entries(ledger.datums)) chain.datumStore.set(hash, cbor);
  return chain;
}
