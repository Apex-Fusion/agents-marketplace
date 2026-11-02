// Domain linkage (Part 2 Section 8.6): a DNS TXT record `_did.<domain>` that names the DID, or a
// Domain Linkage Credential (DIF Well Known DID Configuration v1.0, JWT proof format) signed by an
// assertion key of the DID.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { keyHash } from "../../src/codec/keys.js";
import { DID_CONFIGURATION_CONTEXT, checkDomain, verifyLinkageJwt, type LinkageSubject } from "../../src/fetch/linkage.js";
import { formatTime } from "../../src/resolve/time.js";
import { KEY_A, KEY_B, LEGACY, idOf } from "../support/ledger.js";
import { p256Key } from "../support/keys.js";
import { FakeNet, compactJws, ed25519Signer } from "./support.js";

const ID = idOf("linked agent");
const DID = `did:vector:${ID}`;
const LEGACY_FORM = `did:vector:agent:${LEGACY.policyId}:${ID}`;
const DOMAIN = "acme.example.org";
const CONFIG_URL = `https://${DOMAIN}/.well-known/did-configuration.json`;
const P256 = p256Key(77);
const signA = ed25519Signer(3); // KEY_A
const signB = ed25519Signer(4); // KEY_B
const signP256 = (data: Uint8Array): Buffer => Buffer.from(P256.sign(Buffer.from(data).toString("utf8")), "hex");

const SUBJECT: LinkageSubject = {
  dids: [DID, LEGACY_FORM],
  assertionKeys: new Map([
    [keyHash(KEY_A), { keyType: "Ed25519" as const, key: KEY_A }],
    [P256.keyHash, { keyType: "P256" as const, key: P256.publicKey }],
  ]),
};

function credential(nowMs: number, overrides: { did?: string; origin?: string; exp?: number; nbf?: number; iss?: string; type?: string[] } = {}): object {
  const did = overrides.did ?? DID;
  const now = Math.floor(nowMs / 1000);
  return {
    exp: overrides.exp ?? now + 86_400,
    iss: overrides.iss ?? did,
    nbf: overrides.nbf ?? now - 60,
    sub: did,
    vc: {
      "@context": ["https://www.w3.org/2018/credentials/v1", DID_CONFIGURATION_CONTEXT],
      credentialSubject: { id: did, origin: overrides.origin ?? `https://${DOMAIN}` },
      expirationDate: "2027-11-02T12:00:00Z",
      issuanceDate: "2026-11-01T12:00:00Z",
      issuer: did,
      type: overrides.type ?? ["VerifiableCredential", "DomainLinkageCredential"],
    },
  };
}

const configuration = (...linked: unknown[]) => ({ "@context": DID_CONFIGURATION_CONTEXT, linked_dids: linked });

describe("DNS TXT record", () => {
  test.each([
    ["the DID", [[DID]]],
    ["did= and the DID, in two character strings", [["v=spf1 -all"], ["did=did:vector:", ID]]],
    ["the legacy form of the DID", [[LEGACY_FORM]]],
  ])("a record with %s verifies the domain without an HTTPS fetch", async (_name, records) => {
    const net = new FakeNet().host(DOMAIN);
    net.txtRecords.set(`_did.${DOMAIN}`, records);
    const check = await checkDomain({ fetcher: net.fetcher(), txt: net.txt }, DOMAIN, SUBJECT, net.clock.now());
    const text = records.map((r) => r.join("")).find((t) => t.includes(ID))!;
    expect(check).toEqual({
      domain: DOMAIN,
      checkedAt: net.clock.now(),
      verified: true,
      method: "dnsTxt",
      keyHash: null,
      fetched: { url: `dns:_did.${DOMAIN}?type=TXT`, fetchedAt: formatTime(net.clock.now()), sha256: createHash("sha256").update(text).digest("hex") },
      failure: null,
    });
    expect(net.calls).toEqual([]);
  });

  test("a record that names another DID does not verify; the HTTPS check runs", async () => {
    const net = new FakeNet().host(DOMAIN);
    net.txtRecords.set(`_did.${DOMAIN}`, [[`did:vector:${idOf("someone else")}`]]);
    const check = await checkDomain({ fetcher: net.fetcher(), txt: net.txt }, DOMAIN, SUBJECT, net.clock.now());
    expect(check).toMatchObject({ verified: false, failure: "the DID configuration answered HTTP 404" });
    expect(net.calls.map((c) => c.url)).toEqual([CONFIG_URL]);
  });
});

describe("DID configuration", () => {
  test("an EdDSA credential signed by an assertion key verifies the domain", async () => {
    const net = new FakeNet().host(DOMAIN);
    const jwt = compactJws({ alg: "EdDSA", kid: `${DID}#${keyHash(KEY_A)}` }, credential(net.clock.now()), signA);
    net.json(CONFIG_URL, configuration(jwt));
    const check = await checkDomain({ fetcher: net.fetcher(), txt: net.txt }, DOMAIN, SUBJECT, net.clock.now());
    expect(check).toMatchObject({ verified: true, method: "didConfiguration", keyHash: keyHash(KEY_A), fetched: { url: CONFIG_URL }, failure: null });
    expect(net.txtLookups).toEqual([`_did.${DOMAIN}`]);
  });

  test("an ES256 credential signed by a P-256 assertion key, in the legacy DID form, after an entry that fails", async () => {
    const net = new FakeNet().host(DOMAIN);
    const bad = compactJws({ alg: "EdDSA", kid: `${DID}#${keyHash(KEY_B)}` }, credential(net.clock.now()), signB);
    const good = compactJws({ alg: "ES256", kid: `${LEGACY_FORM}#${P256.keyHash}` }, credential(net.clock.now(), { did: LEGACY_FORM }), signP256);
    net.json(CONFIG_URL, configuration({ "@context": [], proof: {} }, bad, good));
    const check = await checkDomain({ fetcher: net.fetcher(), txt: net.txt }, DOMAIN, SUBJECT, net.clock.now());
    expect(check).toMatchObject({ verified: true, method: "didConfiguration", keyHash: P256.keyHash });
  });

  test("the origin may be the bare domain, as in the specification's JWT example", () => {
    const now = Date.now();
    const jwt = compactJws({ alg: "EdDSA", kid: `${DID}#${keyHash(KEY_A)}` }, credential(now, { origin: DOMAIN }), signA);
    expect(verifyLinkageJwt(jwt, DOMAIN, SUBJECT, now)).toBe(keyHash(KEY_A));
  });

  const now = Date.UTC(2026, 10, 2, 12, 0, 0);
  const kidA = `${DID}#${keyHash(KEY_A)}`;
  test.each([
    ["a key that is not an assertion key", compactJws({ alg: "EdDSA", kid: `${DID}#${keyHash(KEY_B)}` }, credential(now), signB)],
    ["a kid of another DID", compactJws({ alg: "EdDSA", kid: `did:vector:${idOf("x")}#${keyHash(KEY_A)}` }, credential(now, { did: `did:vector:${idOf("x")}` }), signA)],
    ["a kid without a fragment", compactJws({ alg: "EdDSA", kid: DID }, credential(now), signA)],
    ["ES256 with an Ed25519 key", compactJws({ alg: "ES256", kid: kidA }, credential(now), signA)],
    ["another origin", compactJws({ alg: "EdDSA", kid: kidA }, credential(now, { origin: "https://evil.example.net" }), signA)],
    ["an http origin", compactJws({ alg: "EdDSA", kid: kidA }, credential(now, { origin: `http://${DOMAIN}` }), signA)],
    ["an expired credential", compactJws({ alg: "EdDSA", kid: kidA }, credential(now, { exp: now / 1000 - 1 }), signA)],
    ["a credential that is not valid yet", compactJws({ alg: "EdDSA", kid: kidA }, credential(now, { nbf: now / 1000 + 3600 }), signA)],
    ["another issuer", compactJws({ alg: "EdDSA", kid: kidA }, credential(now, { iss: `did:vector:${idOf("x")}` }), signA)],
    ["another credential type", compactJws({ alg: "EdDSA", kid: kidA }, credential(now, { type: ["VerifiableCredential"] }), signA)],
    ["a signature of another key", compactJws({ alg: "EdDSA", kid: kidA }, credential(now), signB)],
    ["a changed payload", (() => {
      const [h, , s] = compactJws({ alg: "EdDSA", kid: kidA }, credential(now), signA).split(".");
      return `${h}.${Buffer.from(JSON.stringify(credential(now, { origin: "https://other.example.org" }))).toString("base64url")}.${s}`;
    })()],
    ["two parts", "abc.def"],
    ["padding in base64url", `${compactJws({ alg: "EdDSA", kid: kidA }, credential(now), signA)}=`],
  ])("a credential with %s does not verify", (_name, jwt) => {
    expect(verifyLinkageJwt(jwt, DOMAIN, SUBJECT, now)).toBeNull();
  });

  test.each([
    ["no linked_dids", { "@context": DID_CONFIGURATION_CONTEXT }, "the DID configuration resource is not valid"],
    ["only the JSON-LD proof format", configuration({ "@context": [], issuer: DID, proof: { type: "Ed25519Signature2018" } }), "no Domain Linkage Credential of the DID verifies"],
  ])("a resource with %s does not verify", async (_name, resource, failure) => {
    const net = new FakeNet().host(DOMAIN);
    net.json(CONFIG_URL, resource);
    expect(await checkDomain({ fetcher: net.fetcher(), txt: net.txt }, DOMAIN, SUBJECT, net.clock.now())).toMatchObject({ verified: false, failure });
  });

  test("a domain that resolves to a private address is not fetched", async () => {
    const net = new FakeNet().host(DOMAIN, "10.1.1.1");
    expect(await checkDomain({ fetcher: net.fetcher(), txt: net.txt }, DOMAIN, SUBJECT, net.clock.now())).toMatchObject({
      verified: false,
      failure: "the host resolves to an address that is not public unicast",
    });
    expect(net.calls).toEqual([]);
  });
});
