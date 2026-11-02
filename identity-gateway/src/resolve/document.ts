// The DID document (Part 1 Section 8.1).

import { keyHash, multikey } from "../codec/keys.js";
import type { RecordView } from "./view.js";

export const DID_CONTEXT = "https://www.w3.org/ns/did/v1.1";

export interface VerificationMethod {
  readonly id: string;
  readonly type: "Multikey";
  readonly controller: string;
  readonly publicKeyMultibase: string;
}

export interface DidDocument {
  readonly "@context": string;
  readonly id: string;
  readonly alsoKnownAs?: readonly string[];
  readonly verificationMethod?: readonly VerificationMethod[];
  readonly capabilityInvocation?: readonly string[];
  readonly authentication?: readonly string[];
  readonly assertionMethod?: readonly string[];
  readonly capabilityDelegation?: readonly string[];
}

/** Listed key purposes (Part 1 Section 5). */
export const PURPOSE = { authentication: 1, assertion: 2, transaction: 8, delegation: 16 } as const;

/**
 * `id` is the document id (the DID of the request). For a legacy view, `legacyKey` is the key that
 * the legacy key search found for the view's owner, or null. P-256 keys without a valid proof are
 * left out. `alsoKnownAs` lists only domains whose link to the DID a background job verified.
 */
export function buildDocument(
  id: string,
  view: RecordView,
  legacyKey: string | null,
  expandRelativeUrls: boolean,
  alsoKnownAs: readonly string[] = [],
): DidDocument {
  const ref = (hash: string): string => (expandRelativeUrls ? `${id}#${hash}` : `#${hash}`);
  const verificationMethod: VerificationMethod[] = [];
  const addMethod = (keyType: "Ed25519" | "P256", key: string): string => {
    const hash = keyHash(key);
    verificationMethod.push({ id: `${id}#${hash}`, type: "Multikey", controller: id, publicKeyMultibase: multikey(keyType, key) });
    return hash;
  };
  const capabilityInvocation: string[] = [];
  const authentication: string[] = [];
  const assertionMethod: string[] = [];
  const capabilityDelegation: string[] = [];

  if (view.kind === "legacy") {
    if (legacyKey !== null) {
      const hash = addMethod("Ed25519", legacyKey);
      capabilityInvocation.push(ref(hash));
      authentication.push(ref(hash));
      assertionMethod.push(ref(hash));
    }
  } else {
    if (view.controller !== null) capabilityInvocation.push(ref(addMethod("Ed25519", view.controller)));
    for (const k of view.keys) {
      if (!k.popValid) continue;
      if (k.key !== view.controller) addMethod(k.keyType, k.key);
      if (k.purposes & PURPOSE.authentication) authentication.push(ref(k.keyHash));
      if (k.purposes & PURPOSE.assertion) assertionMethod.push(ref(k.keyHash));
      if (k.purposes & PURPOSE.delegation) capabilityDelegation.push(ref(k.keyHash));
    }
  }

  return {
    "@context": DID_CONTEXT,
    id,
    ...(alsoKnownAs.length ? { alsoKnownAs: [...alsoKnownAs] } : {}),
    ...(verificationMethod.length ? { verificationMethod } : {}),
    ...(capabilityInvocation.length ? { capabilityInvocation } : {}),
    ...(authentication.length ? { authentication } : {}),
    ...(assertionMethod.length ? { assertionMethod } : {}),
    ...(capabilityDelegation.length ? { capabilityDelegation } : {}),
  };
}
