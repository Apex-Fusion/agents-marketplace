// What the renderings take from the parties of an agent: the provider of the A2A card (the Provider party
// first, then the Accountable Party).

import { afterAll, beforeAll, expect, test } from "vitest";
import { KEY_B, identityDatum, idOf, keySigner, party, utf8 } from "../support/ledger.js";
import { A2A_CARD, A2A_ID, renderLedger, renderNet, startGateway, type Gateway } from "./support.js";

const PROVIDER_ID = idOf("render provider agent");

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
  gw = await startGateway({ ledger, net });
});
afterAll(async () => {
  await gw.close();
});

test("the card names the verified organisation of the Provider", async () => {
  const card = await (await gw.get(`/agents/${PROVIDER_ID}/agent-card.json`)).json();
  expect(card).toMatchObject({ provider: { organization: "provider.example.org", url: "https://provider.example.org" } });
});
