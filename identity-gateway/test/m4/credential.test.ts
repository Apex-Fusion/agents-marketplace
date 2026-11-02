// GET /agents/{id}/credential (Part 2 Section 8.6): a VC 2.0 identity credential issued by the
// gateway's DID, secured as application/vc+jwt, with a credentialStatus entry for each purpose.

import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { LIST_SIZE } from "../../src/m4/status-lists.js";
import { formatTime } from "../../src/resolve/time.js";
import { CONTROLLER_2, LedgerBuilder, identityDatum, idOf, legacyDatum, timeAt } from "../support/ledger.js";
import { tombstoneOf } from "../support/resolve.js";
import { BASE, GATEWAY_ID, at, bodyOf, decodeJwt, gatewayKeys, startGateway, stopGateways, text, verifiedByGateway } from "./support.js";

afterEach(stopGateways);

const ROOT = idOf("m4 credential root");
const CHILD = idOf("m4 credential child");
const SUSPENDED = idOf("m4 credential suspended");
const REVOKED = idOf("m4 credential revoked");
const LEGACY = idOf("m4 credential legacy");

function ledger(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.legacyRegister(LEGACY, legacyDatum(), { height: 40 });
  b.adopt(LEGACY, identityDatum(), { height: 600 });
  b.register(ROOT, identityDatum(), { height: 100 });
  b.register(CHILD, identityDatum({ lineage: { type: "Subagent", parent: ROOT, parentEpoch: 0, depth: 1 }, endpoint: new Uint8Array(), controller: CONTROLLER_2 }), { height: 110 });
  b.register(SUSPENDED, identityDatum({ status: { type: "Suspended", holds: [{ by: { type: "ControllerSet" }, reason: 6, since: timeAt(900), until: timeAt(1100) }] } }), {
    height: 120,
  });
  b.register(REVOKED, identityDatum(), { height: 130 });
  b.update(REVOKED, tombstoneOf(identityDatum(), { type: "Retired", at: timeAt(300), successor: null }), { height: 300 });
  return b;
}

describe("GET /agents/{id}/credential", () => {
  test("a VC 2.0 credential by the gateway's DID with revocation and suspension entries", async () => {
    const b = ledger();
    const h = await startGateway(b);
    const res = await fetch(`${h.url}/agents/${ROOT}/credential`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vc+jwt");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const jwt = await res.text();
    expect(verifiedByGateway(jwt)).toBe(true);
    const { header, payload } = decodeJwt(jwt);
    expect(header).toEqual({ alg: "ES256", kid: gatewayKeys().p256.kid, typ: "vc+jwt", cty: "vc" });
    const index = (await h.resolver.listRecords()).entries.find((e) => e.vectorId === ROOT)!.statusListIndex!;
    const list = `${BASE}/status/bsl/0`;
    expect(payload).toEqual({
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiableCredential", "VectorAgentIdentityCredential"],
      issuer: `did:vector:${GATEWAY_ID}`,
      validFrom: formatTime(h.now),
      validUntil: formatTime(h.now + 86_400_000),
      credentialSubject: { id: `did:vector:${ROOT}`, created: formatTime(timeAt(100)), origin: "native" },
      credentialStatus: [
        { id: `${list}#${index}`, type: "BitstringStatusListEntry", statusPurpose: "revocation", statusListIndex: String(index), statusListCredential: list },
        {
          id: `${list}#${LIST_SIZE + index}`,
          type: "BitstringStatusListEntry",
          statusPurpose: "suspension",
          statusListIndex: String(LIST_SIZE + index),
          statusListCredential: list,
        },
      ],
    });

    // The entries point at the bits that the status list sets for this agent.
    const bsl = await (await fetch(`${h.url}/status/bsl/0`)).text();
    const bits = gunzipSync(Buffer.from(text(at(decodeJwt(bsl).payload, "credentialSubject", "encodedList")).slice(1), "base64url"));
    const bit = (i: number) => (bits[i >> 3]! >> (7 - (i & 7))) & 1;
    expect([bit(index), bit(LIST_SIZE + index)]).toEqual([0, 0]);
    const suspended = (await h.resolver.listRecords()).entries.find((e) => e.vectorId === SUSPENDED)!.statusListIndex!;
    expect([bit(suspended), bit(LIST_SIZE + suspended)]).toEqual([0, 1]);
  });

  test("a subagent names its parent; an adopted record keeps its legacy index and shows origin adopted", async () => {
    const h = await startGateway(ledger());
    const child = decodeJwt(await (await fetch(`${h.url}/agents/${CHILD}/credential`)).text()).payload;
    expect(child.credentialSubject).toEqual({ id: `did:vector:${CHILD}`, created: formatTime(timeAt(110)), origin: "native", parent: `did:vector:${ROOT}` });
    const adopted = decodeJwt(await (await fetch(`${h.url}/agents/${LEGACY}/credential`)).text()).payload;
    expect(adopted.credentialSubject).toEqual({ id: `did:vector:${LEGACY}`, created: formatTime(timeAt(40)), origin: "adopted" });
    const legacyIndex = (await h.resolver.listRecords()).entries.find((e) => e.vectorId === LEGACY)!.statusListIndex;
    expect(legacyIndex).toBe(0);
    expect(at(adopted, "credentialStatus", 0, "statusListIndex")).toBe("0");
  });

  test.each<[string, string, number, string]>([
    ["a suspended agent", SUSPENDED, 409, "agent_not_active"],
    ["a retired agent", REVOKED, 410, "deactivated"],
    ["an unknown identifier", idOf("m4 credential nobody"), 404, "not_found"],
  ])("%s", async (_name, vectorId, status, error) => {
    const h = await startGateway(ledger());
    const res = await fetch(`${h.url}/agents/${vectorId}/credential`);
    expect(res.status).toBe(status);
    expect((await bodyOf(res)).error).toBe(error);
  });

  test("only GET and HEAD; other paths under /agents are not M4 routes", async () => {
    const h = await startGateway(ledger());
    expect((await fetch(`${h.url}/agents/${ROOT}/credential`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${h.url}/agents/${ROOT.toUpperCase()}/credential`)).status).toBe(404);
    expect((await fetch(`${h.url}/agents/${ROOT}/did.json`)).status).toBe(404);
  });
});
