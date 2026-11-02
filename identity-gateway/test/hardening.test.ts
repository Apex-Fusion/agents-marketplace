// Regression tests for the findings F1 to F11 of the gateway review R3 (availability and protocol
// details). They come from the review's proofs of concept: each test failed on the code that the
// review read, and passes now.

import { X509Certificate } from "node:crypto";
import type { Server } from "node:http";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import type { Key } from "../src/codec/identity-datum.js";
import { keyHash } from "../src/codec/keys.js";
import { FactsStore } from "../src/fetch/facts.js";
import { DID_CONFIGURATION_CONTEXT } from "../src/fetch/linkage.js";
import { DAY_MS, FetchScheduler } from "../src/fetch/scheduler.js";
import type { RenderConfig } from "../src/render/config.js";
import type { SingleUseStore } from "../src/m4/replay.js";
import { TokenRegistry } from "../src/m4/tokens.js";
import { signingCertificate } from "../src/m4/x509.js";
import { VectorResolver } from "../src/resolve/resolver.js";
import { negotiate } from "../src/server/accept.js";
import { createResolverServer } from "../src/server/http.js";
import { renderRoutes } from "../src/server/routes-render.js";
import { FakeNet, compactJws, ed25519Signer } from "./fetch/support.js";
import { JWT_TYPE, TOKEN_EXCHANGE, TRUST_DOMAIN, agentJwt, at, bodyOf, decodeJwt, dpopProof, edKey, gatewayKeys, postForm, requestToken, startGateway, stopGateways, text } from "./m4/support.js";
import { KEY_A, LEGACY, LEGACY_OWNER, LEGACY_OWNER_2, LedgerBuilder, PARTY_KEY, identityDatum, idOf, keySigner, legacyDatum, party, timeAt, utf8 } from "./support/ledger.js";

const servers: Server[] = [];
afterEach(async () => {
  await stopGateways();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

const AGENT = idOf("r3 regression agent");
const AUTH = edKey(71);
const STRANGER = edKey(72);
const DPOP = edKey(73);
const RENDER_CONFIG: RenderConfig = { baseUrl: "https://id.vector.apexfusion.org", accessLogRetention: "x", fetchJobs: true, scanIntervalMs: 600_000 };

function agentLedger(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(AGENT, identityDatum({ keys: [{ keyType: "Ed25519", key: AUTH.publicKey, purposes: 1, pop: null }] }), { height: 100 });
  return b;
}

/**
 * A legacy record, minted before the cutoff, with `updates` updates in their own blocks after the
 * cutoff (the legacy registry stays open). The last update names an owner key that never signs, so
 * the legacy key search looks at every transaction of the record.
 */
function longLegacyHistory(b: LedgerBuilder, id: string, updates: number): void {
  b.legacyRegister(id, legacyDatum(LEGACY_OWNER), { height: 120, vkeys: [LEGACY_OWNER] });
  for (let i = 0; i < updates; i++) b.legacyUpdate(id, legacyDatum(LEGACY_OWNER, { description: utf8(`update ${i}`) }), { height: 600 + i, vkeys: [LEGACY_OWNER] });
  b.legacyUpdate(id, legacyDatum(LEGACY_OWNER_2), { height: 600 + updates, vkeys: [LEGACY_OWNER] });
}

/** Ledger reads of block witnesses (one Ogmios session each). */
const blockReads = (b: LedgerBuilder): number => b.chain.calls.filter((c) => c === "blockWitnesses").length;

/**
 * The value of `promise`, or null when it takes longer than `ms`. A deadline, not a wait: the answer
 * that the test expects comes at once, and the timer only turns a hang (the old behaviour) into a
 * failure. No fake clock can do this here, because the HTTP stack uses real timers.
 */
async function within<T>(ms: number, promise: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("F1: the legacy key search is bounded and cached; status lists do not wait for it", () => {
  test("a history of 302 transactions takes 10 ledger reads once; later resolutions and currentRecord read no block", async () => {
    const b = new LedgerBuilder();
    const id = idOf("r3 long legacy history");
    longLegacyHistory(b, id, 300);
    const resolver = new VectorResolver(b.chain, b.settings, { log: () => undefined });
    const first = await resolver.resolveDid(`did:vector:${id}`);
    expect(first.didDocumentMetadata.vectorMetadataError).toBe("controllerKeyNotFound");
    // Windows of 1, 2, 4, ..., 64 blocks: 302 blocks in 10 reads.
    expect(blockReads(b)).toBe(10);
    expect(b.chain.blocksRead).toHaveLength(302);
    await resolver.resolveDid(`did:vector:${id}`);
    const lookup = await resolver.currentRecord(id);
    expect(lookup.found && lookup.record.legacyControllerKey).toBeNull();
    expect(blockReads(b)).toBe(10);
  });

  test("a new transaction of the record costs one block, not the whole history again", async () => {
    const b = new LedgerBuilder();
    const id = idOf("r3 growing legacy history");
    longLegacyHistory(b, id, 300);
    const resolver = new VectorResolver(b.chain, b.settings, { log: () => undefined });
    await resolver.resolveDid(`did:vector:${id}`);
    const reads = blockReads(b);
    // A value-only change in a new block: the base version gets a new last output, so the search runs
    // again. The output is not confirmed yet, so no result is kept for it; the witnesses are.
    b.touch(id, 3_000_000n, { height: 1001 });
    b.tip(1001);
    for (let i = 0; i < 2; i++) {
      const again = await resolver.resolveDid(`did:vector:${id}`);
      expect(again.didDocumentMetadata.vectorMetadataError).toBe("controllerKeyNotFound");
    }
    expect(blockReads(b)).toBe(reads + 1);
    expect(b.chain.blocksRead.slice(-1)).toEqual([1001]);
  });

  test("status lists read no block, and a request during a rebuild gets the previous lists at once", async () => {
    const b = agentLedger();
    longLegacyHistory(b, idOf("r3 long legacy history"), 300);
    const h = await startGateway(b);
    const first = await fetch(`${h.url}/status/tsl/0`);
    expect(first.status).toBe(200);
    const jwt = await first.text();
    expect(blockReads(b)).toBe(0);

    // The next build waits for the ledger; meanwhile requests get the previous lists, still valid.
    h.now += 61_000;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const assets = b.chain.policyAssets.bind(b.chain);
    b.chain.policyAssets = async (policyId) => {
      await gate;
      return assets(policyId);
    };
    const answer = await within(
      2_000,
      fetch(`${h.url}/status/tsl/0`).then(async (res) => ({ status: res.status, body: await res.text() })),
    );
    open();
    expect(answer).toEqual({ status: 200, body: jwt });
    await h.services.statusLists.refresh();
    expect(blockReads(b)).toBe(0);
  }, 30_000);
});

describe("F2: detection keeps small details; a card is built and signed once for the same facts", () => {
  test("a card with 6,000 interfaces and 41 modes: detection keeps 8 and 16; the signed card is small and signed once", async () => {
    const ID = idOf("r3 big card agent");
    const interfaces = Array.from({ length: 6_000 }, (_, i) => ({ url: `https://big.example.org/a2a/${String(i).padStart(70, "0")}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }));
    const modes = [`text/${"x".repeat(300)}`, ...Array.from({ length: 40 }, (_, i) => `text/x-mode-${i}`)];
    const card = { name: "Big", description: "", version: "1", supportedInterfaces: interfaces, capabilities: {}, defaultInputModes: modes, defaultOutputModes: ["text/plain"], skills: [] };
    const net = new FakeNet().host("big.example.org");
    net.json("https://big.example.org/.well-known/agent-card.json", card);
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ endpoint: utf8("https://big.example.org/a2a") }), { height: 100 });
    const store = new FactsStore();
    const resolver = new VectorResolver(b.chain, b.settings, { fetchedFacts: store.provider, log: () => undefined });
    const scheduler = new FetchScheduler(resolver, store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId });
    await scheduler.scan();
    await scheduler.idle();
    const a2a = store.get(ID)?.detection?.a2a;
    // The first 8 interfaces and 16 modes in card order (DETECTION_LIMITS); the 300-byte mode is left out.
    expect(a2a?.interfaces).toEqual(interfaces.slice(0, 8));
    expect(a2a?.defaultInputModes).toEqual(modes.slice(1, 17));

    let signatures = 0;
    const sign = ed25519Signer(21);
    const signer = {
      kid: "did:vector:00#x",
      sign: async (data: Uint8Array) => {
        signatures++;
        return sign(data);
      },
    };
    const base = await listen(
      createResolverServer(resolver, {
        routes: [renderRoutes({ records: resolver, facts: store, snapshot: () => scheduler.snapshot, settings: b.settings, config: RENDER_CONFIG, signer })],
      }),
    );
    const url = `${base}/agents/${ID}/agent-card.json`;
    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    expect(signatures).toBe(1);
    expect(new Set(bodies).size).toBe(1);
    expect(Buffer.byteLength(bodies[0]!)).toBeLessThan(16_384);

    // A new check stores new facts, so the next request builds and signs the card again.
    net.clock.t += DAY_MS;
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
    expect((await fetch(url)).status).toBe(200);
    expect(signatures).toBe(2);
  });

  test("an MCP endpoint that names 100 protocol versions: detection keeps 16, and the server card lists those", async () => {
    const ID = idOf("r3 many versions agent");
    const versions = Array.from({ length: 100 }, (_, i) => `2025-01-${String(i).padStart(3, "0")}`);
    const net = new FakeNet().host("mcp.example.org");
    net.json("https://mcp.example.org/mcp", { jsonrpc: "2.0", id: 1, result: { supportedVersions: versions, capabilities: {} } }, "POST");
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ endpoint: utf8("https://mcp.example.org/mcp") }), { height: 100 });
    const store = new FactsStore();
    const resolver = new VectorResolver(b.chain, b.settings, { fetchedFacts: store.provider, log: () => undefined });
    const scheduler = new FetchScheduler(resolver, store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId });
    await scheduler.scan();
    await scheduler.idle();
    expect(store.get(ID)?.detection).toMatchObject({ protocol: "mcp", mcpVersions: versions.slice(0, 16) });
    const base = await listen(
      createResolverServer(resolver, {
        routes: [renderRoutes({ records: resolver, facts: store, snapshot: () => scheduler.snapshot, settings: b.settings, config: RENDER_CONFIG, signer: null })],
      }),
    );
    const serverCard = await bodyOf(await fetch(`${base}/agents/${ID}/server-card`));
    expect(serverCard.remotes).toEqual([{ type: "streamable-http", url: "https://mcp.example.org/mcp", supportedProtocolVersions: versions.slice(0, 16) }]);
  });
});

describe("F3: a token request that does not authenticate writes no single-use entry", () => {
  test("three requests with a garbage subject token and fresh DPoP proofs leave the store as it was", async () => {
    const h = await startGateway(agentLedger());
    // The test reads the token service's private store, to count its entries.
    const internals = h.services.tokens as unknown as { readonly replay: SingleUseStore };
    const before = internals.replay.size;
    for (let i = 0; i < 3; i++) {
      const res = await postForm(
        h,
        "/token",
        { grant_type: TOKEN_EXCHANGE, subject_token: "x", subject_token_type: JWT_TYPE, audience: "a" },
        // A key that nobody registered, and a 256-character jti.
        { dpop: await dpopProof(STRANGER, { now: h.now, claims: { jti: `${"j".repeat(255)}${i}` } }) },
      );
      expect(res.status).toBe(400);
      expect(String((await bodyOf(res)).error_description)).toMatch(/^subject_token:/);
    }
    expect(internals.replay.size).toBe(before);
  });

  test("a DPoP proof of a failed request is not used up: it works once with a valid subject token", async () => {
    const h = await startGateway(agentLedger());
    const proof = await dpopProof(DPOP, { now: h.now });
    const exchange = (subjectToken: string) =>
      postForm(h, "/token", { grant_type: TOKEN_EXCHANGE, subject_token: subjectToken, subject_token_type: JWT_TYPE, audience: "https://rs.example.org" }, { dpop: proof });
    expect((await exchange("x")).status).toBe(400);
    expect((await exchange(await agentJwt(AUTH, AGENT, { now: h.now }))).status).toBe(200);
    const replayed = await exchange(await agentJwt(AUTH, AGENT, { now: h.now }));
    expect(replayed.status).toBe(400);
    expect(await bodyOf(replayed)).toEqual({ error: "invalid_dpop_proof", error_description: "the DPoP proof was already used" });
  });
});

describe("F4: nonce requests cannot exhaust the SPIFFE service", () => {
  test("POST /spiffe/nonce stores nothing: each request succeeds, and each nonce works once", async () => {
    const h = await startGateway(agentLedger());
    // A nonce store with a cap of 3 (the earlier design) refused the fourth nonce; issuing has no cap now.
    const capped = h.services.spiffe.nonces as unknown as { max: number };
    capped.max = 3;
    const internals = h.services.tokens as unknown as { readonly replay: SingleUseStore };
    const before = internals.replay.size;
    const issued: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${h.url}/spiffe/nonce`, { method: "POST" });
      expect(res.status).toBe(200);
      issued.push(text((await bodyOf(res)).nonce));
    }
    expect(new Set(issued).size).toBe(10);
    expect(internals.replay.size).toBe(before);
    expect(h.services.spiffe.nonces.consume(issued[9]!, h.now)).toBe("ok");
    expect(h.services.spiffe.nonces.consume(issued[9]!, h.now)).toBe("unknown");
  });
});

describe("F5: resolution applies the stored facts to the view that it shows", () => {
  const ID = idOf("r3 facts agent");
  const DID = `did:vector:${ID}`;
  const CARD = {
    name: "Agent",
    description: "An agent.",
    version: "1",
    supportedInterfaces: [{ url: "https://agent.example.org/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: {},
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };
  const datum = (keys: readonly Key[]) =>
    identityDatum({ keys, endpoint: utf8("https://agent.example.org/a2a"), parties: [party({ organisation: utf8("acme.example.org") })] });

  test("after the controller removes the key that signed the Domain Linkage Credential, the result no longer claims the domain; the version that lists the key does", async () => {
    const net = new FakeNet().host("agent.example.org").host("acme.example.org");
    net.json("https://agent.example.org/.well-known/agent-card.json", CARD);
    const now = Math.floor(net.clock.now() / 1000);
    const vc = {
      exp: now + 86_400,
      iss: DID,
      nbf: now - 60,
      sub: DID,
      vc: {
        "@context": ["https://www.w3.org/2018/credentials/v1", DID_CONFIGURATION_CONTEXT],
        credentialSubject: { id: DID, origin: "https://acme.example.org" },
        issuer: DID,
        type: ["VerifiableCredential", "DomainLinkageCredential"],
      },
    };
    const jwt = compactJws({ alg: "EdDSA", kid: `${DID}#${keyHash(KEY_A)}` }, vc, ed25519Signer(3));
    net.json("https://acme.example.org/.well-known/did-configuration.json", { "@context": DID_CONFIGURATION_CONTEXT, linked_dids: [jwt] });

    const b = new LedgerBuilder();
    b.register(ID, datum([{ keyType: "Ed25519", key: KEY_A, purposes: 1 | 2, pop: null }]), { height: 100 });
    const store = new FactsStore();
    const resolver = new VectorResolver(b.chain, b.settings, { fetchedFacts: store.provider, log: () => undefined });
    const scheduler = new FetchScheduler(resolver, store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId });
    await scheduler.scan();
    await scheduler.idle();
    expect((await resolver.resolveDid(DID)).didDocument?.alsoKnownAs).toEqual(["https://acme.example.org"]);

    // The controller removes KEY_A. A removal reduces the record, so the view drops the key at once
    // (Part 1 Section 7.2); the next scan has not run.
    b.update(ID, datum([]), { height: 1001 });
    b.tip(1001);
    const result = await resolver.resolveDid(DID);
    expect(result.didDocument?.assertionMethod).toBeUndefined();
    expect(result.didDocument?.alsoKnownAs).toBeUndefined();
    expect(result.didDocumentMetadata.vectorParties?.[0]?.organisationVerified).toBeUndefined();
    expect(result.didDocumentMetadata.vectorProfile?.protocol).toBe("a2a");

    // Version 0 lists KEY_A, so its result shows the link that the key signed.
    const v0 = await resolver.resolveDid(DID, { versionId: "0" });
    expect(v0.didDocument?.alsoKnownAs).toEqual(["https://acme.example.org"]);
    expect(v0.didDocumentMetadata.vectorParties?.[0]?.organisationVerified).toBe(true);
  });
});

describe("F6: a token that a status change revoked stays invalid in the Token Status List", () => {
  test("after the hold ends, the token's entry reads SUSPENDED until the token can no longer be accepted", async () => {
    const b = agentLedger();
    const h = await startGateway(b);
    const issued = await bodyOf(await requestToken(h, await agentJwt(AUTH, AGENT, { now: h.now }), DPOP));
    const token = text(issued.access_token);
    const { payload } = decodeJwt(token);
    const idx = Number(at(payload, "status", "status_list", "idx"));
    const entry = async (): Promise<number> => {
      await h.services.statusLists.refresh();
      const list = decodeJwt(await (await fetch(`${h.url}/status/tsl/0`)).text()).payload;
      const bytes = inflateSync(Buffer.from(text(at(list, "status_list", "lst")), "base64url"));
      return (bytes[idx >> 2]! >> ((idx & 3) * 2)) & 3;
    };
    expect(await entry()).toBe(0);

    // A party puts a short hold on the agent; the watcher revokes the agent's tokens.
    const hold = { by: keySigner(PARTY_KEY), reason: 68, since: timeAt(1001), until: timeAt(1005) };
    b.update(AGENT, identityDatum({ keys: [{ keyType: "Ed25519", key: AUTH.publicKey, purposes: 1, pop: null }], status: { type: "Suspended", holds: [hold] } }), { height: 1001 });
    b.tip(1001);
    await h.services.tokens.checkStatuses();
    h.now += 20_000;
    expect(await entry()).toBe(2);

    // The hold ends without a transaction; the token has not expired.
    b.tip(1006);
    h.now += 100_000;
    expect(Number(payload.exp) * 1000).toBeGreaterThan(h.now);
    expect(await entry()).toBe(2);

    // Once the token has expired and the clock leeway has passed, the entry is valid again.
    h.now = Number(payload.exp) * 1000 + 30_000;
    expect(await entry()).toBe(0);
  });

  test("a delegator's status change holds the entry that the delegation token names; a JWT-SVID names no entry", () => {
    const [requester, delegator, other] = ["r", "d", "s"].map((label) => idOf(`r3 held ${label}`)) as [string, string, string];
    const registry = new TokenRegistry();
    const token = { owners: [], delegation: null, issuedAt: 1_000, expiresAt: 301_000, revoked: false };
    registry.add({ ...token, jti: "a", kind: "access_token", agents: [requester, delegator] }, 1_000);
    registry.add({ ...token, jti: "b", kind: "jwt_svid", agents: [other] }, 1_000);
    expect(registry.heldEntries(2_000)).toEqual(new Set());
    registry.revokeAgent(delegator, 2_000);
    registry.revokeAgent(other, 2_000);
    expect(registry.heldEntries(2_000)).toEqual(new Set([requester]));
    expect(registry.heldEntries(331_000)).toEqual(new Set());
  });
});

describe("F7: Accept takes the weight of the most specific range for each media type (RFC 9110 Section 12.5.1)", () => {
  test.each([
    ["application/did-resolution;q=0.1, application/*;q=0.9", "document"],
    ['application/did-resolution;q=0.1, application/ld+json;profile="https://w3id.org/did-resolution";q=0.1, */*', "document"],
    ["application/did;q=0.2, */*;q=0.9", "result"],
    ["application/*;q=0.5, application/did-resolution;q=0.6", "result"],
  ])("%s gives the %s", (accept, expected) => {
    expect(negotiate(accept)).toBe(expected);
  });
});

describe("F8: each SPIFFE CA certificate has its own serial number and starts before issue", () => {
  test("two builds have different serial numbers; the service backdates the CA as it backdates SVIDs", async () => {
    const key = gatewayKeys().p256;
    const a = new X509Certificate((await signingCertificate(key, TRUST_DOMAIN, Date.UTC(2026, 10, 2, 12))).der);
    const b = new X509Certificate((await signingCertificate(key, TRUST_DOMAIN, Date.UTC(2026, 10, 3, 12))).der);
    expect(a.issuer).toBe(b.issuer);
    expect(a.serialNumber).not.toBe(b.serialNumber);

    const h = await startGateway(agentLedger());
    const ca = new X509Certificate((await h.services.spiffe.signingCertificate()).der);
    const backdated = new X509Certificate((await signingCertificate(key, TRUST_DOMAIN, h.now - 60_000)).der);
    expect(ca.validFrom).toBe(backdated.validFrom);
  });
});

describe("F9: an index build does not read the legacy mints made at or after the cutoff", () => {
  test("1,000 late legacy mints: the first build reads only the other mint, and a later build reads none", async () => {
    const b = agentLedger();
    for (let i = 0; i < 1000; i++) b.legacyRegister(idOf(`r3 late legacy ${i}`), legacyDatum(), { height: 600 + (i % 300), txIndex: 1 + Math.floor(i / 300) });
    const resolver = new VectorResolver(b.chain, b.settings, { log: () => undefined });
    const requested: number[] = [];
    const transactions = b.chain.transactions.bind(b.chain);
    b.chain.transactions = async (hashes) => {
      requested.push(hashes.length);
      return transactions(hashes);
    };
    const list = await resolver.listRecords();
    expect(list.entries.map((e) => [e.vectorId, e.statusListIndex])).toEqual([[AGENT, 0]]);
    expect(requested).toEqual([1]);
    // The confirmed mint is kept between builds.
    expect((await resolver.listRecords()).entries).toEqual(list.entries);
    expect(requested).toEqual([1]);
  });
});

describe("F10: HEAD on the resolution endpoint", () => {
  test("HEAD answers with the status and header fields of GET and no body", async () => {
    const h = await startGateway(agentLedger());
    const url = `${h.url}/1.0/identifiers/did:vector:${AGENT}`;
    const get = await fetch(url);
    const body = await get.text();
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");
    const post = await fetch(url, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("F11: the per-host fetch limit counts the destination, not the host text", () => {
  test.each([
    ["a name with and without the trailing dot", "https://victim.example.org./a", "https://victim.example.org/b"],
    ["an IPv4 address and its IPv4-mapped IPv6 form", "https://93.184.215.14/a", "https://[::ffff:5db8:d70e]/b"],
    ["an IPv4 address and its NAT64 form", "https://93.184.215.14/a", "https://[64:ff9b::5db8:d70e]/b"],
  ])("%s share one slot", async (_name, first, second) => {
    const net = new FakeNet().host("victim.example.org").host("victim.example.org.");
    const fetcher = net.fetcher();
    await fetcher.fetch(first);
    await fetcher.fetch(second);
    expect(net.calls.map((c) => c.url)).toEqual([first, second].map((u) => new URL(u).href));
    expect(net.clock.sleeps).toEqual([60_000]);
  });
});
