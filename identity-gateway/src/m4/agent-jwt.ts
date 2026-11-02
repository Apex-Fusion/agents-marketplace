// JWTs that an agent signs with one of its authentication keys (Part 2 Section 8.6): the subject
// token of the token service (RFC 8693 Section 2.1), client assertions (RFC 7523 Sections 2.2 and
// 3), and the X.509-SVID proof. The rules:
// - the header names the key: `kid` = `did:vector:<id>#<key hash>`; `typ`, when present, is JWT;
// - `iss` = `sub` = `did:vector:<id>`, the canonical form (Part 1 Section 3);
// - `aud` is the token endpoint URL (one value);
// - `iat` and `exp` are present, `exp - iat <= 5 min`, and the token has not expired;
// - `jti` is single-use; the gateway keeps it at least until the token expires;
// - the key is an authentication key of the agent in the view without options (Part 1 Section 8.1:
//   a listed key with the authentication purpose, P-256 keys only with a valid pop; for a legacy
//   view, the key that the legacy key search found), and the agent's effective status is Active
//   (Part 1 Section 7.3, "Relying parties").

import type { KeyObject } from "node:crypto";
import { keyHash } from "../codec/keys.js";
import { PURPOSE } from "../resolve/document.js";
import type { CurrentRecord } from "../resolve/resolver.js";
import { CLOCK_LEEWAY_S, MAX_TOKEN_LIFETIME_S, type RecordSource } from "./context.js";
import { JoseError, algKeyKind, has, parseJws, recordKeyObject, verifyJws, type KeyKind } from "./jose.js";
import type { SingleUseStore } from "./replay.js";

const KID = /^did:vector:([0-9a-f]{64})#([0-9a-f]{56})$/;

/** Why an agent JWT was refused. `inactive`: valid, but the agent's effective status is not Active. */
export class AgentJwtError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid" | "inactive",
  ) {
    super(message);
  }
}

export interface AuthenticationKey {
  readonly kind: KeyKind;
  /** Hex, as the record stores it. */
  readonly publicKey: string;
  readonly keyHash: string;
  /** Listed purposes (sum of Part 1 Section 5 values); the legacy key counts as authentication. */
  readonly purposes: number;
}

/** The keys of the view that the DID document puts in `authentication` (Part 1 Section 8.1). */
export function authenticationKeys(record: CurrentRecord): AuthenticationKey[] {
  const view = record.view;
  if (view.kind === "legacy") {
    if (record.legacyControllerKey === null) return [];
    const key = record.legacyControllerKey;
    return [{ kind: "Ed25519", publicKey: key, keyHash: keyHash(key), purposes: PURPOSE.authentication | PURPOSE.assertion }];
  }
  return view.keys
    .filter((k) => k.popValid && k.purposes & PURPOSE.authentication)
    .map((k) => ({ kind: k.keyType, publicKey: k.key, keyHash: k.keyHash, purposes: k.purposes }));
}

export interface VerifiedAgentJwt {
  readonly vectorId: string;
  readonly did: string;
  readonly record: CurrentRecord;
  readonly key: AuthenticationKey;
  readonly claims: Record<string, unknown>;
  readonly header: Record<string, unknown>;
}

export interface AgentJwtOptions {
  /** The required `aud` value: the token endpoint URL. */
  readonly audience: string;
  /** Key types whose signatures this kind of JWT accepts. */
  readonly keyKinds: readonly KeyKind[];
  readonly records: RecordSource;
  readonly replay: SingleUseStore;
  /** POSIX milliseconds. */
  readonly now: number;
}

const numericDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Verifies an agent JWT. Throws AgentJwtError when the JWT is refused; a failed ledger read
 * propagates as another error.
 */
export async function verifyAgentJwt(token: unknown, options: AgentJwtOptions): Promise<VerifiedAgentJwt> {
  const invalid = (message: string): AgentJwtError => new AgentJwtError(message, "invalid");
  let jws;
  try {
    jws = parseJws(token);
  } catch (e) {
    throw invalid(e instanceof JoseError ? e.message : "the token is not a JWS");
  }
  const { header, payload: claims } = jws;
  if (has(header, "typ") && (typeof header.typ !== "string" || header.typ.toLowerCase() !== "jwt")) throw invalid("the JWT type (typ) must be JWT");
  const kind = algKeyKind(header.alg);
  if (kind === null || !options.keyKinds.includes(kind)) throw invalid(`the algorithm ${String(header.alg)} is not accepted here`);
  const kid = typeof header.kid === "string" ? KID.exec(header.kid) : null;
  if (!kid) throw invalid("the kid must be the DID URL of the key: did:vector:<id>#<key hash>");
  const [, vectorId, kidHash] = kid;
  const did = `did:vector:${vectorId}`;
  if (claims.iss !== did || claims.sub !== did) throw invalid("iss and sub must both be the DID of the key in kid");
  const aud = claims.aud;
  if (!(aud === options.audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === options.audience))) {
    throw invalid(`aud must be ${options.audience}`);
  }
  if (!numericDate(claims.iat) || !numericDate(claims.exp)) throw invalid("iat and exp are required");
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TOKEN_LIFETIME_S) throw invalid("exp - iat must be more than 0 and at most 300 seconds");
  const nowS = options.now / 1000;
  if (claims.iat > nowS + CLOCK_LEEWAY_S) throw invalid("iat is in the future");
  if (claims.exp <= nowS - CLOCK_LEEWAY_S) throw invalid("the token has expired");
  if (has(claims, "nbf") && (!numericDate(claims.nbf) || claims.nbf > nowS + CLOCK_LEEWAY_S)) throw invalid("the token is not valid yet (nbf)");
  if (typeof claims.jti !== "string" || claims.jti.length === 0 || claims.jti.length > 256) throw invalid("jti must be a string of 1 to 256 characters");

  const lookup = await options.records.currentRecord(vectorId);
  if (!lookup.found) throw invalid("the DID does not resolve to a registered agent");
  const record = lookup.record;
  const key = authenticationKeys(record).find((k) => k.keyHash === kidHash);
  if (!key) throw invalid("the key in kid is not an authentication key of the agent");
  if (key.kind !== kind) throw invalid("the algorithm does not match the key type");
  let publicKey: KeyObject;
  try {
    publicKey = recordKeyObject(key.kind, key.publicKey);
  } catch {
    throw invalid("the key in kid is not a valid public key");
  }
  if (!verifyJws(jws, kind, publicKey)) throw invalid("the signature does not verify");
  if (record.effective.status !== "active") {
    throw new AgentJwtError(`the agent's effective status is ${record.effective.status}${record.effective.reason ? ` (${record.effective.reason})` : ""}, not active`, "inactive");
  }
  if (!options.replay.use(`jti\n${did}\n${claims.jti}`, (claims.exp + CLOCK_LEEWAY_S) * 1000, options.now)) {
    throw invalid("the jti was already used");
  }
  return { vectorId, did, record, key, claims, header };
}
