// Generation-1 record lookup (method spec Sections 4 and 6.1 steps 3-4, for generation 1 only).

import type { Asset, ChainSource, LedgerTx, UnspentOutput } from "../chain/types.js";
import { GENERATION_1 } from "./registry.js";

export type LegacyLookup =
  /** No transaction ever minted the token. */
  | { state: "neverMinted" }
  /** The token exists, but no unspent output is an authentic record (Section 4). */
  | { state: "notAuthentic" }
  | {
      state: "active";
      record: UnspentOutput;
      /** Oldest first. */
      history: LedgerTx[];
      mintTx: LedgerTx;
      /** The transaction that produced the current record output. */
      producedBy: LedgerTx;
      /** Transactions that spent the record and recreated it: the v1 update count. */
      updates: number;
    }
  /** The token was burned (legacy deregistration; no generation 2 exists, so no burn is an adoption). */
  | { state: "deactivated"; history: LedgerTx[]; mintTx: LedgerTx; burnTx: LedgerTx };

const quantityOf = (assets: Asset[], assetName: string): bigint =>
  assets.reduce((n, a) => (a.policyId === GENERATION_1.policyId && a.assetName === assetName ? n + a.quantity : n), 0n);

/** Section 4: at the generation-1 script address, holding exactly one token of the policy, and that token is (policy, vector-id). */
export function isAuthenticRecord(output: { address: string; assets: Asset[] }, assetName: string): boolean {
  if (output.address !== GENERATION_1.scriptAddress) return false;
  const ofPolicy = output.assets.filter((a) => a.policyId === GENERATION_1.policyId);
  return ofPolicy.length === 1 && ofPolicy[0]!.assetName === assetName && ofPolicy[0]!.quantity === 1n;
}

export async function findLegacyRecord(chain: ChainSource, assetName: string): Promise<LegacyLookup> {
  const [unspent, hashes] = await Promise.all([
    chain.utxosWithAsset(GENERATION_1.policyId, assetName),
    chain.assetTxHashes(GENERATION_1.policyId, assetName),
  ]);
  const history = hashes.length ? await chain.transactions(hashes) : [];
  const missing = hashes.filter((h) => !history.some((t) => t.txHash === h));
  if (missing.length) throw new Error(`chain source listed transactions it cannot return: ${missing.join(", ")}`);
  // Ledger order: block height, then position in the block.
  history.sort((a, b) => a.blockHeight - b.blockHeight || a.blockIndex - b.blockIndex);

  const mintTx = history.find((t) => quantityOf(t.mint, assetName) > 0n);
  if (!mintTx) {
    if (history.length || unspent.length) throw new Error(`asset ${assetName} has transactions or holders but no mint`);
    return { state: "neverMinted" };
  }

  const records = unspent.filter((o) => isAuthenticRecord(o, assetName));
  if (records.length > 1) throw new Error(`asset ${assetName}: more than one authentic record`);
  const record = records[0];
  if (record) {
    const producedBy = history.find((t) => t.txHash === record.txHash);
    // The record output is unspent, so its transaction is the newest one touching the token. Anything else means the
    // two queries saw different chain states (a block arrived in between).
    if (!producedBy || producedBy !== history[history.length - 1]) {
      throw new Error(`chain source views disagree for asset ${assetName}; retry`);
    }
    const updates = history.filter(
      (t) => t !== mintTx && t.inputs.some((i) => quantityOf(i.assets, assetName) > 0n) && t.outputs.some((o) => isAuthenticRecord(o, assetName)),
    ).length;
    return { state: "active", record, history, mintTx, producedBy, updates };
  }

  const supply = history.reduce((n, t) => n + quantityOf(t.mint, assetName), 0n);
  const burnTx = [...history].reverse().find((t) => quantityOf(t.mint, assetName) < 0n);
  if (supply === 0n && unspent.length === 0 && burnTx) return { state: "deactivated", history, mintTx, burnTx };
  return { state: "notAuthentic" };
}
