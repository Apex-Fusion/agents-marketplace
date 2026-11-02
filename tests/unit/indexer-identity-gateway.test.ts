/**
 * tests/unit/indexer-identity-gateway.test.ts — identity facts from the identity gateway.
 *
 * parseResolution is checked against the resolver's own test vectors
 * (identity-gateway/test/vectors/*.json: settings, ledger, requests with the
 * HTTP status and the JCS result), so the indexer reads what the gateway
 * really writes. The client is checked with a stubbed fetch, and the
 * refresher with a real SqliteCache and a scripted gateway.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createGatewayClient,
  parseResolution,
  RESOLUTION_MEDIA_TYPE,
  type GatewayOutcome,
} from "../../indexer/src/identity/gateway.js";
import { IdentityRefresher, RETRY_MS, SETTLE_MS } from "../../indexer/src/identity/refresher.js";
import { SqliteCache } from "../../indexer/src/db/cache.js";
import { INDEXER_SUPPLIER_PKH } from "../fixtures/indexer-side/sample-blocks.js";
import {
  AGENT_ID,
  IDENTITY_ADDRESS,
  OTHER_AGENT_ID,
  buildIdentityAdvertDatumHex,
  resolutionError,
  resolutionResult,
} from "../fixtures/indexer-side/identity-blocks.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── parseResolution against the resolver vectors ────────────────────────────

interface VectorRequest {
  did: string;
  options: Record<string, string>;
  httpStatus: number;
  result: unknown;
}

const VECTOR_DIR = fileURLToPath(new URL("../../identity-gateway/test/vectors/", import.meta.url));

/** Requests without options for a canonical DID: what the indexer sends. */
function canonicalRequests(): Array<{ file: string; agentId: string; request: VectorRequest }> {
  const out: Array<{ file: string; agentId: string; request: VectorRequest }> = [];
  for (const file of readdirSync(VECTOR_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const vector = JSON.parse(readFileSync(join(VECTOR_DIR, file), "utf8")) as { requests: VectorRequest[] };
    for (const request of vector.requests) {
      const match = /^did:vector:([0-9a-f]{64})$/.exec(request.did);
      if (match && Object.keys(request.options).length === 0) out.push({ file, agentId: match[1]!, request });
    }
  }
  return out;
}

function outcomeOf(file: string, nth = 0): { agentId: string; outcome: GatewayOutcome } {
  const entry = canonicalRequests().filter((r) => r.file === file)[nth]!;
  return { agentId: entry.agentId, outcome: parseResolution(entry.agentId, entry.request.httpStatus, entry.request.result) };
}

describe("parseResolution — identity-gateway test vectors", () => {
  it("covers every canonical request without options in the vector files", () => {
    expect(canonicalRequests().length).toBeGreaterThanOrEqual(12);
  });

  it("root agent: active, independent, native; the Ed25519 transaction key and the capabilities", () => {
    const { outcome } = outcomeOf("root-agent.json");
    expect(outcome).toEqual({
      kind: "found",
      identity: {
        effective: "active",
        independent: true,
        origin: "native",
        transactionKeys: ["8a95c8ed588306ea88860b54eb0c65e77dfab999789cc5e6ca008799"],
        capabilities: ["ocr.extract.v1", "llm.text.generate.v1"],
      },
    });
  });

  it("subagent: the child has a vectorParent, so it is not independent", () => {
    const outcomes = canonicalRequests()
      .filter((r) => r.file === "subagent.json")
      .map((r) => parseResolution(r.agentId, r.request.httpStatus, r.request.result));
    const independence = outcomes.map((o) => (o.kind === "found" ? o.identity.independent : null)).sort();
    expect(independence).toEqual([false, true]);
  });

  it.each([
    ["suspended-two-authors.json", "suspended"],
    ["unaccountable.json", "suspended"],
    ["pending-versions.json", "suspended"],
    ["adopted.json", "active"],
  ])("%s: effective status %s", (file, effective) => {
    const { outcome } = outcomeOf(file);
    expect(outcome.kind).toBe("found");
    if (outcome.kind === "found") expect(outcome.identity.effective).toBe(effective);
  });

  it("adopted record: origin adopted", () => {
    const { outcome } = outcomeOf("adopted.json");
    expect(outcome.kind === "found" && outcome.identity.origin).toBe("adopted");
  });

  it("legacy record before the cutoff: origin legacy and no transaction key", () => {
    const { outcome } = outcomeOf("legacy-before-cutoff.json");
    expect(outcome).toMatchObject({ kind: "found", identity: { origin: "legacy", effective: "active", transactionKeys: [] } });
  });

  it.each(["revoked-invalid-from.json", "retired-successor.json"])("%s: HTTP 410 deactivated is a definitive answer", (file) => {
    expect(outcomeOf(file).outcome).toEqual({ kind: "absent", detail: "deactivated" });
  });

  it("legacy id minted after the cutoff: HTTP 404 NOT_FOUND is a definitive answer", () => {
    const notFound = canonicalRequests().find((r) => r.file === "legacy-after-cutoff.json" && r.request.httpStatus === 404)!;
    expect(parseResolution(notFound.agentId, 404, notFound.request.result)).toEqual({ kind: "absent", detail: "NOT_FOUND" });
  });
});

describe("parseResolution — answers that do not count", () => {
  it("a result for another DID is unavailable", () => {
    expect(parseResolution(AGENT_ID, 200, resolutionResult(OTHER_AGENT_ID)).kind).toBe("unavailable");
  });

  it("a 404 page without a DID Resolution error (wrong URL) is unavailable, not absent", () => {
    expect(parseResolution(AGENT_ID, 404, null)).toEqual({ kind: "unavailable", error: "HTTP 404" });
  });

  it("INTERNAL_ERROR (500) is unavailable", () => {
    expect(parseResolution(AGENT_ID, 500, resolutionError("INTERNAL_ERROR"))).toMatchObject({ kind: "unavailable" });
  });

  it("a P-256 key never counts for the transaction purpose", () => {
    const result = resolutionResult(AGENT_ID, {
      keys: [{ keyHash: INDEXER_SUPPLIER_PKH, type: "P-256", purposes: ["authentication", "transaction"] }],
    });
    const outcome = parseResolution(AGENT_ID, 200, result);
    expect(outcome.kind === "found" && outcome.identity.transactionKeys).toEqual([]);
  });

  it("an empty capability list is left out by the gateway and reads as no capability", () => {
    const outcome = parseResolution(AGENT_ID, 200, resolutionResult(AGENT_ID, { capabilities: [] }));
    expect(outcome.kind === "found" && outcome.identity.capabilities).toEqual([]);
  });
});

// ─── HTTP client ──────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/did-resolution" } });
}

describe("createGatewayClient", () => {
  it("asks GET /1.0/identifiers/did:vector:<id> with Accept: application/did-resolution", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, resolutionResult(AGENT_ID)));
    const resolve = createGatewayClient({ baseUrl: "http://identity-gateway:8080/", fetch });
    const outcome = await resolve(AGENT_ID);
    expect(outcome.kind).toBe("found");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://identity-gateway:8080/1.0/identifiers/did%3Avector%3A${AGENT_ID}`);
    expect((init.headers as Record<string, string>).accept).toBe(RESOLUTION_MEDIA_TYPE);
  });

  it("a network error is unavailable", async () => {
    const resolve = createGatewayClient({ baseUrl: "http://gw", fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) });
    expect(await resolve(AGENT_ID)).toEqual({ kind: "unavailable", error: "ECONNREFUSED" });
  });

  it("a 200 body that is not JSON is unavailable", async () => {
    const resolve = createGatewayClient({ baseUrl: "http://gw", fetch: vi.fn(async () => new Response("<html>", { status: 200 })) });
    expect(await resolve(AGENT_ID)).toEqual({ kind: "unavailable", error: "response body is not JSON" });
  });

  it("a 410 answer is absent", async () => {
    const body = { didDocument: null, didDocumentMetadata: { deactivated: true }, didResolutionMetadata: {} };
    const resolve = createGatewayClient({ baseUrl: "http://gw", fetch: vi.fn(async () => jsonResponse(410, body)) });
    expect(await resolve(AGENT_ID)).toEqual({ kind: "absent", detail: "deactivated" });
  });
});

// ─── Refresher ────────────────────────────────────────────────────────────────

const NOW0 = 1_800_000_000_000;

function cacheWithAdvert(clock: { now: number }): SqliteCache {
  const cache = new SqliteCache(":memory:", { listing: { identityAddress: IDENTITY_ADDRESS, now: () => clock.now } });
  cache.insertUtxo(`${"f1".repeat(32)}#0`, IDENTITY_ADDRESS, "d87980", 10, "f1".repeat(32), AGENT_ID);
  cache.upsertAdvertisement({
    utxo_ref: `${"a1".repeat(32)}#0`,
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "https://agent.example",
    detail_uri: "ipfs://x",
    detail_hash: "b".repeat(64),
    advertised_at: 1,
    status: "Active",
    created_slot: 11,
    datum_hex: buildIdentityAdvertDatumHex(),
    rolled_back: 0,
    layout: "identity",
    agent_id: AGENT_ID,
    creator_signed: 1,
  });
  return cache;
}

function scriptedGateway(outcomes: GatewayOutcome[]) {
  return vi.fn(async (): Promise<GatewayOutcome> => outcomes.shift() ?? { kind: "unavailable", error: "script ended" });
}

const FOUND: GatewayOutcome = {
  kind: "found",
  identity: { effective: "active", independent: true, origin: "native", transactionKeys: [INDEXER_SUPPLIER_PKH], capabilities: ["llm.text.generate.v1"] },
};

function storeFactsAt(cache: SqliteCache, at: number): void {
  cache.saveIdentityFacts({
    agent_id: AGENT_ID, found: 1, effective: "active", independent: 1, origin: "native",
    transaction_keys: JSON.stringify([INDEXER_SUPPLIER_PKH]), capabilities: JSON.stringify(["llm.text.generate.v1"]),
    detail: null, resolved_at: at,
  });
}

describe("IdentityRefresher", () => {
  it("resolves the agent of a new advert, stores the answer, and lists the advert", async () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    const resolve = scriptedGateway([FOUND]);
    const refresher = new IdentityRefresher({ cache, resolve, now: () => clock.now, log: () => {} });
    expect(cache.listActiveAdvertisements()).toEqual([]);
    await refresher.tickOnce();
    expect(resolve).toHaveBeenCalledWith(AGENT_ID);
    expect(cache.getIdentityFacts([AGENT_ID]).get(AGENT_ID)).toMatchObject({ found: 1, effective: "active", resolved_at: NOW0 });
    expect(cache.listActiveAdvertisements().map((a) => a.agent_id)).toEqual([AGENT_ID]);
    cache.close();
  });

  it("keeps the answer until refreshMs, then asks again", async () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    const resolve = scriptedGateway([FOUND, FOUND]);
    const refresher = new IdentityRefresher({ cache, resolve, refreshMs: 60_000, now: () => clock.now, log: () => {} });
    await refresher.tickOnce();
    clock.now += 59_000;
    await refresher.tickOnce();
    expect(resolve).toHaveBeenCalledTimes(1);
    clock.now += 1_000;
    await refresher.tickOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
    cache.close();
  });

  it("a record change unlists at once and asks again after the settle delay", async () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    const resolve = scriptedGateway([FOUND, FOUND]);
    const refresher = new IdentityRefresher({ cache, resolve, now: () => clock.now, log: () => {} });
    await refresher.tickOnce();
    clock.now += 1_000;
    // What the worker does when it sees an output at the identity address:
    cache.invalidateIdentityFacts([AGENT_ID], clock.now);
    refresher.invalidate([AGENT_ID]);
    expect(cache.listActiveAdvertisements()).toEqual([]);
    await refresher.tickOnce();
    expect(resolve).toHaveBeenCalledTimes(1);
    clock.now += SETTLE_MS;
    await refresher.tickOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(cache.listActiveAdvertisements()).toHaveLength(1);
    cache.close();
  });

  it("a record change during a request keeps the entry invalidated and its settle re-check", async () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    let refresher: IdentityRefresher;
    const resolve = vi.fn(async (): Promise<GatewayOutcome> => {
      clock.now += 1_000; // the follower sees a record change while the request runs
      cache.invalidateIdentityFacts([AGENT_ID], clock.now);
      refresher.invalidate([AGENT_ID]);
      return FOUND;
    });
    refresher = new IdentityRefresher({ cache, resolve, now: () => clock.now, log: () => {} });
    storeFactsAt(cache, NOW0 - 120_000); // an old answer: the agent is due
    await refresher.tickOnce();
    expect(cache.getIdentityFacts([AGENT_ID]).get(AGENT_ID)!.invalidated_at).toBe(NOW0 + 1_000);
    expect(cache.listActiveAdvertisements()).toEqual([]);
    await refresher.tickOnce();
    expect(resolve).toHaveBeenCalledTimes(1);
    clock.now += SETTLE_MS;
    resolve.mockImplementation(async () => FOUND);
    await refresher.tickOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(cache.listActiveAdvertisements()).toHaveLength(1);
    cache.close();
  });

  it("an answer whose request started before the record change keeps the entry invalidated", () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    cache.invalidateIdentityFacts([AGENT_ID], NOW0); // no row yet: nothing to mark
    storeFactsAt(cache, NOW0);
    expect(cache.getIdentityFacts([AGENT_ID]).get(AGENT_ID)!.invalidated_at).toBeNull();
    cache.invalidateIdentityFacts([AGENT_ID], NOW0 + 500);
    storeFactsAt(cache, NOW0 + 100);
    expect(cache.getIdentityFacts([AGENT_ID]).get(AGENT_ID)!.invalidated_at).toBe(NOW0 + 500);
    storeFactsAt(cache, NOW0 + 600);
    expect(cache.getIdentityFacts([AGENT_ID]).get(AGENT_ID)!.invalidated_at).toBeNull();
    cache.close();
  });

  it("gateway unreachable: keeps the last answer for 10 minutes, then unlists and logs once", async () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    const logs: Array<[string, string]> = [];
    const resolve = scriptedGateway([FOUND]);
    const refresher = new IdentityRefresher({
      cache, resolve, refreshMs: 60_000, now: () => clock.now, log: (level, message) => logs.push([level, message]),
    });
    await refresher.tickOnce();

    clock.now = NOW0 + 60_000; // due; the gateway fails from now on
    await refresher.tickOnce();
    expect(cache.listActiveAdvertisements()).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toContain("counts until");

    clock.now = NOW0 + 600_000; // exactly 10 minutes: still listed
    expect(cache.listActiveAdvertisements()).toHaveLength(1);
    await refresher.tickOnce();
    expect(logs).toHaveLength(1);

    clock.now = NOW0 + 600_001 + RETRY_MS;
    expect(cache.listActiveAdvertisements()).toEqual([]);
    await refresher.tickOnce();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toEqual(["warn", expect.stringContaining("older than 10 minutes")]);

    clock.now += RETRY_MS;
    await refresher.tickOnce();
    expect(logs).toHaveLength(2); // logged once per outage
    cache.close();
  });

  it("logs when the gateway answers again and lists the advert again", async () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    const logs: string[] = [];
    const resolve = scriptedGateway([{ kind: "unavailable", error: "down" }, FOUND]);
    const refresher = new IdentityRefresher({ cache, resolve, now: () => clock.now, log: (_l, m) => logs.push(m) });
    await refresher.tickOnce();
    expect(logs[0]).toContain("its adverts are not listed until it answers");
    expect(cache.listActiveAdvertisements()).toEqual([]);
    clock.now += RETRY_MS;
    await refresher.tickOnce();
    expect(logs[1]).toContain("answers again");
    expect(cache.listActiveAdvertisements()).toHaveLength(1);
    cache.close();
  });

  it("a definitive negative answer is stored and does not list", async () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    const refresher = new IdentityRefresher({
      cache, resolve: scriptedGateway([{ kind: "absent", detail: "NOT_FOUND" }]), now: () => clock.now, log: () => {},
    });
    await refresher.tickOnce();
    expect(cache.getIdentityFacts([AGENT_ID]).get(AGENT_ID)).toMatchObject({ found: 0, detail: "NOT_FOUND" });
    expect(cache.listActiveAdvertisements()).toEqual([]);
    cache.close();
  });

  it("does not ask about an agent without a live record output at the identity address", async () => {
    const clock = { now: NOW0 };
    const cache = cacheWithAdvert(clock);
    cache.spendUtxo(`${"f1".repeat(32)}#0`, 12, "f9".repeat(32));
    const resolve = scriptedGateway([FOUND]);
    await new IdentityRefresher({ cache, resolve, now: () => clock.now, log: () => {} }).tickOnce();
    expect(resolve).not.toHaveBeenCalled();
    cache.close();
  });
});
