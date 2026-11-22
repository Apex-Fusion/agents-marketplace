// The limits that GET /policy publishes (revocationBounds.terms) are the limits that the M4 services
// use. Each test asks a running service (a gateway on a fake ledger, with a refresh interval other than
// the default) and compares the answer with the term that /policy computes from the same settings.

import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { bitString, oid, sequence, set, unsignedInteger, utf8String } from "../../src/m4/der.js";
import { pem } from "../../src/m4/x509.js";
import { revocationBounds, type RevocationBounds } from "../../src/render/policy-bounds.js";
import { LedgerBuilder, identityDatum, idOf } from "../support/ledger.js";
import { BASE, agentJwt, at, bodyOf, decodeJwt, edKey, nowS, postJson, requestToken, startGateway, stopGateways, text, type Harness } from "./support.js";

afterEach(stopGateways);

const AGENT = idOf("policy limits agent");
const AUTH = edKey(71);
const DPOP = edKey(72);

function ledger(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(AGENT, identityDatum({ keys: [{ keyType: "Ed25519", key: AUTH.publicKey, purposes: 1 | 2, pop: null }] }), { height: 100 });
  return b;
}

/** A gateway with a refresh interval that is not the default, and the bounds that /policy computes from the settings of its services. */
async function gateway(): Promise<{ h: Harness; terms: RevocationBounds["terms"] }> {
  const h = await startGateway(ledger(), { refreshMs: 120_000 });
  const { terms } = revocationBounds({ baseUrl: BASE, accessLogRetention: "x", fetchJobs: true, scanIntervalMs: 600_000, m4: h.services.context.settings });
  return { h, terms };
}

/** A PKCS #10 request for `key`, signed by it. */
function csr(key: KeyObject): Buffer {
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const info = sequence(unsignedInteger(Uint8Array.of(0)), sequence(set(sequence(oid("2.5.4.3"), utf8String("test")))), spki, Buffer.from([0xa0, 0x00]));
  return sequence(info, sequence(oid("1.2.840.10045.4.3.2")), bitString(sign("sha256", info, { key, dsaEncoding: "der" })));
}

describe("the limits of the M4 services and the terms of /policy", () => {
  test("an access token lives tokenSeconds from the issue", async () => {
    const { h, terms } = await gateway();
    const res = await requestToken(h, await agentJwt(AUTH, AGENT, { now: h.now }), DPOP);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.expires_in).toBe(terms.tokenSeconds!.value);
    expect(decodeJwt(text(body.access_token)).payload).toMatchObject({ exp: nowS(h.now) + terms.tokenSeconds!.value! });
  });

  test("a JWT-SVID lives jwtSvidSeconds from the issue", async () => {
    const { h, terms } = await gateway();
    const res = await postJson(h, "/spiffe/jwt-svid", { subject_token: await agentJwt(AUTH, AGENT, { now: h.now }), audience: "https://rs.example.org" });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).expires_at).toBe(nowS(h.now) + terms.jwtSvidSeconds!.value!);
  });

  test("an X.509-SVID ends x509SvidSeconds after the issue: its life of one hour starts 60 s before", async () => {
    const { h, terms } = await gateway();
    const nonce = text((await bodyOf(await fetch(`${h.url}/spiffe/nonce`, { method: "POST" }))).nonce);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = createPublicKey(privateKey).export({ format: "jwk" });
    const proof = await agentJwt(AUTH, AGENT, { now: h.now, claims: { nonce, cnf: { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } } } });
    const res = await postJson(h, "/spiffe/x509-svid", { csr: pem("CERTIFICATE REQUEST", csr(privateKey)), proof });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).expires_at).toBe(nowS(h.now) + terms.x509SvidSeconds!.value!);
  });

  test("an identity credential is valid credentialSeconds from the issue", async () => {
    const { h, terms } = await gateway();
    const res = await fetch(`${h.url}/agents/${AGENT}/credential`);
    expect(res.status).toBe(200);
    const { payload } = decodeJwt(await res.text());
    expect((Date.parse(text(payload.validUntil)) - Date.parse(text(payload.validFrom))) / 1000).toBe(terms.credentialSeconds!.value);
  });

  test("a reader can keep a status list listCacheSeconds: the max-age and the ttl of both lists", async () => {
    const { h, terms } = await gateway();
    const cache = terms.listCacheSeconds!.value!;
    const tsl = await fetch(`${h.url}/status/tsl/0`);
    expect(tsl.status).toBe(200);
    expect(tsl.headers.get("cache-control")).toBe(`public, max-age=${cache}`);
    expect(decodeJwt(await tsl.text()).payload).toMatchObject({ ttl: cache });
    const bsl = await fetch(`${h.url}/status/bsl/0`);
    expect(bsl.headers.get("cache-control")).toBe(`public, max-age=${cache}`);
    expect(at(decodeJwt(await bsl.text()).payload, "credentialSubject", "ttl")).toBe(cache * 1000);
  });
});
