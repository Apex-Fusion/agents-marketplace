import { describe, expect, test } from "vitest";
import { encodeIdentityDatum } from "../src/codec/identity-datum.js";
import { keyHash } from "../src/codec/keys.js";
import { canonicalize } from "../src/resolve/jcs.js";
import { VectorResolver, httpStatus } from "../src/resolve/resolver.js";
import { formatTime } from "../src/resolve/time.js";
import { ed25519Key, p256Key } from "./support/keys.js";
import {
  CONTROLLER,
  CONTROLLER_2,
  GUARDIAN_KEY,
  KEY_A,
  KEY_B,
  LedgerBuilder,
  PARTY_KEY,
  identityDatum,
  idOf,
  keySigner,
  party,
  timeAt,
  utf8,
} from "./support/ledger.js";
import { didOf, errorType, method, ref, resolveIn, tombstoneOf } from "./support/resolve.js";

const ID = idOf("native");
const DID = didOf(ID);

describe("native record", () => {
  test("root agent: the document lists the controller key first, then the listed keys; metadata as Part 1 Section 8.2", async () => {
    const b = new LedgerBuilder();
    const p256 = p256Key(21);
    const datum = identityDatum({
      keys: [
        { keyType: "Ed25519", key: KEY_A, purposes: 1 | 2 | 8, pop: null },
        { keyType: "Ed25519", key: KEY_B, purposes: 16, pop: null },
        { keyType: "P256", key: p256.publicKey, purposes: 1 | 2, pop: p256.pop(ID) },
      ],
      parties: [party(), party({ role: "Guardian", signer: keySigner(GUARDIAN_KEY), rights: 4, organisation: utf8("example.org") })],
      guardianThreshold: 1,
    });
    const mint = b.register(ID, datum, { height: 100 });
    const result = await resolveIn(b, DID);

    expect(httpStatus(result)).toBe(200);
    expect(result.didResolutionMetadata).toEqual({ contentType: "application/did" });
    expect(result.didDocument).toEqual({
      "@context": "https://www.w3.org/ns/did/v1.1",
      id: DID,
      verificationMethod: [method(DID, CONTROLLER), method(DID, KEY_A), method(DID, KEY_B), method(DID, p256.publicKey, "P256")],
      capabilityInvocation: [ref(CONTROLLER)],
      authentication: [ref(KEY_A), ref(p256.publicKey)],
      assertionMethod: [ref(KEY_A), ref(p256.publicKey)],
      capabilityDelegation: [ref(KEY_B)],
    });
    expect(result.didDocumentMetadata).toEqual({
      created: formatTime(timeAt(100)),
      versionId: "0",
      canonicalId: DID,
      vectorOrigin: "native",
      vectorStatus: { status: "active", effective: "active" },
      vectorKeys: [
        { id: ref(KEY_A), type: "Ed25519", purposes: ["authentication", "assertion", "transaction"] },
        { id: ref(KEY_B), type: "Ed25519", purposes: ["delegation"] },
        { id: ref(p256.publicKey), type: "P-256", purposes: ["authentication", "assertion"] },
      ],
      vectorParties: [
        { role: "accountable", signer: keyHash(PARTY_KEY), rights: ["suspend", "revoke"], notBefore: "1970-01-01T00:00:00Z" },
        { role: "guardian", signer: keyHash(GUARDIAN_KEY), organisation: "example.org", rights: ["recover"], notBefore: "1970-01-01T00:00:00Z" },
      ],
      vectorRecovery: { guardianThreshold: 1 },
      vectorProfile: {
        name: "test-agent",
        description: "An agent for resolver tests.",
        framework: "vector-agent-template",
        endpoint: "https://agent.example.org/a2a",
        capabilities: ["ocr.extract.v1", "llm.text.generate.v1"],
        createdAt: formatTime(timeAt(100)),
      },
      vectorLedger: { txId: mint.txHash, outputIndex: 0, blockHash: mint.blockHash, blockHeight: 100, slot: 1000, confirmations: 900 },
    });
  });

  test("a controller key that is also a listed key appears once in verificationMethod", async () => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ keys: [{ keyType: "Ed25519", key: CONTROLLER, purposes: 1, pop: null }] }), { height: 100 });
    const doc = (await resolveIn(b, DID)).didDocument!;
    expect(doc.verificationMethod).toEqual([method(DID, CONTROLLER)]);
    expect(doc.capabilityInvocation).toEqual([ref(CONTROLLER)]);
    expect(doc.authentication).toEqual([ref(CONTROLLER)]);
    expect(doc.assertionMethod).toBeUndefined();
  });

  test("a mint with fewer than 30 confirmations does not resolve yet", async () => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum(), { height: 971 });
    expect(errorType(await resolveIn(b, DID))).toBe("NOT_FOUND");
    b.tip(1001);
    expect((await resolveIn(b, DID)).didDocumentMetadata.versionId).toBe("0");
  });

  test("versions: a datum change adds a version; a value-only change and a re-encoding of the same data do not", async () => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum(), { height: 100 });
    const update = b.update(ID, identityDatum({ name: utf8("renamed") }), { height: 200 });
    const cbor = Buffer.from(encodeIdentityDatum(identityDatum({ name: utf8("renamed") }))).toString("hex");
    // The same Plutus Data with a definite-length field array: d879 8e … instead of d879 9f … ff.
    const reencoded = b.updateRaw(ID, `${cbor.slice(0, 4)}8e${cbor.slice(6, -2)}`, { height: 250 });
    const reclaim = b.touch(ID, 7_000_000n, { height: 300 });
    expect(reencoded.outputs[0]!.inlineDatum).not.toBe(update.outputs[0]!.inlineDatum);

    const now = await resolveIn(b, DID);
    expect(now.didDocumentMetadata).toMatchObject({ versionId: "1", updated: formatTime(timeAt(200)), created: formatTime(timeAt(100)) });
    expect(now.didDocumentMetadata.nextVersionId).toBeUndefined();
    expect(now.didDocumentMetadata.vectorLedger).toEqual({
      txId: reclaim.txHash,
      outputIndex: 0,
      blockHash: reclaim.blockHash,
      blockHeight: 300,
      slot: 3000,
      confirmations: 700,
    });
    expect(now.didDocumentMetadata.vectorProfile?.name).toBe("renamed");

    const first = await resolveIn(b, DID, { versionId: "0" });
    expect(first.didDocumentMetadata).toMatchObject({ versionId: "0", nextVersionId: "1", vectorProfile: { name: "test-agent" } });
    expect(first.didDocumentMetadata.updated).toBeUndefined();
    expect(first.didDocumentMetadata.vectorLedger?.blockHeight).toBe(100);
    expect(errorType(await resolveIn(b, DID, { versionId: "2" }))).toBe("NOT_FOUND");
  });
});

describe("effective status", () => {
  test("suspended with holds by two authors", async () => {
    const b = new LedgerBuilder();
    const holds = [
      { by: { type: "ControllerSet" as const }, reason: 6, since: timeAt(900), until: timeAt(1100) },
      { by: keySigner(PARTY_KEY), reason: 68, since: timeAt(910), until: timeAt(1200) },
    ];
    b.register(ID, identityDatum({ status: { type: "Suspended", holds } }), { height: 100 });
    const result = await resolveIn(b, DID);
    expect(httpStatus(result)).toBe(200);
    expect(result.didDocument).not.toBeNull();
    expect(result.didDocumentMetadata.vectorStatus).toEqual({
      status: "suspended",
      effective: "suspended",
      holds: [
        { by: "controller", reason: "hold", since: formatTime(timeAt(900)), until: formatTime(timeAt(1100)) },
        { by: keyHash(PARTY_KEY), reason: "securityInvestigation", since: formatTime(timeAt(910)), until: formatTime(timeAt(1200)) },
      ],
    });
  });

  test("a hold that ended is shown, and the record is effectively active", async () => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ status: { type: "Suspended", holds: [{ by: { type: "ControllerSet" }, reason: 0, since: timeAt(900), until: timeAt(950) }] } }), {
      height: 100,
    });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toMatchObject({ status: "suspended", effective: "active" });
  });

  test.each([
    ["no party", []],
    ["a Responsible Party only", [party({ role: "Responsible", rights: 1 })]],
    ["an Accountable Party that starts after t", [party({ notBefore: timeAt(1001) })]],
    ["an Accountable Party that ended before t", [party({ notAfter: timeAt(999) })]],
  ])("unaccountable: %s", async (_name, parties) => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ parties }), { height: 100 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "suspended", effectiveReason: "unaccountable" });
  });

  test("an Accountable Party whose period covers t exactly keeps the record active", async () => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ parties: [party({ notBefore: timeAt(1000), notAfter: timeAt(1000) })] }), { height: 100 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus?.effective).toBe("active");
  });

  test("revoked: deactivated, 410, no document, tombstone fields in vectorStatus", async () => {
    const b = new LedgerBuilder();
    const datum = identityDatum();
    b.register(ID, datum, { height: 100 });
    const at = timeAt(299);
    b.update(ID, tombstoneOf(datum, { type: "Revoked", by: keySigner(PARTY_KEY), reason: 3, at, invalidFrom: null, successor: null }), { height: 300 });
    const result = await resolveIn(b, DID);
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).toBeNull();
    expect(result.didResolutionMetadata).toEqual({});
    expect(result.didDocumentMetadata).toMatchObject({
      deactivated: true,
      versionId: "1",
      vectorStatus: { status: "revoked", effective: "revoked", by: keyHash(PARTY_KEY), reason: "affiliationChanged", at: formatTime(at) },
      vectorProfile: { name: "test-agent", createdAt: formatTime(timeAt(100)) },
    });
    // Part 1 Section 8.2: the empty description, framework and endpoint of a tombstone are left out.
    expect(result.didDocumentMetadata.vectorProfile).toEqual({ name: "test-agent", createdAt: formatTime(timeAt(100)) });
    expect(result.didDocumentMetadata.vectorKeys).toBeUndefined();
    expect(result.didDocumentMetadata.vectorParties).toBeUndefined();
  });

  test("retired with a successor", async () => {
    const b = new LedgerBuilder();
    const datum = identityDatum();
    const successor = idOf("successor");
    b.register(ID, datum, { height: 100 });
    b.update(ID, tombstoneOf(datum, { type: "Retired", at: timeAt(300), successor }), { height: 300 });
    const result = await resolveIn(b, DID);
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocumentMetadata.vectorStatus).toEqual({ status: "retired", effective: "retired", at: formatTime(timeAt(300)), successor: didOf(successor) });
  });

  test("an unconfirmed revocation is Suspended (deactivationPending) until it has 30 confirmations", async () => {
    const b = new LedgerBuilder();
    const datum = identityDatum();
    b.register(ID, datum, { height: 100 });
    const revoke = b.update(ID, tombstoneOf(datum, { type: "Revoked", by: { type: "ControllerSet" }, reason: 5, at: timeAt(990), invalidFrom: null, successor: null }), {
      height: 990,
    });
    const pending = await resolveIn(b, DID);
    expect(httpStatus(pending)).toBe(200);
    expect(pending.didDocumentMetadata).toMatchObject({
      versionId: "0",
      vectorPending: [revoke.txHash],
      vectorStatus: { status: "active", effective: "suspended", effectiveReason: "deactivationPending" },
    });
    // The view keeps only what the tombstone also allows: the controller key, no listed keys, no parties.
    expect(pending.didDocument).toEqual({
      "@context": "https://www.w3.org/ns/did/v1.1",
      id: DID,
      verificationMethod: [method(DID, CONTROLLER)],
      capabilityInvocation: [ref(CONTROLLER)],
    });
    b.tip(1020);
    expect(httpStatus(await resolveIn(b, DID))).toBe(410);
  });

  test("an invalid-from time applies to earlier versions at or after that time", async () => {
    const b = new LedgerBuilder();
    const datum = identityDatum();
    b.register(ID, datum, { height: 100 });
    b.update(ID, identityDatum({ name: utf8("second") }), { height: 200 });
    b.update(ID, tombstoneOf(datum, { type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: timeAt(300), invalidFrom: timeAt(150), successor: null }), {
      height: 300,
    });

    const before = await resolveIn(b, DID, { versionId: "0" });
    expect(httpStatus(before)).toBe(410);
    expect(before.didDocument).not.toBeNull();
    expect(before.didDocumentMetadata).toMatchObject({
      deactivated: true,
      vectorCurrent: { effective: "revoked" },
      vectorStatus: { status: "active", effective: "active", invalidFrom: formatTime(timeAt(150)) },
    });

    const after = await resolveIn(b, DID, { versionId: "1" });
    expect(after.didDocument).toBeNull();
    expect(after.didDocumentMetadata.vectorStatus).toMatchObject({ status: "active", effective: "revoked", effectiveReason: "invalidated" });

    const between = await resolveIn(b, DID, { versionTime: formatTime(timeAt(170)) });
    expect(between.didDocumentMetadata).toMatchObject({ versionId: "0", vectorStatus: { effective: "revoked", effectiveReason: "invalidated" } });
  });

  test("P-256 keys: both forms of s verify; an invalid proof hides the key and sets keyProofInvalid", async () => {
    const low = p256Key(31);
    const high = p256Key(32);
    const wrong = p256Key(33);
    const b = new LedgerBuilder();
    b.register(
      ID,
      identityDatum({
        keys: [
          { keyType: "P256", key: low.publicKey, purposes: 1, pop: low.pop(ID, "low") },
          { keyType: "P256", key: high.publicKey, purposes: 2, pop: high.pop(ID, "high") },
          { keyType: "P256", key: wrong.publicKey, purposes: 1, pop: wrong.pop(idOf("another record")) },
        ],
      }),
      { height: 100 },
    );
    const result = await resolveIn(b, DID);
    expect(result.didDocument?.verificationMethod).toEqual([method(DID, CONTROLLER), method(DID, low.publicKey, "P256"), method(DID, high.publicKey, "P256")]);
    expect(result.didDocument?.authentication).toEqual([ref(low.publicKey)]);
    expect(result.didDocument?.assertionMethod).toEqual([ref(high.publicKey)]);
    expect(result.didDocumentMetadata.vectorKeys?.map((k) => k.id)).toEqual([ref(low.publicKey), ref(high.publicKey)]);
    expect(result.didDocumentMetadata.vectorMetadataError).toBe("keyProofInvalid");
    expect(result.didDocument?.verificationMethod?.[1]?.publicKeyMultibase.startsWith("zDn")).toBe(true);
  });

  test("a P-256 key whose point is not on the curve is left out", async () => {
    const b = new LedgerBuilder();
    const offCurve = `02${"00".repeat(31)}05`;
    b.register(ID, identityDatum({ keys: [{ keyType: "P256", key: offCurve, purposes: 1, pop: "11".repeat(64) }] }), { height: 100 });
    const result = await resolveIn(b, DID);
    expect(result.didDocument?.verificationMethod).toEqual([method(DID, CONTROLLER)]);
    expect(result.didDocumentMetadata.vectorMetadataError).toBe("keyProofInvalid");
  });

  test("text that is not valid UTF-8, or that holds a noncharacter or an encoded surrogate, is left out", async () => {
    const b = new LedgerBuilder();
    b.register(
      ID,
      identityDatum({
        name: Uint8Array.from([0x61, 0xff]),
        description: utf8("ok \u{FDD0}"),
        framework: Uint8Array.from([0xed, 0xa0, 0x80]),
        capabilities: [utf8("good"), utf8("bad\u{FFFE}"), Uint8Array.from([0xc0, 0xaf])],
        parties: [party({ organisation: Uint8Array.from([0xed, 0xbf, 0xbf]) })],
      }),
      { height: 100 },
    );
    const metadata = (await resolveIn(b, DID)).didDocumentMetadata;
    expect(metadata.vectorProfile).toEqual({ endpoint: "https://agent.example.org/a2a", capabilities: ["good"], createdAt: formatTime(timeAt(100)) });
    expect(metadata.vectorParties?.[0]?.organisation).toBeUndefined();
  });

  test("recovery: threshold and the pending new controller as a key hash", async () => {
    const b = new LedgerBuilder();
    const newController = ed25519Key(40);
    b.register(
      ID,
      identityDatum({
        parties: [party(), party({ role: "Guardian", signer: keySigner(GUARDIAN_KEY), rights: 4 })],
        guardianThreshold: 1,
        pendingRecovery: { newController, effectiveAfter: timeAt(1500) },
      }),
      { height: 100 },
    );
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorRecovery).toEqual({
      guardianThreshold: 1,
      pendingNewController: keyHash(newController),
      pendingEffectiveAfter: formatTime(timeAt(1500)),
    });
  });

  test("a Module-1 party and a removal notice are shown as script signer and removalAfter", async () => {
    const b = new LedgerBuilder();
    const module1 = "ab".repeat(28);
    b.register(
      ID,
      identityDatum({
        parties: [party({ signer: { type: "Script", hash: module1 }, removalAfter: timeAt(2000) }), party({ role: "Responsible", signer: { type: "ControllerSet" }, rights: 1, notAfter: timeAt(3000) })],
      }),
      { height: 100 },
    );
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorParties).toEqual([
      { role: "accountable", signer: `script:${module1}`, rights: ["suspend", "revoke"], notBefore: "1970-01-01T00:00:00Z", removalAfter: formatTime(timeAt(2000)) },
      { role: "responsible", signer: "controller", rights: ["suspend"], notBefore: "1970-01-01T00:00:00Z", notAfter: formatTime(timeAt(3000)) },
    ]);
  });
});

describe("subagents", () => {
  const PARENT = idOf("parent");
  const CHILD = idOf("child");
  const child = (overrides = {}) =>
    identityDatum({ lineage: { type: "Subagent", parent: PARENT, parentEpoch: 0, depth: 1 }, endpoint: new Uint8Array(), controller: CONTROLLER_2, ...overrides });

  function family(): LedgerBuilder {
    const b = new LedgerBuilder();
    b.register(PARENT, identityDatum(), { height: 100 });
    b.register(CHILD, child(), { height: 150 });
    return b;
  }

  test("an active parent: the child is active and names its parent", async () => {
    const result = await resolveIn(family(), didOf(CHILD));
    expect(result.didDocumentMetadata).toMatchObject({
      vectorStatus: { status: "active", effective: "active" },
      vectorParent: { parent: didOf(PARENT), parentEpoch: 0, depth: 1 },
    });
  });

  test("a suspended parent suspends the child (parentSuspended)", async () => {
    const b = family();
    b.update(PARENT, identityDatum({ status: { type: "Suspended", holds: [{ by: { type: "ControllerSet" }, reason: 6, since: timeAt(200), until: timeAt(5000) }] } }), {
      height: 200,
    });
    expect((await resolveIn(b, didOf(CHILD))).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "suspended", effectiveReason: "parentSuspended" });
  });

  test("an unaccountable parent suspends the child", async () => {
    const b = family();
    b.update(PARENT, identityDatum({ parties: [] }), { height: 200 });
    expect((await resolveIn(b, didOf(CHILD))).didDocumentMetadata.vectorStatus?.effectiveReason).toBe("parentSuspended");
  });

  test("a revoked parent revokes the child; a retired parent retires it", async () => {
    const revoked = family();
    revoked.update(PARENT, tombstoneOf(identityDatum(), { type: "Revoked", by: { type: "ControllerSet" }, reason: 5, at: timeAt(200), invalidFrom: null, successor: null }), {
      height: 200,
    });
    const r = await resolveIn(revoked, didOf(CHILD));
    expect(httpStatus(r)).toBe(410);
    expect(r.didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "revoked", effectiveReason: "parentRevoked" });

    const retired = family();
    retired.update(PARENT, tombstoneOf(identityDatum(), { type: "Retired", at: timeAt(200), successor: null }), { height: 200 });
    expect((await resolveIn(retired, didOf(CHILD))).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "retired", effectiveReason: "parentRetired" });
  });

  test("an epoch increase of the parent ends the child; a versionTime before it shows the child active, with vectorCurrent", async () => {
    const b = family();
    b.update(PARENT, identityDatum({ subagentEpoch: 1 }), { height: 400 });
    const now = await resolveIn(b, didOf(CHILD));
    expect(now.didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "revoked", effectiveReason: "parentRevoked" });
    const before = await resolveIn(b, didOf(CHILD), { versionTime: formatTime(timeAt(300)) });
    expect(httpStatus(before)).toBe(410);
    expect(before.didDocument).not.toBeNull();
    expect(before.didDocumentMetadata).toMatchObject({
      deactivated: true,
      vectorStatus: { effective: "active" },
      vectorCurrent: { effective: "revoked", effectiveReason: "parentRevoked" },
    });
  });

  test("the parent's invalid-from time applies to the child, also to child versions before the parent's revocation", async () => {
    const b = family();
    b.update(CHILD, child({ name: utf8("child v1") }), { height: 250 });
    b.update(PARENT, tombstoneOf(identityDatum(), { type: "Revoked", by: keySigner(PARTY_KEY), reason: 1, at: timeAt(400), invalidFrom: timeAt(200), successor: null }), {
      height: 400,
    });
    const v1 = await resolveIn(b, didOf(CHILD), { versionId: "1" });
    expect(v1.didDocument).toBeNull();
    expect(v1.didDocumentMetadata.vectorStatus).toEqual({
      status: "active",
      effective: "revoked",
      effectiveReason: "parentRevoked",
      invalidFrom: formatTime(timeAt(200)),
    });
    const v0 = await resolveIn(b, didOf(CHILD), { versionId: "0" });
    expect(v0.didDocument).not.toBeNull();
    expect(v0.didDocumentMetadata.vectorStatus?.effective).toBe("active");
    expect(v0.didDocumentMetadata.vectorCurrent).toEqual({ effective: "revoked", effectiveReason: "parentRevoked" });
  });

  test("a depth-4 subagent resolves through four ancestors", async () => {
    const b = new LedgerBuilder();
    const ids = [0, 1, 2, 3, 4].map((i) => idOf(`level ${i}`));
    b.register(ids[0]!, identityDatum(), { height: 100 });
    for (let depth = 1; depth <= 4; depth++) {
      b.register(ids[depth]!, identityDatum({ endpoint: new Uint8Array(), lineage: { type: "Subagent", parent: ids[depth - 1]!, parentEpoch: 0, depth } }), {
        height: 100 + depth * 10,
      });
    }
    b.update(ids[1]!, identityDatum({ endpoint: new Uint8Array(), lineage: { type: "Subagent", parent: ids[0]!, parentEpoch: 0, depth: 1 }, parties: [] }), {
      height: 300,
    });
    expect((await resolveIn(b, didOf(ids[4]!))).didDocumentMetadata.vectorStatus?.effectiveReason).toBe("parentSuspended");
    expect((await resolveIn(b, didOf(ids[1]!))).didDocumentMetadata.vectorStatus?.effectiveReason).toBe("unaccountable");
  });

  test("a subagent whose parent does not resolve is INTERNAL_ERROR, never a partial document", async () => {
    const b = new LedgerBuilder();
    b.register(CHILD, child(), { height: 150 });
    expect(errorType(await resolveIn(b, didOf(CHILD)))).toBe("INTERNAL_ERROR");
  });
});

describe("values from background fetches", () => {
  test("alsoKnownAs, organisationVerified, protocol and vectorFetched come only from the stored facts", async () => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum({ parties: [party({ organisation: utf8("example.org") }), party({ role: "Responsible", rights: 1, organisation: utf8("other.org") })] }), {
      height: 100,
    });
    const fetched = { url: "https://example.org/.well-known/did-configuration.json", fetchedAt: "2025-08-29T18:00:00Z", sha256: "ab".repeat(32) };
    const resolver = new VectorResolver(b.chain, b.settings, {
      fetchedFacts: (vectorId) =>
        vectorId === ID ? { alsoKnownAs: ["https://example.org"], verifiedOrganisations: ["example.org"], protocol: "a2a", fetched: [fetched] } : undefined,
    });
    const result = await resolver.resolveDid(DID);
    expect(result.didDocument?.alsoKnownAs).toEqual(["https://example.org"]);
    expect(result.didDocumentMetadata.vectorParties?.map((p) => p.organisationVerified)).toEqual([true, undefined]);
    expect(result.didDocumentMetadata.vectorProfile?.protocol).toBe("a2a");
    expect(result.didDocumentMetadata.vectorFetched).toEqual([fetched]);

    const plain = await resolveIn(b, DID);
    expect(plain.didDocument?.alsoKnownAs).toBeUndefined();
    expect(plain.didDocumentMetadata.vectorFetched).toBeUndefined();
    expect(plain.didDocumentMetadata.vectorProfile?.protocol).toBeUndefined();
  });
});

describe("determinism", () => {
  test("the same tip gives byte-identical results, whatever order the source returns transactions in", async () => {
    const build = () => {
      const b = new LedgerBuilder();
      b.register(ID, identityDatum(), { height: 100 });
      b.update(ID, identityDatum({ keys: [] }), { height: 200 });
      b.update(ID, identityDatum({ name: utf8("x") }), { height: 990 });
      return b;
    };
    const first = canonicalize(await resolveIn(build(), DID));
    const reordered = build();
    reordered.chain.txs.reverse();
    expect(canonicalize(await resolveIn(reordered, DID))).toBe(first);
    expect(canonicalize(JSON.parse(first))).toBe(first);
  });

  test("transactions after the tip that the source already lists do not change the result", async () => {
    const b = new LedgerBuilder();
    b.register(ID, identityDatum(), { height: 100 });
    const before = canonicalize(await resolveIn(b, DID));
    b.update(ID, identityDatum({ parties: [] }), { height: 1001 });
    expect(canonicalize(await resolveIn(b, DID))).toBe(before);
  });
});
