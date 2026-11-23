// What the renderings take from the parties and the attestations of an agent: the provider of the A2A card
// (the Provider party first, then the Accountable Party) and the Trust Manifests of the AI Catalog entry.

import { afterAll, beforeAll, expect, test } from "vitest";
import type { VectorAttestation } from "../../src/resolve/metadata.js";
import { catalogIdentifier } from "../../src/render/agent.js";
import { KEY_B, identityDatum, idOf, keySigner, party, utf8 } from "../support/ledger.js";
import { A2A_CARD, A2A_ID, BASE, renderLedger, renderNet, startGateway, type Gateway } from "./support.js";

const PROVIDER_ID = idOf("render provider agent");
const DIGEST = "cd".repeat(32);
const software: VectorAttestation = {
  id: "ab".repeat(32),
  type: "software",
  issuer: `did:vector:${idOf("attestation issuer")}`,
  issuedAt: "2026-11-25T11:00:00Z",
  solicited: true,
  digest: DIGEST,
  locator: "https://attestations.example.org/build/1.json",
};

let gw: Gateway;
beforeAll(async () => {
  const ledger = renderLedger();
  // The Accountable Party and the Provider both have a verified organisation. The old rule chose the Accountable Party.
  ledger.register(
    PROVIDER_ID,
    identityDatum({
      name: utf8("Provider agent"),
      endpoint: utf8("https://a2a.provider.example.org/rpc"),
      parties: [party({ organisation: utf8("acme.example.org") }), party({ role: "Provider", signer: keySigner(KEY_B), rights: 0, organisation: utf8("provider.example.org") })],
    }),
    { height: 170 },
  );
  const net = renderNet();
  net.host("a2a.provider.example.org");
  net.json("https://a2a.provider.example.org/.well-known/agent-card.json", {
    ...A2A_CARD,
    supportedInterfaces: [{ url: "https://a2a.provider.example.org/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  });
  net.txtRecords.set("_did.acme.example.org", [[`did:vector:${A2A_ID}`], [`did:vector:${PROVIDER_ID}`]]);
  net.txtRecords.set("_did.provider.example.org", [[`did:vector:${PROVIDER_ID}`]]);
  // The agent has a software attestation with a locator, one without a locator and an environment attestation.
  const attestations = [software, { ...software, id: "ac".repeat(32), locator: undefined }, { ...software, id: "ad".repeat(32), type: "environment" as const }];
  gw = await startGateway({ ledger, net, provenance: { provenance: (id) => (id === PROVIDER_ID ? { attestations } : undefined) } });
});
afterAll(async () => {
  await gw.close();
});

test("the card names the verified organisation of the Provider; the catalog entry has one unsigned Trust Manifest for the software attestation with a locator", async () => {
  const card = await (await gw.get(`/agents/${PROVIDER_ID}/agent-card.json`)).json();
  expect(card).toMatchObject({ provider: { organization: "provider.example.org", url: "https://provider.example.org" } });

  const catalog: { entries: Array<{ identifier: string; trustManifests?: unknown }> } = JSON.parse(await (await gw.get("/.well-known/ai-catalog.json")).text());
  const trustManifests = (id: string) => catalog.entries.find((e) => e.identifier === catalogIdentifier(BASE, id))?.trustManifests;
  expect(trustManifests(PROVIDER_ID)).toEqual([{ contributor: software.issuer, attestations: [{ type: "software", uri: software.locator, digest: `sha256:${DIGEST}` }] }]);
  expect(catalog.entries.find((e) => e.identifier === catalogIdentifier(BASE, A2A_ID))).toBeDefined();
  expect(trustManifests(A2A_ID)).toBeUndefined();
});
