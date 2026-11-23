// A gateway for rendering tests: a ledger with agents of each protocol, a fake network that serves
// their endpoints, a background scan that has run, and the HTTP server with the rendering routes.

import { once } from "node:events";
import { FactsStore } from "../../src/fetch/facts.js";
import { FetchScheduler } from "../../src/fetch/scheduler.js";
import type { RenderConfig } from "../../src/render/config.js";
import type { Ed25519Signer } from "../../src/render/signer.js";
import { VectorResolver } from "../../src/resolve/resolver.js";
import { createResolverServer } from "../../src/server/http.js";
import { renderRoutes } from "../../src/server/routes-render.js";
import { keyHash } from "../../src/codec/keys.js";
import { ed25519Key, p256Key } from "../support/keys.js";
import { KEY_A, KEY_B, LEGACY, LedgerBuilder, PARTY_KEY, identityDatum, idOf, keySigner, party, timeAt, utf8 } from "../support/ledger.js";
import { tombstoneOf } from "../support/resolve.js";
import { FakeNet, ed25519Signer } from "../fetch/support.js";

export const BASE = "https://id.vector.apexfusion.org";
export const CONFIG: RenderConfig = { baseUrl: BASE, accessLogRetention: "Traefik keeps the access log for 14 days.", fetchJobs: true, scanIntervalMs: 600_000 };

export const A2A_ID = idOf("render a2a agent");
export const MCP_ID = idOf("render mcp agent");
export const WEB_ID = idOf("render web agent");
export const DOWN_ID = idOf("render unreachable agent");
export const CHILD_ID = idOf("render subagent");
export const HELD_ID = idOf("render held agent");
export const REVOKED_ID = idOf("render revoked agent");
export const P256 = p256Key(61);
export const BAD_P256 = p256Key(62);

/** The gateway's card-signing key in these tests. */
export const GATEWAY_ID = idOf("render gateway");
export const GATEWAY_KEY = ed25519Key(21);
export const SIGNER: Ed25519Signer = {
  kid: `did:vector:${GATEWAY_ID}#${keyHash(GATEWAY_KEY)}`,
  sign: async (data) => ed25519Signer(21)(data),
};

export const A2A_CARD = {
  name: "Self-described name",
  description: "Self-described.",
  version: "9.9.9",
  supportedInterfaces: [{ url: "https://a2a.example.org/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["application/json"],
  skills: [{ id: "x", name: "X", description: "", tags: [] }],
};

export interface Gateway {
  readonly net: FakeNet;
  readonly ledger: LedgerBuilder;
  readonly store: FactsStore;
  readonly resolver: VectorResolver;
  readonly scheduler: FetchScheduler;
  get(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** The ledger of the rendering tests, at tip 1000. */
export function renderLedger(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(
    A2A_ID,
    identityDatum({
      keys: [
        { keyType: "Ed25519", key: KEY_A, purposes: 1 | 2 | 8, pop: null },
        { keyType: "P256", key: P256.publicKey, purposes: 2, pop: P256.pop(A2A_ID) },
        { keyType: "P256", key: BAD_P256.publicKey, purposes: 1, pop: BAD_P256.pop(idOf("another record")) },
      ],
      parties: [party({ organisation: utf8("acme.example.org") }), party({ role: "Distributor", signer: keySigner(KEY_B), rights: 0, organisation: utf8("did:web:other") })],
      name: utf8("Route planner"),
      description: utf8("Plans routes on Vector."),
      endpoint: utf8("https://a2a.example.org/rpc"),
      capabilities: [utf8("llm.text.generate.v1"), utf8("ocr.extract.v1"), utf8("custom.thing")],
    }),
    { height: 100 },
  );
  b.register(
    MCP_ID,
    identityDatum({
      name: utf8("Paper tools"),
      description: utf8(`Paper2Agent tools: ${"x".repeat(200)}`),
      endpoint: utf8("https://mcp.example.org/mcp"),
      capabilities: [utf8("mcp.tool.execute.v1")],
    }),
    { height: 110 },
  );
  b.register(WEB_ID, identityDatum({ name: utf8("Web agent"), endpoint: utf8("https://web.example.org/"), capabilities: [] }), { height: 120 });
  b.register(DOWN_ID, identityDatum({ name: utf8("Down agent"), endpoint: utf8("https://down.example.org/") }), { height: 130 });
  b.register(CHILD_ID, identityDatum({ controller: KEY_B, endpoint: new Uint8Array(), lineage: { type: "Subagent", parent: A2A_ID, parentEpoch: 0, depth: 1 } }), { height: 140 });
  b.register(HELD_ID, identityDatum({ name: utf8("Held agent"), endpoint: utf8("https://held.example.org/") }), { height: 150 });
  b.register(REVOKED_ID, identityDatum({ endpoint: utf8("https://revoked.example.org/") }), { height: 160 });
  return b;
}

export function renderNet(): FakeNet {
  const net = new FakeNet();
  for (const host of ["a2a.example.org", "mcp.example.org", "web.example.org", "down.example.org", "held.example.org", "revoked.example.org", "acme.example.org"]) net.host(host);
  net.json("https://a2a.example.org/.well-known/agent-card.json", A2A_CARD);
  net.on(
    "https://mcp.example.org/mcp",
    { headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28", "2025-11-25"], capabilities: {} } }) },
    "POST",
  );
  net.on("https://web.example.org/", { status: 200, body: "<html>web</html>" });
  net.on("https://held.example.org/", { status: 200, body: "<html>held</html>" });
  net.on("https://revoked.example.org/", { status: 200, body: "<html>revoked</html>" });
  net.txtRecords.set("_did.acme.example.org", [[`did:vector:${A2A_ID}`]]);
  return net;
}

/** Builds the gateway, runs one scan with its checks, then suspends HELD_ID and revokes REVOKED_ID (both confirmed). */
export async function startGateway(options: { signer?: Ed25519Signer | null; ledger?: LedgerBuilder; net?: FakeNet; logs?: string[] } = {}): Promise<Gateway> {
  const net = options.net ?? renderNet();
  const ledger = options.ledger ?? renderLedger();
  const store = new FactsStore();
  const resolver = new VectorResolver(ledger.chain, ledger.settings, { fetchedFacts: store.provider, log: () => undefined });
  const scheduler = new FetchScheduler(resolver, store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId }, { log: () => undefined });
  await scheduler.scan();
  await scheduler.idle();
  if (!options.ledger) {
    ledger.update(HELD_ID, identityDatum({ name: utf8("Held agent"), endpoint: utf8("https://held.example.org/"), status: { type: "Suspended", holds: [{ by: keySigner(PARTY_KEY), reason: 68, since: timeAt(900), until: timeAt(5000) }] } }), {
      height: 900,
    });
    ledger.update(
      REVOKED_ID,
      tombstoneOf(identityDatum({ endpoint: utf8("https://revoked.example.org/") }), { type: "Revoked", by: { type: "ControllerSet" }, reason: 5, at: timeAt(900), invalidFrom: null, successor: null }),
      { height: 900, txIndex: 1 },
    );
    ledger.tip(1001);
    await scheduler.scan();
  }
  const server = createResolverServer(resolver, {
    log: () => undefined,
    routes: [
      renderRoutes({
        records: resolver,
        facts: store,
        snapshot: () => scheduler.snapshot,
        settings: ledger.settings,
        config: CONFIG,
        signer: options.signer === undefined ? SIGNER : options.signer,
        log: (message) => options.logs?.push(message),
      }),
    ],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server has no TCP address");
  const { port } = address;
  return {
    net,
    ledger,
    store,
    resolver,
    scheduler,
    get: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

