/**
 * Transaction files of the build mode (`--build`, `sign`, `submit`): JSON
 * with the transaction CBOR in a TextEnvelope-like form, plus the step, the
 * transaction ID and the key hashes that must sign. The transaction ID
 * links a file to its pending build in the state file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { dirname } from "node:path";
import { keyHash, transactionId } from "@marketplace/shared";
import { readCbor } from "../../../packages/shared/src/identity/tx/cbor.js";
import { DeployError, type NetworkName } from "./network.js";

export const UNSIGNED_TYPE = "Unwitnessed Tx ConwayEra";
export const SIGNED_TYPE = "Witnessed Tx ConwayEra";

export interface TxFile {
  type: typeof UNSIGNED_TYPE | typeof SIGNED_TYPE;
  description: string;
  cborHex: string;
  network: NetworkName;
  step: string;
  txId: string;
  /** Key hashes that must sign. */
  signers: string[];
}

export function writeTxFile(path: string, file: TxFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temporary, path);
}

export function readTxFile(path: string): TxFile {
  let file: TxFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as TxFile;
  } catch (error) {
    throw new DeployError(`cannot read the transaction file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((file.type !== UNSIGNED_TYPE && file.type !== SIGNED_TYPE) || typeof file.cborHex !== "string" || typeof file.step !== "string" || !Array.isArray(file.signers)) {
    throw new DeployError(`${path} is not a transaction file of this tool`);
  }
  if (transactionId(file.cborHex) !== file.txId) throw new DeployError(`${path}: the transaction ID ${file.txId} does not match the transaction`);
  return file;
}

/** DER prefix of an SPKI Ed25519 public key; the 32-byte key follows it. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The key hashes of the key witnesses whose Ed25519 signature of the transaction ID is valid. */
export function witnessedKeyHashes(txCborHex: string): string[] {
  const bytes = Buffer.from(txCborHex, "hex");
  const tx = readCbor(bytes);
  if (tx.kind !== "array" || tx.items.length !== 4 || tx.items[1]!.kind !== "map") throw new DeployError("not a Conway transaction");
  const id = Buffer.from(transactionId(txCborHex), "hex");
  const field = tx.items[1]!.entries.find(([key]) => key.kind === "uint" && key.value === 0n)?.[1];
  if (field === undefined) return [];
  const list = field.kind === "tag" ? field.item : field;
  if (list.kind !== "array") throw new DeployError("the key witnesses are not a list");
  const hashes: string[] = [];
  for (const witness of list.items) {
    if (witness.kind !== "array" || witness.items[0]?.kind !== "bytes" || witness.items[1]?.kind !== "bytes") throw new DeployError("a key witness is not [key, signature]");
    const publicKey = Buffer.from(witness.items[0].value);
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: "der", type: "spki" });
    if (verify(null, id, key, Buffer.from(witness.items[1].value))) hashes.push(keyHash(publicKey.toString("hex")));
  }
  return hashes;
}

/** The fee (body field 2) and the coin of output 0 (body field 1) of a transaction. */
export function feeAndFirstOutput(txCborHex: string): { fee: bigint; firstOutput: bigint } {
  const tx = readCbor(Buffer.from(txCborHex, "hex"));
  const body = tx.kind === "array" ? tx.items[0] : undefined;
  if (body?.kind !== "map") throw new DeployError("the transaction has no body");
  const field = (key: bigint) => body.entries.find(([k]) => k.kind === "uint" && k.value === key)?.[1];
  const fee = field(2n);
  const outputs = field(1n);
  const first = outputs?.kind === "array" ? outputs.items[0] : undefined;
  const value = first?.kind === "map" ? first.entries.find(([k]) => k.kind === "uint" && k.value === 1n)?.[1] : undefined;
  const coin = value?.kind === "uint" ? value : value?.kind === "array" ? value.items[0] : undefined;
  if (fee?.kind !== "uint" || coin?.kind !== "uint") throw new DeployError("the transaction has no fee or no output 0");
  return { fee: fee.value, firstOutput: coin.value };
}
