/**
 * indexer/src/follower/ogmiosBlock.ts — Ogmios v6 block → IndexerBlock.
 *
 * Shapes follow the Ogmios v6 JSON schema (v6.14.0):
 * https://github.com/CardanoSolutions/ogmios/blob/v6.14.0/docs/static/cardano.json
 * (definitions Block<Praos>, Transaction, TransactionOutputReference,
 * TransactionOutput, Redeemer, RedeemerPointer, InputSource).
 *
 *   - `Transaction.spends` is "inputs" or "collaterals". A transaction with
 *     "collaterals" failed script validation: the ledger spends only its
 *     collateral inputs, so its inputs stay unspent and its outputs do not
 *     exist. The converter leaves such transactions out.
 *   - `Transaction.redeemers` is an array of
 *     `{ validator: { purpose, index }, redeemer: <Plutus Data CBOR, base16>, executionUnits }`.
 *     For `purpose: "spend"`, `index` points into the transaction inputs in
 *     ledger order: the ledger keeps inputs as a set ordered by transaction id
 *     (bytes), then output index (Alonzo ledger specification, redeemer
 *     pointers: `rdptr` maps `Spending txin` to `(Spend, indexof txin (txinputs txb))`).
 *     Lowercase hex of equal length sorts like the bytes.
 *   - `Transaction.requiredExtraSignatories` lists the required signer key hashes.
 *   - `Transaction.metadata` is `{ hash, labels }`; follower/metadata.ts converts
 *     each label value (`json` or `cbor`) into a Metadatum.
 *   - `Block.height` is the block number.
 *
 * The converter never throws. A malformed redeemer pointer or metadata label is logged and left out.
 */

import { metadataFromOgmios } from "./metadata.js";
import type { IndexerBlock, IndexerTx, TxInput, TxOutput } from "./types.js";

/** The parts of the Ogmios v6 JSON that the indexer reads. Every leaf is checked before use. */
interface OgmiosOutputReferenceJson {
  transaction?: { id?: unknown };
  index?: unknown;
}

interface OgmiosOutputJson {
  address?: unknown;
  value?: unknown;
  datum?: unknown;
  datumHash?: unknown;
}

interface OgmiosRedeemerJson {
  validator?: { purpose?: unknown; index?: unknown };
  redeemer?: unknown;
}

interface OgmiosTransactionJson {
  id?: unknown;
  spends?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  requiredExtraSignatories?: unknown;
  redeemers?: unknown;
  metadata?: unknown;
  mint?: unknown;
}

interface OgmiosBlockJson {
  slot?: unknown;
  id?: unknown;
  height?: unknown;
  ancestor?: unknown;
  transactions?: unknown;
}

const HEX_RE = /^[0-9a-f]*$/;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Ledger order of transaction inputs: transaction id bytes, then output index. */
export function compareInputs(a: TxInput, b: TxInput): number {
  if (a.transaction.id !== b.transaction.id) return a.transaction.id < b.transaction.id ? -1 : 1;
  return a.index - b.index;
}

function toInput(raw: unknown): TxInput | null {
  const ref = raw as OgmiosOutputReferenceJson | null | undefined;
  const id = ref?.transaction?.id;
  const index = ref?.index;
  if (typeof id !== "string" || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return null;
  return { transaction: { id: id.toLowerCase() }, index };
}

function toOutput(raw: unknown): TxOutput {
  const output = raw as OgmiosOutputJson | null | undefined;
  const value = output?.value;
  const out: TxOutput = {
    // An output without an address keeps its position, so that output indexes stay right.
    address: typeof output?.address === "string" ? output.address : "",
    value: typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
  };
  if (typeof output?.datum === "string") out.datum = output.datum.toLowerCase();
  if (typeof output?.datumHash === "string") out.datumHash = output.datumHash.toLowerCase();
  return out;
}

function toTransaction(raw: unknown): IndexerTx | null {
  const tx = raw as OgmiosTransactionJson | null | undefined;
  if (typeof tx?.id !== "string" || tx.spends === "collaterals") return null;
  const txId = tx.id.toLowerCase();

  const inputs: TxInput[] = [];
  for (const item of list(tx.inputs)) {
    const input = toInput(item);
    if (input) inputs.push(input);
    else console.warn(`[ogmiosBlock] tx ${txId}: input without transaction id or index; left out`);
  }

  const outputs = list(tx.outputs).map(toOutput);

  const requiredSigners = list(tx.requiredExtraSignatories)
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.toLowerCase());

  const ordered = [...inputs].sort(compareInputs);
  const spendRedeemers: Record<string, string> = {};
  for (const item of list(tx.redeemers)) {
    const entry = item as OgmiosRedeemerJson | null | undefined;
    if (entry?.validator?.purpose !== "spend") continue;
    const index = entry.validator.index;
    const data = entry.redeemer;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= ordered.length) {
      console.warn(`[ogmiosBlock] tx ${txId}: spend redeemer index ${String(index)} has no input; left out`);
      continue;
    }
    if (typeof data !== "string" || !HEX_RE.test(data.toLowerCase())) {
      console.warn(`[ogmiosBlock] tx ${txId}: spend redeemer ${index} is not base16 CBOR; left out`);
      continue;
    }
    const input = ordered[index]!;
    spendRedeemers[`${input.transaction.id}#${input.index}`] = data.toLowerCase();
  }

  const converted: IndexerTx = { id: txId, inputs, outputs, requiredSigners, spendRedeemers };
  const metadata = metadataFromOgmios(tx.metadata, txId);
  if (metadata) converted.metadata = metadata;
  const mint: Record<string, Record<string, number>> = {};
  if (typeof tx.mint === "object" && tx.mint !== null) {
    for (const [policy, assets] of Object.entries(tx.mint as Record<string, unknown>)) {
      if (typeof assets !== "object" || assets === null) continue;
      for (const [name, qty] of Object.entries(assets as Record<string, unknown>)) {
        if (typeof qty === "number" && Number.isSafeInteger(qty) && qty !== 0) {
          (mint[policy.toLowerCase()] ??= {})[name.toLowerCase()] = qty;
        }
      }
    }
  }
  if (Object.keys(mint).length > 0) converted.mint = mint;
  return converted;
}

/**
 * Convert one Ogmios v6 chain-sync block. The block header fields pass
 * unchanged; an epoch boundary block without a slot keeps `slot` undefined,
 * which the worker skips.
 */
export function fromOgmiosBlock(raw: unknown): IndexerBlock {
  const block = raw as OgmiosBlockJson | null | undefined;
  const transactions: IndexerTx[] = [];
  for (const item of list(block?.transactions)) {
    const tx = toTransaction(item);
    if (tx) transactions.push(tx);
  }
  const out: IndexerBlock = {
    slot: block?.slot as number,
    id: block?.id as string,
    ancestor: typeof block?.ancestor === "string" ? block.ancestor : undefined,
    transactions,
  };
  const height = block?.height;
  if (typeof height === "number" && Number.isSafeInteger(height) && height >= 0) out.height = height;
  return out;
}
