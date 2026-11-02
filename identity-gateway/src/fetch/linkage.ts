// Domain linkage (Part 1 Section 8.1; Part 2 Section 8.6), as a background job. A domain is linked
// to a DID when one of these is true:
// - a DNS TXT record at `_did.<domain>` names the DID (its text is the DID, or `did=` and the DID);
// - `https://<domain>/.well-known/did-configuration.json` holds a Domain Linkage Credential in the
//   JSON Web Token proof format of DIF Well Known DID Configuration v1.0
//   (https://identity.foundation/.well-known/resources/did-configuration/), issued by the DID and
//   signed by an assertion key of its current DID document (EdDSA or ES256). The JSON-LD proof
//   format needs Linked Data signature suites that this gateway does not implement; such entries
//   are skipped.
// The fetch rules of fetcher.ts apply to the HTTPS check.

import { createHash } from "node:crypto";
import type { VectorFetched } from "../resolve/metadata.js";
import { formatTime } from "../resolve/time.js";
import { fromBase64url, signatureValid, type RecordKeyType } from "../render/jose.js";
import { fetchedRecord, parseJson } from "./detect.js";
import type { SafeFetcher } from "./fetcher.js";

/** TXT records of a DNS name; each record is the list of its character strings. */
export type TxtLookup = (name: string) => Promise<string[][]>;

export interface AssertionKey {
  readonly keyType: RecordKeyType;
  /** Public key, hex. */
  readonly key: string;
}

export interface LinkageSubject {
  /** The DIDs that name the record: the canonical form, and the legacy form when the legacy registry minted it. */
  readonly dids: readonly string[];
  /** The assertion keys of the record's current DID document, by key hash. */
  readonly assertionKeys: ReadonlyMap<string, AssertionKey>;
}

export interface DomainCheck {
  /** Lowercase domain name. */
  readonly domain: string;
  readonly checkedAt: number;
  readonly verified: boolean;
  readonly method: "dnsTxt" | "didConfiguration" | null;
  /** didConfiguration: the key hash of the assertion key that signed the credential. */
  readonly keyHash: string | null;
  readonly fetched: VectorFetched | null;
  readonly failure: string | null;
}

export const DID_CONFIGURATION_CONTEXT = "https://identity.foundation/.well-known/did-configuration/v1";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `credentialSubject.origin` names the domain: `https://<domain>`, or the bare domain as in the specification's JWT example. */
function namesDomain(origin: unknown, domain: string): boolean {
  if (typeof origin !== "string") return false;
  const lower = origin.toLowerCase().replace(/\/$/, "");
  return lower === `https://${domain}` || lower === domain;
}

/**
 * Checks one Domain Linkage Credential in the JWT proof format for `domain`. Returns the key hash of
 * the assertion key that signed it, or null.
 */
export function verifyLinkageJwt(jwt: string, domain: string, subject: LinkageSubject, nowMs: number): string | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const headerBytes = fromBase64url(headerPart);
  const payloadBytes = fromBase64url(payloadPart);
  const signature = fromBase64url(signaturePart);
  if (!headerBytes || !payloadBytes || !signature) return null;
  const header = parseJson(headerBytes);
  const payload = parseJson(payloadBytes);
  if (!isObject(header) || !isObject(payload) || typeof header.kid !== "string") return null;

  const hashAt = header.kid.indexOf("#");
  const did = header.kid.slice(0, hashAt);
  const keyHash = header.kid.slice(hashAt + 1);
  const key = hashAt > 0 && subject.dids.includes(did) ? subject.assertionKeys.get(keyHash) : undefined;
  if (!key) return null;
  if (key.keyType === "Ed25519" ? header.alg !== "EdDSA" && header.alg !== "Ed25519" : header.alg !== "ES256") return null;

  const vc = payload.vc;
  if (payload.iss !== did || payload.sub !== did || !isObject(vc)) return null;
  const issuer = isObject(vc.issuer) ? vc.issuer.id : vc.issuer;
  const subjectClaim = vc.credentialSubject;
  if (issuer !== did || !isObject(subjectClaim) || subjectClaim.id !== did || !namesDomain(subjectClaim.origin, domain)) return null;
  if (!Array.isArray(vc.type) || !vc.type.includes("DomainLinkageCredential")) return null;
  if (!Array.isArray(vc["@context"]) || !vc["@context"].includes(DID_CONFIGURATION_CONTEXT)) return null;
  const nowSeconds = nowMs / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > nowSeconds)) return null;

  const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  return signatureValid(key.keyType, key.key, signingInput, signature) ? keyHash : null;
}

export interface LinkageDeps {
  readonly fetcher: SafeFetcher;
  readonly txt: TxtLookup;
}

/** Checks DNS first, then the DID configuration resource. Never throws. */
export async function checkDomain(deps: LinkageDeps, domain: string, subject: LinkageSubject, now: number): Promise<DomainCheck> {
  const base = { domain, checkedAt: now };
  const txtName = `_did.${domain}`;
  try {
    for (const record of await deps.txt(txtName)) {
      const text = record.join("");
      const value = text.trim();
      if (subject.dids.includes(value.startsWith("did=") ? value.slice(4) : value)) {
        return {
          ...base,
          verified: true,
          method: "dnsTxt",
          keyHash: null,
          // RFC 4501 DNS URI of the record set.
          fetched: { url: `dns:${txtName}?type=TXT`, fetchedAt: formatTime(now), sha256: createHash("sha256").update(text, "utf8").digest("hex") },
          failure: null,
        };
      }
    }
  } catch {
    // No TXT record (or no answer): the HTTPS check decides.
  }

  const failed = (failure: string): DomainCheck => ({ ...base, verified: false, method: null, keyHash: null, fetched: null, failure });
  let result;
  try {
    result = await deps.fetcher.fetch(`https://${domain}/.well-known/did-configuration.json`, { headers: { accept: "application/json" } });
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
  if (result.status !== 200) return failed(`the DID configuration answered HTTP ${result.status}`);
  const resource = parseJson(result.body);
  if (!isObject(resource) || resource["@context"] === undefined || !Array.isArray(resource.linked_dids)) return failed("the DID configuration resource is not valid");
  for (const entry of resource.linked_dids) {
    const keyHash = typeof entry === "string" ? verifyLinkageJwt(entry, domain, subject, now) : null;
    if (keyHash) return { ...base, verified: true, method: "didConfiguration", keyHash, fetched: fetchedRecord(result), failure: null };
  }
  return failed("no Domain Linkage Credential of the DID verifies");
}
