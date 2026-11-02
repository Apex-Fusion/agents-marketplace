// POST /introspect (RFC 7662) and POST /revoke (RFC 7009) for gateway-issued tokens, and the rule
// that a change of an agent's effective status away from Active revokes all its tokens.

import { afterEach, describe, expect, test } from "vitest";
import { signJws } from "../../src/m4/jose.js";
import { LedgerBuilder, identityDatum, idOf, timeAt } from "../support/ledger.js";
import {
  BASE,
  agentJwt,
  bodyOf,
  clientAuth,
  decodeJwt,
  didOf,
  edKey,
  gatewayKeys,
  p256TestKey,
  postForm,
  requestToken,
  startGateway,
  stopGateways,
  text,
  type Harness,
} from "./support.js";

const AGENT = idOf("m4 introspection agent");
const RS = idOf("m4 resource server");
const AUTH = edKey(71);
const RS_AUTH = edKey(72);
const DPOP = edKey(73);

const keys = (key = AUTH) => [{ keyType: "Ed25519" as const, key: key.publicKey, purposes: 1, pop: null }];

function ledger(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(AGENT, identityDatum({ keys: keys() }), { height: 100 });
  b.register(RS, identityDatum({ keys: keys(RS_AUTH) }), { height: 110 });
  return b;
}

afterEach(stopGateways);

async function issue(h: Harness): Promise<string> {
  const res = await requestToken(h, await agentJwt(AUTH, AGENT, { now: h.now }), DPOP);
  expect(res.status).toBe(200);
  return text((await bodyOf(res)).access_token);
}

async function introspect(h: Harness, token: string, as: { key: typeof AUTH; id: string } = { key: RS_AUTH, id: RS }): Promise<Response> {
  return postForm(h, "/introspect", { token, ...(await clientAuth(as.key, as.id, h.now)) });
}

async function revoke(h: Harness, token: string, as: { key: typeof AUTH; id: string } = { key: AUTH, id: AGENT }): Promise<Response> {
  return postForm(h, "/revoke", { token, token_type_hint: "access_token", ...(await clientAuth(as.key, as.id, h.now)) });
}

/** A hold that starts at the tip's height `height` and ends at `until`. */
function suspend(b: LedgerBuilder, height: number, until: number): void {
  b.update(AGENT, identityDatum({ keys: keys(), status: { type: "Suspended", holds: [{ by: { type: "ControllerSet" }, reason: 6, since: timeAt(height), until }] } }), { height });
}

describe("POST /introspect", () => {
  test("an active token: its claims, active true and token_type DPoP", async () => {
    const h = await startGateway(ledger());
    const token = await issue(h);
    const res = await introspect(h, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toEqual({ ...decodeJwt(token).payload, active: true, token_type: "DPoP" });
  });

  test("client authentication is required", async () => {
    const h = await startGateway(ledger());
    const token = await issue(h);
    const res = await postForm(h, "/introspect", { token });
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error).toBe("invalid_client");
  });

  test("a missing token parameter is invalid_request", async () => {
    const h = await startGateway(ledger());
    const res = await postForm(h, "/introspect", await clientAuth(RS_AUTH, RS, h.now));
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("invalid_request");
  });

  test("tokens that this gateway did not issue, or no longer knows, are inactive", async () => {
    const h = await startGateway(ledger());
    const token = await issue(h);
    const claims = decodeJwt(token).payload;
    const other = p256TestKey(99);
    const forged = await signJws({ alg: "ES256", kid: gatewayKeys().p256.kid, typ: "at+jwt" }, claims, other);
    const unknownJti = await signJws({ alg: "ES256", kid: gatewayKeys().p256.kid, typ: "at+jwt" }, { ...claims, jti: "unknown" }, gatewayKeys().p256);
    for (const t of ["garbage", forged, unknownJti, await agentJwt(AUTH, AGENT, { now: h.now })]) {
      const res = await introspect(h, t);
      expect(res.status).toBe(200);
      expect(await bodyOf(res)).toEqual({ active: false });
    }
  });

  test("an expired token is inactive", async () => {
    const h = await startGateway(ledger());
    const token = await issue(h);
    h.now += 301_000;
    expect(await bodyOf(await introspect(h, token))).toEqual({ active: false });
  });

  test("a status other than Active revokes the agent's tokens, also after the status is Active again", async () => {
    const b = ledger();
    const h = await startGateway(b);
    const token = await issue(h);
    suspend(b, 1001, timeAt(1005));
    b.tip(1001);
    expect(await bodyOf(await introspect(h, token))).toEqual({ active: false });
    // 30 confirmations later the hold has ended and the agent is Active again.
    b.tip(1040);
    h.now += 60_000;
    const lookup = await h.resolver.currentRecord(AGENT);
    expect(lookup.found && lookup.record.effective.status).toBe("active");
    expect(await bodyOf(await introspect(h, token))).toEqual({ active: false });
    const fresh = await issue(h);
    expect((await bodyOf(await introspect(h, fresh))).active).toBe(true);
  });

  test("the status watcher revokes tokens of an agent that was not Active between two introspections", async () => {
    const b = ledger();
    const h = await startGateway(b);
    const token = await issue(h);
    suspend(b, 1001, timeAt(1005));
    b.tip(1001);
    await h.services.tokens.checkStatuses();
    b.tip(1040);
    h.now += 60_000;
    expect(await bodyOf(await introspect(h, token))).toEqual({ active: false });
  });

  test("a resource server whose own status is not Active cannot introspect", async () => {
    const b = ledger();
    b.update(RS, identityDatum({ keys: keys(RS_AUTH), parties: [] }), { height: 900 });
    const h = await startGateway(b);
    const token = await issue(h);
    const res = await introspect(h, token);
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error_description).toMatch(/effective status is suspended/);
  });
});

describe("POST /revoke", () => {
  test("the agent revokes its own token; introspection then answers inactive", async () => {
    const h = await startGateway(ledger());
    const token = await issue(h);
    const res = await revoke(h, token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(await bodyOf(await introspect(h, token))).toEqual({ active: false });
  });

  test("another agent cannot revoke the token", async () => {
    const h = await startGateway(ledger());
    const token = await issue(h);
    const res = await revoke(h, token, { key: RS_AUTH, id: RS });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("unauthorized_client");
    expect((await bodyOf(await introspect(h, token))).active).toBe(true);
  });

  test("an invalid or unknown token gets 200; client authentication is required", async () => {
    const h = await startGateway(ledger());
    expect((await revoke(h, "garbage")).status).toBe(200);
    const token = await issue(h);
    const unauthenticated = await postForm(h, "/revoke", { token });
    expect(unauthenticated.status).toBe(401);
    expect((await bodyOf(unauthenticated)).error).toBe("invalid_client");
    expect((await bodyOf(await introspect(h, token))).active).toBe(true);
  });

  test("tokens name the issuer; the RFC 8414 issuer is the gateway origin", async () => {
    const h = await startGateway(ledger());
    expect(decodeJwt(await issue(h)).payload.iss).toBe(BASE);
    expect(didOf(AGENT)).toBe(decodeJwt(await issue(h)).payload.sub);
  });
});
