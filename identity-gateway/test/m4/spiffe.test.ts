// SPIFFE service (Part 2 Section 8.6): nonces, X.509-SVIDs for P-256 certification requests,
// JWT-SVIDs and the trust bundle (https_web profile).

import { X509Certificate, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { bitString, children, decode, decodeOid, oid, sequence, set, unsignedInteger, utf8String } from "../../src/m4/der.js";
import type { Status } from "../../src/codec/identity-datum.js";
import { derFromText, pem } from "../../src/m4/x509.js";
import { LedgerBuilder, identityDatum, idOf, timeAt } from "../support/ledger.js";
import {
  BASE,
  TRUST_DOMAIN,
  agentJwt,
  at,
  bodyOf,
  clientAuth,
  decodeJwt,
  edKey,
  gatewayKeys,
  list,
  nowS,
  p256TestKey,
  postForm,
  postJson,
  startGateway,
  stopGateways,
  text,
  type Harness,
  type TestKey,
} from "./support.js";

const AGENT = idOf("m4 spiffe agent");
const AUTH = edKey(91);
const ASSERTION_ONLY = edKey(92);
const P256_AUTH = p256TestKey(93);
const SPIFFE_ID = `spiffe://${TRUST_DOMAIN}/agent/${AGENT}`;

/** Made with `openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1` (it also asks for a URI SAN that the gateway ignores). */
const OPENSSL_P256_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIIBEDCBtwIBADAfMR0wGwYDVQQDDBRvcGVuc3NsIHRlc3QgcmVxdWVzdDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABFr/n3jY5ExOCbXVSskVyfAi8bGYmaw/CZEA
ztvaDVGyHB6v5ZfDzk9srJnq9uxu2zzi9BpoZnHWbUsmVE6KhQWgNjA0BgkqhkiG
9w0BCQ4xJzAlMCMGA1UdEQQcMBqGGHNwaWZmZTovL290aGVyLmV4YW1wbGUveDAK
BggqhkjOPQQDAgNIADBFAiEA89nUBYedJ7tG/YLIv+4z4hgImDrcftyz07XipReC
/9ACIAM5tDogcwZngg2HKaCd/puKu5ICMyzbsquRwDkdexgO
-----END CERTIFICATE REQUEST-----`;

/** OpenSSL P-384 and Ed25519 requests: the gateway issues X.509-SVIDs for P-256 keys only. */
const OPENSSL_P384_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIIBCDCBjgIBADAPMQ0wCwYDVQQDDARwMzg0MHYwEAYHKoZIzj0CAQYFK4EEACID
YgAE/4vTM8T1yiLcNFjfrlZXTh7SxAcSFexYDiTjTDaDi0ZUyiySJeqSbwpGXDww
dOn0w7IGJbW/22bOvF7HJOxYL8ydUdV3MAvCml5FFhFg/IqNzXBZFyY3a4kS7bsA
i3QRoAAwCgYIKoZIzj0EAwIDaQAwZgIxAJ0TDbNFH55TTgMFXW74bP4qjiekijIR
gh2RW/1Pnvy93cZWxJm6OR0uk92mwiLXEgIxALQhQaTSsREo35SwZpIa6L6B3riY
/JDui2oU0RXupV7a0B7kUwR31uRCGdFcfkAnVg==
-----END CERTIFICATE REQUEST-----`;
const OPENSSL_ED25519_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIGMMEACAQAwDTELMAkGA1UEAwwCZWQwKjAFBgMrZXADIQDBgDMibWZx9yCrfq0h
oppfIjyo40y6os6Rd/ZcgEX/Q6AAMAUGAytlcANBAJCy/CYJUpOO/g9BoDsSwB5H
DeX3H48F4164J2zOHRtzay4mFMh4/RO5XkAlXopTgUu1AWNzX5xtpZEgu4+nEgw=
-----END CERTIFICATE REQUEST-----`;

function ledger(status?: Status): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(
    AGENT,
    identityDatum({
      keys: [
        { keyType: "Ed25519", key: AUTH.publicKey, purposes: 1, pop: null },
        { keyType: "Ed25519", key: ASSERTION_ONLY.publicKey, purposes: 2, pop: null },
        { keyType: "P256", key: P256_AUTH.publicKey, purposes: 1, pop: P256_AUTH.pop(AGENT) },
      ],
      ...(status ? { status } : {}),
    }),
    { height: 100 },
  );
  return b;
}

afterEach(stopGateways);

/** A PKCS #10 request for `key`, signed by it (or over other bytes, to break the signature). */
function csr(key: KeyObject, options: { breakSignature?: boolean } = {}): Buffer {
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const info = sequence(unsignedInteger(Uint8Array.of(0)), sequence(set(sequence(oid("2.5.4.3"), utf8String("test")))), spki, Buffer.from([0xa0, 0x00]));
  const signed = options.breakSignature ? Buffer.concat([info, Buffer.from([0])]) : info;
  return sequence(info, sequence(oid("1.2.840.10045.4.3.2")), bitString(sign("sha256", signed, { key, dsaEncoding: "der" })));
}

const publicJwk = (key: KeyObject) => {
  const jwk = (key.type === "public" ? key : createPublicKey(key)).export({ format: "jwk" });
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
};

async function nonce(h: Harness): Promise<string> {
  const res = await fetch(`${h.url}/spiffe/nonce`, { method: "POST" });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await bodyOf(res);
  expect(body.expires_in).toBe(300);
  return text(body.nonce);
}

async function proof(h: Harness, jwk: unknown, nonceValue: unknown, key: TestKey = AUTH, claims: Record<string, unknown> = {}): Promise<string> {
  return agentJwt(key, AGENT, { now: h.now, claims: { nonce: nonceValue, cnf: { jwk }, ...claims } });
}

/** Extensions of a DER certificate by OID: criticality and extnValue content. */
function extensions(der: Buffer): Map<string, { critical: boolean; value: string }> {
  const [tbs] = children(decode(der));
  const container = children(tbs!).find((f) => f.tag === 0xa3)!;
  return new Map(
    children(children(container)[0]!).map((e) => {
      const parts = children(e);
      return [decodeOid(parts[0]!), { critical: parts.length === 3 && parts[1]!.content[0] === 0xff, value: parts[parts.length - 1]!.content.toString("hex") }];
    }),
  );
}

describe("POST /spiffe/x509-svid", () => {
  test("issues an X.509-SVID: one URI SAN, P-256, at most 1 hour, noRevAvail, chained to the bundle's CA", async () => {
    const h = await startGateway(ledger());
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const n = await nonce(h);
    const res = await postJson(h, "/spiffe/x509-svid", { csr: pem("CERTIFICATE REQUEST", csr(privateKey)), proof: await proof(h, publicJwk(privateKey), n) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await bodyOf(res);
    expect(body.spiffe_id).toBe(SPIFFE_ID);
    const cert = new X509Certificate(text(body.x509_svid));
    const ca = new X509Certificate(text(body.bundle));
    expect(cert.subjectAltName).toBe(`URI:${SPIFFE_ID}`);
    expect(children(children(decode(cert.raw))[0]!)[5]!.bytes.toString("hex")).toBe("3000"); // empty subject
    expect(cert.issuer).toBe(`O=${TRUST_DOMAIN}`);
    expect(cert.ca).toBe(false);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]);
    expect(Date.parse(cert.validTo) - Date.parse(cert.validFrom)).toBe(3_600_000);
    expect(Date.parse(cert.validFrom)).toBe(Math.floor(h.now / 1000) * 1000 - 60_000);
    expect(body.expires_at).toBe(Date.parse(cert.validTo) / 1000);
    expect(cert.publicKey.export({ format: "jwk" })).toEqual(createPublicKey(privateKey).export({ format: "jwk" }));
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");

    const ext = extensions(cert.raw);
    expect(ext.get("2.5.29.56")).toEqual({ critical: false, value: "0500" }); // noRevAvail, RFC 9608
    expect(ext.get("2.5.29.15")).toEqual({ critical: true, value: "03020780" }); // digitalSignature only
    expect(ext.get("2.5.29.19")).toEqual({ critical: true, value: "3000" }); // cA false
    expect(ext.get("2.5.29.17")?.critical).toBe(true); // SAN critical: the subject is empty
    const caKeyId = extensions(ca.raw).get("2.5.29.14")!.value.slice(4); // OCTET STRING 04 14 <key identifier>
    expect(ext.get("2.5.29.35")?.value).toBe(`30168014${caKeyId}`); // authorityKeyIdentifier [0] = the CA's key identifier
    expect(ext.has("2.5.29.31")).toBe(false); // no CRL distribution point
    expect(ext.has("1.3.6.1.5.5.7.1.1")).toBe(false); // no authority information access
  });

  test("an OpenSSL request in base64url DER, an ES256 proof by a P-256 authentication key; requested names are ignored", async () => {
    const h = await startGateway(ledger());
    const der = derFromText(OPENSSL_P256_CSR, ["CERTIFICATE REQUEST"])!;
    const key = createPublicKey({ key: childSpki(der), format: "der", type: "spki" });
    const res = await postJson(h, "/spiffe/x509-svid", { csr: der.toString("base64url"), proof: await proof(h, publicJwk(key), await nonce(h), P256_AUTH) });
    expect(res.status).toBe(200);
    const cert = new X509Certificate(text((await bodyOf(res)).x509_svid));
    expect(cert.subjectAltName).toBe(`URI:${SPIFFE_ID}`);
  });

  test.each<[string, () => Buffer | string, string, RegExp]>([
    ["a request signature that does not verify", () => csr(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey, { breakSignature: true }), "invalid_csr", /signature does not verify/],
    ["a P-384 key", () => OPENSSL_P384_CSR, "invalid_csr", /not a P-256 key/],
    ["an Ed25519 key", () => OPENSSL_ED25519_CSR, "invalid_csr", /not a P-256 key/],
    ["bytes after the request", () => Buffer.concat([csr(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), Buffer.from([0])]), "invalid_csr", /DER/],
    ["text that is not a request", () => "not a request!", "invalid_request", /PEM certificate request/],
    ["a certificate instead of a request", () => "-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----", "invalid_request", /PEM certificate request/],
  ])("refused request: %s", async (_name, make, error, message) => {
    const h = await startGateway(ledger());
    const value = make();
    const res = await postJson(h, "/spiffe/x509-svid", {
      csr: typeof value === "string" ? value : pem("CERTIFICATE REQUEST", value),
      proof: await proof(h, publicJwk(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), await nonce(h)),
    });
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toBe(error);
    expect(body.error_description).toMatch(message);
  });

  test("the proof must name the request's key in cnf.jwk", async () => {
    const h = await startGateway(ledger());
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    for (const jwk of [publicJwk(other), undefined, { kty: "OKP", crv: "Ed25519", x: AUTH.jwk.x }]) {
      const res = await postJson(h, "/spiffe/x509-svid", { csr: pem("CERTIFICATE REQUEST", csr(privateKey)), proof: await proof(h, jwk, await nonce(h)) });
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ error: "invalid_proof", error_description: "proof: cnf.jwk must be the public key of the certificate request" });
    }
  });

  test.each<[string, (h: Harness, jwk: unknown) => Promise<string>, number, string, RegExp]>([
    ["a key without the authentication purpose", async (h, jwk) => proof(h, jwk, await nonce(h), ASSERTION_ONLY), 400, "invalid_proof", /not an authentication key/],
    ["a wrong audience", async (h, jwk) => proof(h, jwk, await nonce(h), AUTH, { aud: `${BASE}/spiffe/x509-svid` }), 400, "invalid_proof", /aud must be/],
    ["an expired proof", async (h, jwk) => agentJwt(AUTH, AGENT, { now: h.now - 400_000, claims: { nonce: await nonce(h), cnf: { jwk } } }), 400, "invalid_proof", /expired/],
    ["no nonce claim", async (h, jwk) => proof(h, jwk, undefined), 400, "invalid_nonce", /nonce claim is missing/],
    ["a nonce that the gateway never issued", async (h, jwk) => proof(h, jwk, "made-up"), 400, "invalid_nonce", /unknown or was already used/],
  ])("refused proof: %s", async (_name, makeProof, status, error, message) => {
    const h = await startGateway(ledger());
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const res = await postJson(h, "/spiffe/x509-svid", { csr: pem("CERTIFICATE REQUEST", csr(privateKey)), proof: await makeProof(h, publicJwk(privateKey)) });
    expect(res.status).toBe(status);
    const body = await bodyOf(res);
    expect(body.error).toBe(error);
    expect(body.error_description).toMatch(message);
  });

  test("a nonce is single-use, and older than 5 minutes it is refused", async () => {
    const h = await startGateway(ledger());
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const request = async (n: string) => postJson(h, "/spiffe/x509-svid", { csr: pem("CERTIFICATE REQUEST", csr(privateKey)), proof: await proof(h, publicJwk(privateKey), n) });
    const n = await nonce(h);
    expect((await request(n)).status).toBe(200);
    const replay = await request(n);
    expect(replay.status).toBe(400);
    expect((await bodyOf(replay)).error_description).toBe("the nonce is unknown or was already used");

    const old = await nonce(h);
    h.now += 300_001;
    const late = await request(old);
    expect(late.status).toBe(400);
    expect(await bodyOf(late)).toEqual({ error: "invalid_nonce", error_description: "the nonce is older than 5 minutes" });
  });

  test("a proof is single-use", async () => {
    const h = await startGateway(ledger());
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const p = await proof(h, publicJwk(privateKey), await nonce(h));
    const body = { csr: pem("CERTIFICATE REQUEST", csr(privateKey)), proof: p };
    expect((await postJson(h, "/spiffe/x509-svid", body)).status).toBe(200);
    const replay = await postJson(h, "/spiffe/x509-svid", body);
    expect(replay.status).toBe(400);
    expect((await bodyOf(replay)).error_description).toBe("proof: the jti was already used");
  });

  test("a suspended agent gets no SVID (403)", async () => {
    const h = await startGateway(ledger({ type: "Suspended", holds: [{ by: { type: "ControllerSet" }, reason: 6, since: timeAt(900), until: timeAt(1100) }] }));
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const res = await postJson(h, "/spiffe/x509-svid", { csr: pem("CERTIFICATE REQUEST", csr(privateKey)), proof: await proof(h, publicJwk(privateKey), await nonce(h)) });
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toBe("agent_not_active");
  });

  test("the body must be JSON", async () => {
    const h = await startGateway(ledger());
    const res = await postForm(h, "/spiffe/x509-svid", { csr: "x" });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error_description).toMatch(/application\/json/);
  });
});

/** The SubjectPublicKeyInfo of a DER certification request. */
function childSpki(der: Buffer): Buffer {
  const info = children(decode(der))[0]!;
  return children(info)[2]!.bytes;
}

describe("POST /spiffe/jwt-svid", () => {
  test("issues an ES256 JWT-SVID with only alg, kid and typ in the header; introspection and revocation know it", async () => {
    const h = await startGateway(ledger());
    const res = await postJson(h, "/spiffe/jwt-svid", { subject_token: await agentJwt(AUTH, AGENT, { now: h.now }), audience: "spiffe://example.org/reports" });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const svid = text(body.svid);
    const { header, payload } = decodeJwt(svid);
    expect(header).toEqual({ alg: "ES256", kid: gatewayKeys().p256.kid, typ: "JWT" });
    expect(payload).toEqual({ sub: SPIFFE_ID, aud: "spiffe://example.org/reports", iat: nowS(h.now), exp: nowS(h.now) + 300, jti: expect.any(String) });
    expect(body).toMatchObject({ spiffe_id: SPIFFE_ID, expires_at: nowS(h.now) + 300 });

    const bundle = await bodyOf(await fetch(`${h.url}/spiffe/bundle`));
    const jwtKey = list(at(bundle, "keys")).find((k) => at(k, "use") === "jwt-svid");
    expect(at(jwtKey, "kid")).toBe(header.kid);
    const [h64, p64, s64] = svid.split(".");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: text(at(jwtKey, "x")), y: text(at(jwtKey, "y")) }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h64}.${p64}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s64!, "base64url"))).toBe(true);

    const introspected = await bodyOf(await postForm(h, "/introspect", { token: svid, ...(await clientAuth(AUTH, AGENT, h.now)) }));
    expect(introspected).toMatchObject({ active: true, sub: SPIFFE_ID, token_type: "Bearer" });
    expect((await postForm(h, "/revoke", { token: svid, ...(await clientAuth(AUTH, AGENT, h.now)) })).status).toBe(200);
    expect(await bodyOf(await postForm(h, "/introspect", { token: svid, ...(await clientAuth(AUTH, AGENT, h.now)) }))).toEqual({ active: false });
  });

  test.each<[string, unknown]>([
    ["no audience", undefined],
    ["an empty audience list", []],
    ["an empty audience", ""],
    ["nine audiences", Array.from({ length: 9 }, (_, i) => `a${i}`)],
  ])("refused: %s", async (_name, audience) => {
    const h = await startGateway(ledger());
    const res = await postJson(h, "/spiffe/jwt-svid", { subject_token: await agentJwt(AUTH, AGENT, { now: h.now }), audience });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("invalid_request");
  });

  test("a refused subject token and a suspended agent", async () => {
    const h = await startGateway(ledger());
    const bad = await postJson(h, "/spiffe/jwt-svid", { subject_token: await agentJwt(ASSERTION_ONLY, AGENT, { now: h.now }), audience: "x" });
    expect(bad.status).toBe(400);
    expect((await bodyOf(bad)).error_description).toMatch(/^subject_token: .*not an authentication key/);
    const suspended = await startGateway(ledger({ type: "Suspended", holds: [{ by: { type: "ControllerSet" }, reason: 6, since: timeAt(900), until: timeAt(1100) }] }));
    const res = await postJson(suspended, "/spiffe/jwt-svid", { subject_token: await agentJwt(AUTH, AGENT, { now: suspended.now }), audience: "x" });
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toBe("agent_not_active");
  });
});

describe("GET /spiffe/bundle", () => {
  test("the bundle holds the CA certificate (x509-svid, no kid) and the JWT-SVID key (jwt-svid, kid), refresh hint 300 s", async () => {
    const h = await startGateway(ledger());
    const res = await fetch(`${h.url}/spiffe/bundle`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const bundle = await bodyOf(res);
    const { p256 } = gatewayKeys();
    const keys = list(at(bundle, "keys"));
    expect(bundle.spiffe_refresh_hint).toBe(300);
    expect(bundle.spiffe_sequence).toBe(nowS(h.now));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({ kty: "EC", crv: "P-256", x: p256.publicJwk.x, y: p256.publicJwk.y, use: "x509-svid", x5c: [expect.any(String)] });
    expect(keys[1]).toEqual({ kty: "EC", crv: "P-256", x: p256.publicJwk.x, y: p256.publicJwk.y, use: "jwt-svid", kid: p256.kid });

    const ca = new X509Certificate(Buffer.from(text(at(keys[0], "x5c", 0)), "base64"));
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe(`O=${TRUST_DOMAIN}`);
    expect(ca.subjectAltName).toBe(`URI:spiffe://${TRUST_DOMAIN}`);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(ca.validTo).toBe("Dec 31 23:59:59 9999 GMT");
    expect(ca.publicKey.export({ format: "jwk" })).toEqual({ kty: "EC", crv: "P-256", x: p256.publicJwk.x, y: p256.publicJwk.y });
    const ext = extensions(ca.raw);
    expect(ext.get("2.5.29.19")).toEqual({ critical: true, value: "30060101ff020100" }); // cA true, pathLen 0
    expect(ext.get("2.5.29.15")).toEqual({ critical: true, value: "03020204" }); // keyCertSign only
    expect(ext.has("2.5.29.56")).toBe(false);

    // The bundle is stable while the process runs.
    expect(await bodyOf(await fetch(`${h.url}/spiffe/bundle`))).toEqual(bundle);
  });
});
