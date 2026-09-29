import { CML } from "@lucid-evolution/lucid";
import { sha256Hex } from "./testTxBody.js";

export interface SignedTransactionInfo {
  txHash: string;
  validUntilSlot: number | null;
  outputIndexes: number[];
}

interface SyntheticTransactionBody {
  type?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  validityRange?: {
    upperBoundMs?: unknown;
  };
}

function safeSlot(value: bigint): number {
  const slot = Number(value);
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new Error(`signed transaction has an invalid upper validity slot: ${value.toString()}`);
  }
  return slot;
}

function inspectSyntheticTransaction(txCborHex: string): SignedTransactionInfo | null {
  if (!/^[0-9a-fA-F]+$/.test(txCborHex) || txCborHex.length < 10 || txCborHex.length % 2 !== 0) {
    return null;
  }

  const jsonByteLength = Number.parseInt(txCborHex.slice(0, 8), 16);
  if (!Number.isSafeInteger(jsonByteLength) || jsonByteLength <= 0) return null;
  const jsonEnd = 8 + jsonByteLength * 2;
  if (jsonEnd > txCborHex.length) return null;

  let parsed: SyntheticTransactionBody;
  try {
    const json = Buffer.from(txCborHex.slice(8, jsonEnd), "hex").toString("utf8");
    if (!json.startsWith("{")) return null;
    parsed = JSON.parse(json) as SyntheticTransactionBody;
  } catch {
    return null;
  }

  if (typeof parsed.type !== "string" || !Array.isArray(parsed.inputs) || !Array.isArray(parsed.outputs)) {
    return null;
  }

  const upperBoundMs = parsed.validityRange?.upperBoundMs;
  let validUntilSlot: number | null = null;
  if (upperBoundMs !== undefined && upperBoundMs !== null) {
    if (typeof upperBoundMs !== "number" || !Number.isFinite(upperBoundMs) || upperBoundMs < 0) {
      throw new Error("synthetic signed transaction has an invalid upper validity bound");
    }
    validUntilSlot = Math.floor(upperBoundMs / 1_000);
  }

  return {
    txHash: sha256Hex(txCborHex),
    validUntilSlot,
    outputIndexes: parsed.outputs.map((_output, index) => index),
  };
}

/** Inspect an already-signed transaction without changing it. */
export function inspectSignedTransaction(txCborHex: string): SignedTransactionInfo {
  const synthetic = inspectSyntheticTransaction(txCborHex);
  if (synthetic !== null) return synthetic;

  let transaction: InstanceType<typeof CML.Transaction> | undefined;
  let body: InstanceType<typeof CML.TransactionBody> | undefined;
  let hash: InstanceType<typeof CML.TransactionHash> | undefined;
  let outputs: InstanceType<typeof CML.TransactionOutputList> | undefined;
  try {
    transaction = CML.Transaction.from_cbor_hex(txCborHex);
    body = transaction.body();
    hash = CML.hash_transaction(body);
    outputs = body.outputs();
    const ttl = body.ttl();
    return {
      txHash: hash.to_hex().toLowerCase(),
      validUntilSlot: ttl === undefined ? null : safeSlot(ttl),
      outputIndexes: Array.from({ length: outputs.len() }, (_unused, index) => index),
    };
  } catch (error) {
    throw new Error(
      `cannot inspect signed transaction: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    outputs?.free();
    hash?.free();
    body?.free();
    transaction?.free();
  }
}
