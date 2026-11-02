// POST /token (RFC 8693 token exchange, RFC 7523 client assertions, RFC 9449 DPoP), the RFC 8414
// metadata and the gateway JWKS (Part 2 Section 8.6).

import { request } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { LedgerBuilder, identityDatum, idOf, timeAt } from "../support/ledger.js";
import {
  BASE,
  GATEWAY_ID,
  JWT_TYPE,
  NOW,
  TOKEN_EXCHANGE,
  TOKEN_URL,
  agentJwt,
  bodyOf,
  clientAuth,
  decodeJwt,
  didOf,
  dpopProof,
  edKey,
  gatewayKeys,
  nowS,
  p256TestKey,
  postForm,
  requestToken,
  startGateway,
  stopGateways,
  text,
  thumbprint,
  verifiedByGateway,
  type Harness,
  type TestKey,
} from "./support.js";

const AGENT = idOf("m4 token agent");
const CLIENT = idOf("m4 token client");
const AUTH = edKey(51);
const DELEGATION_KEY = edKey(52);
const ASSERTION_ONLY = edKey(53);
const P256_AUTH = p256TestKey(54);
const CLIENT_AUTH = edKey(55);
const DPOP = edKey(60);
const DPOP_P256 = p256TestKey(61);
const OUTSIDER = edKey(62);

function agentKeys(id: string) {
  return [
    { keyType: "Ed25519" as const, key: AUTH.publicKey, purposes: 1 | 2, pop: null },
    { keyType: "Ed25519" as const, key: DELEGATION_KEY.publicKey, purposes: 16, pop: null },
    { keyType: "Ed25519" as const, key: ASSERTION_ONLY.publicKey, purposes: 2, pop: null },
    { keyType: "P256" as const, key: P256_AUTH.publicKey, purposes: 1, pop: P256_AUTH.pop(id) },
  ];
}

function ledger(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(AGENT, identityDatum({ keys: agentKeys(AGENT) }), { height: 100 });
  b.register(CLIENT, identityDatum({ keys: [{ keyType: "Ed25519", key: CLIENT_AUTH.publicKey, purposes: 1, pop: null }] }), { height: 110 });
  return b;
}

afterEach(stopGateways);

const subject = (h: Harness, options: Parameters<typeof agentJwt>[2] = {}, key: TestKey = AUTH, id = AGENT) => agentJwt(key, id, { now: h.now, ...options });

describe("POST /token", () => {
  test("issues an ES256 JWT access token bound to the DPoP key, with the Token Status List claim", async () => {
    const h = await startGateway(ledger());
    const res = await requestToken(h, await subject(h), DPOP);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await bodyOf(res);
    expect(body).toMatchObject({ issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "DPoP", expires_in: 300 });
    expect(body.authorization_details).toBeUndefined();
    const { header, payload } = decodeJwt(text(body.access_token));
    expect(header).toEqual({ alg: "ES256", kid: gatewayKeys().p256.kid, typ: "at+jwt" });
    expect(gatewayKeys().p256.kid).toBe(`did:vector:${GATEWAY_ID}#${gatewayKeys().p256.keyHash}`);
    expect(verifiedByGateway(text(body.access_token))).toBe(true);
    const entry = (await h.resolver.listRecords()).entries.find((e) => e.vectorId === AGENT)!;
    expect(payload).toEqual({
      iss: BASE,
      sub: didOf(AGENT),
      aud: "https://rs.example.org",
      iat: nowS(h.now),
      exp: nowS(h.now) + 300,
      jti: expect.any(String),
      client_id: didOf(AGENT),
      cnf: { jkt: thumbprint(DPOP) },
      status: { status_list: { idx: entry.statusListIndex, uri: `${BASE}/status/tsl/0` } },
    });
  });

  test("a P-256 DPoP key, several audiences and requested_token_type jwt", async () => {
    const h = await startGateway(ledger());
    const res = await requestToken(h, await subject(h), DPOP_P256, {
      requested_token_type: JWT_TYPE,
      audience: ["https://a.example.org", "agent-b"],
      resource: "https://c.example.org/api",
    });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.issued_token_type).toBe(JWT_TYPE);
    const { payload } = decodeJwt(text(body.access_token));
    expect(payload.cnf).toEqual({ jkt: thumbprint(DPOP_P256) });
    expect(payload.aud).toEqual(["https://c.example.org/api", "https://a.example.org", "agent-b"]);
  });

  test("the fully specified algorithm name Ed25519 (RFC 9864) is accepted for the subject token", async () => {
    const h = await startGateway(ledger());
    expect((await requestToken(h, await subject(h, { header: { alg: "Ed25519" } }), DPOP)).status).toBe(200);
  });

  test("a subject token is single-use", async () => {
    const h = await startGateway(ledger());
    const token = await subject(h);
    expect((await requestToken(h, token, DPOP)).status).toBe(200);
    const replay = await requestToken(h, token, DPOP);
    expect(replay.status).toBe(400);
    expect(await bodyOf(replay)).toEqual({ error: "invalid_request", error_description: "subject_token: the jti was already used" });
  });

  const t0 = nowS(NOW);
  test.each<[string, (h: Harness) => Promise<string>, RegExp]>([
    ["expired", (h) => subject(h, { claims: { iat: t0 - 400, exp: t0 - 280 } }), /expired/],
    ["exp - iat over 5 minutes", (h) => subject(h, { claims: { iat: t0, exp: t0 + 301 } }), /at most 300 seconds/],
    ["exp before iat", (h) => subject(h, { claims: { iat: t0, exp: t0 - 1 } }), /more than 0/],
    ["iat in the future", (h) => subject(h, { claims: { iat: t0 + 120, exp: t0 + 200 } }), /future/],
    ["no iat", (h) => subject(h, { claims: { iat: undefined } }), /iat and exp/],
    ["wrong aud", (h) => subject(h, { claims: { aud: "https://other.example.org/token" } }), /aud must be/],
    ["two audiences", (h) => subject(h, { claims: { aud: [TOKEN_URL, "https://other.example.org"] } }), /aud must be/],
    ["iss different from sub", (h) => subject(h, { claims: { sub: didOf(CLIENT) } }), /iss and sub/],
    ["legacy-form iss", (h) => subject(h, { claims: { iss: `did:vector:agent:${"be".repeat(28)}:${AGENT}` } }), /iss and sub/],
    ["no jti", (h) => subject(h, { claims: { jti: undefined } }), /jti/],
    ["a key without the authentication purpose", (h) => subject(h, {}, ASSERTION_ONLY), /not an authentication key/],
    ["a delegation key", (h) => subject(h, {}, DELEGATION_KEY), /not an authentication key/],
    ["a key that the record does not list", (h) => subject(h, {}, OUTSIDER), /not an authentication key/],
    ["a signature by another key than kid names", (h) => subject(h, { signWith: OUTSIDER }), /signature does not verify/],
    ["an ES256 subject token (P-256 authentication key)", (h) => subject(h, {}, P256_AUTH), /algorithm ES256 is not accepted/],
    ["alg none", (h) => subject(h, { header: { alg: "none" } }), /algorithm none/],
    ["HS256", (h) => subject(h, { header: { alg: "HS256" } }), /algorithm HS256/],
    ["typ dpop+jwt", (h) => subject(h, { header: { typ: "dpop+jwt" } }), /typ/],
    ["a relative kid", (h) => subject(h, { header: { kid: `#${AUTH.keyHash}` } }), /kid must be the DID URL/],
    ["a crit header", (h) => subject(h, { header: { crit: ["exp"] } }), /extension/],
    ["not a JWS", async () => "not.a.jws", /base64url|JSON/],
  ])("refused subject token: %s", async (_name, make, message) => {
    const h = await startGateway(ledger());
    const res = await requestToken(h, await make(h), DPOP);
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(message);
  });

  test("a suspended agent gets no token", async () => {
    const b = new LedgerBuilder();
    const hold = { by: { type: "ControllerSet" as const }, reason: 6, since: timeAt(900), until: timeAt(1100) };
    b.register(AGENT, identityDatum({ keys: agentKeys(AGENT), status: { type: "Suspended", holds: [hold] } }), { height: 100 });
    const h = await startGateway(b);
    const res = await requestToken(h, await subject(h), DPOP);
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error_description).toMatch(/effective status is suspended, not active/);
  });

  test("an unregistered or unconfirmed agent gets no token", async () => {
    const b = ledger();
    const late = idOf("m4 late agent");
    b.register(late, identityDatum({ keys: agentKeys(late) }), { height: 990 });
    const h = await startGateway(b);
    for (const id of [idOf("m4 nobody"), late]) {
      const res = await requestToken(h, await agentJwt(AUTH, id, { now: h.now }), DPOP);
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error_description).toMatch(/does not resolve/);
    }
  });

  test("a failed ledger read is a server error, not a refusal", async () => {
    const b = ledger();
    const h = await startGateway(b);
    b.chain.failing.add("assetTxHashes");
    const res = await requestToken(h, await subject(h), DPOP);
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).error).toBe("server_error");
    expect(h.logs.some((m) => m.includes("token failed"))).toBe(true);
    expect(h.logs.some((m) => m.includes(AGENT))).toBe(false);
  });
});

describe("POST /token: DPoP proofs (RFC 9449 Section 4.3)", () => {
  const form = async (h: Harness) => ({ grant_type: TOKEN_EXCHANGE, subject_token: await subject(h), subject_token_type: JWT_TYPE, audience: "rs" });

  test.each<[string, (h: Harness) => Promise<Record<string, string>>, RegExp]>([
    ["no DPoP header", async () => ({}), /DPoP proof is required/],
    ["typ JWT", async (h) => ({ dpop: await dpopProof(DPOP, { header: { typ: "JWT" }, now: h.now }) }), /typ must be dpop\+jwt/],
    ["htm GET", async (h) => ({ dpop: await dpopProof(DPOP, { claims: { htm: "GET" }, now: h.now }) }), /htm must be POST/],
    ["another htu", async (h) => ({ dpop: await dpopProof(DPOP, { claims: { htu: `${BASE}/introspect` }, now: h.now }) }), /htu must be/],
    ["an old iat", async (h) => ({ dpop: await dpopProof(DPOP, { now: h.now - 301_000 }) }), /outside the accepted window/],
    ["a jwk with the private key", async (h) => ({ dpop: await dpopProof(DPOP, { header: { jwk: { ...DPOP.jwk, d: "AAAA" } }, now: h.now }) }), /private key material/],
    ["an alg that does not match the jwk", async (h) => ({ dpop: await dpopProof(DPOP, { header: { alg: "ES256" }, now: h.now }) }), /does not match/],
    ["a signature by another key", async (h) => ({ dpop: await dpopProof(DPOP, { header: { jwk: OUTSIDER.jwk }, now: h.now }) }), /signature does not verify/],
  ])("refused: %s", async (_name, headers, message) => {
    const h = await startGateway(ledger());
    const res = await postForm(h, "/token", await form(h), await headers(h));
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toBe("invalid_dpop_proof");
    expect(body.error_description).toMatch(message);
  });

  test("htu comparison ignores the query and normalises the scheme, host and default port", async () => {
    const h = await startGateway(ledger());
    const dpop = await dpopProof(DPOP, { claims: { htu: "HTTPS://ID.vector.apexfusion.org:443/token?x=1" }, now: h.now });
    expect((await postForm(h, "/token", await form(h), { dpop })).status).toBe(200);
  });

  test("a DPoP proof is single-use", async () => {
    const h = await startGateway(ledger());
    const dpop = await dpopProof(DPOP, { now: h.now });
    expect((await postForm(h, "/token", await form(h), { dpop })).status).toBe(200);
    const replay = await postForm(h, "/token", await form(h), { dpop });
    expect(replay.status).toBe(400);
    expect(await bodyOf(replay)).toEqual({ error: "invalid_dpop_proof", error_description: "the DPoP proof was already used" });
  });

  test("two DPoP header fields are refused", async () => {
    const h = await startGateway(ledger());
    const body = new URLSearchParams(await form(h)).toString();
    const proofs = [await dpopProof(DPOP, { now: h.now }), await dpopProof(DPOP, { now: h.now })];
    const url = new URL(`${h.url}/token`);
    const answer = await new Promise<{ status: number; body: string }>((done, fail) => {
      const req = request(
        { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", dpop: proofs } },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => done({ status: res.statusCode!, body: text }));
        },
      );
      req.on("error", fail);
      req.end(body);
    });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ error: "invalid_dpop_proof", error_description: "the request has more than one DPoP header field" });
  });
});

describe("POST /token: request parameters", () => {
  test.each<[string, Record<string, string | string[]>, number, string]>([
    ["another grant type", { grant_type: "client_credentials" }, 400, "unsupported_grant_type"],
    ["no grant type", { grant_type: "" }, 400, "invalid_request"],
    ["a repeated grant type", { grant_type: [TOKEN_EXCHANGE, TOKEN_EXCHANGE] }, 400, "invalid_request"],
    ["another subject token type", { subject_token_type: "urn:ietf:params:oauth:token-type:access_token" }, 400, "invalid_request"],
    ["no subject token", { subject_token: "" }, 400, "invalid_request"],
    ["an actor token", { actor_token: "x", actor_token_type: JWT_TYPE }, 400, "invalid_request"],
    ["another requested token type", { requested_token_type: "urn:ietf:params:oauth:token-type:refresh_token" }, 400, "invalid_request"],
    ["a scope", { scope: "openid" }, 400, "invalid_scope"],
    ["no audience", { audience: "" }, 400, "invalid_target"],
    ["a relative resource", { resource: "/api" }, 400, "invalid_target"],
    ["a resource with a fragment", { resource: "https://rs.example.org/#x" }, 400, "invalid_target"],
    ["client_id without a client assertion", { client_id: "did:vector:x" }, 401, "invalid_client"],
  ])("%s", async (_name, change, status, error) => {
    const h = await startGateway(ledger());
    const res = await requestToken(h, await subject(h), DPOP, change);
    expect(res.status).toBe(status);
    expect((await bodyOf(res)).error).toBe(error);
  });

  test("the body must be form-encoded and at most 64 KiB; GET is not allowed", async () => {
    const h = await startGateway(ledger());
    const json = await fetch(`${h.url}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(400);
    expect((await bodyOf(json)).error_description).toMatch(/x-www-form-urlencoded/);
    const big = await fetch(`${h.url}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=".padEnd(70_000, "b") });
    expect(big.status).toBe(413);
    const get = await fetch(`${h.url}/token`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });
});

describe("POST /token: RFC 7523 client assertions", () => {
  test("an authenticated client is the token's client_id", async () => {
    const h = await startGateway(ledger());
    const res = await requestToken(h, await subject(h), DPOP, { ...(await clientAuth(CLIENT_AUTH, CLIENT, h.now)), client_id: didOf(CLIENT) });
    expect(res.status).toBe(200);
    expect(decodeJwt(text((await bodyOf(res)).access_token)).payload.client_id).toBe(didOf(CLIENT));
  });

  test.each<[string, (h: Harness) => Promise<Record<string, string>>, RegExp]>([
    ["a wrong assertion type", async (h) => ({ ...(await clientAuth(CLIENT_AUTH, CLIENT, h.now)), client_assertion_type: "urn:x" }), /client_assertion_type/],
    ["no assertion", async () => ({ client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" }), /client_assertion is missing/],
    ["a wrong audience", async (h) => ({ client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await agentJwt(CLIENT_AUTH, CLIENT, { now: h.now, claims: { aud: BASE } }) }), /aud must be/],
    ["an expired assertion", async (h) => ({ client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await agentJwt(CLIENT_AUTH, CLIENT, { now: h.now - 400_000 }) }), /expired/],
    ["a client_id that differs", async (h) => ({ ...(await clientAuth(CLIENT_AUTH, CLIENT, h.now)), client_id: didOf(AGENT) }), /client_id/],
    ["a key that the client does not list", async (h) => ({ client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await agentJwt(OUTSIDER, CLIENT, { now: h.now }) }), /authentication key/],
  ])("refused: %s", async (_name, auth, message) => {
    const h = await startGateway(ledger());
    const res = await requestToken(h, await subject(h), DPOP, await auth(h));
    expect(res.status).toBe(401);
    const body = await bodyOf(res);
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toMatch(message);
  });

  test("a replayed client assertion and HTTP authentication are refused", async () => {
    const h = await startGateway(ledger());
    const auth = await clientAuth(CLIENT_AUTH, CLIENT, h.now);
    expect((await requestToken(h, await subject(h), DPOP, auth)).status).toBe(200);
    const replay = await requestToken(h, await subject(h), DPOP, auth);
    expect(replay.status).toBe(401);
    expect((await bodyOf(replay)).error_description).toMatch(/already used/);
    const basic = await postForm(
      h,
      "/token",
      { grant_type: TOKEN_EXCHANGE, subject_token: await subject(h), subject_token_type: JWT_TYPE, audience: "rs" },
      { dpop: await dpopProof(DPOP, { now: h.now }), authorization: "Basic eDp5" },
    );
    expect(basic.status).toBe(401);
  });
});

describe("GET /.well-known/oauth-authorization-server and /.well-known/jwks.json", () => {
  test("RFC 8414 metadata names the M4 endpoints", async () => {
    const h = await startGateway(ledger());
    const res = await fetch(`${h.url}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const metadata = await bodyOf(res);
    expect(metadata).toMatchObject({
      issuer: BASE,
      token_endpoint: TOKEN_URL,
      jwks_uri: `${BASE}/.well-known/jwks.json`,
      introspection_endpoint: `${BASE}/introspect`,
      revocation_endpoint: `${BASE}/revoke`,
      grant_types_supported: [TOKEN_EXCHANGE],
      response_types_supported: [],
      token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
      dpop_signing_alg_values_supported: ["EdDSA", "Ed25519", "ES256"],
      authorization_details_types_supported: ["https://id.vector.apexfusion.org/ns/delegation"],
    });
    expect((await fetch(`${h.url}/.well-known/oauth-authorization-server`, { method: "POST" })).status).toBe(405);
  });

  test("the JWKS lists both gateway keys with their DID URLs as kid", async () => {
    const h = await startGateway(ledger());
    const jwks = await bodyOf(await fetch(`${h.url}/.well-known/jwks.json`));
    const { ed25519, p256 } = gatewayKeys();
    expect(jwks).toEqual({
      keys: [
        { kty: "OKP", crv: "Ed25519", x: ed25519.publicJwk.x, kid: `did:vector:${GATEWAY_ID}#${ed25519.keyHash}`, alg: "EdDSA", use: "sig" },
        { kty: "EC", crv: "P-256", x: p256.publicJwk.x, y: p256.publicJwk.y, kid: `did:vector:${GATEWAY_ID}#${p256.keyHash}`, alg: "ES256", use: "sig" },
      ],
    });
  });

  test("paths that the M4 routes do not own still reach the resolver", async () => {
    const h = await startGateway(ledger());
    expect((await fetch(`${h.url}/1.0/identifiers/${didOf(AGENT)}`)).status).toBe(200);
    expect((await fetch(`${h.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${h.url}/nothing`)).status).toBe(404);
  });
});
