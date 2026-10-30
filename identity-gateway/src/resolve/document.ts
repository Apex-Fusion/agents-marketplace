// DID document and DID document metadata for generation-1 records (method spec Sections 6.2, 6.5, 7).

import type { ChainTip, LedgerTx } from "../chain/types.js";
import { ed25519Multikey } from "./multikey.js";

/** Section 7. The same list for every document, so that the content stays deterministic. */
export const DID_CONTEXT = [
  "https://www.w3.org/ns/did/v1",
  "https://w3id.org/security/multikey/v1",
  "https://w3id.org/security/jwk/v1",
  "https://id.vector.apexfusion.org/ns/v1",
];

export interface VerificationMethod {
  id: string;
  type: "Multikey";
  controller: string;
  publicKeyMultibase: string;
}

export interface DidDocument {
  "@context": string[];
  id: string;
  verificationMethod?: VerificationMethod[];
  capabilityInvocation?: string[];
  authentication?: string[];
}

export interface VectorLedger {
  txId: string;
  /** Absent for a deactivated legacy record: the burn leaves no record output. */
  outputIndex?: number;
  blockHash: string;
  blockHeight: number;
  slot: number;
  confirmations: number;
}

/** Why a generation-1 document renders no verification method. */
export type VectorMetadataError =
  /** No vkey witness on the searched ledger history hashes to the owner hash. */
  | "controllerKeyNotFound"
  /** The owner credential is a script hash; scripts have no verification method. */
  | "controllerIsScript"
  /** The record datum is not a 7-field generation-1 datum. */
  | "recordDatumInvalid"
  /** The record datum bytes are not available (datum hash without a known datum). */
  | "recordDatumUnavailable";

export interface DidDocumentMetadata {
  created?: string;
  updated?: string;
  versionId?: string;
  deactivated?: true;
  canonicalId?: string;
  vectorOrigin?: "legacy";
  vectorStatus?: { status: "active"; effective: "active" };
  vectorLedger?: VectorLedger;
  vectorMetadataError?: VectorMetadataError;
}

/** Block time (POSIX seconds) as an XML Schema dateTime in UTC without fractional seconds. */
export function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function vectorLedger(tx: LedgerTx, outputIndex: number | null, tip: ChainTip): VectorLedger {
  const confirmations = tip.blockHeight - tx.blockHeight;
  if (confirmations < 0) throw new Error(`tip ${tip.blockHeight} is behind transaction ${tx.txHash} at ${tx.blockHeight}`);
  return {
    txId: tx.txHash,
    ...(outputIndex === null ? {} : { outputIndex }),
    blockHash: tx.blockHash,
    blockHeight: tx.blockHeight,
    slot: tx.slot,
    confirmations,
  };
}

/**
 * Section 6.5: the controller key, when known, is `#c0` (controller signer index 0) and is listed
 * under both capabilityInvocation and authentication. Nothing else of the record is rendered.
 */
export function legacyDidDocument(id: string, controllerKeyHex: string | null): DidDocument {
  const doc: DidDocument = { "@context": DID_CONTEXT, id };
  if (controllerKeyHex !== null) {
    doc.verificationMethod = [
      { id: `${id}#c0`, type: "Multikey", controller: id, publicKeyMultibase: ed25519Multikey(Buffer.from(controllerKeyHex, "hex")) },
    ];
    doc.capabilityInvocation = ["#c0"];
    doc.authentication = ["#c0"];
  }
  return doc;
}

/** Section 6.1 step 4: the minimal document returned for a deactivated identifier. */
export function minimalDidDocument(id: string): DidDocument {
  return { "@context": DID_CONTEXT, id };
}
