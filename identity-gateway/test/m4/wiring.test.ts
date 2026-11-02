// The gateway as main.ts wires it: the renderings sign agent cards with the M4 Ed25519 key, and the
// key's kid resolves in the M4 JWK set that the card's `jku` names.

import { createPublicKey, verify } from "node:crypto";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FactsStore } from "../../src/fetch/facts.js";
import { FetchScheduler } from "../../src/fetch/scheduler.js";
import { createM4Services } from "../../src/m4/index.js";
import { canonicalize } from "../../src/resolve/jcs.js";
import { VectorResolver } from "../../src/resolve/resolver.js";
import { createResolverServer } from "../../src/server/http.js";
import { m4Routes } from "../../src/server/routes-m4.js";
import { renderRoutes } from "../../src/server/routes-render.js";
import { A2A_ID, CONFIG, renderLedger, renderNet } from "../render/support.js";
import { LEGACY } from "../support/ledger.js";
import { BASE, GATEWAY_ID, NOW, at, bodyOf, gatewayKeys, list, text } from "./support.js";

let url = "";
let close: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const net = renderNet();
  const ledger = renderLedger();
  const facts = new FactsStore();
  const resolver = new VectorResolver(ledger.chain, ledger.settings, { fetchedFacts: facts.provider, log: () => undefined });
  const scheduler = new FetchScheduler(resolver, facts, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId }, { log: () => undefined });
  await scheduler.scan();
  await scheduler.idle();
  const keys = gatewayKeys();
  const m4 = createM4Services({
    settings: { baseUrl: CONFIG.baseUrl, gatewayId: GATEWAY_ID, trustDomain: new URL(CONFIG.baseUrl).hostname, delegation: null, statusListRefreshMs: 60_000 },
    keys,
    records: resolver,
    chain: ledger.chain,
    now: () => NOW,
  });
  const server = createResolverServer(resolver, {
    routes: [
      renderRoutes({ records: resolver, facts, snapshot: () => scheduler.snapshot, settings: ledger.settings, config: CONFIG, signer: m4.context.keys.ed25519 }),
      m4Routes(m4),
    ],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server has no TCP address");
  url = `http://127.0.0.1:${address.port}`;
  close = async () => {
    server.close();
    await once(server, "close");
  };
});

afterAll(() => close());

describe("renderings and M4 services in one gateway", () => {
  test("an agent card is signed with the M4 Ed25519 key, which the M4 JWK set publishes under the card's kid", async () => {
    const res = await fetch(`${url}/agents/${A2A_ID}/agent-card.json`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const { signatures, ...card } = body;
    const signature = list(signatures)[0];
    const header: unknown = JSON.parse(Buffer.from(text(at(signature, "protected")), "base64url").toString("utf8"));
    expect(header).toEqual({ alg: "EdDSA", typ: "JOSE", kid: gatewayKeys().ed25519.kid, jku: `${BASE}/.well-known/jwks.json` });

    const jwks = await bodyOf(await fetch(`${url}/.well-known/jwks.json`));
    const jwk = list(jwks.keys).find((k) => at(k, "kid") === at(header, "kid"));
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: text(at(jwk, "x")) }, format: "jwk" });
    const signingInput = `${text(at(signature, "protected"))}.${Buffer.from(canonicalize(card)).toString("base64url")}`;
    expect(verify(null, Buffer.from(signingInput), publicKey, Buffer.from(text(at(signature, "signature")), "base64url"))).toBe(true);
  });

  test("the AI Catalog names the gateway's DID as host; M4 and rendering paths both answer", async () => {
    const catalog = await (await fetch(`${url}/.well-known/ai-catalog.json`)).text();
    expect(catalog).toContain(`did:vector:${GATEWAY_ID}`);
    expect((await fetch(`${url}/.well-known/oauth-authorization-server`)).status).toBe(200);
    expect((await fetch(`${url}/policy`)).status).toBe(200);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
});
