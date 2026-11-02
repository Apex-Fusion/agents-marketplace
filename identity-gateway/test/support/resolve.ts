// Shortcuts for resolver tests.

import type { IdentityDatum, Status } from "../../src/codec/identity-datum.js";
import { keyHash, multikey } from "../../src/codec/keys.js";
import type { ResolutionOptionsInput } from "../../src/resolve/options.js";
import { VectorResolver, type ResolutionResult } from "../../src/resolve/resolver.js";
import { LEGACY, type LedgerBuilder } from "./ledger.js";

export const didOf = (id: string): string => `did:vector:${id}`;
export const legacyDidOf = (id: string): string => `did:vector:agent:${LEGACY.policyId}:${id}`;

export function resolverFor(builder: LedgerBuilder, logs: string[] = []): VectorResolver {
  return new VectorResolver(builder.chain, builder.settings, { log: (m) => logs.push(m) });
}

export function resolveIn(builder: LedgerBuilder, did: string, options?: ResolutionOptionsInput): Promise<ResolutionResult> {
  return resolverFor(builder).resolveDid(did, options);
}

/** A relative reference to a key: `#<key hash>`. */
export const ref = (key: string): string => `#${keyHash(key)}`;

/** The verificationMethod entry of a key. */
export function method(docId: string, key: string, keyType: "Ed25519" | "P256" = "Ed25519") {
  return { id: `${docId}#${keyHash(key)}`, type: "Multikey", controller: docId, publicKeyMultibase: multikey(keyType, key) };
}

/** Part 2 Section 3.7: a tombstone keeps the controller, name, lineage, epoch and created_at. */
export function tombstoneOf(datum: IdentityDatum, status: Status): IdentityDatum {
  const empty = new Uint8Array();
  return {
    ...datum,
    keys: [],
    parties: [],
    guardianThreshold: 0,
    pendingRecovery: null,
    description: empty,
    framework: empty,
    endpoint: empty,
    capabilities: [],
    status,
  };
}

export const errorType = (result: ResolutionResult): string | undefined => result.didResolutionMetadata.error?.type.split("#")[1];
