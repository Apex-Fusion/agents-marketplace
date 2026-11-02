// Token service, introspection and revocation (Part 2 Sections 5.4 and 8.6).
// - POST /token: OAuth 2.0 Token Exchange (RFC 8693 Section 2) with
//   `subject_token_type = urn:ietf:params:oauth:token-type:jwt`; the subject token follows the rules
//   in agent-jwt.ts. Optional client authentication with an RFC 7523 client assertion
//   (Sections 2.2 and 3) that follows the same rules. Every request carries a DPoP proof
//   (RFC 9449 Section 5). Issued tokens are JWT access tokens (RFC 9068, `typ: at+jwt`) signed with
//   ES256, with a lifetime of at most 5 minutes, `sub = did:vector:<id>`, `cnf.jkt` (RFC 9449
//   Section 6.1) and a Token Status List claim (draft-ietf-oauth-status-list-21 Section 6.2) that
//   points to the agent's entry. A request that names a delegation in `authorization_details`
//   (RFC 9396 Section 6) gets a token only after the whole chain passes the Section 5.2 use checks;
//   the token then carries the delegators in a nested `act` claim (RFC 8693 Section 4.1) and the
//   granted actions and resources in `authorization_details` (RFC 9396 Section 9.1).
// - POST /introspect (RFC 7662) and POST /revoke (RFC 7009): for tokens that this gateway issued
//   only, with client authentication by an RFC 7523 client assertion. A change that makes the
//   effective status of an agent other than Active revokes every token that depends on it.

import { randomBytes } from "node:crypto";
import { keyHash } from "../codec/keys.js";
import { tokenEndpoint, CLOCK_LEEWAY_S, MAX_TOKEN_LIFETIME_S, type M4Context } from "./context.js";
import { AgentJwtError, verifyAgentJwt, type VerifiedAgentJwt } from "./agent-jwt.js";
import {
  DELEGATION_DETAILS_TYPE,
  actClaim,
  checkDelegationChain,
  delegationDetails,
  isActionPattern,
  isResourcePattern,
  type DelegationSource,
} from "./delegation.js";
import { DpopError, verifyDpopProof, type DpopProof } from "./dpop.js";
import { M4Error, NO_STORE, invalidRequest, jsonResponse, parseForm, single, unavailable, type M4Request, type M4Response } from "./http.js";
import { parseJws, recordKeyObject, signJws, verifyJws } from "./jose.js";
import type { SingleUseStore } from "./replay.js";
import { listPosition, type StatusLists } from "./status-lists.js";

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const JWT_BEARER_CLIENT_ASSERTION = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** A token that this gateway issued, kept until it expires. */
export interface IssuedToken {
  readonly jti: string;
  readonly kind: "access_token" | "jwt_svid";
  /** Agents whose effective status the token depends on: its subject and every delegator agent. */
  readonly agents: readonly string[];
  /** Agents that may revoke it: the subject, the authenticated client and every delegator agent. */
  readonly owners: readonly string[];
  /** The leaf delegation of a delegation token. */
  readonly delegation: string | null;
  /** POSIX ms. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  revoked: boolean;
}

export class TokenRegistry {
  private readonly tokens = new Map<string, IssuedToken>();
  /** Per agent: tokens issued at or before this time are revoked (the gateway saw a status other than Active). */
  private readonly revokedUpTo = new Map<string, number>();

  constructor(private readonly max = 1_000_000) {}

  add(token: IssuedToken, now: number): void {
    if (this.tokens.size >= this.max) {
      this.prune(now);
      if (this.tokens.size >= this.max) throw unavailable("too many live tokens; try again later");
    }
    this.tokens.set(token.jti, token);
  }

  /** A live (not expired) token by its jti. */
  get(jti: string, now: number): IssuedToken | undefined {
    const token = this.tokens.get(jti);
    return token && token.expiresAt > now ? token : undefined;
  }

  isRevoked(token: IssuedToken): boolean {
    return token.revoked || token.agents.some((a) => (this.revokedUpTo.get(a) ?? -1) >= token.issuedAt);
  }

  /** Revokes every token of `agent` issued at or before `at`. */
  revokeAgent(agent: string, at: number): void {
    this.revokedUpTo.set(agent, Math.max(at, this.revokedUpTo.get(agent) ?? at));
  }

  /** Agents with live, unrevoked tokens. */
  liveAgents(now: number): Set<string> {
    this.prune(now);
    const agents = new Set<string>();
    for (const token of this.tokens.values()) if (!this.isRevoked(token)) for (const a of token.agents) agents.add(a);
    return agents;
  }

  private prune(now: number): void {
    for (const [jti, token] of this.tokens) if (token.expiresAt <= now) this.tokens.delete(jti);
    // A mark older than the longest token lifetime revokes nothing that is still live.
    const horizon = now - (MAX_TOKEN_LIFETIME_S + CLOCK_LEEWAY_S) * 1000;
    for (const [agent, at] of this.revokedUpTo) if (at < horizon) this.revokedUpTo.delete(agent);
  }
}

/** The `authorization_details` of a token request: one delegation, optionally narrowed. */
interface DelegationRequest {
  readonly identifier: string;
  readonly actions?: readonly string[];
  readonly locations?: readonly string[];
}

const invalidDetails = (description: string): M4Error => new M4Error(400, "invalid_authorization_details", description);
const DETAIL_MEMBERS: Record<string, true> = { type: true, identifier: true, actions: true, locations: true };

function patternList(value: unknown, name: string, max: number, valid: (p: string) => boolean): string[] | undefined {
  if (value === undefined) return undefined;
  const items: unknown[] = Array.isArray(value) ? value : [];
  if (!Array.isArray(value) || items.length > max || !items.every((p): p is string => typeof p === "string" && valid(p))) {
    throw invalidDetails(`${name} must be a list of at most ${max} patterns as in Part 2 Section 5.1`);
  }
  return items;
}

/** RFC 9396 Section 2 `authorization_details`: exactly one object of the delegation type. */
function parseDelegationRequest(text: string | undefined): DelegationRequest | null {
  if (text === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidDetails("authorization_details is not JSON");
  }
  if (!Array.isArray(value) || value.length !== 1 || value[0] === null || typeof value[0] !== "object" || Array.isArray(value[0])) {
    throw invalidDetails("authorization_details must be a list with one delegation object");
  }
  const detail = value[0] as Record<string, unknown>;
  if (detail.type !== DELEGATION_DETAILS_TYPE) throw invalidDetails(`the authorization details type must be ${DELEGATION_DETAILS_TYPE}`);
  const unknown = Object.keys(detail).find((k) => DETAIL_MEMBERS[k] !== true);
  if (unknown !== undefined) throw invalidDetails(`unknown authorization details member ${unknown}`);
  if (typeof detail.identifier !== "string" || !/^[0-9a-f]{64}$/.test(detail.identifier)) throw invalidDetails("identifier must be the delegation identifier (64 lowercase hex)");
  const actions = patternList(detail.actions, "actions", 16, isActionPattern);
  if (actions !== undefined && actions.length === 0) throw invalidDetails("actions must not be empty");
  const locations = patternList(detail.locations, "locations", 8, isResourcePattern);
  return { identifier: detail.identifier, ...(actions ? { actions } : {}), ...(locations ? { locations } : {}) };
}

/** RFC 8693 `resource` (RFC 8707 Section 2: absolute URIs without fragment) and `audience` values: the token's `aud`. */
function audiencesOf(params: Map<string, string[]>): string[] {
  const resources = params.get("resource") ?? [];
  for (const resource of resources) {
    let url: URL | null = null;
    try {
      url = new URL(resource);
    } catch {
      // handled below
    }
    if (url === null || resource.includes("#")) throw new M4Error(400, "invalid_target", "each resource must be an absolute URI without a fragment");
  }
  const audiences = [...new Set([...resources, ...(params.get("audience") ?? [])])];
  if (audiences.length === 0) throw new M4Error(400, "invalid_target", "name the token's audience with resource or audience");
  if (audiences.length > 8 || audiences.some((a) => a.length > 512)) throw new M4Error(400, "invalid_target", "at most 8 audiences of at most 512 characters");
  return audiences;
}

/** A token identifier: 128 random bits. */
export const newJti = (): string => randomBytes(16).toString("base64url");

export class TokenService {
  readonly registry = new TokenRegistry();

  constructor(
    private readonly ctx: M4Context,
    private readonly replay: SingleUseStore,
    private readonly statusLists: StatusLists,
    private readonly delegations: DelegationSource | null,
  ) {}

  /** RFC 7523 client authentication. `required`: introspection and revocation. */
  private async authenticateClient(req: M4Request, params: Map<string, string[]>, required: boolean): Promise<VerifiedAgentJwt | null> {
    const invalidClient = (description: string): M4Error => new M4Error(401, "invalid_client", description);
    if (req.headers.authorization !== undefined) throw invalidClient("the gateway authenticates clients only with RFC 7523 client assertions, not with HTTP authentication");
    const type = single(params, "client_assertion_type");
    const assertion = single(params, "client_assertion");
    const clientId = single(params, "client_id");
    if (type === undefined && assertion === undefined) {
      if (required) throw invalidClient("client authentication with an RFC 7523 client assertion is required");
      if (clientId !== undefined) throw invalidClient("client_id needs a client assertion");
      return null;
    }
    if (type !== JWT_BEARER_CLIENT_ASSERTION) throw invalidClient(`client_assertion_type must be ${JWT_BEARER_CLIENT_ASSERTION}`);
    if (assertion === undefined) throw invalidClient("client_assertion is missing");
    let client: VerifiedAgentJwt;
    try {
      client = await verifyAgentJwt(assertion, this.agentJwtOptions(["Ed25519"]));
    } catch (e) {
      if (e instanceof AgentJwtError) throw invalidClient(`client_assertion: ${e.message}`);
      throw e;
    }
    if (clientId !== undefined && clientId !== client.did) throw invalidClient("client_id is not the subject of the client assertion");
    return client;
  }

  private agentJwtOptions(keyKinds: readonly ("Ed25519" | "P256")[]) {
    return { audience: tokenEndpoint(this.ctx.settings), keyKinds, records: this.ctx.records, replay: this.replay, now: this.ctx.now() };
  }

  /** Verifies a subject token (RFC 8693) with the agent JWT rules. */
  async subjectToken(token: unknown): Promise<VerifiedAgentJwt> {
    try {
      return await verifyAgentJwt(token, this.agentJwtOptions(["Ed25519"]));
    } catch (e) {
      // RFC 8693 Section 2.2.2: an invalid or unacceptable subject token is invalid_request.
      if (e instanceof AgentJwtError) throw invalidRequest(`subject_token: ${e.message}`);
      throw e;
    }
  }

  async token(req: M4Request): Promise<M4Response> {
    const { settings, keys } = this.ctx;
    const params = parseForm(req);
    const grantType = single(params, "grant_type");
    if (grantType === undefined) throw invalidRequest("grant_type is missing");
    if (grantType !== TOKEN_EXCHANGE_GRANT) throw new M4Error(400, "unsupported_grant_type", `the gateway supports only ${TOKEN_EXCHANGE_GRANT}`);
    const subjectToken = single(params, "subject_token");
    if (subjectToken === undefined) throw invalidRequest("subject_token is missing");
    if (single(params, "subject_token_type") !== JWT_TOKEN_TYPE) throw invalidRequest(`subject_token_type must be ${JWT_TOKEN_TYPE}`);
    if (params.has("actor_token") || params.has("actor_token_type")) throw invalidRequest("the gateway does not accept actor tokens");
    const requestedType = single(params, "requested_token_type") ?? ACCESS_TOKEN_TYPE;
    if (requestedType !== ACCESS_TOKEN_TYPE && requestedType !== JWT_TOKEN_TYPE) {
      throw invalidRequest(`requested_token_type must be ${ACCESS_TOKEN_TYPE} or ${JWT_TOKEN_TYPE}`);
    }
    if (single(params, "scope") !== undefined) throw new M4Error(400, "invalid_scope", "the gateway issues no scopes; name a delegation in authorization_details");
    const audiences = audiencesOf(params);
    const delegationRequest = parseDelegationRequest(single(params, "authorization_details"));
    if (delegationRequest !== null && this.delegations === null) throw invalidDetails("this gateway has no delegation contract configured");

    const client = await this.authenticateClient(req, params, false);
    let proof: DpopProof;
    try {
      proof = verifyDpopProof(req.headersDistinct.dpop, { method: "POST", uri: tokenEndpoint(settings), replay: this.replay, now: this.ctx.now() });
    } catch (e) {
      if (e instanceof DpopError) throw new M4Error(400, "invalid_dpop_proof", e.message);
      throw e;
    }
    const subject = await this.subjectToken(subjectToken);

    const now = this.ctx.now();
    const iat = Math.floor(now / 1000);
    let exp = iat + MAX_TOKEN_LIFETIME_S;
    let delegated: { act: Record<string, unknown>; details: Record<string, unknown>; agents: string[]; leaf: string } | null = null;
    if (delegationRequest !== null) {
      const check = await checkDelegationChain(this.delegations!, this.ctx.records, {
        leafId: delegationRequest.identifier,
        atMs: iat * 1000,
        delegate: subject.vectorId,
        ...(delegationRequest.actions ? { actions: delegationRequest.actions } : {}),
        ...(delegationRequest.locations ? { resources: delegationRequest.locations } : {}),
        provenKeyHash: proof.kind === "Ed25519" ? keyHash(proof.publicKey) : null,
      });
      if (!check.ok) throw invalidDetails(check.reason);
      const { chain, notAfter } = check.value;
      exp = Math.min(exp, Math.floor(notAfter / 1000));
      if (exp <= iat) throw invalidDetails("the delegation period ends within a second");
      const leaf = chain[0]!;
      delegated = {
        act: actClaim(chain),
        details: delegationDetails(leaf, delegationRequest.actions ?? leaf.actions, delegationRequest.locations ?? leaf.resources),
        agents: chain.flatMap((d) => (d.datum.delegator.type === "Agent" ? [d.datum.delegator.id] : [])),
        leaf: leaf.id,
      };
    }

    const index = await this.statusLists.indexOf(subject.vectorId);
    if (index === null) throw unavailable("the agent has no status-list index yet");
    const { n, p } = listPosition(index);
    const jti = newJti();
    const claims = {
      iss: settings.baseUrl,
      sub: subject.did,
      aud: audiences.length === 1 ? audiences[0] : audiences,
      iat,
      exp,
      jti,
      client_id: client?.did ?? subject.did,
      cnf: { jkt: proof.jkt },
      status: { status_list: { idx: p, uri: `${settings.baseUrl}/status/tsl/${n}` } },
      ...(delegated ? { act: delegated.act, authorization_details: [delegated.details] } : {}),
    };
    const accessToken = await signJws({ alg: "ES256", kid: keys.p256.kid, typ: "at+jwt" }, claims, keys.p256);
    const agents = [...new Set([subject.vectorId, ...(delegated?.agents ?? [])])];
    this.registry.add(
      {
        jti,
        kind: "access_token",
        agents,
        owners: [...new Set([...agents, ...(client ? [client.vectorId] : [])])],
        delegation: delegated?.leaf ?? null,
        issuedAt: now,
        expiresAt: exp * 1000,
        revoked: false,
      },
      now,
    );
    return jsonResponse(200, {
      access_token: accessToken,
      issued_token_type: requestedType,
      token_type: "DPoP",
      expires_in: exp - iat,
      ...(delegated ? { authorization_details: [delegated.details] } : {}),
    });
  }

  /** A token that this gateway signed and still knows, with its verified claims; null for any other token. */
  private ownToken(token: string, now: number): { claims: Record<string, unknown>; entry: IssuedToken } | null {
    const { p256 } = this.ctx.keys;
    let jws;
    try {
      jws = parseJws(token);
    } catch {
      return null;
    }
    if (jws.header.alg !== "ES256" || jws.header.kid !== p256.kid) return null;
    if (!verifyJws(jws, "P256", recordKeyObject("P256", p256.publicKey))) return null;
    const jti = jws.payload.jti;
    const entry = typeof jti === "string" ? this.registry.get(jti, now) : undefined;
    if (entry === undefined || typeof jws.payload.exp !== "number" || jws.payload.exp * 1000 <= now) return null;
    return { claims: jws.payload, entry };
  }

  /** The token is not revoked, its agents are Active, and its delegation chain still passes the use checks. */
  private async stillValid(entry: IssuedToken, now: number): Promise<boolean> {
    if (this.registry.isRevoked(entry)) return false;
    for (const agent of entry.agents) {
      const lookup = await this.ctx.records.currentRecord(agent);
      if (!lookup.found || lookup.record.effective.status !== "active") {
        this.registry.revokeAgent(agent, now);
        return false;
      }
    }
    if (entry.delegation !== null && this.delegations !== null) {
      const check = await checkDelegationChain(this.delegations, this.ctx.records, { leafId: entry.delegation, atMs: now, delegate: entry.agents[0]! });
      if (!check.ok) {
        entry.revoked = true;
        return false;
      }
    }
    return true;
  }

  async introspect(req: M4Request): Promise<M4Response> {
    const params = parseForm(req);
    await this.authenticateClient(req, params, true);
    const token = single(params, "token");
    if (token === undefined) throw invalidRequest("token is missing");
    const now = this.ctx.now();
    const own = this.ownToken(token, now);
    if (own === null || !(await this.stillValid(own.entry, now))) return jsonResponse(200, { active: false });
    return jsonResponse(200, { ...own.claims, active: true, token_type: own.entry.kind === "access_token" ? "DPoP" : "Bearer" });
  }

  async revoke(req: M4Request): Promise<M4Response> {
    const params = parseForm(req);
    const client = (await this.authenticateClient(req, params, true))!;
    const token = single(params, "token");
    if (token === undefined) throw invalidRequest("token is missing");
    const own = this.ownToken(token, this.ctx.now());
    // RFC 7009 Section 2.2: an invalid or unknown token also gets 200.
    if (own !== null) {
      if (!own.entry.owners.includes(client.vectorId)) throw new M4Error(400, "unauthorized_client", "the token was not issued to this client");
      own.entry.revoked = true;
    }
    return { status: 200, headers: NO_STORE, body: "" };
  }

  /** Registers a token that another service issued (JWT-SVIDs), so that introspection and revocation know it. */
  register(token: IssuedToken): void {
    this.registry.add(token, this.ctx.now());
  }

  /**
   * The status watcher: checks every agent with live tokens and revokes its tokens when its
   * effective status is not Active. A failed read skips that agent until the next round.
   */
  async checkStatuses(): Promise<void> {
    for (const agent of this.registry.liveAgents(this.ctx.now())) {
      try {
        const lookup = await this.ctx.records.currentRecord(agent);
        if (!lookup.found || lookup.record.effective.status !== "active") this.registry.revokeAgent(agent, this.ctx.now());
      } catch (e) {
        this.ctx.log(`identity-gateway: token status check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
