// The background jobs (Part 2 Section 8.5): checks only for Active records, never during a request,
// daily (sooner after a check that found no protocol) and after each record change; their results reach the resolver through the facts provider.

import { describe, expect, test } from "vitest";
import { FactsStore, factInputs } from "../../src/fetch/facts.js";
import { DAY_MS, FetchScheduler, recheckDelayMs, type RecordSource } from "../../src/fetch/scheduler.js";
import { PassFailed, VectorResolver } from "../../src/resolve/resolver.js";
import { formatTime } from "../../src/resolve/time.js";
import {
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
import { FakeNet, TestClock } from "./support.js";

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
    const sleepers: Array<() => void> = [];
    /** Resolves when the loop starts its next sleep: a scan has ended. */
    const nextSleep = (): Promise<void> => new Promise<void>((resolve) => sleepers.push(resolve));
    const clock = new TestClock();
    clock.sleep = (ms) => {
      clock.sleeps.push(ms);
      for (const wake of sleepers.splice(0)) wake();
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
    let slept = nextSleep();
    scheduler.start();
    await slept;
    expect(clock.sleeps).toContain(120_000);
    expect(scans).toBe(1);
    slept = nextSleep();
    waits.shift()!();
    // The second scan has ended when the loop sleeps again; then stop it.
    await slept;
    expect(scans).toBe(2);
    const stopped = scheduler.stop();
    waits.shift()!();
    await stopped;
    expect(scans).toBe(2);
  });
});

describe("an endpoint that answers nothing at the first check", () => {
  /** An Active record whose host exists but serves no card, no MCP server and no page: every probe answers 404. */
  function silentHost() {
    const net = new FakeNet().host("agent.example.org");
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ endpoint: utf8("https://agent.example.org/a2a") }), { height: 100 });
    const store = new FactsStore();
    const resolver = new VectorResolver(b.chain, b.settings, { fetchedFacts: store.provider, log: () => undefined });
    const logs: string[] = [];
    const scheduler = new FetchScheduler(resolver, store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId }, { log: (m) => logs.push(m) });
    return { net, b, store, scheduler, logs };
  }
  const MINUTE = 60_000;

  test("the operator publishes the card after the first check: a scan an hour later finds it; the gateway does not wait a day", async () => {
    const { net, store, scheduler } = silentHost();
    expect(await scheduler.scan()).toEqual({ records: 1, started: [ID] });
    await scheduler.idle();
    expect(store.get(ID)?.detection).toMatchObject({ protocol: null, failure: "the endpoint answered HTTP 404" });

    net.json("https://agent.example.org/.well-known/agent-card.json", CARD);
    net.clock.t += 3_600_000;
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
    expect(store.get(ID)?.detection).toMatchObject({ protocol: "a2a", failure: null });
  });

  test("a check that finds nothing is repeated after 10 minutes, then after twice as long each time, and after a day at most; the wait counts from the end of the check", async () => {
    const { net, store, scheduler } = silentHost();
    await scheduler.scan();
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ failedChecks: 1 });
    for (const [index, minutes] of [10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440].entries()) {
      const ended = store.get(ID)!.endedAt;
      expect(ended).toBeGreaterThan(store.get(ID)!.checkedAt);
      expect(recheckDelayMs(store.get(ID)!, DAY_MS)).toBe(minutes * MINUTE);
      net.clock.t = ended + minutes * MINUTE - 1;
      expect((await scheduler.scan()).started).toEqual([]);
      net.clock.t = ended + minutes * MINUTE;
      expect((await scheduler.scan()).started).toEqual([ID]);
      await scheduler.idle();
      expect(store.get(ID)).toMatchObject({ failedChecks: index + 2 });
    }
  });

  test("a check that finds a protocol is repeated after a day; one failure after it starts the waits at 10 minutes again", async () => {
    const { net, store, scheduler } = silentHost();
    net.json("https://agent.example.org/.well-known/agent-card.json", CARD);
    await scheduler.scan();
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ failedChecks: 0, detection: { protocol: "a2a" } });
    expect(recheckDelayMs(store.get(ID)!, DAY_MS)).toBe(DAY_MS);
    net.clock.t = store.get(ID)!.endedAt + 11 * MINUTE;
    expect((await scheduler.scan()).started).toEqual([]);

    net.handlers.delete("GET https://agent.example.org/.well-known/agent-card.json");
    net.clock.t = store.get(ID)!.endedAt + DAY_MS;
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ failedChecks: 1, detection: { protocol: null } });

    net.json("https://agent.example.org/.well-known/agent-card.json", CARD);
    net.clock.t = store.get(ID)!.endedAt + 10 * MINUTE;
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ failedChecks: 0, detection: { protocol: "a2a" } });
    expect(recheckDelayMs(store.get(ID)!, DAY_MS)).toBe(DAY_MS);
  });

  test("a record change starts a check at once and the waits start again at 10 minutes; a record without an endpoint waits a day", async () => {
    const { net, b, store, scheduler } = silentHost();
    for (let i = 0; i < 3; i++) {
      await scheduler.scan();
      await scheduler.idle();
      net.clock.t = store.get(ID)!.endedAt + recheckDelayMs(store.get(ID)!, DAY_MS);
    }
    expect(store.get(ID)).toMatchObject({ failedChecks: 3 });

    b.update(ID, identityDatum({ endpoint: utf8("https://moved.example.org/a2a") }), { height: 950 });
    b.tip(1001);
    net.host("moved.example.org");
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ failedChecks: 1, detection: { endpoint: "https://moved.example.org/a2a", protocol: null } });

    b.update(ID, identityDatum({ endpoint: new Uint8Array() }), { height: 960 });
    b.tip(1010);
    net.clock.t = store.get(ID)!.endedAt + 1;
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ failedChecks: 0, detection: null });
    net.clock.t = store.get(ID)!.endedAt + 11 * MINUTE;
    expect((await scheduler.scan()).started).toEqual([]);
  });

  test("repeated checks of two records on one host keep the rule of one fetch each minute for the host", async () => {
    const net = new FakeNet().host("shared.example.org");
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ endpoint: utf8("https://shared.example.org/one") }), { height: 100 });
    b.register(idOf("second scheduled agent"), identityDatum({ endpoint: utf8("https://shared.example.org/two") }), { height: 101 });
    const store = new FactsStore();
    const scheduler = new FetchScheduler(new VectorResolver(b.chain, b.settings), store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId }, { log: () => undefined });
    for (let pass = 0; pass < 4; pass++) {
      const before = { at: net.clock.now(), calls: net.calls.length };
      expect((await scheduler.scan()).started).toHaveLength(2);
      await scheduler.idle();
      // Each record makes 5 fetches: four probes and the DID configuration. The test clock advances by each wait of the host limit.
      const made = net.calls.length - before.calls;
      expect(made).toBe(10);
      expect(net.clock.now() - before.at).toBeGreaterThanOrEqual((made - 1) * 60_000);
      const last = Math.max(...store.ids().map((id) => store.get(id)!.endedAt));
      net.clock.t = last + 10 * MINUTE * 2 ** pass;
    }
  });

  test("a host that does not resolve is repeated like any other failure", async () => {
    const net = new FakeNet();
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ endpoint: utf8("https://gone.example.org/") }), { height: 100 });
    const store = new FactsStore();
    const scheduler = new FetchScheduler(new VectorResolver(b.chain, b.settings), store, { fetcher: net.fetcher(), txt: net.txt, clock: net.clock, legacyPolicyId: LEGACY.policyId }, { log: () => undefined });
    await scheduler.scan();
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ failedChecks: 1, detection: { protocol: null, failure: "the host name does not resolve" } });
    net.host("gone.example.org");
    net.json("https://gone.example.org/.well-known/agent-card.json", { ...CARD, supportedInterfaces: [{ url: "https://gone.example.org/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }] });
    net.clock.t = store.get(ID)!.endedAt + 10 * MINUTE;
    expect((await scheduler.scan()).started).toEqual([ID]);
    await scheduler.idle();
    expect(store.get(ID)).toMatchObject({ failedChecks: 0, detection: { protocol: "a2a" } });
  });

  test("each such check is logged with the host, the reason and the next wait, and without the DID or any control character", async () => {
    const { net, store, scheduler, logs } = silentHost();
    await scheduler.scan();
    await scheduler.idle();
    expect(logs).toEqual(["identity-gateway: background check found no protocol at agent.example.org (the endpoint answered HTTP 404); the next check is in 10 minutes"]);
    net.clock.t = store.get(ID)!.endedAt + 10 * MINUTE;
    await scheduler.scan();
    await scheduler.idle();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("the next check is in 20 minutes");
    expect(logs.join("\n")).not.toContain(ID);

    const hostile = new FakeNet().host("evil.example.org");
    hostile.on("https://evil.example.org/.well-known/agent-card.json", () => {
      throw new Error("line one\nidentity-gateway: forged line\u0007");
    });
    const b = new LedgerBuilder();
    b.register(idOf("hostile endpoint"), identityDatum({ endpoint: utf8("https://evil.example.org/") }), { height: 100 });
    const hostileLogs: string[] = [];
    const other = new FetchScheduler(new VectorResolver(b.chain, b.settings), new FactsStore(), { fetcher: hostile.fetcher(), txt: hostile.txt, clock: hostile.clock, legacyPolicyId: LEGACY.policyId }, { log: (m) => hostileLogs.push(m) });
    await other.scan();
    await other.idle();
    expect(hostileLogs).toHaveLength(1);
    expect(hostileLogs[0]).not.toMatch(/[\n\u0007]/);
  });
});
