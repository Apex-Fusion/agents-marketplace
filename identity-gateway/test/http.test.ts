import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalize } from "../src/resolve/jcs.js";
import { DidVectorResolver } from "../src/resolve/resolver.js";
import { createResolverServer, negotiate, type Resolver } from "../src/server/http.js";
import { ASSET, CANONICAL_DID, FakeChain, LEGACY_DID, OWNER_KEY, OWNER_MULTIKEY, realMint } from "./fixtures.js";

let server: Server | null = null;
const logs: string[] = [];

async function start(resolver: Resolver): Promise<string> {
  server = createResolverServer(resolver, (m) => logs.push(m));
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = null;
  logs.length = 0;
});

const get = (base: string, did: string, accept?: string) =>
  fetch(`${base}/1.0/identifiers/${did}`, accept ? { headers: { accept } } : {});

describe("GET /1.0/identifiers/{did}", () => {
  test("200 with the JCS resolution result", async () => {
    const chain = FakeChain.history([realMint()]);
    const base = await start(new DidVectorResolver(chain));
    const res = await get(base, LEGACY_DID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/did-resolution");
    const body = await res.text();
    expect(body).toBe(canonicalize(await new DidVectorResolver(chain).resolve(LEGACY_DID)));
    expect(JSON.parse(body).didDocument.verificationMethod[0].publicKeyMultibase).toBe(OWNER_MULTIKEY);
  });

  test("percent-encoded DIDs resolve the same way", async () => {
    const base = await start(new DidVectorResolver(FakeChain.history([realMint()])));
    const res = await get(base, encodeURIComponent(CANONICAL_DID));
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).didDocument.id).toBe(CANONICAL_DID);
  });

  test("Accept: application/did returns the DID document only", async () => {
    const base = await start(new DidVectorResolver(FakeChain.history([realMint()])));
    const res = await get(base, LEGACY_DID, "application/did");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/did");
    const doc = JSON.parse(await res.text());
    expect(doc.id).toBe(LEGACY_DID);
    expect(doc.didDocumentMetadata).toBeUndefined();
  });

  test("410 for a burned token", async () => {
    const base = await start(new DidVectorResolver(FakeChain.history([realMint(), { kind: "burn", height: 4_900_000, witnesses: [OWNER_KEY] }])));
    const res = await get(base, LEGACY_DID);
    expect(res.status).toBe(410);
    expect(JSON.parse(await res.text()).didDocumentMetadata.deactivated).toBe(true);
    const doc = await get(base, LEGACY_DID, "application/did");
    expect(doc.status).toBe(410);
    expect(JSON.parse(await doc.text())).toEqual({ "@context": expect.any(Array), id: LEGACY_DID });
  });

  test("404 for a DID that was never minted", async () => {
    const base = await start(new DidVectorResolver(new FakeChain()));
    const res = await get(base, `did:vector:${"ab".repeat(32)}`);
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text()).didResolutionMetadata.error.type).toBe("https://www.w3.org/ns/did#NOT_FOUND");
  });

  test("400 for malformed and uppercase DIDs", async () => {
    const base = await start(new DidVectorResolver(new FakeChain()));
    for (const did of [`did:vector:${ASSET.toUpperCase()}`, "did:vector:xyz", "", "%E0%A4%A"]) {
      const res = await get(base, did);
      expect(res.status, did).toBe(400);
      expect(JSON.parse(await res.text()).didResolutionMetadata.error.type).toBe("https://www.w3.org/ns/did#INVALID_DID");
    }
  });

  test("501 for resolution options", async () => {
    const base = await start(new DidVectorResolver(FakeChain.history([realMint()])));
    expect((await get(base, `${LEGACY_DID}?versionTime=2026-01-01T00:00:00Z`)).status).toBe(501);
  });

  test("500 INTERNAL_ERROR when the chain source fails, with the cause logged", async () => {
    const chain = FakeChain.history([realMint()]);
    chain.tip = async () => {
      throw new Error("Koios GET tip answered HTTP 503");
    };
    const base = await start(new DidVectorResolver(chain));
    const res = await get(base, LEGACY_DID);
    expect(res.status).toBe(500);
    expect(JSON.parse(await res.text()).didResolutionMetadata.error.type).toBe("https://www.w3.org/ns/did#INTERNAL_ERROR");
    expect(logs.join("\n")).toContain("HTTP 503");
  });

  test("406 for an unsupported representation; 405 and 404 outside the binding", async () => {
    const base = await start(new DidVectorResolver(FakeChain.history([realMint()])));
    expect((await get(base, LEGACY_DID, "text/html")).status).toBe(406);
    expect((await fetch(`${base}/1.0/identifiers/${LEGACY_DID}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/health`)).status).toBe(404);
  });
});

describe("negotiate", () => {
  test("result by default, document for DID media types, null when nothing fits", () => {
    expect(negotiate(undefined)).toBe("result");
    expect(negotiate("*/*")).toBe("result");
    expect(negotiate('application/ld+json;profile="https://w3id.org/did-resolution"')).toBe("result");
    expect(negotiate("application/did+ld+json")).toBe("document");
    expect(negotiate("application/did;q=0, application/did-resolution")).toBe("result");
    expect(negotiate("text/html")).toBeNull();
  });
});
