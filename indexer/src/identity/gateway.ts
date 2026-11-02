/**
 * indexer/src/identity/gateway.ts — identity facts from the identity gateway.
 *
 * The indexer reads the view without options (Part 2 §6.4, Part 1 §7.2–7.3)
 * through the gateway's DID Resolution HTTPS binding (Part 1 §7.4,
 * W3C DID Resolution v1.0: https://www.w3.org/TR/did-resolution/):
 *
 *   GET {gateway}/1.0/identifiers/did:vector:<agent_id>
 *   Accept: application/did-resolution
 *
 * The body is the resolution result `{ didDocument, didResolutionMetadata,
 * didDocumentMetadata }`. The indexer reads these members of the document
 * metadata (Part 1 §8.2):
 *   - canonicalId               must be did:vector:<agent_id>
 *   - vectorStatus.effective    active | suspended | revoked | retired
 *   - vectorParent              present only for a subagent
 *   - vectorOrigin              native | adopted | legacy
 *   - vectorKeys[]              { id: "#<key hash>", type: "Ed25519" | "P-256", purposes[] }
 *   - vectorProfile.capabilities
 * Members whose value is false, none or an empty list are left out (§8.2).
 *
 * HTTP status (Part 1 §7.4): 200 found; 410 deactivated; 404 NOT_FOUND;
 * 400 INVALID_DID. These are definitive answers. Any other status, a
 * network error, a timeout or a body that does not fit is "unavailable".
 */

import { isVectorId, vectorDid } from "@marketplace/shared/identity";

export const RESOLUTION_MEDIA_TYPE = "application/did-resolution";
const DEFAULT_TIMEOUT_MS = 5_000;
const KEY_HASH_RE = /^[0-9a-f]{56}$/;

/** Facts that the listing rule needs from a found record. */
export interface ResolvedIdentity {
  effective: string;
  independent: boolean;
  origin: string | null;
  /** Key hashes of the Ed25519 keys with the transaction purpose. */
  transactionKeys: string[];
  capabilities: string[];
}

export type GatewayOutcome =
  | { kind: "found"; identity: ResolvedIdentity }
  | { kind: "absent"; detail: string }
  | { kind: "unavailable"; error: string };

export type ResolveIdentity = (agentId: string) => Promise<GatewayOutcome>;

/** The resolution result members that the indexer reads. Every leaf is checked before use. */
interface ResolutionResultJson {
  didResolutionMetadata?: { error?: { type?: unknown } };
  didDocumentMetadata?: {
    deactivated?: unknown;
    canonicalId?: unknown;
    vectorOrigin?: unknown;
    vectorStatus?: { effective?: unknown };
    vectorParent?: unknown;
    vectorKeys?: unknown;
    vectorProfile?: { capabilities?: unknown };
  };
}

/** DID Resolution error types (https://www.w3.org/ns/did#<NAME>) that are definitive answers. */
const DEFINITIVE_ERRORS = new Map<number, string>([
  [404, "https://www.w3.org/ns/did#NOT_FOUND"],
  [400, "https://www.w3.org/ns/did#INVALID_DID"],
]);

interface VectorKeyJson {
  id?: unknown;
  type?: unknown;
  purposes?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Map one gateway response to an outcome. Pure; the status and body come
 * from the caller. A 404 or 400 counts as an answer only with its DID
 * Resolution error type, and a 410 only with `deactivated: true`: a 404 page
 * of a wrong URL is "unavailable", not "absent".
 */
export function parseResolution(agentId: string, status: number, body: unknown): GatewayOutcome {
  const result = body as ResolutionResultJson | null | undefined;
  const errorType = result?.didResolutionMetadata?.error?.type;
  if (status === 410 && result?.didDocumentMetadata?.deactivated === true) return { kind: "absent", detail: "deactivated" };
  const definitive = DEFINITIVE_ERRORS.get(status);
  if (definitive !== undefined && errorType === definitive) return { kind: "absent", detail: definitive.slice(definitive.indexOf("#") + 1) };
  if (status !== 200) {
    return { kind: "unavailable", error: `HTTP ${status}${typeof errorType === "string" ? ` ${errorType}` : ""}` };
  }
  if (errorType !== undefined) return { kind: "unavailable", error: "HTTP 200 with a resolution error" };

  const meta = result?.didDocumentMetadata;
  if (meta?.canonicalId !== vectorDid(agentId)) {
    return { kind: "unavailable", error: "result is not for the requested DID" };
  }
  const effective = meta.vectorStatus?.effective;
  if (typeof effective !== "string") return { kind: "unavailable", error: "result has no vectorStatus.effective" };

  const keys = Array.isArray(meta.vectorKeys) ? (meta.vectorKeys as VectorKeyJson[]) : [];
  const transactionKeys = keys
    .filter((k) => k?.type === "Ed25519" && strings(k.purposes).includes("transaction") && typeof k.id === "string")
    .map((k) => (k.id as string).replace(/^#/, ""))
    .filter((h) => KEY_HASH_RE.test(h));

  return {
    kind: "found",
    identity: {
      effective,
      independent: meta.vectorParent === undefined,
      origin: typeof meta.vectorOrigin === "string" ? meta.vectorOrigin : null,
      transactionKeys,
      capabilities: strings(meta.vectorProfile?.capabilities),
    },
  };
}

export interface GatewayClientOpts {
  /** Internal gateway origin, for example http://identity-gateway:8080 (no trailing path). */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createGatewayClient(opts: GatewayClientOpts): ResolveIdentity {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (agentId: string): Promise<GatewayOutcome> => {
    if (!isVectorId(agentId)) return { kind: "absent", detail: "invalid agent id" };
    const fetchFn = opts.fetch ?? globalThis.fetch;
    const url = `${base}/1.0/identifiers/${encodeURIComponent(vectorDid(agentId))}`;
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers: { accept: RESOLUTION_MEDIA_TYPE },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { kind: "unavailable", error: (err as Error).message };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      if (response.status === 200) return { kind: "unavailable", error: "response body is not JSON" };
    }
    return parseResolution(agentId, response.status, body);
  };
}
