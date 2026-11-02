// DPoP proofs at the token endpoint (RFC 9449 Sections 4.2 and 4.3). Every token that the gateway
// issues is bound to the proof key: `cnf.jkt` is the key's JWK SHA-256 thumbprint (RFC 9449
// Section 6.1, RFC 7638). The gateway sends no DPoP nonces (RFC 9449 Section 8), so a `nonce`
// claim is not checked. A proof key needs no registration, so a proof alone authenticates nobody:
// the caller uses up the proof's jti (RFC 9449 Section 11.1, `useDpopProof`) only after the
// request authenticated, and an unauthenticated request writes nothing to the single-use store.

import { CLOCK_LEEWAY_S, MAX_TOKEN_LIFETIME_S } from "./context.js";
import { JoseError, algKeyKind, jwkThumbprint, parseJws, publicJwkKey, verifyJws, type JwkKey } from "./jose.js";
import type { SingleUseStore } from "./replay.js";

export class DpopError extends Error {}

/** A verified proof: its key, the key's thumbprint, and the claims that make it single-use. */
export interface DpopProof extends JwkKey {
  readonly jkt: string;
  readonly jti: string;
  /** POSIX seconds. */
  readonly iat: number;
}

/**
 * The `htu` comparison form: scheme, host and path, after syntax- and scheme-based normalisation
 * (RFC 3986 Sections 6.2.2 and 6.2.3; RFC 9449 Section 4.3 step 9), without query and fragment.
 */
export function htuForm(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export interface DpopOptions {
  readonly method: string;
  /** The URI of the request as the client sees it (the public endpoint URL). */
  readonly uri: string;
  /** POSIX milliseconds. */
  readonly now: number;
}

/** RFC 9449 Section 4.3, steps 1-11, for a request without an access token. The jti check of Section 11.1 is `useDpopProof`. */
export function verifyDpopProof(fieldValues: readonly string[] | undefined, options: DpopOptions): DpopProof {
  if (!fieldValues || fieldValues.length === 0) throw new DpopError("a DPoP proof is required: the gateway issues only DPoP-bound tokens");
  if (fieldValues.length > 1) throw new DpopError("the request has more than one DPoP header field");
  let jws;
  try {
    jws = parseJws(fieldValues[0]!.trim());
  } catch (e) {
    throw new DpopError(`the DPoP proof is not a JWT: ${e instanceof JoseError ? e.message : "parse error"}`);
  }
  const { header, payload } = jws;
  if (header.typ !== "dpop+jwt") throw new DpopError("the DPoP proof typ must be dpop+jwt");
  const kind = algKeyKind(header.alg);
  if (kind === null) throw new DpopError("the DPoP proof algorithm must be EdDSA, Ed25519 or ES256");
  let key: JwkKey;
  try {
    key = publicJwkKey(header.jwk);
  } catch (e) {
    throw new DpopError(`the DPoP proof jwk is not acceptable: ${e instanceof JoseError ? e.message : "invalid"}`);
  }
  if (key.kind !== kind) throw new DpopError("the DPoP proof algorithm does not match its key");
  if (!verifyJws(jws, kind, key.key)) throw new DpopError("the DPoP proof signature does not verify");
  if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 256) throw new DpopError("the DPoP proof needs a jti of 1 to 256 characters");
  if (payload.htm !== options.method) throw new DpopError(`the DPoP proof htm must be ${options.method}`);
  const expected = htuForm(options.uri);
  if (typeof payload.htu !== "string" || htuForm(payload.htu) === null || htuForm(payload.htu) !== expected) {
    throw new DpopError(`the DPoP proof htu must be ${options.uri}`);
  }
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) throw new DpopError("the DPoP proof needs iat");
  const nowS = options.now / 1000;
  if (payload.iat > nowS + CLOCK_LEEWAY_S || payload.iat < nowS - MAX_TOKEN_LIFETIME_S) throw new DpopError("the DPoP proof iat is outside the accepted window");
  return { ...key, jkt: jwkThumbprint(key.jwk), jti: payload.jti, iat: payload.iat };
}

/** RFC 9449 Section 11.1: a proof's jti is accepted once while the proof is acceptable. */
export function useDpopProof(proof: DpopProof, replay: SingleUseStore, now: number): void {
  if (!replay.use(`dpop\n${proof.jkt}\n${proof.jti}`, (proof.iat + MAX_TOKEN_LIFETIME_S + CLOCK_LEEWAY_S) * 1000, now)) {
    throw new DpopError("the DPoP proof was already used");
  }
}
