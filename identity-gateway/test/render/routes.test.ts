// The renderings of Part 2 Section 8.5, the listing rule of Section 8.4 and /policy, over HTTP.

import { createPublicKey, verify } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { keyHash } from "../../src/codec/keys.js";
import { canonicalize } from "../../src/resolve/jcs.js";
import { formatTime } from "../../src/resolve/time.js";
import { CONTROLLER, IDENTITY, KEY_A, LEGACY, LEGACY_OWNER, LedgerBuilder, SETTINGS, identityDatum, idOf, legacyDatum, timeAt, utf8 } from "../support/ledger.js";
import { FakeNet } from "../fetch/support.js";
import {
  A2A_CARD,
  A2A_ID,
  BAD_P256,
  BASE,
  CHILD_ID,
  CONFIG,
  DOWN_ID,
  GATEWAY_ID,
  GATEWAY_KEY,
  HELD_ID,
  MCP_ID,
  P256,
  REVOKED_ID,
  SIGNER,
  WEB_ID,
  startGateway,
  type Gateway,
} from "./support.js";

const did = (id: string): string => `did:vector:${id}`;
const didWeb = (id: string): string => `did:web:id.vector.apexfusion.org:agents:${id}`;

let gw: Gateway;
beforeAll(async () => {
  gw = await startGateway();
});
afterAll(async () => {
  await gw.close();
});

async function json(path: string, init?: RequestInit, gateway: Gateway = gw): Promise<{ status: number; type: string | null; body: unknown; response: Response }> {
  const response = await gateway.get(path, init);
  return { status: response.status, type: response.headers.get("content-type"), body: await response.json(), response };
}

interface SignedCard {
  readonly signatures: ReadonlyArray<{ readonly protected: string; readonly signature: string }>;
  readonly [member: string]: unknown;
}

function isSignedCard(value: unknown): value is SignedCard {
  if (typeof value !== "object" || value === null || !("signatures" in value) || !Array.isArray(value.signatures)) return false;
  return value.signatures.every((s: unknown) => typeof s === "object" && s !== null && "protected" in s && typeof s.protected === "string" && "signature" in s && typeof s.signature === "string");
}

function ecPoint(value: unknown, index: number): { x: string; y: string } {
  if (typeof value !== "object" || value === null || !("keys" in value) || !Array.isArray(value.keys)) throw new Error("not a JWK set");
  const key: unknown = value.keys[index];
  if (typeof key !== "object" || key === null || !("x" in key) || !("y" in key) || typeof key.x !== "string" || typeof key.y !== "string") throw new Error("not an EC key");
  return { x: key.x, y: key.y };
}

/** The registration file with its 256-bit agentId as a string, so that JSON.parse keeps every digit. */
const registration = (text: string): unknown => JSON.parse(text.replace(/"agentId":(\d+)/, '"agentId":"$1"'));

describe("did:web alias (GET /agents/{id}/did.json)", () => {
  test("names the did:vector DID and the verified domains in alsoKnownAs; absolute DID URLs; listed keys with a valid proof", async () => {
    const { status, type, body, response } = await json(`/agents/${A2A_ID}/did.json`);
    expect(status).toBe(200);
    expect(type).toBe("application/did+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const id = didWeb(A2A_ID);
    const url = (key: string): string => `${id}#${keyHash(key)}`;
    expect(body).toMatchObject({
      "@context": "https://www.w3.org/ns/did/v1.1",
      id,
      alsoKnownAs: [did(A2A_ID), "https://acme.example.org"],
      verificationMethod: [{ id: url(CONTROLLER), controller: id }, { id: url(KEY_A) }, { id: url(P256.publicKey) }],
      capabilityInvocation: [url(CONTROLLER)],
      authentication: [url(KEY_A)],
      assertionMethod: [url(KEY_A), url(P256.publicKey)],
    });
    expect(JSON.stringify(body)).not.toContain(BAD_P256.keyHash);
  });

  test("a subagent has an alias (it is Active, although it is not listed)", async () => {
    expect((await gw.get(`/agents/${CHILD_ID}/did.json`)).status).toBe(200);
  });

  test.each([
    ["a suspended agent", HELD_ID, 404, "the effective status of the agent is not Active"],
    ["a revoked agent", REVOKED_ID, 410, "the DID is deactivated"],
    ["an identifier that no registry minted", idOf("nobody"), 404, "the identifier does not resolve"],
  ])("%s has none", async (_name, id, status, error) => {
    expect(await json(`/agents/${id}/did.json`)).toMatchObject({ status, body: { error } });
  });

  test("a malformed identifier is not a rendering path", async () => {
    const response = await gw.get(`/agents/${A2A_ID.toUpperCase()}/did.json`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found\n");
  });
});

describe("JWKS (GET /agents/{id}/jwks.json)", () => {
  test("the listed keys as JWKs with their DID URL as kid; a P-256 key without a valid proof is left out", async () => {
    const { status, type, body } = await json(`/agents/${A2A_ID}/jwks.json`);
    expect(status).toBe(200);
    expect(type).toBe("application/jwk-set+json");
    expect(body).toMatchObject({
      keys: [
        { kty: "OKP", crv: "Ed25519", x: Buffer.from(KEY_A, "hex").toString("base64url"), kid: `${did(A2A_ID)}#${keyHash(KEY_A)}`, alg: "EdDSA", use: "sig" },
        { kty: "EC", crv: "P-256", kid: `${did(A2A_ID)}#${P256.keyHash}`, alg: "ES256", use: "sig" },
      ],
    });
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", ...ecPoint(body, 1) }, format: "jwk" });
    expect(verify("sha256", Buffer.from("probe"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(P256.sign("probe"), "hex"))).toBe(true);
  });
});

describe("A2A agent card (GET /agents/{id}/agent-card.json)", () => {
  test("the on-chain profile, the detected interfaces and modes, signed with the gateway's Ed25519 key (JWS over JCS)", async () => {
    const { status, type, body } = await json(`/agents/${A2A_ID}/agent-card.json`);
    expect(status).toBe(200);
    expect(type).toBe("application/json");
    if (!isSignedCard(body)) throw new Error("the card has no signatures");
    const { signatures, ...card } = body;
    expect(card).toEqual({
      name: "Route planner",
      description: "Plans routes on Vector.",
      supportedInterfaces: A2A_CARD.supportedInterfaces,
      provider: { organization: "acme.example.org", url: "https://acme.example.org" },
      version: "0",
      documentationUrl: `${BASE}/1.0/identifiers/${did(A2A_ID)}`,
      capabilities: {},
      defaultInputModes: A2A_CARD.defaultInputModes,
      defaultOutputModes: A2A_CARD.defaultOutputModes,
      skills: ["llm.text.generate.v1", "ocr.extract.v1", "custom.thing"].map((c) => ({
        id: c,
        name: c,
        description: `The capability ${c} that the record of ${did(A2A_ID)} declares.`,
        tags: [c],
      })),
    });
    expect(signatures).toHaveLength(1);
    const signature = signatures[0]!;
    expect(JSON.parse(Buffer.from(signature.protected, "base64url").toString("utf8"))).toEqual({ alg: "EdDSA", typ: "JOSE", kid: SIGNER.kid, jku: `${BASE}/.well-known/jwks.json` });
    const signingInput = `${signature.protected}.${Buffer.from(canonicalize(card)).toString("base64url")}`;
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(GATEWAY_KEY, "hex").toString("base64url") }, format: "jwk" });
    expect(verify(null, Buffer.from(signingInput), publicKey, Buffer.from(signature.signature, "base64url"))).toBe(true);
  });

  test("the A2A card media type when the client asks for it", async () => {
    const response = await gw.get(`/agents/${A2A_ID}/agent-card.json`, { headers: { accept: "application/a2a-agent-card+json" } });
    expect(response.headers.get("content-type")).toBe("application/a2a-agent-card+json");
  });

  test.each([
    ["an MCP agent", MCP_ID, 404, "the agent is not an A2A agent"],
    ["a web agent", WEB_ID, 404, "the agent is not an A2A agent"],
    ["an agent whose endpoint is not reachable", DOWN_ID, 404, "the agent is not listed (notReachable)"],
    ["a suspended agent", HELD_ID, 404, "the agent is not listed (notActive)"],
    ["a subagent", CHILD_ID, 404, "the agent is not listed (notIndependent)"],
    ["a revoked agent", REVOKED_ID, 410, "the DID is deactivated"],
  ])("%s has none", async (_name, id, status, error) => {
    expect(await json(`/agents/${id}/agent-card.json`)).toMatchObject({ status, body: { error } });
  });

  test("without a signing key the card answers 503", async () => {
    const other = await startGateway({ signer: null });
    try {
      expect(await json(`/agents/${A2A_ID}/agent-card.json`, undefined, other)).toMatchObject({ status: 503, body: { error: "no key to sign agent cards is configured" } });
    } finally {
      await other.close();
    }
  });
});

describe("MCP server card (GET /agents/{id}/server-card)", () => {
  test("an MCP agent: Server Card v1 with the endpoint and the versions it named", async () => {
    const { status, type, body } = await json(`/agents/${MCP_ID}/server-card`, { headers: { accept: "application/mcp-server-card+json" } });
    expect(status).toBe(200);
    expect(type).toBe("application/mcp-server-card+json");
    expect(body).toEqual({
      $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
      name: `org.apexfusion.vector.id/${MCP_ID}`,
      title: "Paper tools",
      // At most 100 characters: 99 of the on-chain description and an ellipsis.
      description: expect.stringMatching(/^Paper2Agent tools: x{80}…$/u),
      version: "0",
      websiteUrl: `${BASE}/1.0/identifiers/${did(MCP_ID)}`,
      remotes: [{ type: "streamable-http", url: "https://mcp.example.org/mcp", supportedProtocolVersions: ["2026-07-28", "2025-11-25"] }],
      _meta: { "org.apexfusion.vector.id/did": did(MCP_ID) },
    });
    expect(body).toMatchObject({ name: expect.stringMatching(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/) });
  });

  test("an A2A agent has none", async () => {
    expect(await json(`/agents/${A2A_ID}/server-card`)).toMatchObject({ status: 404, body: { error: "the agent is not an MCP agent" } });
  });
});

describe("MCP subregistry (GET /v0/servers)", () => {
  test("the listed MCP agents as server.json entries; /v0.1/servers is the same list", async () => {
    const { status, body } = await json("/v0/servers");
    expect(status).toBe(200);
    expect(body).toEqual({
      servers: [
        {
          server: {
            $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
            name: `org.apexfusion.vector.id/${MCP_ID}`,
            title: "Paper tools",
            description: expect.stringMatching(/^Paper2Agent tools: x{80}…$/u),
            version: "0",
            websiteUrl: `${BASE}/1.0/identifiers/${did(MCP_ID)}`,
            remotes: [{ type: "streamable-http", url: "https://mcp.example.org/mcp" }],
          },
          _meta: { "org.apexfusion.vector.id/did": did(MCP_ID) },
        },
      ],
      metadata: { count: 1 },
    });
    expect((await json("/v0.1/servers")).body).toEqual(body);
  });

  test.each([
    ["search=paper", 0],
    [`search=${MCP_ID.slice(10, 20)}`, 1],
    ["version=latest", 1],
    ["version=0", 1],
    ["version=7", 0],
    ["updated_since=2030-01-01T00:00:00Z", 0],
    ["updated_since=2020-01-01T00:00:00.5%2B02:00", 1],
  ])("?%s gives %i entries", async (query, count) => {
    expect((await json(`/v0/servers?${query}`)).body).toMatchObject({ metadata: { count } });
  });

  test.each(["limit=0", "limit=101", "limit=x", "updated_since=yesterday"])("?%s is 400", async (query) => {
    expect(await json(`/v0/servers?${query}`)).toMatchObject({ status: 400, body: { error: expect.any(String) } });
  });

  test("pages of `limit` entries in name order, with nextCursor", async () => {
    const net = new FakeNet();
    const ledger = new LedgerBuilder();
    const ids = ["mcp one", "mcp two", "mcp three"].map(idOf);
    ids.forEach((id, i) => {
      net.host(`m${i}.example.org`);
      net.on(`https://m${i}.example.org/mcp`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28"], capabilities: {} } }) }, "POST");
      ledger.register(id, identityDatum({ endpoint: utf8(`https://m${i}.example.org/mcp`) }), { height: 100 + i });
    });
    const paged = await startGateway({ net, ledger });
    try {
      const names = ids.map((id) => `org.apexfusion.vector.id/${id}`).sort();
      expect((await json("/v0/servers?limit=2", undefined, paged)).body).toMatchObject({
        servers: [{ server: { name: names[0] } }, { server: { name: names[1] } }],
        metadata: { count: 2, nextCursor: names[1] },
      });
      expect((await json(`/v0/servers?limit=2&cursor=${encodeURIComponent(names[1]!)}`, undefined, paged)).body).toMatchObject({
        servers: [{ server: { name: names[2] } }],
        metadata: { count: 1 },
      });
    } finally {
      await paged.close();
    }
  });
});

describe("catalogs", () => {
  test("AI Catalog: listed A2A and MCP agents, by their cards; web agents and unlisted agents are not in it", async () => {
    const { status, type, body } = await json("/.well-known/ai-catalog.json");
    expect(status).toBe(200);
    expect(type).toBe("application/ai-catalog+json");
    expect(body).toEqual({
      specVersion: "1.0",
      host: { displayName: "Vector identity gateway", identifier: did(GATEWAY_ID), documentationUrl: `${BASE}/policy` },
      entries: [
        {
          identifier: `urn:air:id.vector.apexfusion.org:agent:${A2A_ID}`,
          type: "application/a2a-agent-card+json",
          url: `${BASE}/agents/${A2A_ID}/agent-card.json`,
          tags: ["llm.text.generate.v1", "ocr.extract.v1", "custom.thing"],
          updatedAt: formatTime(timeAt(100)),
        },
        {
          identifier: `urn:air:id.vector.apexfusion.org:agent:${MCP_ID}`,
          type: "application/mcp-server-card+json",
          url: `${BASE}/agents/${MCP_ID}/server-card`,
          tags: ["mcp.tool.execute.v1"],
          updatedAt: formatTime(timeAt(110)),
        },
      ],
    });
  });

  test("ARD manifest: the same agents as ARD entries", async () => {
    const urn = expect.stringMatching(/^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/);
    expect(await json("/.well-known/ard.json")).toMatchObject({
      status: 200,
      body: {
        entries: [
          {
            identifier: `urn:air:id.vector.apexfusion.org:agent:${A2A_ID}`,
            displayName: "Route planner",
            type: "application/a2a-agent-card+json",
            url: `${BASE}/agents/${A2A_ID}/agent-card.json`,
            description: "Plans routes on Vector.",
            capabilities: ["llm.text.generate.v1", "ocr.extract.v1", "custom.thing"],
            updatedAt: formatTime(timeAt(100)),
            metadata: { did: did(A2A_ID), protocol: "a2a" },
          },
          { identifier: urn, displayName: "Paper tools", type: "application/mcp-server-card+json", metadata: { did: did(MCP_ID), protocol: "mcp" } },
        ],
      },
    });
  });
});

describe("OASF record and ERC-8004 registration file", () => {
  test("OASF: profile, mapped skills, the endpoint as locator", async () => {
    expect(await json(`/agents/${A2A_ID}/oasf.json`)).toMatchObject({
      status: 200,
      body: {
        name: "Route planner",
        version: "0",
        schema_version: "1.1.0",
        description: "Plans routes on Vector.",
        authors: [did(A2A_ID)],
        created_at: formatTime(timeAt(100)),
        skills: [
          { name: "language_processing/language_generation/text_completion", id: 10301 },
          { name: "computer_vision/image_analysis/optical_character_recognition", id: 20108 },
        ],
        locators: [{ type: "url", urls: ["https://a2a.example.org/rpc"] }],
        annotations: { did: did(A2A_ID), protocol: "a2a", capabilities: '["llm.text.generate.v1","ocr.extract.v1","custom.thing"]' },
      },
    });
  });

  test("ERC-8004: agentId is the identifier as a decimal integer; agentRegistry names the identity policy", async () => {
    const response = await gw.get(`/agents/${A2A_ID}/registration.json`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const agentId = BigInt(`0x${A2A_ID}`).toString(10);
    expect(text).toContain(`"agentId":${agentId}`);
    expect(registration(text)).toEqual({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Route planner",
      description: "Plans routes on Vector.",
      services: [
        { name: "A2A", endpoint: `${BASE}/agents/${A2A_ID}/agent-card.json`, version: "1.0" },
        { name: "OASF", endpoint: `${BASE}/agents/${A2A_ID}/oasf.json`, version: "1.1.0" },
        { name: "DID", endpoint: did(A2A_ID), version: "v1" },
      ],
      x402Support: false,
      active: true,
      registrations: [{ agentId, agentRegistry: `vector:mainnet:${IDENTITY.policyId}` }],
    });
  });

  test.each([
    [MCP_ID, { name: "MCP", endpoint: "https://mcp.example.org/mcp", version: "2026-07-28" }],
    [WEB_ID, { name: "web", endpoint: "https://web.example.org/" }],
  ])("ERC-8004 service of %s", async (id, service) => {
    expect(registration(await (await gw.get(`/agents/${id}/registration.json`)).text())).toMatchObject({ services: [service, { name: "OASF" }, { name: "DID" }] });
  });

  test("unlisted agents have neither", async () => {
    for (const file of ["oasf.json", "registration.json"]) expect((await gw.get(`/agents/${DOWN_ID}/${file}`)).status).toBe(404);
  });

  test("a legacy record before the deployment: agentRegistry names the legacy policy; its key is the one the legacy key search found", async () => {
    const net = new FakeNet().host("legacy.example.org");
    net.on("https://legacy.example.org/agent", { status: 200, body: "legacy" });
    const ledger = new LedgerBuilder({ ...SETTINGS, registries: { identity: null, legacy: LEGACY, cutoffSlot: null } });
    const id = idOf("render legacy agent");
    ledger.legacyRegister(id, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    const legacy = await startGateway({ net, ledger });
    try {
      const text = await (await legacy.get(`/agents/${id}/registration.json`)).text();
      expect(registration(text)).toMatchObject({ registrations: [{ agentRegistry: `vector:mainnet:${LEGACY.policyId}` }], services: [{ name: "web" }, { name: "OASF" }, { name: "DID" }] });
      expect((await json(`/agents/${id}/jwks.json`, undefined, legacy)).body).toEqual({
        keys: [{ kty: "OKP", crv: "Ed25519", x: Buffer.from(LEGACY_OWNER, "hex").toString("base64url"), kid: `${did(id)}#${keyHash(LEGACY_OWNER)}`, alg: "EdDSA", use: "sig" }],
      });
    } finally {
      await legacy.close();
    }
  });
});

describe("GET /policy", () => {
  test("the listing rule, the fetch rules, the confirmation rule and the access-log retention", async () => {
    expect(await json("/policy")).toMatchObject({
      status: 200,
      body: {
        listingRule: expect.stringContaining("independent"),
        fetchRules: expect.stringContaining("public unicast"),
        confirmationRule: expect.stringContaining("30 confirmations"),
        requestLog: "The gateway writes no request log. It logs errors without the requested DID.",
        accessLogRetention: CONFIG.accessLogRetention,
        limits: { fetchMaxBytes: 1_048_576, fetchTimeoutSeconds: 10, fetchIntervalPerHostSeconds: 60, maxRedirects: 5, recheckSeconds: 86_400, confirmations: 30 },
      },
    });
  });
});

describe("HTTP behaviour", () => {
  test("no request fetches anything", async () => {
    const calls = gw.net.calls.length;
    const lookups = gw.net.lookups.length + gw.net.txtLookups.length;
    for (const path of [`/agents/${A2A_ID}/agent-card.json`, `/agents/${MCP_ID}/server-card`, "/v0/servers", "/.well-known/ai-catalog.json", `/agents/${WEB_ID}/did.json`]) {
      await gw.get(path);
    }
    expect(gw.net.calls.length).toBe(calls);
    expect(gw.net.lookups.length + gw.net.txtLookups.length).toBe(lookups);
  });

  test("OPTIONS answers the CORS preflight; POST is 405; HEAD has no body", async () => {
    const preflight = await gw.get(`/agents/${MCP_ID}/server-card`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const post = await gw.get("/policy", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    const head = await gw.get("/policy", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await head.text()).toBe("");
  });

  test("a failed ledger read is 500; the log does not name the DID", async () => {
    const logs: string[] = [];
    const failing = await startGateway({ logs });
    try {
      failing.ledger.chain.failing.add("tip");
      expect(await json(`/agents/${A2A_ID}/did.json`, undefined, failing)).toMatchObject({ status: 500, body: { error: "internal error: the gateway could not read the ledger" } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain(A2A_ID);
    } finally {
      await failing.close();
    }
  });

  test("an endpoint change: the agent is not listed until the next check of the new endpoint", async () => {
    const changed = await startGateway();
    try {
      changed.ledger.update(A2A_ID, identityDatum({ endpoint: utf8("https://a2a-new.example.org/rpc") }), { height: 950 });
      changed.ledger.tip(1002);
      expect(await json(`/agents/${A2A_ID}/agent-card.json`, undefined, changed)).toMatchObject({ status: 404, body: { error: "the agent is not listed (notReachable)" } });
      expect((await changed.get(`/agents/${A2A_ID}/did.json`)).status).toBe(200);
    } finally {
      await changed.close();
    }
  });
});
