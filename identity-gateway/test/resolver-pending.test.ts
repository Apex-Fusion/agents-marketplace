import { describe, expect, test } from "vitest";
import { keyHash } from "../src/codec/keys.js";
import { formatTime } from "../src/resolve/time.js";
import { ed25519Key } from "./support/keys.js";
import {
  CONTROLLER,
  CONTROLLER_2,
  GUARDIAN_KEY,
  KEY_A,
  KEY_B,
  LedgerBuilder,
  PARTY_KEY,
  PARTY_KEY_2,
  identityDatum,
  idOf,
  keySigner,
  party,
  timeAt,
  utf8,
} from "./support/ledger.js";
import { didOf, method, ref, resolveIn, tombstoneOf } from "./support/resolve.js";

// Base: version 0 at height 100 (confirmed). Pending: versions at heights 980-995 (tip 1000, fewer than 30 confirmations).
const ID = idOf("pending");
const DID = didOf(ID);
const KEY_C = ed25519Key(50);

function base(overrides = {}): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(ID, identityDatum(overrides), { height: 100 });
  return b;
}

describe("view with pending versions", () => {
  test("keys: a new key waits for 30 confirmations; a removed key and a removed purpose apply at once", async () => {
    const b = base({
      keys: [
        { keyType: "Ed25519", key: KEY_A, purposes: 1 | 2 | 8, pop: null },
        { keyType: "Ed25519", key: KEY_B, purposes: 1, pop: null },
      ],
    });
    const pending = b.update(
      ID,
      identityDatum({
        keys: [
          { keyType: "Ed25519", key: KEY_A, purposes: 1, pop: null },
          { keyType: "Ed25519", key: KEY_C, purposes: 1 | 2, pop: null },
        ],
      }),
      { height: 980 },
    );
    const now = await resolveIn(b, DID);
    expect(now.didDocument).toEqual({
      "@context": "https://www.w3.org/ns/did/v1.1",
      id: DID,
      verificationMethod: [method(DID, CONTROLLER), method(DID, KEY_A)],
      capabilityInvocation: [ref(CONTROLLER)],
      authentication: [ref(KEY_A)],
    });
    expect(now.didDocumentMetadata).toMatchObject({
      versionId: "0",
      vectorPending: [pending.txHash],
      vectorKeys: [{ id: ref(KEY_A), type: "Ed25519", purposes: ["authentication"] }],
    });

    b.tip(1010);
    const confirmed = await resolveIn(b, DID);
    expect(confirmed.didDocument?.verificationMethod).toEqual([method(DID, CONTROLLER), method(DID, KEY_A), method(DID, KEY_C)]);
    expect(confirmed.didDocumentMetadata.vectorPending).toBeUndefined();
    expect(confirmed.didDocumentMetadata.versionId).toBe("1");
  });

  test("parties: new parties wait; removed parties and reduced rights apply at once; limits merge to the narrowest", async () => {
    const b = base({ parties: [party(), party({ role: "Responsible", signer: keySigner(PARTY_KEY_2), rights: 1 })] });
    b.update(
      ID,
      identityDatum({
        parties: [
          party({ rights: 1, notBefore: timeAt(50), notAfter: timeAt(6000) }),
          party({ role: "Guardian", signer: keySigner(GUARDIAN_KEY), rights: 4 }),
        ],
      }),
      { height: 980 },
    );
    b.update(ID, identityDatum({ parties: [party({ rights: 3, notAfter: timeAt(5000), removalAfter: timeAt(4000) })] }), { height: 985 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorParties).toEqual([
      {
        role: "accountable",
        signer: keyHash(PARTY_KEY),
        rights: ["suspend"],
        notBefore: formatTime(timeAt(50)),
        notAfter: formatTime(timeAt(5000)),
        removalAfter: formatTime(timeAt(4000)),
      },
    ]);
  });

  test("a pending removal of the last Accountable Party makes the record unaccountable at once", async () => {
    const b = base();
    b.update(ID, identityDatum({ parties: [party({ role: "Responsible", rights: 1 })] }), { height: 990 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "suspended", effectiveReason: "unaccountable" });
  });

  test("a hold set in a pending version suspends at once", async () => {
    const b = base();
    const hold = { by: keySigner(PARTY_KEY), reason: 9, since: timeAt(990), until: timeAt(1100) };
    b.update(ID, identityDatum({ status: { type: "Suspended", holds: [hold] } }), { height: 990 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({
      status: "suspended",
      effective: "suspended",
      holds: [{ by: keyHash(PARTY_KEY), reason: "privilegeWithdrawn", since: formatTime(timeAt(990)), until: formatTime(timeAt(1100)) }],
    });
  });

  test("a hold lifted in a pending version stays until the lift is confirmed", async () => {
    const hold = { by: keySigner(PARTY_KEY), reason: 6, since: timeAt(90), until: timeAt(1100) };
    const b = base({ status: { type: "Suspended", holds: [hold] } });
    b.update(ID, identityDatum(), { height: 990 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toMatchObject({ status: "suspended", effective: "suspended" });
    b.tip(1020);
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "active" });
  });

  test("holds merge: for each author the hold with the latest until (newest on a tie); base authors first, then new authors", async () => {
    const byController = { type: "ControllerSet" as const };
    const byParty = keySigner(PARTY_KEY);
    const b = base({ status: { type: "Suspended", holds: [{ by: byController, reason: 6, since: timeAt(90), until: timeAt(1100) }] } });
    b.update(
      ID,
      identityDatum({
        status: {
          type: "Suspended",
          holds: [
            { by: byParty, reason: 68, since: timeAt(980), until: timeAt(1300) },
            { by: byController, reason: 0, since: timeAt(980), until: timeAt(1200) },
          ],
        },
      }),
      { height: 980 },
    );
    b.update(ID, identityDatum({ status: { type: "Suspended", holds: [{ by: byController, reason: 65, since: timeAt(985), until: timeAt(1200) }] } }), {
      height: 985,
    });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus?.holds).toEqual([
      { by: "controller", reason: "legalOrder", since: formatTime(timeAt(985)), until: formatTime(timeAt(1200)) },
      { by: keyHash(PARTY_KEY), reason: "securityInvestigation", since: formatTime(timeAt(980)), until: formatTime(timeAt(1300)) },
    ]);
  });

  test("a pending controller change removes the controller key from the view", async () => {
    const b = base();
    b.update(ID, identityDatum({ controller: CONTROLLER_2, subagentEpoch: 1 }), { height: 990 });
    const doc = (await resolveIn(b, DID)).didDocument!;
    expect(doc.capabilityInvocation).toBeUndefined();
    expect(doc.verificationMethod).toEqual([method(DID, KEY_A)]);
  });

  test("a pending retirement is Suspended (deactivationPending)", async () => {
    const b = base();
    b.update(ID, tombstoneOf(identityDatum(), { type: "Retired", at: timeAt(990), successor: null }), { height: 990 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorStatus).toEqual({ status: "active", effective: "suspended", effectiveReason: "deactivationPending" });
  });

  test("pending recovery: the newest pending recovery of the base or a pending version", async () => {
    const guardians = { parties: [party(), party({ role: "Guardian" as const, signer: keySigner(GUARDIAN_KEY), rights: 4 })], guardianThreshold: 1 };
    const first = { newController: ed25519Key(60), effectiveAfter: timeAt(1500) };
    const b = base(guardians);
    b.update(ID, identityDatum({ ...guardians, pendingRecovery: first }), { height: 980 });
    b.update(ID, identityDatum(guardians), { height: 985 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorRecovery).toEqual({
      guardianThreshold: 1,
      pendingNewController: keyHash(first.newController),
      pendingEffectiveAfter: formatTime(timeAt(1500)),
    });
  });

  test("capabilities: only those that every pending version keeps; other profile fields from the base", async () => {
    const b = base({ capabilities: [utf8("a"), utf8("b")] });
    b.update(ID, identityDatum({ capabilities: [utf8("b"), utf8("c")], name: utf8("pending name") }), { height: 990 });
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorProfile).toMatchObject({ name: "test-agent", capabilities: ["b"] });
  });

  test("versionTime counts only transactions before the requested time", async () => {
    const b = base();
    const first = b.update(ID, identityDatum({ keys: [] }), { height: 980 });
    b.update(ID, identityDatum({ name: utf8("later") }), { height: 990 });
    const result = await resolveIn(b, DID, { versionTime: formatTime(timeAt(985)) });
    expect(result.didDocumentMetadata).toMatchObject({ versionId: "0", vectorPending: [first.txHash], vectorCurrent: { effective: "active" } });
    expect(result.didDocument?.authentication).toBeUndefined();
  });
});
