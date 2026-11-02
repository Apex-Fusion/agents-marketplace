// did:vector syntax (Part 1 Section 3):
//
//   did-vector        = %s"did:vector:" vector-id
//   did-vector-legacy = %s"did:vector:agent:" 56lowhex ":" vector-id
//   did-vector-net    = %s"did:vector:" network ":" vector-id   ; reserved
//   network           = %s"testnet"
//   vector-id         = 64lowhex
//
// Every character is lowercase; a DID with an uppercase character is INVALID_DID.

import { ResolutionError } from "./errors.js";

export type DidForm = "canonical" | "legacy" | "testnet";

export interface ParsedDid {
  /** The DID exactly as given. */
  readonly did: string;
  readonly form: DidForm;
  /** The 64-hex identifier. */
  readonly vectorId: string;
  /** The policy ID that the legacy form names; null for the other forms. */
  readonly legacyPolicyId: string | null;
}

// DID Core: "did:" method-name ":" method-specific-id.
const IDCHAR = "(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})";
const GENERIC_DID = new RegExp(`^did:([a-z0-9]+):((?:${IDCHAR}*:)*${IDCHAR}+)$`);

const CANONICAL = /^([0-9a-f]{64})$/;
const TESTNET = /^testnet:([0-9a-f]{64})$/;
const LEGACY = /^agent:([0-9a-f]{56}):([0-9a-f]{64})$/;

/** Part 1 Section 7.1 step 1. */
export function parseDid(input: string): ParsedDid {
  const generic = GENERIC_DID.exec(input);
  if (!generic) throw new ResolutionError("INVALID_DID", "Invalid DID: the input is not a DID");
  const method = generic[1]!;
  const msid = generic[2]!;
  if (method !== "vector") throw new ResolutionError("METHOD_NOT_SUPPORTED", `DID method not supported: did:${method}`);

  let m = CANONICAL.exec(msid);
  if (m) return { did: input, form: "canonical", vectorId: m[1]!, legacyPolicyId: null };
  m = TESTNET.exec(msid);
  if (m) return { did: input, form: "testnet", vectorId: m[1]!, legacyPolicyId: null };
  m = LEGACY.exec(msid);
  if (m) return { did: input, form: "legacy", vectorId: m[2]!, legacyPolicyId: m[1]! };
  throw new ResolutionError(
    "INVALID_DID",
    "Invalid DID: expected did:vector:<64 lowercase hex> or did:vector:agent:<56 lowercase hex>:<64 lowercase hex>",
  );
}

export const canonicalDid = (vectorId: string): string => `did:vector:${vectorId}`;
export const legacyDid = (policyId: string, vectorId: string): string => `did:vector:agent:${policyId}:${vectorId}`;
