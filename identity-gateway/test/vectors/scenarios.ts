// The DID-document vector set of Part 2 Section 12.4. Each scenario is a ledger history and the
// requests to resolve against it; generate.ts turns them into the published JSON files.

import { formatTime } from "../../src/resolve/time.js";
import { p256PopValid } from "../../src/codec/keys.js";
import { p256Key } from "../support/keys.js";
import {
  CONTROLLER,
  CONTROLLER_2,
  CUTOFF_HEIGHT,
  GUARDIAN_KEY,
  KEY_A,
  KEY_B,
  LEGACY,
  LEGACY_OWNER,
  LedgerBuilder,
  PARTY_KEY,
  PARTY_KEY_2,
  identityDatum,
  idOf,
  keySigner,
  legacyDatum,
  party,
  timeAt,
  utf8,
} from "../support/ledger.js";
import { tombstoneOf } from "../support/resolve.js";

/** ES256 is randomised; this proof was made once with p256Key(101), so the files stay stable between runs. */
const ROOT_AGENT_POP =
  "8d909f829189a90eb00a8f8ad81c88ca09655b4ee88226071dea9b780940e2c70619e6b542d3bbf4348e7f655f449fd41a9af17194b41702960e6ea3de332ff8";

export interface VectorRequest {
  readonly did: string;
  readonly options?: Readonly<Record<string, string>>;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly builder: LedgerBuilder;
  readonly requests: readonly VectorRequest[];
}

const did = (id: string) => `did:vector:${id}`;
const legacyForm = (id: string) => `did:vector:agent:${LEGACY.policyId}:${id}`;

const guardianParties = [
  party(),
  party({ role: "Guardian", signer: keySigner(GUARDIAN_KEY), rights: 4, organisation: utf8("guardians.example.org") }),
];

export function scenarios(): Scenario[] {
  const list: Scenario[] = [];

  {
    const id = idOf("vector root agent");
    const b = new LedgerBuilder();
    const p256 = p256Key(101);
    if (!p256PopValid(id, p256.publicKey, ROOT_AGENT_POP)) throw new Error("the pinned P-256 proof no longer verifies");
    b.register(
      id,
      identityDatum({
        keys: [
          { keyType: "Ed25519", key: CONTROLLER, purposes: 1, pop: null },
          { keyType: "Ed25519", key: KEY_A, purposes: 1 | 2 | 8, pop: null },
          { keyType: "Ed25519", key: KEY_B, purposes: 16, pop: null },
          { keyType: "P256", key: p256.publicKey, purposes: 2, pop: ROOT_AGENT_POP },
        ],
        parties: guardianParties,
        guardianThreshold: 1,
      }),
      { height: 100 },
    );
    list.push({
      name: "root-agent",
      description: "A native root agent: the controller key is also listed; Ed25519 and P-256 keys with every relationship; an Accountable Party and a guardian.",
      builder: b,
      requests: [{ did: did(id) }, { did: did(id), options: { expandRelativeUrls: "true" } }],
    });
  }

  {
    const parent = idOf("vector parent");
    const child = idOf("vector subagent");
    const b = new LedgerBuilder();
    b.register(parent, identityDatum(), { height: 100 });
    b.register(child, identityDatum({ controller: CONTROLLER_2, endpoint: new Uint8Array(), lineage: { type: "Subagent", parent, parentEpoch: 0, depth: 1 } }), {
      height: 150,
    });
    list.push({
      name: "subagent",
      description: "A depth-1 subagent of an active parent; the parent's epoch equals the subagent's parent_epoch.",
      builder: b,
      requests: [{ did: did(child) }, { did: did(parent) }],
    });
  }

  {
    const id = idOf("vector suspended");
    const b = new LedgerBuilder();
    b.register(id, identityDatum({ parties: [party(), party({ role: "Responsible", signer: keySigner(PARTY_KEY_2), rights: 1 })] }), { height: 100 });
    b.update(
      id,
      identityDatum({
        parties: [party(), party({ role: "Responsible", signer: keySigner(PARTY_KEY_2), rights: 1 })],
        status: {
          type: "Suspended",
          holds: [
            { by: { type: "ControllerSet" }, reason: 6, since: timeAt(900), until: timeAt(1100) },
            { by: keySigner(PARTY_KEY_2), reason: 68, since: timeAt(910), until: timeAt(1200) },
          ],
        },
      }),
      { height: 910 },
    );
    list.push({
      name: "suspended-two-authors",
      description: "A suspended agent with holds by two authors (the controller and a Responsible Party), both in force at the tip.",
      builder: b,
      requests: [{ did: did(id) }, { did: did(id), options: { versionId: "0" } }],
    });
  }

  {
    const id = idOf("vector unaccountable");
    const b = new LedgerBuilder();
    b.register(id, identityDatum({ parties: [party({ notAfter: timeAt(800) }), party({ role: "Responsible", signer: keySigner(PARTY_KEY_2), rights: 1 })] }), {
      height: 100,
    });
    list.push({
      name: "unaccountable",
      description: "An agent whose only Accountable Party ended before the tip: Suspended (unaccountable).",
      builder: b,
      requests: [{ did: did(id) }, { did: did(id), options: { versionTime: formatTime(timeAt(700)) } }],
    });
  }

  {
    const id = idOf("vector revoked");
    const b = new LedgerBuilder();
    const datum = identityDatum();
    b.register(id, datum, { height: 100 });
    b.update(id, identityDatum({ name: utf8("revoked-agent") }), { height: 200 });
    b.update(
      id,
      tombstoneOf(identityDatum({ name: utf8("revoked-agent") }), {
        type: "Revoked",
        by: keySigner(PARTY_KEY),
        reason: 1,
        at: timeAt(300),
        invalidFrom: timeAt(150),
        successor: null,
      }),
      { height: 300 },
    );
    list.push({
      name: "revoked-invalid-from",
      description:
        "An agent that its Accountable Party revoked for key compromise, invalid from a time between version 0 and version 1. Version 0 keeps its document; version 1 is invalidated.",
      builder: b,
      requests: [{ did: did(id) }, { did: did(id), options: { versionId: "0" } }, { did: did(id), options: { versionId: "1" } }],
    });
  }

  {
    const id = idOf("vector retired");
    const successor = idOf("vector successor");
    const b = new LedgerBuilder();
    b.register(successor, identityDatum({ controller: CONTROLLER_2 }), { height: 120 });
    b.register(id, identityDatum(), { height: 100 });
    b.update(id, tombstoneOf(identityDatum(), { type: "Retired", at: timeAt(400), successor }), { height: 400 });
    list.push({
      name: "retired-successor",
      description: "An agent that its controller retired, naming a live root agent as successor.",
      builder: b,
      requests: [{ did: did(id) }, { did: did(id), options: { versionTime: formatTime(timeAt(300)) } }],
    });
  }

  {
    const id = idOf("vector adopted");
    const b = new LedgerBuilder();
    b.legacyRegister(id, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    b.legacyUpdate(id, legacyDatum(LEGACY_OWNER, { name: utf8("Legacy Agent v2") }), { height: 300, vkeys: [LEGACY_OWNER] });
    b.adopt(id, identityDatum({ createdAt: timeAt(600) }), { height: 600, vkeys: [LEGACY_OWNER, CONTROLLER] });
    list.push({
      name: "adopted",
      description:
        "A legacy record (versions 0 and 1) adopted after the cutoff slot (version 2). Resolved in the canonical and the legacy form, and at times before the cutoff slot and before the adoption.",
      builder: b,
      requests: [
        { did: did(id) },
        { did: legacyForm(id) },
        { did: did(id), options: { versionTime: formatTime(timeAt(400)) } },
        { did: did(id), options: { versionTime: formatTime(timeAt(550)) } },
      ],
    });
  }

  {
    const id = idOf("vector deregistered");
    const b = new LedgerBuilder();
    b.legacyRegister(id, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    b.legacyDeregister(id, { height: 450, vkeys: [LEGACY_OWNER] });
    list.push({
      name: "legacy-deregistered",
      description: "A legacy record that its owner deregistered: a version with status Retired; the DID is deactivated.",
      builder: b,
      requests: [{ did: legacyForm(id) }, { did: legacyForm(id), options: { versionId: "0" } }],
    });
  }

  {
    const id = idOf("vector pending");
    const b = new LedgerBuilder();
    b.register(
      id,
      identityDatum({
        keys: [
          { keyType: "Ed25519", key: KEY_A, purposes: 1 | 2, pop: null },
          { keyType: "Ed25519", key: KEY_B, purposes: 1, pop: null },
        ],
        parties: [party(), party({ role: "Responsible", signer: keySigner(PARTY_KEY_2), rights: 1 })],
      }),
      { height: 100 },
    );
    b.update(
      id,
      identityDatum({
        keys: [
          { keyType: "Ed25519", key: KEY_A, purposes: 1, pop: null },
          { keyType: "Ed25519", key: CONTROLLER_2, purposes: 3, pop: null },
        ],
        parties: [party({ rights: 1 }), party({ role: "Guardian", signer: keySigner(GUARDIAN_KEY), rights: 4 })],
        capabilities: [utf8("ocr.extract.v1")],
      }),
      { height: 985 },
    );
    b.update(
      id,
      identityDatum({
        keys: [{ keyType: "Ed25519", key: KEY_A, purposes: 1 | 2, pop: null }],
        parties: [party({ rights: 1 })],
        status: { type: "Suspended", holds: [{ by: keySigner(PARTY_KEY), reason: 9, since: timeAt(990), until: timeAt(1300) }] },
      }),
      { height: 990 },
    );
    list.push({
      name: "pending-versions",
      description:
        "A confirmed base with two pending versions: a removed key, a reduced purpose, a new key, a removed party, reduced rights, a new guardian, a removed capability and a new hold. The view applies only the reductions.",
      builder: b,
      requests: [{ did: did(id) }],
    });
  }

  {
    const id = idOf("vector legacy");
    const late = idOf("vector late legacy");
    const before = new LedgerBuilder().tip(CUTOFF_HEIGHT - 50);
    before.legacyRegister(id, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    list.push({
      name: "legacy-before-cutoff",
      description: "A legacy record resolved at a tip before the cutoff slot: active, with the owner key from its registration witness.",
      builder: before,
      requests: [{ did: did(id) }, { did: legacyForm(id) }],
    });
    const after = new LedgerBuilder();
    after.legacyRegister(id, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    after.legacyRegister(late, legacyDatum(), { height: CUTOFF_HEIGHT + 10, vkeys: [LEGACY_OWNER] });
    list.push({
      name: "legacy-after-cutoff",
      description:
        "The same legacy record at a tip after the cutoff slot: Suspended (unaccountable). A legacy identifier minted after the cutoff slot is NOT_FOUND.",
      builder: after,
      requests: [{ did: did(id) }, { did: did(late) }],
    });
  }

  return list;
}
