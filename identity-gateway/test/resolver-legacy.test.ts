import { describe, expect, test } from "vitest";
import { keyHash } from "../src/codec/keys.js";
import { httpStatus } from "../src/resolve/resolver.js";
import { formatTime } from "../src/resolve/time.js";
import {
  CONTROLLER,
  CUTOFF_HEIGHT,
  IDENTITY,
  LEGACY,
  LEGACY_OWNER,
  LEGACY_OWNER_2,
  LEGACY_WITH_STAKE,
  LedgerBuilder,
  SETTINGS,
  WALLET,
  identityDatum,
  idOf,
  legacyDatum,
  timeAt,
  utf8,
} from "./support/ledger.js";
import { didOf, errorType, legacyDidOf, method, ref, resolveIn, resolverFor } from "./support/resolve.js";

const ID = idOf("legacy");
const DID = didOf(ID);
const LEGACY_DID = legacyDidOf(ID);

/** A legacy record minted at height 200, before the cutoff (height 500). */
function legacyRecord(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.legacyRegister(ID, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
  return b;
}

describe("legacy record", () => {
  test("before the cutoff slot: active, the owner key from the registration witness in three relationships", async () => {
    const b = legacyRecord().tip(400);
    const result = await resolveIn(b, LEGACY_DID);
    expect(httpStatus(result)).toBe(200);
    expect(result.didDocument).toEqual({
      "@context": "https://www.w3.org/ns/did/v1.1",
      id: LEGACY_DID,
      verificationMethod: [method(LEGACY_DID, LEGACY_OWNER)],
      capabilityInvocation: [ref(LEGACY_OWNER)],
      authentication: [ref(LEGACY_OWNER)],
      assertionMethod: [ref(LEGACY_OWNER)],
    });
    expect(result.didDocumentMetadata).toMatchObject({
      created: formatTime(timeAt(200)),
      versionId: "0",
      canonicalId: DID,
      vectorOrigin: "legacy",
      vectorStatus: { status: "active", effective: "active" },
      vectorProfile: {
        name: "Legacy Agent",
        description: "A record of the legacy registry.",
        framework: "custom",
        endpoint: "https://legacy.example.org/agent",
        capabilities: ["document-extraction"],
        createdAt: formatTime(timeAt(200)),
      },
    });
    expect(result.didDocumentMetadata.equivalentId).toBeUndefined();
    expect((await resolveIn(b, DID)).didDocumentMetadata.equivalentId).toEqual([LEGACY_DID]);
  });

  test("from the cutoff slot on: Suspended (unaccountable); a versionTime before the cutoff shows it active", async () => {
    const b = legacyRecord().tip(1000);
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "suspended", effectiveReason: "unaccountable" });
    b.tip(CUTOFF_HEIGHT);
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus?.effectiveReason).toBe("unaccountable");
    b.tip(CUTOFF_HEIGHT - 1);
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "active" });
    b.tip(1000);
    const before = await resolveIn(b, DID, { versionTime: formatTime(timeAt(300)) });
    expect(before.didDocumentMetadata).toMatchObject({ vectorStatus: { effective: "active" }, vectorCurrent: { effective: "suspended", effectiveReason: "unaccountable" } });
  });

  test("without a deployed identity registry and cutoff slot, legacy records stay active", async () => {
    const b = new LedgerBuilder({ ...SETTINGS, registries: { identity: null, legacy: LEGACY, cutoffSlot: null } });
    b.legacyRegister(ID, legacyDatum(), { height: 700, vkeys: [LEGACY_OWNER] });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "active" });
  });

  test("a legacy identifier minted at or after the cutoff slot is NOT_FOUND", async () => {
    const b = new LedgerBuilder();
    b.legacyRegister(ID, legacyDatum(), { height: CUTOFF_HEIGHT, vkeys: [LEGACY_OWNER] });
    expect(errorType(await resolveIn(b, DID))).toBe("NOT_FOUND");
    expect(errorType(await resolveIn(b, LEGACY_DID))).toBe("NOT_FOUND");
  });

  test("deregistration: a version with status Retired; deactivated with a null document", async () => {
    const b = legacyRecord().tip(400);
    const end = b.legacyDeregister(ID, { height: 300, vkeys: [LEGACY_OWNER] });
    const result = await resolveIn(b, LEGACY_DID);
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).toBeNull();
    expect(result.didDocumentMetadata).toEqual({
      created: formatTime(timeAt(200)),
      updated: formatTime(timeAt(300)),
      versionId: "1",
      deactivated: true,
      canonicalId: DID,
      vectorOrigin: "legacy",
      vectorStatus: { status: "retired", effective: "retired", at: formatTime(timeAt(300)) },
      vectorProfile: { createdAt: formatTime(timeAt(200)) },
      vectorLedger: { txId: end.txHash, blockHash: end.blockHash, blockHeight: 300, slot: 3000, confirmations: 100 },
    });
    const earlier = await resolveIn(b, LEGACY_DID, { versionId: "0" });
    expect(httpStatus(earlier)).toBe(410);
    expect(earlier.didDocument?.verificationMethod).toEqual([method(LEGACY_DID, LEGACY_OWNER)]);
    expect(earlier.didDocumentMetadata).toMatchObject({ nextVersionId: "1", vectorCurrent: { effective: "retired" } });
  });

  test("an unconfirmed deregistration is Suspended (deactivationPending) and the view has no controller key", async () => {
    const b = legacyRecord().tip(400);
    const end = b.legacyDeregister(ID, { height: 390, vkeys: [LEGACY_OWNER] });
    const result = await resolveIn(b, DID);
    expect(httpStatus(result)).toBe(200);
    expect(result.didDocument).toEqual({ "@context": "https://www.w3.org/ns/did/v1.1", id: DID });
    expect(result.didDocumentMetadata).toMatchObject({
      vectorPending: [end.txHash],
      vectorStatus: { status: "active", effective: "suspended", effectiveReason: "deactivationPending" },
    });
    expect(result.didDocumentMetadata.vectorMetadataError).toBeUndefined();
  });

  test.each([
    ["another address", WALLET],
    ["the registry script with a stake credential", LEGACY_WITH_STAKE],
  ])("a token moved to %s is Suspended (notAuthentic) until it returns", async (_name, address) => {
    const b = legacyRecord().tip(400);
    b.moveOut(ID, { height: 300, vkeys: [LEGACY_OWNER] }, address);
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "suspended", effectiveReason: "notAuthentic" });
    const back = b.moveBack(ID, LEGACY.address, { height: 350, vkeys: [LEGACY_OWNER] });
    const result = await resolveIn(b, DID);
    expect(result.didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "active" });
    // The return writes the same datum, so the version stays; it owns the new output.
    expect(result.didDocumentMetadata).toMatchObject({ versionId: "0", vectorLedger: { txId: back.txHash, outputIndex: 0 } });
  });

  test("an output with a second token of the policy is not authentic", async () => {
    const b = new LedgerBuilder().tip(400);
    const other = idOf("other");
    b.legacyRegister(ID, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    b.legacyRegister(other, legacyDatum(), { height: 210, vkeys: [LEGACY_OWNER] });
    b.moveOut(ID, { height: 300 }, LEGACY.address, [{ policyId: LEGACY.policyId, assetName: other, quantity: 1n }]);
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus?.effectiveReason).toBe("notAuthentic");
  });
});

describe("legacy key search", () => {
  test("a new owner hash without a witness of the record's own token: no keys and controllerKeyNotFound", async () => {
    const b = legacyRecord().tip(400);
    b.legacyUpdate(ID, legacyDatum(LEGACY_OWNER_2), { height: 300, vkeys: [LEGACY_OWNER] });
    // The new owner signs another transaction in the same block: it is not a transaction of the token.
    b.other({ height: 300, txIndex: 1, vkeys: [LEGACY_OWNER_2] });
    const result = await resolveIn(b, DID);
    expect(result.didDocument).toEqual({ "@context": "https://www.w3.org/ns/did/v1.1", id: DID });
    expect(result.didDocumentMetadata.vectorMetadataError).toBe("controllerKeyNotFound");
  });

  test("the newest witness up to the last output that the base owns, also in a value-only change", async () => {
    const b = legacyRecord().tip(400);
    b.legacyUpdate(ID, legacyDatum(LEGACY_OWNER_2), { height: 300, vkeys: [LEGACY_OWNER] });
    b.touch(ID, 3_000_000n, { height: 320, vkeys: [LEGACY_OWNER_2] });
    const result = await resolveIn(b, DID);
    expect(result.didDocument?.verificationMethod).toEqual([method(DID, LEGACY_OWNER_2)]);
    expect(result.didDocumentMetadata.vectorMetadataError).toBeUndefined();
    // At version 0 the owner is the first key, found in the mint.
    const first = await resolveIn(b, DID, { versionId: "0" });
    expect(first.didDocument?.verificationMethod).toEqual([method(DID, LEGACY_OWNER)]);
  });

  test("a witness in a pending version's transaction does not count for the base", async () => {
    const b = legacyRecord().tip(400);
    b.legacyUpdate(ID, legacyDatum(LEGACY_OWNER_2), { height: 300, vkeys: [LEGACY_OWNER] });
    b.legacyUpdate(ID, legacyDatum(LEGACY_OWNER_2, { name: utf8("renamed") }), { height: 390, vkeys: [LEGACY_OWNER_2] });
    const result = await resolveIn(b, DID);
    expect(result.didDocumentMetadata).toMatchObject({ versionId: "1", vectorMetadataError: "controllerKeyNotFound" });
    b.tip(420);
    expect((await resolveIn(b, DID)).didDocument?.verificationMethod).toEqual([method(DID, LEGACY_OWNER_2)]);
  });

  test("a pending owner change removes the controller key from the view", async () => {
    const b = legacyRecord().tip(400);
    b.legacyUpdate(ID, legacyDatum(LEGACY_OWNER_2), { height: 390, vkeys: [LEGACY_OWNER] });
    const result = await resolveIn(b, DID);
    expect(result.didDocument).toEqual({ "@context": "https://www.w3.org/ns/did/v1.1", id: DID });
    expect(result.didDocumentMetadata.vectorMetadataError).toBeUndefined();
  });

  test("reads one block for each searched transaction, newest first, and stops at the first match", async () => {
    const b = legacyRecord().tip(400);
    b.touch(ID, 3_000_000n, { height: 300, vkeys: [LEGACY_OWNER] });
    b.touch(ID, 4_000_000n, { height: 310 });
    await resolveIn(b, DID);
    expect(b.chain.calls.filter((c) => c === "blockWitnesses")).toHaveLength(2);
  });

  test("a script owner gives controllerIsScript", async () => {
    const b = new LedgerBuilder().tip(400);
    b.legacyRegister(ID, { ...legacyDatum(), owner: { kind: "script", hash: keyHash(LEGACY_OWNER) } }, { height: 200 });
    const result = await resolveIn(b, DID);
    expect(result.didDocument?.verificationMethod).toBeUndefined();
    expect(result.didDocumentMetadata.vectorMetadataError).toBe("controllerIsScript");
  });

  test("an undecodable datum gives recordDatumInvalid; a datum by hash gives recordDatumUnavailable unless the source knows it", async () => {
    const invalid = new LedgerBuilder().tip(400);
    invalid.legacyRegisterRaw(ID, "d87980", { height: 200, vkeys: [LEGACY_OWNER] });
    const r1 = await resolveIn(invalid, DID);
    expect(r1.didDocumentMetadata).toMatchObject({ vectorMetadataError: "recordDatumInvalid", vectorProfile: { createdAt: formatTime(timeAt(200)) } });
    expect(r1.didDocumentMetadata.vectorProfile?.name).toBeUndefined();

    const byHash = new LedgerBuilder().tip(400);
    byHash.legacyRegister(ID, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] }, { inline: false });
    expect((await resolveIn(byHash, DID)).didDocumentMetadata.vectorMetadataError).toBe("recordDatumUnavailable");

    const known = new LedgerBuilder().tip(400);
    known.legacyRegister(ID, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] }, { inline: false, datumKnown: true });
    const r3 = await resolveIn(known, DID);
    expect(r3.didDocumentMetadata.vectorMetadataError).toBeUndefined();
    expect(r3.didDocument?.verificationMethod).toEqual([method(DID, LEGACY_OWNER)]);
  });
});

describe("adopted record", () => {
  /** Legacy mint at 200, legacy update at 300, adoption at 600 (after the cutoff at 500). */
  function adopted(adoptionHeight = 600): LedgerBuilder {
    const b = new LedgerBuilder();
    b.legacyRegister(ID, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    b.legacyUpdate(ID, legacyDatum(LEGACY_OWNER, { name: utf8("Legacy Agent v2") }), { height: 300, vkeys: [LEGACY_OWNER] });
    b.adopt(ID, identityDatum({ createdAt: timeAt(adoptionHeight) }), { height: adoptionHeight, vkeys: [LEGACY_OWNER, CONTROLLER] });
    return b;
  }

  test("the history starts with the legacy versions; the adoption adds one; origin adopted in every version", async () => {
    const b = adopted();
    const now = await resolveIn(b, DID);
    expect(now.didDocumentMetadata).toMatchObject({
      created: formatTime(timeAt(200)),
      updated: formatTime(timeAt(600)),
      versionId: "2",
      vectorOrigin: "adopted",
      equivalentId: [LEGACY_DID],
      vectorStatus: { status: "active", effective: "active" },
      vectorProfile: { name: "test-agent", createdAt: formatTime(timeAt(600)) },
    });
    expect(now.didDocument?.capabilityInvocation).toEqual([ref(CONTROLLER)]);
    const viaLegacy = await resolveIn(b, LEGACY_DID);
    expect(viaLegacy.didDocument?.id).toBe(LEGACY_DID);
    expect(viaLegacy.didDocumentMetadata.equivalentId).toBeUndefined();

    const v1 = await resolveIn(b, DID, { versionId: "1" });
    expect(v1.didDocumentMetadata).toMatchObject({
      vectorOrigin: "adopted",
      vectorProfile: { name: "Legacy Agent v2", createdAt: formatTime(timeAt(200)) },
      nextVersionId: "2",
    });
    expect(v1.didDocument?.verificationMethod).toEqual([method(DID, LEGACY_OWNER)]);
  });

  test("versionTime before the cutoff slot: the legacy version, active; between the cutoff and the adoption: unaccountable", async () => {
    const b = adopted();
    const beforeCutoff = await resolveIn(b, DID, { versionTime: formatTime(timeAt(400)) });
    expect(beforeCutoff.didDocumentMetadata).toMatchObject({
      versionId: "1",
      vectorStatus: { status: "active", effective: "active" },
      vectorCurrent: { effective: "active" },
    });
    const beforeAdoption = await resolveIn(b, DID, { versionTime: formatTime(timeAt(550)) });
    expect(beforeAdoption.didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "suspended", effectiveReason: "unaccountable" });
    expect(httpStatus(beforeAdoption)).toBe(200);
  });

  test("an unconfirmed adoption: the view is the legacy base alone; the adoption is pending", async () => {
    const b = adopted(990);
    const result = await resolveIn(b, DID);
    const adoption = b.chain.txs.find((t) => t.mint.some((a) => a.policyId === IDENTITY.policyId))!;
    expect(result.didDocumentMetadata).toMatchObject({
      versionId: "1",
      vectorOrigin: "adopted",
      vectorPending: [adoption.txHash],
      vectorProfile: { name: "Legacy Agent v2" },
      vectorStatus: { status: "active", effective: "suspended", effectiveReason: "unaccountable" },
    });
    expect(result.didDocument?.verificationMethod).toEqual([method(DID, LEGACY_OWNER)]);
  });

  test("an unconfirmed adoption after pending legacy versions: those legacy versions reduce the view; the adoption waits", async () => {
    const b = new LedgerBuilder();
    b.legacyRegister(ID, legacyDatum(LEGACY_OWNER, { capabilities: [utf8("document-extraction"), utf8("ocr")] }), { height: 200, vkeys: [LEGACY_OWNER] });
    const update = b.legacyUpdate(ID, legacyDatum(LEGACY_OWNER_2, { capabilities: [utf8("ocr")] }), { height: 980, vkeys: [LEGACY_OWNER] });
    const adoption = b.adopt(ID, identityDatum({ createdAt: timeAt(990), capabilities: [utf8("document-extraction"), utf8("ocr")] }), {
      height: 990,
      vkeys: [LEGACY_OWNER_2, CONTROLLER],
    });
    const result = await resolveIn(b, DID);
    expect(result.didDocumentMetadata).toMatchObject({
      versionId: "0",
      vectorOrigin: "adopted",
      vectorPending: [update.txHash, adoption.txHash],
      vectorProfile: { name: "Legacy Agent", capabilities: ["ocr"] },
      vectorStatus: { status: "active", effective: "suspended", effectiveReason: "unaccountable" },
    });
    // The pending owner change removes the controller key; the adoption's controller does not count yet.
    expect(result.didDocument).toEqual({ "@context": "https://www.w3.org/ns/did/v1.1", id: DID });
    expect(result.didDocumentMetadata.vectorMetadataError).toBeUndefined();
    b.tip(1030);
    const confirmed = await resolveIn(b, DID);
    expect(confirmed.didDocumentMetadata).toMatchObject({ versionId: "2", vectorStatus: { effective: "active" } });
    expect(confirmed.didDocument?.capabilityInvocation).toEqual([ref(CONTROLLER)]);
  });

  test("the legacy form of a native identity record is NOT_FOUND; the canonical form has no equivalentId", async () => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum(), { height: 100 });
    expect(errorType(await resolveIn(b, LEGACY_DID))).toBe("NOT_FOUND");
    expect((await resolveIn(b, DID)).didDocumentMetadata.equivalentId).toBeUndefined();
  });
});

describe("current record accessor", () => {
  test("legacy record: the view, the effective status and the key that the search found", async () => {
    const lookup = await resolverFor(legacyRecord().tip(400)).currentRecord(ID);
    expect(lookup.found).toBe(true);
    if (!lookup.found) return;
    expect(lookup.record).toMatchObject({
      vectorId: ID,
      origin: "legacy",
      versionId: 0,
      effective: { status: "active", reason: null },
      deactivated: false,
      legacyControllerKey: LEGACY_OWNER,
      pending: [],
      created: timeAt(200),
    });
    expect(lookup.record.view.kind).toBe("legacy");
  });

  test("not found, and a malformed identifier", async () => {
    const r = resolverFor(new LedgerBuilder());
    expect(await r.currentRecord(idOf("nothing"))).toEqual({ found: false, reason: "no registry minted the identifier" });
    await expect(r.currentRecord("ABC")).rejects.toThrow(/64 lowercase hex/);
  });
});
