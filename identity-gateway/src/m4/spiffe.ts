// SPIFFE service (Part 2 Section 8.6). The trust domain is the gateway host (Part 2 Section 8.1),
// and an agent's SPIFFE ID is `spiffe://<trust domain>/agent/<id>`.
// - POST /spiffe/nonce: a single-use gateway nonce, valid for 5 minutes. The endpoint needs no
//   authentication, so issuing stores nothing (NonceStore): only a used nonce is kept.
// - POST /spiffe/x509-svid: a PKCS #10 request for a P-256 key and a proof: a JWT by an
//   authentication key of the agent (agent JWT rules, EdDSA or ES256) whose claims also hold the
//   gateway nonce (`nonce`) and the request's public key (`cnf.jwk`, RFC 7800 Section 3.2). So the
//   key signs over the request's public key and the nonce. The X.509-SVID lasts at most 1 hour and
//   carries `noRevAvail`.
// - POST /spiffe/jwt-svid: a subject token (agent JWT rules) and the audiences; a JWT-SVID signed
//   with ES256 (SPIFFE JWT-SVID standard, https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md),
//   valid for at most 5 minutes. Introspection and revocation know it.
// - GET /spiffe/bundle: the SPIFFE bundle (SPIFFE Trust Domain and Bundle standard, Section 4) for
//   the `https_web` profile (SPIFFE Federation standard, Section 5.2.1), refresh hint 300 s.

import { MAX_TOKEN_LIFETIME_S, spiffeIdOf, tokenEndpoint, type M4Context } from "./context.js";
import { AgentJwtError, verifyAgentJwt, type VerifiedAgentJwt } from "./agent-jwt.js";
import { M4Error, jsonResponse, parseJsonObject, publicData, type M4Request, type M4Response } from "./http.js";
import { jwkThumbprint, publicJwkKey, signJws, type KeyKind } from "./jose.js";
import { NonceStore, type SingleUseStore } from "./replay.js";
import { newJti, type TokenService } from "./tokens.js";
import { CsrError, derFromText, parseCertificationRequest, pem, signingCertificate, x509Svid, type SigningCertificate } from "./x509.js";

export const NONCE_LIFETIME_MS = 300_000;
export const X509_SVID_LIFETIME_MS = 3_600_000;
/** Certificates (the CA and each X.509-SVID) start this much before issue, for clocks that run behind; an SVID's lifetime includes it. */
const BACKDATE_MS = 60_000;
export const BUNDLE_REFRESH_HINT_S = 300;
const MAX_AUDIENCES = 8;

export class SpiffeService {
  readonly nonces: NonceStore;
  private ca: Promise<SigningCertificate> | null = null;
  /** The bundle changes only when a process starts (a new CA certificate, maybe other keys): its start time orders it. */
  private readonly sequence: number;

  constructor(
    private readonly ctx: M4Context,
    private readonly replay: SingleUseStore,
    private readonly tokens: TokenService,
  ) {
    this.sequence = Math.floor(ctx.now() / 1000);
    this.nonces = new NonceStore(NONCE_LIFETIME_MS, replay);
  }

  /** The trust domain's signing certificate, built once for each process (with its own serial number). */
  signingCertificate(): Promise<SigningCertificate> {
    this.ca ??= signingCertificate(this.ctx.keys.p256, this.ctx.settings.trustDomain, this.ctx.now() - BACKDATE_MS);
    return this.ca;
  }

  nonce(): M4Response {
    return jsonResponse(200, { nonce: this.nonces.issue(this.ctx.now()), expires_in: NONCE_LIFETIME_MS / 1000 });
  }

  async x509(req: M4Request): Promise<M4Response> {
    const body = parseJsonObject(req);
    const der = typeof body.csr === "string" ? derFromText(body.csr, ["CERTIFICATE REQUEST", "NEW CERTIFICATE REQUEST"]) : null;
    if (der === null) throw new M4Error(400, "invalid_request", "csr must be a PEM certificate request or base64url DER");
    let csr;
    try {
      csr = parseCertificationRequest(der);
    } catch (e) {
      throw new M4Error(400, "invalid_csr", e instanceof CsrError ? e.message : "the certificate request is not valid");
    }
    const now = this.ctx.now();
    const proof = await this.agentJwt(body.proof, ["Ed25519", "P256"], "proof", "invalid_proof");
    const cnf = proof.claims.cnf;
    const proofJwk = cnf !== null && typeof cnf === "object" && "jwk" in cnf ? cnf.jwk : undefined;
    let proofKey: string | null = null;
    try {
      proofKey = jwkThumbprint(publicJwkKey(proofJwk).jwk);
    } catch {
      // A missing or invalid JWK names no key.
    }
    if (proofKey !== jwkThumbprint(csr.jwk)) throw new M4Error(400, "invalid_proof", "proof: cnf.jwk must be the public key of the certificate request");
    if (typeof proof.claims.nonce !== "string") throw new M4Error(400, "invalid_nonce", "proof: the nonce claim is missing");
    const nonce = this.nonces.consume(proof.claims.nonce, now);
    if (nonce !== "ok") {
      throw new M4Error(400, "invalid_nonce", nonce === "expired" ? "the nonce is older than 5 minutes" : "the nonce is unknown or was already used");
    }
    const spiffeId = spiffeIdOf(this.ctx.settings, proof.vectorId);
    const notBeforeMs = now - BACKDATE_MS;
    const notAfterMs = notBeforeMs + X509_SVID_LIFETIME_MS;
    const ca = await this.signingCertificate();
    const svid = await x509Svid(this.ctx.keys.p256, ca, { spki: csr.spki, spiffeId, notBeforeMs, notAfterMs });
    return jsonResponse(200, {
      spiffe_id: spiffeId,
      x509_svid: pem("CERTIFICATE", svid),
      bundle: pem("CERTIFICATE", ca.der),
      expires_at: Math.floor(notAfterMs / 1000),
    });
  }

  /** Agent JWT rules; a refused JWT is `code` (400), an agent whose status is not Active is agent_not_active (403). */
  private async agentJwt(token: unknown, keyKinds: readonly KeyKind[], name: string, code: string): Promise<VerifiedAgentJwt> {
    try {
      return await verifyAgentJwt(token, { audience: tokenEndpoint(this.ctx.settings), keyKinds, records: this.ctx.records, replay: this.replay, now: this.ctx.now() });
    } catch (e) {
      if (!(e instanceof AgentJwtError)) throw e;
      throw e.reason === "inactive" ? new M4Error(403, "agent_not_active", `${name}: ${e.message}`) : new M4Error(400, code, `${name}: ${e.message}`);
    }
  }

  async jwt(req: M4Request): Promise<M4Response> {
    const body = parseJsonObject(req);
    const audience = typeof body.audience === "string" ? [body.audience] : body.audience;
    if (
      !Array.isArray(audience) ||
      audience.length === 0 ||
      audience.length > MAX_AUDIENCES ||
      !audience.every((a) => typeof a === "string" && a.length > 0 && a.length <= 512)
    ) {
      throw new M4Error(400, "invalid_request", `audience must be 1 to ${MAX_AUDIENCES} non-empty strings`);
    }
    const subject = await this.agentJwt(body.subject_token, ["Ed25519"], "subject_token", "invalid_request");
    const now = this.ctx.now();
    const iat = Math.floor(now / 1000);
    const exp = iat + MAX_TOKEN_LIFETIME_S;
    const jti = newJti();
    const spiffeId = spiffeIdOf(this.ctx.settings, subject.vectorId);
    const { p256 } = this.ctx.keys;
    // JWT-SVID Section 2: only alg, kid and typ in the header.
    const svid = await signJws({ alg: "ES256", kid: p256.kid, typ: "JWT" }, { sub: spiffeId, aud: audience.length === 1 ? audience[0] : audience, iat, exp, jti }, p256);
    this.tokens.register({
      jti,
      kind: "jwt_svid",
      agents: [subject.vectorId],
      owners: [subject.vectorId],
      delegation: null,
      issuedAt: now,
      expiresAt: exp * 1000,
      revoked: false,
    });
    return jsonResponse(200, { spiffe_id: spiffeId, svid, expires_at: exp });
  }

  async bundle(): Promise<M4Response> {
    const { p256 } = this.ctx.keys;
    const { kid, alg, use, ...key } = p256.publicJwk;
    const ca = await this.signingCertificate();
    return jsonResponse(
      200,
      {
        spiffe_sequence: this.sequence,
        spiffe_refresh_hint: BUNDLE_REFRESH_HINT_S,
        keys: [
          // X509-SVID Section 6.1: use x509-svid, no kid, x5c with the CA certificate.
          { ...key, use: "x509-svid", x5c: [ca.der.toString("base64")] },
          // JWT-SVID Section 6.1: use jwt-svid, kid set.
          { ...key, use: "jwt-svid", kid },
        ],
      },
      publicData(BUNDLE_REFRESH_HINT_S),
    );
  }
}
