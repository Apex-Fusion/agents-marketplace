// The view (Part 1 Section 7.2): the base version, with only those changes of the pending versions
// that reduce what the record allows.

import {
  signerEquals,
  type Hold,
  type IdentityDatum,
  type KeyType,
  type Lineage,
  type Party,
  type PendingRecovery,
  type Status,
} from "../codec/identity-datum.js";
import { keyHash, p256PopValid } from "../codec/keys.js";
import type { LegacyOwner } from "../codec/legacy-datum.js";
import type { LegacyDatumError, Version } from "./history.js";

export interface ViewKey {
  readonly keyType: KeyType;
  readonly key: string;
  readonly keyHash: string;
  /** The purposes that the base and every pending version give the key. */
  readonly purposes: number;
  readonly pop: string | null;
  /** Ed25519 keys: always true. P-256 keys: the pop verifies (Part 1 Section 8.1). */
  readonly popValid: boolean;
}

export interface IdentityView {
  readonly kind: "identity";
  /** The controller key (hex), or null when a pending version changes it. */
  readonly controller: string | null;
  readonly keys: readonly ViewKey[];
  readonly parties: readonly Party[];
  readonly guardianThreshold: number;
  readonly pendingRecovery: PendingRecovery | null;
  readonly lineage: Lineage;
  readonly subagentEpoch: number;
  readonly name: Uint8Array;
  readonly description: Uint8Array;
  readonly framework: Uint8Array;
  readonly endpoint: Uint8Array;
  readonly capabilities: readonly Uint8Array[];
  /** POSIX milliseconds. */
  readonly createdAt: number;
  readonly status: Status;
}

export interface LegacyProfile {
  readonly name: Uint8Array;
  readonly description: Uint8Array;
  readonly framework: Uint8Array;
  readonly endpoint: Uint8Array;
  readonly capabilities: readonly Uint8Array[];
}

export interface LegacyView {
  readonly kind: "legacy";
  /** The owner of the base, or null when the view has no controller (a pending version differs, or the datum is unreadable). */
  readonly owner: LegacyOwner | null;
  readonly datumError: LegacyDatumError | null;
  /** Null when the base has no readable datum (also for the end of the record). */
  readonly profile: LegacyProfile | null;
  /** The end of the record (POSIX milliseconds), when the view is that version. */
  readonly endedAt: number | null;
}

export type RecordView = IdentityView | LegacyView;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0;

/** Earliest of two optional limits; an empty value is no limit. */
function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

const holdsOf = (status: Status): readonly Hold[] => (status.type === "Suspended" ? status.holds : []);
const isLive = (status: Status): boolean => status.type === "Active" || status.type === "Suspended";

/** Holds row of the view table: for each author, the hold with the latest `until`; on a tie, the newer version's. */
function mergeHolds(statuses: readonly Status[]): Hold[] {
  const chosen: Hold[] = [];
  for (const status of statuses) {
    for (const hold of holdsOf(status)) {
      const i = chosen.findIndex((h) => signerEquals(h.by, hold.by));
      if (i < 0) chosen.push(hold);
      else if (hold.until >= chosen[i]!.until) chosen[i] = hold;
    }
  }
  return chosen;
}

function identityView(vectorId: string, base: Version, pending: readonly Version[]): IdentityView {
  if (base.content.kind !== "identity") throw new Error("identity view of a legacy version");
  const b = base.content.datum;
  const p: IdentityDatum[] = [];
  for (const v of pending) {
    if (v.content.kind !== "identity") throw new Error("identity view with a legacy pending version");
    p.push(v.content.datum);
  }

  const keys: ViewKey[] = [];
  for (const k of b.keys) {
    const later = p.map((d) => d.keys.find((x) => x.key === k.key));
    if (later.some((x) => x === undefined)) continue;
    const purposes = later.reduce((acc, x) => acc & x!.purposes, k.purposes);
    const popValid = k.keyType === "Ed25519" || p256PopValid(vectorId, k.key, k.pop);
    keys.push({ keyType: k.keyType, key: k.key, keyHash: keyHash(k.key), purposes, pop: k.pop, popValid });
  }

  const parties: Party[] = [];
  for (const party of b.parties) {
    const later = p.map((d) => d.parties.find((x) => x.role === party.role && signerEquals(x.signer, party.signer)));
    if (later.some((x) => x === undefined)) continue;
    parties.push(
      later.reduce<Party>(
        (acc, x) => ({
          ...acc,
          rights: acc.rights & x!.rights,
          notBefore: Math.max(acc.notBefore, x!.notBefore),
          notAfter: earliest(acc.notAfter, x!.notAfter),
          removalAfter: earliest(acc.removalAfter, x!.removalAfter),
        }),
        party,
      ),
    );
  }

  const holds = mergeHolds([b.status, ...p.map((d) => d.status)]);
  const status: Status = isLive(b.status) && holds.length > 0 ? { type: "Suspended", holds } : b.status;
  const pendingRecovery = [...p].reverse().find((d) => d.pendingRecovery !== null)?.pendingRecovery ?? b.pendingRecovery;

  return {
    kind: "identity",
    controller: p.every((d) => d.controller === b.controller) ? b.controller : null,
    keys,
    parties,
    guardianThreshold: b.guardianThreshold,
    pendingRecovery,
    lineage: b.lineage,
    subagentEpoch: b.subagentEpoch,
    name: b.name,
    description: b.description,
    framework: b.framework,
    endpoint: b.endpoint,
    capabilities: b.capabilities.filter((c) => p.every((d) => d.capabilities.some((x) => sameBytes(x, c)))),
    createdAt: b.createdAt,
    status,
  };
}

function legacyView(base: Version, pending: readonly Version[]): LegacyView {
  if (base.content.kind === "legacyEnd") return { kind: "legacy", owner: null, datumError: null, profile: null, endedAt: base.made.timeMs };
  if (base.content.kind !== "legacy") throw new Error("legacy view of an identity version");
  const { datum, datumError } = base.content;
  if (datum === null) return { kind: "legacy", owner: null, datumError, profile: null, endedAt: null };
  // Adoption not yet confirmed: the view is the base alone.
  const later = pending.some((v) => v.content.kind === "identity") ? [] : pending.map((v) => (v.content.kind === "legacy" ? v.content.datum : null));
  const sameOwner = later.every((d) => d !== null && d.owner.kind === datum.owner.kind && d.owner.hash === datum.owner.hash);
  return {
    kind: "legacy",
    owner: sameOwner ? datum.owner : null,
    datumError: null,
    profile: {
      name: datum.name,
      description: datum.description,
      framework: datum.framework,
      endpoint: datum.endpoint,
      capabilities: datum.capabilities.filter((c) => later.every((d) => d !== null && d.capabilities.some((x) => sameBytes(x, c)))),
    },
    endedAt: null,
  };
}

/** Part 1 Section 7.2, "View". `vectorId` names the record, for the P-256 proof check. */
export function buildView(vectorId: string, base: Version, pending: readonly Version[]): RecordView {
  return base.content.kind === "identity" ? identityView(vectorId, base, pending) : legacyView(base, pending);
}

export const viewIsTombstone = (view: RecordView): boolean =>
  view.kind === "identity" ? view.status.type === "Revoked" || view.status.type === "Retired" : view.endedAt !== null;
