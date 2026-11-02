import type { Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalize } from "../src/resolve/jcs.js";
import { createResolverServer } from "../src/server/http.js";
import { negotiate } from "../src/server/accept.js";
import { LEGACY_OWNER, LedgerBuilder, identityDatum, idOf, legacyDatum, timeAt } from "./support/ledger.js";
import { didOf, legacyDidOf, resolverFor, tombstoneOf } from "./support/resolve.js";

const ID = idOf("http");
const DID = didOf(ID);

let server: Server | null = null;
const logs: string[] = [];

async function start(builder: LedgerBuilder): Promise<string> {
  server = createResolverServer(resolverFor(builder, logs), { log: (m) => logs.push(m) });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = null;
  logs.length = 0;
});

function record(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(ID, identityDatum(), { height: 100 });
  return b;
}

const get = (base: string, path: string, accept?: string) => fetch(`${base}${path}`, accept === undefined ? {} : { headers: { accept } });
/** The parsed body; JSON.parse gives `any`, so tests can read members of any result. */
const bodyOf = async (res: Response) => JSON.parse(await res.text());

describe("GET /1.0/identifiers/{did}", () => {
  test("200: the JCS resolution result, Content-Type application/did-resolution, Cache-Control no-store", async () => {
    const b = record();
    const base = await start(b);
    const res = await get(base, `/1.0/identifiers/${DID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/did-resolution");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(canonicalize(await resolverFor(b).resolveDid(DID)));
  });

  test("the path is percent-decoded once", async () => {
    const base = await start(record());
    expect((await get(base, `/1.0/identifiers/${encodeURIComponent(DID)}`)).status).toBe(200);
    const twice = await get(base, `/1.0/identifiers/${encodeURIComponent(encodeURIComponent(DID))}`);
    expect(twice.status).toBe(400);
    expect((await bodyOf(twice)).didResolutionMetadata.error.type).toBe("https://www.w3.org/ns/did#INVALID_DID");
    expect((await get(base, "/1.0/identifiers/%E0%A4%A")).status).toBe(400);
  });

  test("query parameters are resolution options", async () => {
    const base = await start(record());
    const expanded = await bodyOf(await get(base, `/1.0/identifiers/${DID}?expandRelativeUrls=true`));
    expect(expanded.didDocument.capabilityInvocation[0]).toMatch(/^did:vector:/);
    expect((await get(base, `/1.0/identifiers/${DID}?versionId=0&versionId=0`)).status).toBe(400);
    expect((await get(base, `/1.0/identifiers/${DID}?versionId=0&versionTime=2026-01-01T00:00:00Z`)).status).toBe(400);
    expect((await get(base, `/1.0/identifiers/${DID}?versionTime=2026-02-30T00:00:00Z`)).status).toBe(400);
    expect((await get(base, `/1.0/identifiers/${DID}?format=json`)).status).toBe(501);
    expect((await get(base, `/1.0/identifiers/${DID}?noCache=true`)).status).toBe(200);
  });

  test.each([
    ["application/did", "application/did"],
    ["application/did+json", "application/did"],
    ["application/did+ld+json", "application/did"],
    ["application/ld+json", "application/did"],
    ["application/json", "application/did"],
    ["*/*", "application/did-resolution"],
    ["application/did-resolution", "application/did-resolution"],
    ['application/ld+json;profile="https://w3id.org/did-resolution"', "application/did-resolution"],
    ["text/html;q=0.9, application/did;q=0.5", "application/did"],
    ["application/did;q=0.8, application/did-resolution;q=0.9", "application/did-resolution"],
    ["application/did-resolution;q=0.5, application/did;q=0.6", "application/did"],
    ["application/did;q=0.5, */*;q=0.5", "application/did-resolution"],
  ])("Accept %s gives %s", async (accept, contentType) => {
    const base = await start(record());
    const res = await get(base, `/1.0/identifiers/${DID}`, accept);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(contentType);
    const body = await bodyOf(res);
    if (contentType === "application/did") expect(body.id).toBe(DID);
    else expect(body.didDocument.id).toBe(DID);
  });

  test("406 when no supported media range is acceptable; the ledger is not read", async () => {
    const b = record();
    const base = await start(b);
    for (const accept of ["text/html", "application/did;q=0", "application/did-resolution;q=0, application/did;q=0.000"]) {
      const res = await get(base, `/1.0/identifiers/${DID}`, accept);
      expect(res.status, accept).toBe(406);
      expect(res.headers.get("content-type")).toBe("application/did-resolution");
      expect((await bodyOf(res)).didResolutionMetadata.error.type).toBe("https://www.w3.org/ns/did#REPRESENTATION_NOT_SUPPORTED");
    }
    expect(b.chain.calls).toEqual([]);
  });

  test("410 with the resolution result for a deactivated DID, also when the client asks for the document", async () => {
    const b = record();
    b.update(ID, tombstoneOf(identityDatum(), { type: "Retired", at: timeAt(300), successor: null }), { height: 300 });
    const base = await start(b);
    for (const accept of [undefined, "application/did"]) {
      const res = await get(base, `/1.0/identifiers/${DID}`, accept);
      expect(res.status).toBe(410);
      expect(res.headers.get("content-type")).toBe("application/did-resolution");
      const body = await bodyOf(res);
      expect(body.didDocument).toBeNull();
      expect(body.didDocumentMetadata.deactivated).toBe(true);
    }
    const before = await get(base, `/1.0/identifiers/${DID}?versionId=0`, "application/did");
    expect(before.status).toBe(410);
    expect((await bodyOf(before)).didDocument.id).toBe(DID);
  });

  test("error statuses: 404, 400, 501, 500", async () => {
    const b = new LedgerBuilder();
    b.legacyRegister(ID, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    const base = await start(b);
    expect((await get(base, `/1.0/identifiers/${didOf(idOf("none"))}`)).status).toBe(404);
    expect((await get(base, `/1.0/identifiers/did:vector:${ID.toUpperCase()}`)).status).toBe(400);
    expect((await get(base, "/1.0/identifiers/did:web:example.com")).status).toBe(501);
    expect((await get(base, `/1.0/identifiers/did:vector:testnet:${ID}`)).status).toBe(501);
    expect((await get(base, `/1.0/identifiers/${legacyDidOf(ID)}`)).status).toBe(200);
    b.chain.failing.add("tip");
    const failed = await get(base, `/1.0/identifiers/${legacyDidOf(ID)}`, "application/did");
    expect(failed.status).toBe(500);
    expect(failed.headers.get("content-type")).toBe("application/did-resolution");
    expect((await bodyOf(failed)).didResolutionMetadata.error.type).toBe("https://www.w3.org/ns/did#INTERNAL_ERROR");
    expect(logs.join("\n")).not.toContain(ID);
  });

  test("GET /healthz answers 200 without a ledger call; other paths and methods", async () => {
    const b = record();
    const base = await start(b);
    const health = await get(base, "/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(health)).toEqual({ status: "ok" });
    expect(b.chain.calls).toEqual([]);
    expect((await fetch(`${base}/1.0/identifiers/${DID}`, { method: "POST" })).status).toBe(405);
    expect((await get(base, "/1.0/other")).status).toBe(404);
    expect((await get(base, "/")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("negotiate (RFC 9110 Accept)", () => {
  test.each([
    [undefined, "result"],
    ["", "result"],
    ["*/*", "result"],
    ["application/*", "result"],
    ["application/did-resolution", "result"],
    ['application/ld+json; profile="https://w3id.org/did-resolution"', "result"],
    ['application/ld+json;profile="https://w3id.org/did-resolution https://www.w3.org/ns/did/v1.1"', "result"],
    ['application/ld+json;profile="https://example.org/other"', null],
    ["application/ld+json", "document"],
    ["APPLICATION/DID", "document"],
    ["application/did;q=1.0", "document"],
    ["application/did;q=0.001", "document"],
    ["application/did;q=0, */*", "result"],
    // q=0 on the most specific range makes that type not acceptable (RFC 9110 Section 12.5.1).
    ["application/did-resolution;q=0, */*", "document"],
    ["application/did-resolution;q=0, application/did;q=0, */*", null],
    ["*/*;q=0", null],
    ["application/did;q=1.5", null],
    ["application/did;q=abc", null],
    ["text/plain, image/png", null],
    ["application/did;q=0.4, application/json;q=0.6, application/did-resolution;q=0.5", "document"],
    ["application/did-resolution;q=0.6, application/did;q=0.6", "result"],
    ["garbage", null],
  ])("%s → %s", (accept, expected) => {
    expect(negotiate(accept)).toBe(expected);
  });
});
