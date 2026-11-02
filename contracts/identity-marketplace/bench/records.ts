/**
 * The records, keys and times of the benchmarks (Part 2 §12.4).
 *
 * The largest record has 8 keys (5 Ed25519 with every purpose, 3 P-256 with a
 * 64-byte `pop`), 8 parties (Module-1 and 7 key parties with 64-byte
 * organisations), 10 holds, 16 capabilities of 64 bytes and the longest
 * profile (name 64, description 256, framework 64, endpoint 256 bytes): the
 * layout of `largest()` in `lib/identity_marketplace/identity/kit.ak`, with
 * real test keys, because every Ed25519 key and every party signs at creation.
 * The contract does not check `pop` signatures, so the P-256 points and their
 * `pop` are filler bytes of the right length.
 */
import {
  identityDatumToData,
  type Hold,
  type IdentityDatum,
  type Key,
  type Party,
  type PlutusData,
  type Signer,
} from "@marketplace/shared/cbor";
import { constr, dataMap, fromHex, posixMsToSlot, toHex, type Data } from "../../../tests/legacy-registry/harness/index.js";
import { M1, wallet, type Wallet } from "./scripts.js";

/** Plutus Data of the shared codecs as the harness writes it (the same bytes). */
export function toData(pd: PlutusData): Data {
  switch (pd.kind) {
    case "constr":
      return constr(Number(pd.index), ...pd.fields.map(toData));
    case "list":
      return pd.items.map(toData);
    case "map":
      return dataMap(pd.entries.map(([key, value]) => [toData(key), toData(value)] as const));
    case "int":
      return pd.value;
    case "bytes":
      return fromHex(pd.hex);
  }
}

export const recordData = (d: IdentityDatum): Data => toData(identityDatumToData(d));

// ─── Times ───────────────────────────────────────────────────────────────

export const DAY = 86_400_000;
/** 2026-11-02T00:00:00Z. */
export const LO = 1_793_577_600_000;
/** `LO` + 10 minutes. */
export const HI = LO + 600_000;
/** The validity interval `[LO, HI]` in slots. */
export const VALIDITY = { invalidBefore: posixMsToSlot(BigInt(LO)), invalidHereafter: posixMsToSlot(BigInt(HI)) } as const;
export const CREATED_AT = LO - 90 * DAY;
export const MAX_TIME = 253_402_300_799_999;

// ─── Keys ────────────────────────────────────────────────────────────────

export const CONTROLLER = wallet("controller");
export const NEW_CONTROLLER = wallet("new controller");
/** The controller of the successor record and of the subagent's ancestors. */
export const OTHER_CONTROLLER = wallet("other controller");
/** Listed Ed25519 keys 1 to 6. */
export const LISTED: readonly Wallet[] = [1, 2, 3, 4, 5, 6].map((n) => wallet(`listed key ${n}`));
/** Key parties 1 to 13 (11 to 13 are guardians). */
export const PARTY: readonly Wallet[] = Array.from({ length: 14 }, (_, n) => wallet(`party ${n}`));

export const publicKey = (w: Wallet): string => toHex(w.key.publicKey);
export const keyHashOf = (w: Wallet): string => toHex(w.key.keyHash);

const filled = (bytes: number, byte: number): string => byte.toString(16).padStart(2, "0").repeat(bytes);

export const ed25519 = (w: Wallet, purposes = 27): Key => ({ keyType: "Ed25519", key: publicKey(w), purposes, pop: null });
export const p256 = (n: number, purposes = 3): Key => ({ keyType: "P256", key: `02${filled(32, 0xa0 + n)}`, purposes, pop: filled(64, 0x50) });

export const keySigner = (w: Wallet): Signer => ({ type: "KeyHash", hash: keyHashOf(w) });
export const MODULE1: Signer = { type: "Script", hash: toHex(M1) };
export const CONTROLLER_SET: Signer = { type: "ControllerSet" };

/** A party with a 64-byte organisation that started 30 days before `LO` and ends 400 days after it. */
export function fullParty(role: Party["role"], signer: Signer, rights: number, notice: boolean): Party {
  return {
    role,
    signer,
    organisation: filled(64, 0x6f),
    notBefore: LO - 30 * DAY,
    notAfter: LO + 400 * DAY,
    rights,
    removalAfter: notice ? LO + 400 * DAY : null,
  };
}

/** Module-1 as Module-1 consents to it: Accountable, both rights, no end and no notice. */
export const MODULE1_PARTY: Party = {
  role: "Accountable",
  signer: MODULE1,
  organisation: null,
  notBefore: LO - 30 * DAY,
  notAfter: null,
  rights: 3,
  removalAfter: null,
};

/** A hold that ends `daysAfterLo` days after `LO` (lapsed when 0 or less), 7 days long. */
export const hold = (by: Signer, daysAfterLo: number, reason = 6): Hold => ({
  by,
  reason,
  since: LO + (daysAfterLo - 7) * DAY,
  until: LO + daysAfterLo * DAY,
});

// ─── The largest record ──────────────────────────────────────────────────

/** 5 Ed25519 keys with every purpose (listed keys 1 to 5), 3 P-256 keys. */
export const EIGHT_KEYS: readonly Key[] = [...LISTED.slice(0, 5).map((w) => ed25519(w)), p256(1), p256(2), p256(3)];

/** Module-1 and seven key parties (1 to 7), each with the suspend right; party 7 has no removal notice. */
export const LARGEST_PARTIES: readonly Party[] = [
  MODULE1_PARTY,
  fullParty("Accountable", keySigner(PARTY[1]!), 3, true),
  fullParty("Accountable", keySigner(PARTY[2]!), 3, true),
  fullParty("Responsible", keySigner(PARTY[3]!), 1, true),
  fullParty("Responsible", keySigner(PARTY[4]!), 1, true),
  fullParty("Provider", keySigner(PARTY[5]!), 1, true),
  fullParty("Provider", keySigner(PARTY[6]!), 1, true),
  fullParty("Provider", keySigner(PARTY[7]!), 1, false),
];

/** 10 holds in force: the controller, Module-1, the seven key parties and a removed key party (8). */
export const LARGEST_HOLDS: readonly Hold[] = [
  hold(CONTROLLER_SET, 5),
  hold(MODULE1, 20, 64),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => hold(keySigner(PARTY[n]!), 5)),
];

/** 16 distinct capabilities of 64 bytes. */
export const LONG_CAPABILITIES: readonly string[] = Array.from({ length: 16 }, (_, i) => `${filled(1, 16 - i)}${filled(63, 0x63)}`);

/** Name 64 bytes, description 256, framework 64, endpoint 256 and 16 capabilities of 64 bytes. */
export const LONGEST_PROFILE: Pick<IdentityDatum, "name" | "description" | "framework" | "endpoint" | "capabilities"> = {
  name: filled(64, 0x6e),
  description: filled(256, 0x64),
  framework: filled(64, 0x66),
  endpoint: filled(256, 0x65),
  capabilities: [...LONG_CAPABILITIES],
};

export const LARGEST: IdentityDatum = {
  controller: publicKey(CONTROLLER),
  keys: [...EIGHT_KEYS],
  parties: [...LARGEST_PARTIES],
  guardianThreshold: 0,
  pendingRecovery: null,
  lineage: { type: "Root" },
  subagentEpoch: 0,
  ...LONGEST_PROFILE,
  createdAt: CREATED_AT,
  status: { type: "Suspended", holds: [...LARGEST_HOLDS] },
};

/** The largest record with guardians: Module-1, four key parties and the guardians 11 to 13, threshold 3. */
export const LARGEST_GUARDED: IdentityDatum = {
  ...LARGEST,
  parties: [
    MODULE1_PARTY,
    fullParty("Accountable", keySigner(PARTY[1]!), 3, true),
    fullParty("Responsible", keySigner(PARTY[2]!), 1, true),
    fullParty("Provider", keySigner(PARTY[3]!), 1, true),
    fullParty("Provider", keySigner(PARTY[4]!), 1, true),
    fullParty("Guardian", keySigner(PARTY[11]!), 4, true),
    fullParty("Guardian", keySigner(PARTY[12]!), 4, true),
    fullParty("Guardian", keySigner(PARTY[13]!), 4, true),
  ],
  guardianThreshold: 3,
};

/** The largest record with every hold lapsed: status Suspended, effective status Active. */
export const LARGEST_LAPSED: IdentityDatum = {
  ...LARGEST,
  status: { type: "Suspended", holds: LARGEST_HOLDS.map((h) => ({ ...h, since: h.since - 30 * DAY, until: LO - DAY })) },
};

/** The tombstone of `d` with `status` (Part 2 §3.7). */
export function tombstone(d: IdentityDatum, status: IdentityDatum["status"]): IdentityDatum {
  return {
    ...d,
    keys: [],
    parties: [],
    guardianThreshold: 0,
    pendingRecovery: null,
    description: "",
    framework: "",
    endpoint: "",
    capabilities: [],
    status,
  };
}

/** A live root record (small) of another agent, controlled by `OTHER_CONTROLLER`: the successor. */
export const SUCCESSOR_RECORD: IdentityDatum = {
  controller: publicKey(OTHER_CONTROLLER),
  keys: [],
  parties: [{ ...MODULE1_PARTY, signer: CONTROLLER_SET }],
  guardianThreshold: 0,
  pendingRecovery: null,
  lineage: { type: "Root" },
  subagentEpoch: 0,
  name: filled(5, 0x73),
  description: "",
  framework: "",
  endpoint: "",
  capabilities: [],
  createdAt: CREATED_AT,
  status: { type: "Active" },
};

// ─── The largest record for Claim and Submit ─────────────────────────────

/** The supplier key of the escrow benchmarks: listed last, with every purpose. */
export const SUPPLIER = wallet("supplier");

/**
 * The largest record of the escrow benchmarks (the layout of
 * `largest_record()` in `lib/identity_marketplace/escrow/fixtures.ak`): 7 P-256
 * keys, then the supplier key; 8 parties with the Accountable Party last; 10
 * lapsed holds (effective status Active); 16 capabilities with the escrow's
 * capability last; a pending recovery; the longest profile. Every search of
 * Claim and Submit reads the whole list.
 */
export const ESCROW_RECORD: IdentityDatum = {
  controller: publicKey(CONTROLLER),
  keys: [1, 2, 3, 4, 5, 6, 7].map((n) => p256(n)).concat([ed25519(SUPPLIER)]),
  parties: [
    fullParty("Responsible", keySigner(PARTY[1]!), 1, true),
    fullParty("Provider", keySigner(PARTY[2]!), 1, true),
    fullParty("Distributor", keySigner(PARTY[3]!), 0, true),
    fullParty("Guardian", keySigner(PARTY[4]!), 4, true),
    fullParty("Guardian", keySigner(PARTY[5]!), 4, true),
    fullParty("Guardian", keySigner(PARTY[6]!), 4, true),
    fullParty("Responsible", keySigner(PARTY[7]!), 1, true),
    fullParty("Accountable", keySigner(PARTY[8]!), 3, true),
  ],
  guardianThreshold: 3,
  pendingRecovery: { newController: publicKey(NEW_CONTROLLER), effectiveAfter: MAX_TIME },
  lineage: { type: "Root" },
  subagentEpoch: 9,
  ...LONGEST_PROFILE,
  createdAt: CREATED_AT,
  status: {
    type: "Suspended",
    holds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => hold(keySigner(wallet(`escrow hold ${n}`)), 0)),
  },
};

/** The escrow's capability: the last capability of `ESCROW_RECORD`. */
export const ESCROW_CAPABILITY = LONG_CAPABILITIES[15]!;
