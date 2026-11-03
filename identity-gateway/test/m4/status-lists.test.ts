// Status lists (Part 2 Sections 8.4 and 8.6): the Token Status List and the Bitstring Status List
// give each indexed identifier the status of its view without options: revocation for Revoked and
// Retired (only after 30 confirmations), suspension for every Suspended reason.

import { gunzipSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { LIST_SIZE, STATUS, bitstring, tokenStatusBytes } from "../../src/m4/status-lists.js";
import { formatTime } from "../../src/resolve/time.js";
import type { ChainMethod } from "../support/chain.js";
import { CONTROLLER_2, LedgerBuilder, identityDatum, idOf, keySigner, legacyDatum, PARTY_KEY, timeAt } from "../support/ledger.js";
import { tombstoneOf } from "../support/resolve.js";
import { BASE, GATEWAY_ID, at, bodyOf, decodeJwt, gatewayKeys, nowS, startGateway, stopGateways, text, verifiedByGateway, type Harness } from "./support.js";

afterEach(stopGateways);

const id = (label: string) => idOf(`m4 status ${label}`);
const R = {
  legacy: id("legacy"),
  active: id("active"),
  suspended: id("suspended"),
  pending: id("pending"),
  revoked: id("revoked"),
  invalidated: id("invalidated"),
  retired: id("retired"),
  unaccountable: id("unaccountable"),
  revokedParent: id("revoked parent"),
  childOfRevoked: id("child of revoked"),
  suspendedParent: id("suspended parent"),
  childOfSuspended: id("child of suspended"),
  retiredParent: id("retired parent"),
  childOfRetired: id("child of retired"),
  notAuthentic: id("not authentic"),
  unconfirmed: id("unconfirmed"),
  legacyLate: id("legacy late"),
};

/** The expected Token Status List value of each indexed record, and its effective status. */
const EXPECTED: Array<[keyof typeof R, number, string, string | null]> = [
  ["legacy", STATUS.suspended, "suspended", "unaccountable"],
  ["active", STATUS.valid, "active", null],
  ["suspended", STATUS.suspended, "suspended", null],
  ["pending", STATUS.suspended, "suspended", "deactivationPending"],
  ["revoked", STATUS.invalid, "revoked", null],
  ["invalidated", STATUS.invalid, "revoked", null],
  ["retired", STATUS.invalid, "retired", null],
  ["unaccountable", STATUS.suspended, "suspended", "unaccountable"],
  ["revokedParent", STATUS.invalid, "revoked", null],
  ["childOfRevoked", STATUS.invalid, "revoked", "parentRevoked"],
  ["suspendedParent", STATUS.suspended, "suspended", null],
  ["childOfSuspended", STATUS.suspended, "suspended", "parentSuspended"],
  ["retiredParent", STATUS.invalid, "retired", null],
  ["childOfRetired", STATUS.invalid, "retired", "parentRetired"],
  ["notAuthentic", STATUS.suspended, "suspended", "notAuthentic"],
];

const hold = (until: number) => ({ type: "Suspended" as const, holds: [{ by: { type: "ControllerSet" as const }, reason: 6, since: timeAt(100), until }] });
const revocation = (at: number, invalidFrom: number | null = null) => ({ type: "Revoked" as const, by: keySigner(PARTY_KEY), reason: 3, at: timeAt(at), invalidFrom, successor: null });
const child = (parent: string) => identityDatum({ lineage: { type: "Subagent", parent, parentEpoch: 0, depth: 1 }, endpoint: new Uint8Array(), controller: CONTROLLER_2 });

function ledger(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.legacyRegister(R.legacy, legacyDatum(), { height: 50 });
  b.register(R.active, identityDatum(), { height: 100 });
  b.register(R.suspended, identityDatum({ status: hold(timeAt(2000)) }), { height: 110 });
  b.register(R.pending, identityDatum(), { height: 120 });
  b.register(R.revoked, identityDatum(), { height: 130 });
  b.register(R.invalidated, identityDatum(), { height: 140 });
  b.register(R.retired, identityDatum(), { height: 150 });
  b.register(R.unaccountable, identityDatum({ parties: [] }), { height: 160 });
  b.register(R.revokedParent, identityDatum(), { height: 170 });
  b.register(R.childOfRevoked, child(R.revokedParent), { height: 175 });
  b.register(R.suspendedParent, identityDatum({ status: hold(timeAt(2000)) }), { height: 180 });
  b.register(R.childOfSuspended, child(R.suspendedParent), { height: 185 });
  b.register(R.retiredParent, identityDatum(), { height: 190 });
  b.register(R.childOfRetired, child(R.retiredParent), { height: 195 });
  b.register(R.notAuthentic, identityDatum(), { height: 200 });
  b.update(R.revoked, tombstoneOf(identityDatum(), revocation(300)), { height: 300 });
  b.update(R.invalidated, tombstoneOf(identityDatum(), revocation(310, timeAt(200))), { height: 310 });
  b.update(R.retired, tombstoneOf(identityDatum(), { type: "Retired", at: timeAt(320), successor: null }), { height: 320 });
  b.update(R.revokedParent, tombstoneOf(identityDatum(), revocation(330)), { height: 330 });
  b.update(R.retiredParent, tombstoneOf(identityDatum(), { type: "Retired", at: timeAt(340), successor: null }), { height: 340 });
  b.moveOut(R.notAuthentic, { height: 400 });
  b.legacyRegister(R.legacyLate, legacyDatum(), { height: 600 });
  b.update(R.pending, tombstoneOf(identityDatum(), revocation(990)), { height: 990 });
  b.register(R.unconfirmed, identityDatum(), { height: 990 });
  return b;
}

async function indices(h: Harness): Promise<Map<string, number | null>> {
  return new Map((await h.resolver.listRecords()).entries.map((e) => [e.vectorId, e.statusListIndex]));
}

/** Ledger reads of one kind so far. */
const reads = (h: Harness, method: ChainMethod): number => h.builder.chain.calls.filter((c) => c === method).length;

async function tokenStatusList(h: Harness, n = 0): Promise<{ jwt: string; values: (i: number) => number; payload: Record<string, unknown> }> {
  const res = await fetch(`${h.url}/status/tsl/${n}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/statuslist+jwt");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const jwt = await res.text();
  const { payload } = decodeJwt(jwt);
  const bytes = inflateSync(Buffer.from(text(at(payload, "status_list", "lst")), "base64url"));
  expect(bytes.length).toBe((LIST_SIZE * 2) / 8);
  return { jwt, payload, values: (i) => (bytes[i >> 2]! >> ((i & 3) * 2)) & 0b11 };
}

async function bitstringList(h: Harness, n = 0): Promise<{ jwt: string; bit: (i: number) => number; credential: Record<string, unknown> }> {
  const res = await fetch(`${h.url}/status/bsl/${n}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/vc+jwt");
  const jwt = await res.text();
  const { payload } = decodeJwt(jwt);
  const encodedList = text(at(payload, "credentialSubject", "encodedList"));
  expect(encodedList.startsWith("u")).toBe(true);
  const gzipped = Buffer.from(encodedList.slice(1), "base64url");
  expect(gzipped.subarray(0, 2).toString("hex")).toBe("1f8b");
  const bits = gunzipSync(gzipped);
  expect(bits.length).toBe((2 * LIST_SIZE) / 8);
  return { jwt, credential: payload, bit: (i) => (bits[i >> 3]! >> (7 - (i & 7))) & 1 };
}

describe("status values", () => {
  test("every effective status of the view without options gets its value", async () => {
    const h = await startGateway(ledger());
    for (const [name, , status, reason] of EXPECTED) {
      const lookup = await h.resolver.currentRecord(R[name]);
      expect(lookup.found && lookup.record.effective, name).toEqual({ status, reason });
    }
    const index = await indices(h);
    expect(index.get(R.unconfirmed)).toBeNull();
    expect(index.has(R.legacyLate)).toBe(false);

    const tsl = await tokenStatusList(h);
    const bsl = await bitstringList(h);
    for (const [name, value] of EXPECTED) {
      const i = index.get(R[name])!;
      expect(tsl.values(i), name).toBe(value);
      expect(bsl.bit(i), `${name} revocation`).toBe(value === STATUS.invalid ? 1 : 0);
      expect(bsl.bit(LIST_SIZE + i), `${name} suspension`).toBe(value === STATUS.suspended ? 1 : 0);
    }
    // Positions without a record are valid.
    expect(tsl.values(index.size + 5)).toBe(STATUS.valid);
  });

  test("the revocation bit waits for 30 confirmations; until then the end shows as a suspension", async () => {
    const b = ledger();
    const h = await startGateway(b);
    const i = (await indices(h)).get(R.pending)!;
    let bsl = await bitstringList(h);
    expect([bsl.bit(i), bsl.bit(LIST_SIZE + i)]).toEqual([0, 1]);
    expect((await tokenStatusList(h)).values(i)).toBe(STATUS.suspended);
    b.tip(1020);
    h.now += 61_000;
    await h.services.statusLists.refresh();
    bsl = await bitstringList(h);
    expect([bsl.bit(i), bsl.bit(LIST_SIZE + i)]).toEqual([1, 0]);
    expect((await tokenStatusList(h)).values(i)).toBe(STATUS.invalid);
  });
});

describe("GET /status/tsl/{n}", () => {
  test("a statuslist+jwt token signed with ES256 (draft-ietf-oauth-status-list-21 Section 5.1)", async () => {
    const h = await startGateway(ledger());
    const { jwt, payload } = await tokenStatusList(h);
    expect(verifiedByGateway(jwt)).toBe(true);
    expect(decodeJwt(jwt).header).toEqual({ alg: "ES256", kid: gatewayKeys().p256.kid, typ: "statuslist+jwt" });
    expect(payload).toEqual({
      iss: BASE,
      sub: `${BASE}/status/tsl/0`,
      iat: nowS(h.now),
      exp: nowS(h.now) + 3600,
      ttl: 60,
      status_list: { bits: 2, lst: expect.any(String) },
    });
    // ZLIB format (RFC 1950), highest compression.
    expect(Buffer.from(text(at(payload, "status_list", "lst")), "base64url").subarray(0, 2).toString("hex")).toBe("78da");
  });

  test("after the refresh interval a request gets the previous lists at once and starts a build; later requests get the new lists", async () => {
    const h = await startGateway(ledger());
    const first = (await tokenStatusList(h)).jwt;
    h.now += 30_000;
    expect((await tokenStatusList(h)).jwt).toBe(first);
    h.now += 31_000;
    expect((await tokenStatusList(h)).jwt).toBe(first);
    await h.services.statusLists.refresh(); // joins the build that the request started
    const rebuilt = await tokenStatusList(h);
    expect(rebuilt.jwt).not.toBe(first);
    expect(rebuilt.payload.iat).toBe(nowS(h.now));
  });

  test("a list that does not exist is 404; other paths and methods are refused", async () => {
    const h = await startGateway(ledger());
    const missing = await fetch(`${h.url}/status/tsl/1`);
    expect(missing.status).toBe(404);
    expect(await bodyOf(missing)).toEqual({ error: "not_found", error_description: "no such status list" });
    expect((await fetch(`${h.url}/status/bsl/1`)).status).toBe(404);
    expect((await fetch(`${h.url}/status/tsl/01`)).status).toBe(404);
    expect((await fetch(`${h.url}/status/xsl/0`)).status).toBe(404);
    const post = await fetch(`${h.url}/status/tsl/0`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const head = await fetch(`${h.url}/status/tsl/0`, { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  test("a failed build: 503 without lists, and no new build within the refresh interval; the last lists while they are valid", async () => {
    const b = ledger();
    const h = await startGateway(b);
    b.chain.failing.add("policyAssets");
    const failed = await fetch(`${h.url}/status/tsl/0`);
    expect(failed.status).toBe(503);
    expect((await bodyOf(failed)).error).toBe("temporarily_unavailable");
    const attempts = reads(h, "policyAssets");
    // Within the refresh interval after the failed build, requests are 503 at once and read nothing.
    b.chain.failing.delete("policyAssets");
    h.now += 59_000;
    const refused = await Promise.all(Array.from({ length: 30 }, () => fetch(`${h.url}/status/tsl/0`)));
    expect(refused.map((r) => r.status)).toEqual(Array(30).fill(503));
    expect(reads(h, "policyAssets")).toBe(attempts);
    // One refresh interval after the failed build, a request starts the next one.
    h.now += 1_000;
    const built = (await tokenStatusList(h)).jwt;
    b.chain.failing.add("policyAssets");
    h.now += 120_000;
    expect((await tokenStatusList(h)).jwt).toBe(built);
    await expect.poll(() => h.logs.filter((m) => m.includes("status lists not rebuilt")).length).toBe(2);
    // After the lists' hour, a request waits for a build again, and a failed build is 503.
    h.now += 3_600_000;
    expect((await fetch(`${h.url}/status/tsl/0`)).status).toBe(503);
  });
});

describe("builds", () => {
  test("30 requests at once share one build; requests within the refresh interval start none", async () => {
    const h = await startGateway(ledger());
    const first = await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`${h.url}/status/${i % 2 ? "bsl" : "tsl"}/0`)));
    expect(first.map((r) => r.status)).toEqual(Array(30).fill(200));
    // One build: one list of the records, which reads the asset index of both registries.
    expect(reads(h, "policyAssets")).toBe(2);
    h.now += 59_000;
    const again = await Promise.all(Array.from({ length: 30 }, () => fetch(`${h.url}/status/bsl/0`)));
    expect(again.map((r) => r.status)).toEqual(Array(30).fill(200));
    expect(reads(h, "policyAssets")).toBe(2);
  });

  test("a build reads the tip once; the next build reads again only records whose tokens moved or whose newest transaction has fewer than 30 confirmations", async () => {
    const b = ledger();
    const h = await startGateway(b);
    await h.services.statusLists.refresh();
    expect([reads(h, "tip"), reads(h, "assetHolders")]).toEqual([1, 1]);
    // Each indexed record once (the parents of the subagents are indexed records); two token histories each.
    expect(reads(h, "assetTxHashes")).toBe(2 * EXPECTED.length);

    // A new block without a record change: only R.pending is read again (its revocation at height 990 has 11 confirmations).
    b.tip(1001);
    h.now += 61_000;
    await h.services.statusLists.refresh();
    expect([reads(h, "tip"), reads(h, "assetHolders"), reads(h, "assetTxHashes")]).toEqual([2, 2, 2 * EXPECTED.length + 2]);

    // R.active is revoked. The next build reads it again, and R.unconfirmed for the first time: with
    // 50 confirmations, its mint gets an index. R.pending (50 confirmations too) is not read again.
    b.update(R.active, tombstoneOf(identityDatum(), revocation(1002)), { height: 1002 });
    b.tip(1040);
    h.now += 61_000;
    await h.services.statusLists.refresh();
    expect(reads(h, "assetTxHashes")).toBe(2 * EXPECTED.length + 6);
    const index = await indices(h);
    const tsl = await tokenStatusList(h);
    expect([tsl.values(index.get(R.active)!), tsl.values(index.get(R.unconfirmed)!), tsl.values(index.get(R.pending)!)]).toEqual([
      STATUS.invalid,
      STATUS.valid,
      STATUS.invalid,
    ]);
    expect((await bitstringList(h)).bit(index.get(R.active)!)).toBe(1);
  });
});

describe("GET /status/bsl/{n}", () => {
  test("a BitstringStatusListCredential with both purposes, secured as application/vc+jwt", async () => {
    const h = await startGateway(ledger());
    const { jwt, credential } = await bitstringList(h);
    expect(verifiedByGateway(jwt)).toBe(true);
    expect(decodeJwt(jwt).header).toEqual({ alg: "ES256", kid: gatewayKeys().p256.kid, typ: "vc+jwt", cty: "vc" });
    expect(credential).toEqual({
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      id: `${BASE}/status/bsl/0`,
      type: ["VerifiableCredential", "BitstringStatusListCredential"],
      issuer: `did:vector:${GATEWAY_ID}`,
      validFrom: formatTime(h.now),
      validUntil: formatTime(h.now + 3_600_000),
      credentialSubject: {
        id: `${BASE}/status/bsl/0#list`,
        type: "BitstringStatusList",
        statusPurpose: ["revocation", "suspension"],
        encodedList: expect.any(String),
        ttl: 60_000,
      },
    });
  });
});

describe("encodings", () => {
  test("Token Status List packing: the bits=2 example of draft-ietf-oauth-status-list-21 Section 4.1", () => {
    const values = new Uint8Array(LIST_SIZE);
    values.set([1, 2, 0, 3, 0, 1, 0, 1, 1, 2, 3, 3]);
    expect(tokenStatusBytes(values).subarray(0, 4).toString("hex")).toBe("c944f900");
  });

  test("Bitstring Status List: index 0 is the left-most bit; suspension bits follow the 131,072 revocation bits", () => {
    const values = new Uint8Array(LIST_SIZE);
    values[0] = STATUS.invalid;
    values[1] = STATUS.suspended;
    values[LIST_SIZE - 1] = STATUS.invalid;
    const bits = bitstring(values);
    expect(bits[0]).toBe(0x80);
    expect(bits[LIST_SIZE / 8 - 1]).toBe(0x01);
    expect(bits[LIST_SIZE / 8]).toBe(0x40);
    expect(bits.subarray(1, LIST_SIZE / 8 - 1).every((b) => b === 0)).toBe(true);
  });

  test("the 16 KB minimum: each purpose has 131,072 entries", () => {
    expect(LIST_SIZE).toBe(131_072);
    expect(bitstring(new Uint8Array(LIST_SIZE)).length * 8).toBe(2 * 131_072);
  });
});
