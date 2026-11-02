import { describe, expect, test } from "vitest";
import type { ChainMethod } from "./support/chain.js";
import { canonicalize } from "../src/resolve/jcs.js";
import { httpStatus } from "../src/resolve/resolver.js";
import { formatTime } from "../src/resolve/time.js";
import {
  CONTROLLER,
  KEY_A,
  LEGACY,
  LEGACY_OWNER,
  LedgerBuilder,
  PARTY_KEY,
  identityDatum,
  idOf,
  keySigner,
  legacyDatum,
  timeAt,
} from "./support/ledger.js";
import { didOf, errorType, legacyDidOf, ref, resolveIn, resolverFor, tombstoneOf } from "./support/resolve.js";

const ID = idOf("options");
const DID = didOf(ID);

function record(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(ID, identityDatum(), { height: 100 });
  return b;
}

describe("DID syntax (Part 1 Section 7.1 step 1)", () => {
  test.each([
    ["uppercase identifier", `did:vector:${ID.toUpperCase()}`],
    ["one uppercase character", `did:vector:${ID.slice(0, 63)}F`],
    ["uppercase legacy policy", `did:vector:agent:${LEGACY.policyId.toUpperCase()}:${ID}`],
    ["uppercase method", `did:VECTOR:${ID}`],
    ["uppercase literal", `did:vector:AGENT:${LEGACY.policyId}:${ID}`],
    ["uppercase network", `did:vector:TESTNET:${ID}`],
    ["unknown network", `did:vector:preprod:${ID}`],
    ["short identifier", `did:vector:${ID.slice(2)}`],
    ["long identifier", `did:vector:${ID}00`],
    ["legacy form without a policy", `did:vector:agent:${ID}`],
    ["short legacy policy", `did:vector:agent:${LEGACY.policyId.slice(2)}:${ID}`],
    ["non-hex identifier", `did:vector:${"g".repeat(64)}`],
    ["a path", `did:vector:${ID}/path`],
    ["a fragment", `did:vector:${ID}#key`],
    ["not a DID", "vector:abc"],
    ["empty", ""],
  ])("%s is INVALID_DID (400)", async (_name, did) => {
    const result = await resolveIn(record(), did);
    expect(errorType(result)).toBe("INVALID_DID");
    expect(httpStatus(result)).toBe(400);
    expect(result).toEqual({ didDocument: null, didResolutionMetadata: { error: { type: "https://www.w3.org/ns/did#INVALID_DID", title: expect.any(String) } }, didDocumentMetadata: {} });
  });

  test("another method is METHOD_NOT_SUPPORTED (501)", async () => {
    const result = await resolveIn(record(), "did:web:example.com");
    expect(errorType(result)).toBe("METHOD_NOT_SUPPORTED");
    expect(httpStatus(result)).toBe(501);
  });

  test("the testnet form is FEATURE_NOT_SUPPORTED, after the options are checked", async () => {
    expect(errorType(await resolveIn(record(), `did:vector:testnet:${ID}`))).toBe("FEATURE_NOT_SUPPORTED");
    expect(errorType(await resolveIn(record(), `did:vector:testnet:${ID}`, { versionId: "01" }))).toBe("INVALID_OPTIONS");
  });

  test("an invalid DID wins over invalid options", async () => {
    expect(errorType(await resolveIn(record(), "did:vector:x", { unknown: "1" }))).toBe("INVALID_DID");
  });

  test("a legacy form with another policy, also the test registry, is NOT_FOUND", async () => {
    const b = new LedgerBuilder();
    b.legacyRegister(ID, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    expect(errorType(await resolveIn(b, `did:vector:agent:5dd5118943d5aa7329696181252a6565a27dbf2c6de92b02a6aae361:${ID}`))).toBe("NOT_FOUND");
    expect(errorType(await resolveIn(b, `did:vector:agent:${"0".repeat(56)}:${ID}`))).toBe("NOT_FOUND");
    expect(httpStatus(await resolveIn(b, legacyDidOf(ID)))).toBe(200);
  });

  test("an identifier that no registry minted is NOT_FOUND (404)", async () => {
    const result = await resolveIn(record(), didOf(idOf("never minted")));
    expect(errorType(result)).toBe("NOT_FOUND");
    expect(httpStatus(result)).toBe(404);
  });
});

describe("resolution options (Part 1 Section 7.1 step 2)", () => {
  test("an unknown option is FEATURE_NOT_SUPPORTED, checked before INVALID_OPTIONS", async () => {
    expect(errorType(await resolveIn(record(), DID, { accept: "application/did" }))).toBe("FEATURE_NOT_SUPPORTED");
    expect(errorType(await resolveIn(record(), DID, [["versionId", "01"], ["unknown", "x"]]))).toBe("FEATURE_NOT_SUPPORTED");
    expect(httpStatus(await resolveIn(record(), DID, { foo: "bar" }))).toBe(501);
  });

  test.each([
    ["a repeated option", [["noCache", "true"], ["noCache", "true"]]],
    ["both version options", [["versionId", "0"], ["versionTime", "2026-01-01T00:00:00Z"]]],
    ["versionId with a leading zero", [["versionId", "01"]]],
    ["a negative versionId", [["versionId", "-1"]]],
    ["a decimal versionId", [["versionId", "1.0"]]],
    ["an empty versionId", [["versionId", ""]]],
    ["versionId with a space", [["versionId", " 1"]]],
    ["2026-02-30", [["versionTime", "2026-02-30T00:00:00Z"]]],
    ["2025-02-29", [["versionTime", "2025-02-29T00:00:00Z"]]],
    ["month 13", [["versionTime", "2026-13-01T00:00:00Z"]]],
    ["day 0", [["versionTime", "2026-01-00T00:00:00Z"]]],
    ["hour 24", [["versionTime", "2026-01-01T24:00:00Z"]]],
    ["minute 60", [["versionTime", "2026-01-01T00:60:00Z"]]],
    ["second 60", [["versionTime", "2026-01-01T00:00:60Z"]]],
    ["fractions", [["versionTime", "2026-01-01T00:00:00.000Z"]]],
    ["an offset", [["versionTime", "2026-01-01T00:00:00+00:00"]]],
    ["a lowercase z", [["versionTime", "2026-01-01T00:00:00z"]]],
    ["a space for T", [["versionTime", "2026-01-01 00:00:00Z"]]],
    ["a date only", [["versionTime", "2026-01-01"]]],
    ["expandRelativeUrls=TRUE", [["expandRelativeUrls", "TRUE"]]],
    ["noCache=1", [["noCache", "1"]]],
    ["noCache without a value", [["noCache", ""]]],
  ])("%s is INVALID_OPTIONS (400)", async (_name, pairs) => {
    const result = await resolveIn(record(), DID, pairs as Array<[string, string]>);
    expect(errorType(result)).toBe("INVALID_OPTIONS");
    expect(httpStatus(result)).toBe(400);
  });

  test("a leap day is a real date", async () => {
    expect(errorType(await resolveIn(record(), DID, { versionTime: "2028-02-29T12:00:00Z" }))).toBeUndefined();
  });

  test("expandRelativeUrls=true writes complete DID URLs in the relationships; noCache has no effect", async () => {
    const b = record();
    const expanded = await resolveIn(b, DID, { expandRelativeUrls: "true" });
    expect(expanded.didDocument).toMatchObject({
      capabilityInvocation: [`${DID}${ref(CONTROLLER)}`],
      authentication: [`${DID}${ref(KEY_A)}`],
      assertionMethod: [`${DID}${ref(KEY_A)}`],
    });
    expect(expanded.didDocumentMetadata.vectorKeys?.[0]?.id).toBe(ref(KEY_A));
    const plain = canonicalize(await resolveIn(b, DID));
    expect(canonicalize(await resolveIn(b, DID, { expandRelativeUrls: "false" }))).toBe(plain);
    expect(canonicalize(await resolveIn(b, DID, { noCache: "true" }))).toBe(plain);
    expect(canonicalize(await resolveIn(b, DID, { noCache: "false" }))).toBe(plain);
  });

  test("versionId of a version that does not exist or is not confirmed is NOT_FOUND", async () => {
    const b = record();
    b.update(ID, identityDatum({ keys: [] }), { height: 990 });
    expect(errorType(await resolveIn(b, DID, { versionId: "1" }))).toBe("NOT_FOUND");
    expect(errorType(await resolveIn(b, DID, { versionId: "2" }))).toBe("NOT_FOUND");
    expect(errorType(await resolveIn(b, DID, { versionId: "123456789012345678901234567890" }))).toBe("NOT_FOUND");
    const v0 = await resolveIn(b, DID, { versionId: "0" });
    expect(v0.didDocumentMetadata.vectorPending).toBeUndefined();
    expect(v0.didDocumentMetadata.nextVersionId).toBeUndefined();
    expect(v0.didDocumentMetadata.vectorCurrent).toEqual({ effective: "active" });
  });

  test("versionTime later than the tip describes the tip; before the first mint it is NOT_FOUND", async () => {
    const b = record();
    const later = await resolveIn(b, DID, { versionTime: "9999-12-31T23:59:59Z" });
    const now = await resolveIn(b, DID);
    expect(later.didDocument).toEqual(now.didDocument);
    expect(later.didDocumentMetadata).toEqual({ ...now.didDocumentMetadata, vectorCurrent: { effective: "active" } });
    expect(errorType(await resolveIn(b, DID, { versionTime: formatTime(timeAt(100)) }))).toBe("NOT_FOUND");
    expect(errorType(await resolveIn(b, DID, { versionTime: "0000-01-01T00:00:00Z" }))).toBe("NOT_FOUND");
    expect(errorType(await resolveIn(b, DID, { versionTime: formatTime(timeAt(101)) }))).toBeUndefined();
  });

  test("versionTime before a hold: not deactivated; vectorCurrent is suspended", async () => {
    const b = record();
    b.update(ID, identityDatum({ status: { type: "Suspended", holds: [{ by: keySigner(PARTY_KEY), reason: 6, since: timeAt(400), until: timeAt(5000) }] } }), {
      height: 400,
    });
    const result = await resolveIn(b, DID, { versionTime: formatTime(timeAt(300)) });
    expect(httpStatus(result)).toBe(200);
    expect(result.didDocumentMetadata).toMatchObject({ vectorStatus: { effective: "active" }, vectorCurrent: { effective: "suspended" } });
    expect(result.didDocumentMetadata.deactivated).toBeUndefined();
  });

  test.each([
    ["a revocation", { type: "Revoked" as const, by: { type: "ControllerSet" as const }, reason: 5, at: timeAt(400), invalidFrom: null, successor: null }, "revoked"],
    ["a retirement", { type: "Retired" as const, at: timeAt(400), successor: null }, "retired"],
  ])("versionTime before %s: deactivated (410) with the document at t", async (_name, status, current) => {
    const b = record();
    b.update(ID, tombstoneOf(identityDatum(), status), { height: 400 });
    const result = await resolveIn(b, DID, { versionTime: formatTime(timeAt(300)) });
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument?.capabilityInvocation).toEqual([ref(CONTROLLER)]);
    expect(result.didResolutionMetadata).toEqual({ contentType: "application/did" });
    expect(result.didDocumentMetadata).toMatchObject({ deactivated: true, vectorStatus: { effective: "active" }, vectorCurrent: { effective: current } });
  });
});

describe("failed ledger reads (Part 1 Section 7.1)", () => {
  const methods: ChainMethod[] = ["tip", "genesis", "assetTxHashes", "transactions", "blockWitnesses", "datums"];

  test.each(methods)("a failed %s read is INTERNAL_ERROR (500), never NOT_FOUND; the log names no DID", async (method) => {
    const b = new LedgerBuilder().tip(400);
    b.legacyRegister(ID, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] }, { inline: false, datumKnown: true });
    b.chain.failing.add(method);
    const logs: string[] = [];
    const result = await resolverFor(b, logs).resolveDid(DID);
    expect(errorType(result)).toBe("INTERNAL_ERROR");
    expect(httpStatus(result)).toBe(500);
    expect(result.didDocument).toBeNull();
    expect(logs.join("\n")).toContain("HTTP 503");
    expect(logs.join("\n")).not.toContain(ID);
  });

  test("a transaction that the asset history lists but the source cannot return is INTERNAL_ERROR", async () => {
    const b = record();
    const update = b.update(ID, identityDatum({ keys: [] }), { height: 200 });
    b.chain.hidden.add(update.txHash);
    expect(errorType(await resolveIn(b, DID))).toBe("INTERNAL_ERROR");
  });

  test("a source with other genesis values (same network magic) is INTERNAL_ERROR; the check runs again on the next request", async () => {
    const b = record();
    b.chain.genesisInfo = { ...b.chain.genesisInfo, systemStart: b.chain.genesisInfo.systemStart + 86_400 };
    const resolver = resolverFor(b);
    expect(errorType(await resolver.resolveDid(DID))).toBe("INTERNAL_ERROR");
    b.chain.genesisInfo = { ...b.chain.genesisInfo, systemStart: b.chain.genesisInfo.systemStart - 86_400 };
    expect(errorType(await resolver.resolveDid(DID))).toBeUndefined();
    expect(b.chain.calls.filter((c) => c === "genesis")).toHaveLength(2);
    await resolver.resolveDid(DID);
    expect(b.chain.calls.filter((c) => c === "genesis")).toHaveLength(2);
  });

  test("an identity record output whose datum does not decode is INTERNAL_ERROR", async () => {
    const b = record();
    b.updateRaw(ID, "d87980", { height: 200 });
    expect(errorType(await resolveIn(b, DID))).toBe("INTERNAL_ERROR");
  });
});
