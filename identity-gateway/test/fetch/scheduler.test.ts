// The background jobs (Part 2 Section 8.5): checks only for Active records, never during a request,
// daily and after each record change; their results reach the resolver through the facts provider.

import { describe, expect, test } from "vitest";
import { FactsStore, factInputs } from "../../src/fetch/facts.js";
import { FetchScheduler, type RecordSource } from "../../src/fetch/scheduler.js";
import { PassFailed, VectorResolver } from "../../src/resolve/resolver.js";
import { formatTime } from "../../src/resolve/time.js";
import {
  CONTROLLER,
  LEGACY,
  LedgerBuilder,
  PARTY_KEY,
  identityDatum,
  idOf,
  keySigner,
  party,
  timeAt,
  utf8,
} from "../support/ledger.js";
import { tombstoneOf } from "../support/resolve.js";
import { FakeNet, TestClock, type Handler } from "./support.js";

const ID = idOf("scheduled agent");
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

function setup() {
  const net = new FakeNet().host("agent.example.org").host("acme.example.org");
  net.json("https://agent.example.org/.well-known/agent-card.json", CARD);
  net.txtRecords.set("_did.acme.example.org", [[DID]]);
  const b = new LedgerBuilder();
  b.register(ID, identityDatum({ endpoint: utf8("https://agent.example.org/a2a"), parties: [party({ organisation: utf8("acme.example.org") })] }), { height: 100 });
  const store = new FactsStore();
  const resolver = new VectorResolver(b.chain, b.settings, { fetchedFacts: store.provider, log: () => undefined });
  const logs: string[] = [];
  const scheduler = new FetchScheduler(resolver, store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId }, { log: (m) => logs.push(m) });
  return { net, b, store, resolver, scheduler, logs };
}

describe("background checks", () => {
  test("a scan checks an Active record; the facts reach the resolution result; a resolution never fetches", async () => {
    const { net, store, resolver, scheduler } = setup();
    const before = await resolver.resolveDid(DID);
    expect(before.didDocument?.alsoKnownAs).toBeUndefined();
    expect(before.didDocumentMetadata.vectorProfile?.protocol).toBeUndefined();

    expect(await scheduler.scan()).toEqual({ records: 1, started: [ID] });
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ detection: { protocol: "a2a" }, domains: [{ domain: "agent.example.org", verified: false }, { domain: "acme.example.org", verified: true, method: "dnsTxt" }] });

    const calls = net.calls.length;
    const lookups = net.lookups.length + net.txtLookups.length;
    const result = await resolver.resolveDid(DID);
    expect(net.calls.length).toBe(calls);
    expect(net.lookups.length + net.txtLookups.length).toBe(lookups);
    expect(result.didDocument?.alsoKnownAs).toEqual(["https://acme.example.org"]);
    expect(result.didDocumentMetadata.vectorParties?.[0]).toMatchObject({ organisation: "acme.example.org", organisationVerified: true });
    expect(result.didDocumentMetadata.vectorProfile?.protocol).toBe("a2a");
    expect(result.didDocumentMetadata.vectorFetched).toEqual([
      store.get(ID)!.detection!.fetched,
      { url: "dns:_did.acme.example.org?type=TXT", fetchedAt: formatTime(store.get(ID)!.domains[1]!.checkedAt), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  test("checks run again after a day, not before", async () => {
    const { net, scheduler } = setup();
    await scheduler.scan();
    await scheduler.idle();
    net.clock.t += 3_600_000;
    expect((await scheduler.scan()).started).toEqual([]);
    net.clock.t += 86_400_000;
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
  });

  test("a record change starts a check at the next scan; until then a fact for the old endpoint no longer applies", async () => {
    const { net, b, store, resolver, scheduler } = setup();
    await scheduler.scan();
    await scheduler.idle();
    b.update(ID, identityDatum({ endpoint: utf8("https://moved.example.org/a2a"), parties: [party({ organisation: utf8("acme.example.org") })] }), { height: 950 });
    b.tip(1001);
    const lookup = await resolver.currentRecord(ID);
    if (!lookup.found) throw new Error("not found");
    const current = store.current(ID, factInputs(lookup.record, LEGACY.policyId));
    expect(current.detection).toBeNull();
    expect(current.verifiedOrganisations).toEqual(["acme.example.org"]);
    net.host("moved.example.org");
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
    expect(store.get(ID)?.detection).toMatchObject({ endpoint: "https://moved.example.org/a2a", protocol: null });
  });

  test("only Active records are checked", async () => {
    const net = new FakeNet().host("agent.example.org");
    const b = new LedgerBuilder();
    const held = idOf("held");
    const revoked = idOf("revoked");
    b.register(held, identityDatum({ status: { type: "Suspended", holds: [{ by: keySigner(PARTY_KEY), reason: 6, since: timeAt(100), until: timeAt(5000) }] } }), { height: 100 });
    b.register(revoked, identityDatum(), { height: 100, txIndex: 1 });
    b.update(revoked, tombstoneOf(identityDatum(), { type: "Revoked", by: { type: "ControllerSet" }, reason: 5, at: timeAt(200), invalidFrom: null, successor: null }), { height: 200 });
    const store = new FactsStore();
    const scheduler = new FetchScheduler(new VectorResolver(b.chain, b.settings), store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId });
    expect(await scheduler.scan()).toEqual({ records: 2, started: [] });
    expect(net.lookups).toEqual([]);
  });

  test("a scan is one pass over the records: one tip read, every record as of it", async () => {
    const { b, scheduler } = setup();
    b.register(idOf("second scheduled agent"), identityDatum(), { height: 110 });
    expect((await scheduler.scan()).records).toBe(2);
    await scheduler.idle();
    expect(b.chain.calls.filter((c) => c === "tip")).toHaveLength(1);
  });

  test("when the pass fails, the scan fails and the records of the last scan stay", async () => {
    const { b, scheduler, logs } = setup();
    await scheduler.scan();
    await scheduler.idle();
    const last = scheduler.snapshot;
    expect(last.records.map((r) => r.vectorId)).toEqual([ID]);
    b.chain.failing.add("assetHolders");
    await expect(scheduler.scan()).rejects.toBeInstanceOf(PassFailed);
    expect(scheduler.snapshot).toBe(last);
    expect(logs).toEqual([]);
  });

  test("a record that the scan cannot read is logged without its DID; the others are checked", async () => {
    const { resolver, store, net, logs } = setup();
    const other = idOf("unreadable");
    const source: RecordSource = {
      listRecords: async () => {
        const list = await resolver.listRecords();
        return { ...list, entries: [...list.entries, { ...list.entries[0]!, vectorId: other }] };
      },
      currentRecord: async (id) => {
        if (id === other) throw new Error("Koios tx_info answered HTTP 503");
        return resolver.currentRecord(id);
      },
    };
    const scheduler = new FetchScheduler(source, store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId }, { log: (m) => logs.push(m) });
    expect(await scheduler.scan()).toEqual({ records: 1, started: [ID] });
    await scheduler.idle();
    expect(logs).toEqual(["identity-gateway: background scan could not read a record: Koios tx_info answered HTTP 503"]);
    expect(logs.join()).not.toContain(other);
  });

  test("start() scans at once and then after each interval; stop() ends the loop", async () => {
    const { b, store, net } = setup();
    const waits: Array<() => void> = [];
    const clock = new TestClock();
    clock.sleep = (ms) => {
      clock.sleeps.push(ms);
      return new Promise<void>((resolve) => waits.push(resolve));
    };
    let scans = 0;
    const resolver = new VectorResolver(b.chain, b.settings);
    const source: RecordSource = {
      listRecords: () => {
        scans++;
        return resolver.listRecords();
      },
      currentRecord: (id) => resolver.currentRecord(id),
    };
    const scheduler = new FetchScheduler(source, store, { fetcher: net.fetcher(), txt: net.txt, clock, legacyPolicyId: LEGACY.policyId }, { scanIntervalMs: 120_000 });
    scheduler.start();
    await expect.poll(() => clock.sleeps.includes(120_000)).toBe(true);
    expect(scans).toBe(1);
    waits.shift()!();
    // Wait until the second scan has ended and the loop sleeps again, then stop it.
    await expect.poll(() => clock.sleeps.length).toBe(2);
    expect(scans).toBe(2);
    const stopped = scheduler.stop();
    waits.shift()!();
    await stopped;
    expect(scans).toBe(2);
  });
});

test("the job's own handler sees the fetch rules: a check of an endpoint on a private address does not connect", async () => {
  const net = new FakeNet().host("internal.example.org", "10.0.0.7");
  const touched: Handler = () => ({ status: 200 });
  net.on("https://internal.example.org/.well-known/agent-card.json", touched);
  const b = new LedgerBuilder();
  b.register(ID, identityDatum({ controller: CONTROLLER, endpoint: utf8("https://internal.example.org/") }), { height: 100 });
  const store = new FactsStore();
  const scheduler = new FetchScheduler(new VectorResolver(b.chain, b.settings), store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId });
  await scheduler.scan();
  await scheduler.idle();
  expect(net.calls).toEqual([]);
  expect(store.get(ID)?.detection).toMatchObject({ protocol: null, failure: "the host resolves to an address that is not public unicast" });
});
