// did:vector resolution (method spec Section 6.1), milestone M0: generation-1 (legacy) records on
// Vector mainnet, resolved at the current tip. No generation 2 exists yet (see registry.ts).

import type { ChainSource } from "../chain/types.js";
import { findControllerKey } from "./controller-key.js";
import { parseDid } from "./did.js";
import {
  isoTime,
  legacyDidDocument,
  minimalDidDocument,
  vectorLedger,
  type DidDocument,
  type DidDocumentMetadata,
  type VectorMetadataError,
} from "./document.js";
import { ERROR_HTTP_STATUS, ResolutionError, errorTypeUri, type ResolutionErrorType } from "./errors.js";
import { decodeLegacyOwner, type LegacyOwner } from "./legacy-datum.js";
import { findLegacyRecord } from "./legacy-record.js";
import { GENERATION_1 } from "./registry.js";

/** Media type of the DID document representation (DID 1.1). */
export const DID_DOCUMENT_MEDIA_TYPE = "application/did";

export interface ResolutionResult {
  didDocument: DidDocument | null;
  didResolutionMetadata: {
    contentType?: string;
    error?: { type: string; title: string; detail?: string };
  };
  didDocumentMetadata: DidDocumentMetadata;
}

export function errorResult(error: ResolutionError): ResolutionResult {
  return {
    didDocument: null,
    didResolutionMetadata: {
      error: { type: errorTypeUri(error.type), title: error.title, ...(error.detail ? { detail: error.detail } : {}) },
    },
    didDocumentMetadata: {},
  };
}

const STATUS_BY_TYPE_URI = new Map(
  (Object.entries(ERROR_HTTP_STATUS) as Array<[ResolutionErrorType, number]>).map(([type, status]) => [errorTypeUri(type), status]),
);

/** HTTPS binding status (DID Resolution Section 11): 410 for deactivated wins over everything else. */
export function httpStatus(result: ResolutionResult): number {
  if (result.didDocumentMetadata.deactivated) return 410;
  const error = result.didResolutionMetadata.error;
  return error ? (STATUS_BY_TYPE_URI.get(error.type) ?? 500) : 200;
}

export class DidVectorResolver {
  constructor(private readonly chain: ChainSource) {}

  /**
   * Resolves a DID. Expected failures (bad DID, unknown DID, unsupported request) come back as an
   * error result; unexpected failures (chain source down, inconsistent chain data) are thrown.
   */
  async resolve(did: string, options: Record<string, string> = {}): Promise<ResolutionResult> {
    try {
      return await this.resolveOrThrow(did, options);
    } catch (e) {
      if (e instanceof ResolutionError) return errorResult(e);
      throw e;
    }
  }

  private async resolveOrThrow(did: string, options: Record<string, string>): Promise<ResolutionResult> {
    const parsed = parseDid(did);
    const optionNames = Object.keys(options);
    if (optionNames.length) {
      throw new ResolutionError(
        "FEATURE_NOT_SUPPORTED",
        "Resolution option not supported",
        `this resolver resolves the current version only and accepts no options (got ${optionNames.join(", ")})`,
      );
    }
    if (parsed.network !== "mainnet") {
      throw new ResolutionError("FEATURE_NOT_SUPPORTED", "Network not supported", "this resolver serves Vector mainnet only");
    }
    if (parsed.legacyPolicyId !== null && parsed.legacyPolicyId !== GENERATION_1.policyId) {
      throw new ResolutionError("NOT_FOUND", "DID not found", `policy ${parsed.legacyPolicyId} is not a did:vector registry generation`);
    }

    const lookup = await findLegacyRecord(this.chain, parsed.vectorId);
    switch (lookup.state) {
      case "neverMinted":
        throw new ResolutionError("NOT_FOUND", "DID not found", "no registry generation ever minted this identifier");
      case "notAuthentic":
        throw new ResolutionError("NOT_FOUND", "DID not found", "the identity token is not held by an authentic generation-1 record");
      case "deactivated": {
        const tip = await this.chain.tip();
        return {
          didDocument: minimalDidDocument(parsed.did),
          didResolutionMetadata: { contentType: DID_DOCUMENT_MEDIA_TYPE },
          didDocumentMetadata: {
            created: isoTime(lookup.mintTx.blockTime),
            updated: isoTime(lookup.burnTx.blockTime),
            deactivated: true,
            canonicalId: parsed.canonicalId,
            vectorOrigin: "legacy",
            vectorLedger: vectorLedger(lookup.burnTx, null, tip),
          },
        };
      }
      case "active": {
        let controllerKey: string | null = null;
        let metadataError: VectorMetadataError | undefined;
        if (lookup.record.datumHex === null) metadataError = "recordDatumUnavailable";
        else {
          let owner: LegacyOwner | null = null;
          try {
            owner = decodeLegacyOwner(lookup.record.datumHex);
          } catch {
            metadataError = "recordDatumInvalid";
          }
          if (owner?.kind === "script") metadataError = "controllerIsScript";
          else if (owner) {
            controllerKey = await findControllerKey(this.chain, owner.hash, lookup.history);
            if (controllerKey === null) metadataError = "controllerKeyNotFound";
          }
        }
        const tip = await this.chain.tip();
        return {
          didDocument: legacyDidDocument(parsed.did, controllerKey),
          didResolutionMetadata: { contentType: DID_DOCUMENT_MEDIA_TYPE },
          didDocumentMetadata: {
            created: isoTime(lookup.mintTx.blockTime),
            updated: isoTime(lookup.producedBy.blockTime),
            versionId: String(lookup.updates),
            canonicalId: parsed.canonicalId,
            vectorOrigin: "legacy",
            // Section 6.5: before the generation-2 deployment a legacy record is effectively active.
            vectorStatus: { status: "active", effective: "active" },
            vectorLedger: vectorLedger(lookup.producedBy, lookup.record.outputIndex, tip),
            ...(metadataError ? { vectorMetadataError: metadataError } : {}),
          },
        };
      }
    }
  }
}
