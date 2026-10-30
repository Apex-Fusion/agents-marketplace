// did:vector parser (method spec Section 3.1).
//
//   did-vector        = "did:vector:" [ network ":" ] vector-id
//   network           = "testnet"            ; absent means mainnet
//   vector-id         = 64lowhex
//   legacy-did-vector = "did:vector:agent:" 56lowhex ":" 64lowhex
//
// Literal parts are matched in lowercase only. RFC 5234 quoted strings are case-insensitive, but
// DID Core requires a lowercase scheme and method name, and the spec says the identifier is
// case-sensitive; an uppercase literal is therefore rejected as INVALID_DID like uppercase hex.

import { ResolutionError } from "./errors.js";

export type VectorNetwork = "mainnet" | "testnet";

export interface ParsedDid {
  /** The DID exactly as given. */
  did: string;
  network: VectorNetwork;
  /** The 64-hex identifier (for the legacy form: the asset name). */
  vectorId: string;
  /** The policy ID named by the legacy form; null for the canonical form. */
  legacyPolicyId: string | null;
  /** `did:vector:[testnet:]<vector-id>` (Section 6.2). */
  canonicalId: string;
}

// DID Core 1.0 Section 3.1: "did:" method-name ":" method-specific-id.
const IDCHAR = "(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})";
const GENERIC_DID = new RegExp(`^did:([a-z0-9]+):((?:${IDCHAR}*:)*${IDCHAR}+)$`);

const CANONICAL = /^([0-9a-f]{64})$/;
const TESTNET = /^testnet:([0-9a-f]{64})$/;
const LEGACY = /^agent:([0-9a-f]{56}):([0-9a-f]{64})$/;

export function parseDid(input: string): ParsedDid {
  const generic = GENERIC_DID.exec(input);
  if (!generic) throw new ResolutionError("INVALID_DID", "Invalid DID", "the input does not conform to the DID syntax");
  const method = generic[1];
  const msid = generic[2];
  if (method !== "vector") {
    throw new ResolutionError("METHOD_NOT_SUPPORTED", "DID method not supported", `this resolver supports did:vector only, not did:${method}`);
  }

  let m = CANONICAL.exec(msid);
  if (m) return { did: input, network: "mainnet", vectorId: m[1], legacyPolicyId: null, canonicalId: `did:vector:${m[1]}` };
  m = TESTNET.exec(msid);
  if (m) return { did: input, network: "testnet", vectorId: m[1], legacyPolicyId: null, canonicalId: `did:vector:testnet:${m[1]}` };
  m = LEGACY.exec(msid);
  if (m) return { did: input, network: "mainnet", vectorId: m[2], legacyPolicyId: m[1], canonicalId: `did:vector:${m[2]}` };

  const lower = msid.toLowerCase();
  if (CANONICAL.test(lower) || TESTNET.test(lower) || LEGACY.test(lower)) {
    throw new ResolutionError("INVALID_DID", "Invalid DID", "did:vector identifiers are lowercase; uppercase is not allowed");
  }
  throw new ResolutionError(
    "INVALID_DID",
    "Invalid DID",
    "expected did:vector:<64 hex>, did:vector:testnet:<64 hex> or did:vector:agent:<56 hex>:<64 hex>",
  );
}
