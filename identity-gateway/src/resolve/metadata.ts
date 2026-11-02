// DID document metadata (Part 1 Section 8.2). In every object, a member whose value is false, none
// or an empty list is left out. Times are YYYY-MM-DDThh:mm:ssZ; text that is not valid UTF-8, or
// that holds a surrogate or a noncharacter, is left out.

import type { Party, Role, Signer, Status } from "../codec/identity-datum.js";
import { keyHash } from "../codec/keys.js";
import { recordText } from "../codec/text.js";
import { canonicalDid } from "./did.js";
import { PURPOSE } from "./document.js";
import type { Origin, PlacedTx, RecordHistory, Version } from "./history.js";
import type { Effective, EffectiveReason, EffectiveStatus } from "./status.js";
import { formatTime } from "./time.js";
import type { LegacyView, RecordView } from "./view.js";
import { CONFIRMATION_DEPTH } from "./settings.js";
import type { FetchedFacts } from "./fetched.js";

export type VectorMetadataError =
  | "controllerKeyNotFound"
  | "controllerIsScript"
  | "recordDatumInvalid"
  | "recordDatumUnavailable"
  | "keyProofInvalid";

export type PurposeName = keyof typeof PURPOSE;
export type RightName = "suspend" | "revoke" | "recover";
export type RoleName = "accountable" | "responsible" | "provider" | "distributor" | "guardian";
export type StatusName = "active" | "suspended" | "revoked" | "retired";

export interface VectorHold {
  readonly by: string;
  readonly reason: string;
  readonly since: string;
  readonly until: string;
}

export interface VectorStatus {
  readonly status: StatusName;
  readonly effective: EffectiveStatus;
  readonly effectiveReason?: EffectiveReason;
  readonly holds?: readonly VectorHold[];
  readonly by?: string;
  readonly reason?: string;
  readonly at?: string;
  readonly invalidFrom?: string;
  readonly successor?: string;
}

export interface VectorKey {
  readonly id: string;
  readonly type: "Ed25519" | "P-256";
  readonly purposes?: readonly PurposeName[];
}

export interface VectorParty {
  readonly role: RoleName;
  readonly signer: string;
  readonly organisation?: string;
  /** Set by domain linkage (Part 2 Section 8.6); never true here. */
  readonly organisationVerified?: true;
  readonly rights?: readonly RightName[];
  readonly notBefore: string;
  readonly notAfter?: string;
  readonly removalAfter?: string;
}

export interface VectorRecovery {
  readonly guardianThreshold: number;
  readonly pendingNewController?: string;
  readonly pendingEffectiveAfter?: string;
}

export interface VectorParent {
  readonly parent: string;
  readonly parentEpoch: number;
  readonly depth: number;
}

export interface VectorProfile {
  readonly name?: string;
  readonly description?: string;
  readonly framework?: string;
  readonly endpoint?: string;
  /** Set by endpoint detection (Part 2 Section 8.5); not set here. */
  readonly protocol?: "a2a" | "mcp" | "web";
  readonly capabilities?: readonly string[];
  readonly createdAt?: string;
}

export interface VectorLedger {
  readonly txId: string;
  /** Absent for the end of a legacy record: the burn leaves no record output. */
  readonly outputIndex?: number;
  readonly blockHash: string;
  readonly blockHeight: number;
  readonly slot: number;
  readonly confirmations: number;
}

export interface VectorFetched {
  readonly url: string;
  readonly fetchedAt: string;
  readonly sha256: string;
}

export interface DidDocumentMetadata {
  readonly created?: string;
  readonly updated?: string;
  readonly versionId?: string;
  readonly nextVersionId?: string;
  readonly deactivated?: true;
  readonly vectorCurrent?: { readonly effective: EffectiveStatus; readonly effectiveReason?: EffectiveReason };
  readonly canonicalId?: string;
  readonly equivalentId?: readonly string[];
  readonly vectorOrigin?: Origin;
  readonly vectorStatus?: VectorStatus;
  readonly vectorKeys?: readonly VectorKey[];
  readonly vectorParties?: readonly VectorParty[];
  readonly vectorRecovery?: VectorRecovery;
  readonly vectorParent?: VectorParent;
  readonly vectorProfile?: VectorProfile;
  readonly vectorLedger?: VectorLedger;
  readonly vectorPending?: readonly string[];
  /** Values that depend on a fetch (wave 2: domain linkage and endpoint detection). */
  readonly vectorFetched?: readonly VectorFetched[];
  readonly vectorMetadataError?: VectorMetadataError;
}

/** Part 2 Appendix A. */
export const REASON_NAMES: Readonly<Record<number, string>> = {
  0: "unspecified",
  1: "keyCompromise",
  3: "affiliationChanged",
  4: "superseded",
  5: "cessationOfOperation",
  6: "hold",
  9: "privilegeWithdrawn",
  64: "disputeVerdict",
  65: "legalOrder",
  66: "parentRevoked",
  67: "providerWithdrawn",
  68: "securityInvestigation",
  69: "unaccountable",
  70: "parentRetired",
  71: "parentSuspended",
  72: "deactivationPending",
  73: "invalidated",
  74: "notAuthentic",
};

/** A reason code as its Appendix A name; a code that the table does not name stays a decimal string. */
export const reasonName = (code: number): string => REASON_NAMES[code] ?? String(code);

export function signerName(signer: Signer): string {
  if (signer.type === "ControllerSet") return "controller";
  return signer.type === "Script" ? `script:${signer.hash}` : signer.hash;
}

const RIGHTS: ReadonlyArray<readonly [RightName, number]> = [
  ["suspend", 1],
  ["revoke", 2],
  ["recover", 4],
];

/** Drops members that are undefined, null, false or an empty list (Part 1 Section 8.2). */
export function compact<T extends object>(value: T): T {
  const kept = Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0));
  // Same members minus the dropped ones; every dropped member is optional in the metadata types.
  return Object.fromEntries(kept) as T;
}

const text = (bytes: Uint8Array): string | undefined => recordText(bytes) ?? undefined;
const texts = (items: readonly Uint8Array[]): string[] => items.map(recordText).filter((s): s is string => s !== null);

const PURPOSE_NAMES: ReadonlyArray<readonly [PurposeName, number]> = [
  ["authentication", PURPOSE.authentication],
  ["assertion", PURPOSE.assertion],
  ["transaction", PURPOSE.transaction],
  ["delegation", PURPOSE.delegation],
];

const ROLE_NAMES: Readonly<Record<Role, RoleName>> = {
  Accountable: "accountable",
  Responsible: "responsible",
  Provider: "provider",
  Distributor: "distributor",
  Guardian: "guardian",
};

/** Purpose names in the Part 1 Section 8.2 order. */
export function purposeNames(purposes: number): PurposeName[] {
  return PURPOSE_NAMES.filter(([, bit]) => purposes & bit).map(([name]) => name);
}

function party(p: Party, verifiedOrganisations: readonly string[]): VectorParty {
  const organisation = p.organisation === null ? undefined : text(p.organisation);
  return compact({
    role: ROLE_NAMES[p.role],
    signer: signerName(p.signer),
    organisation,
    organisationVerified: organisation !== undefined && verifiedOrganisations.includes(organisation) ? (true as const) : undefined,
    rights: RIGHTS.filter(([, bit]) => p.rights & bit).map(([name]) => name),
    notBefore: formatTime(p.notBefore),
    notAfter: p.notAfter === null ? undefined : formatTime(p.notAfter),
    removalAfter: p.removalAfter === null ? undefined : formatTime(p.removalAfter),
  });
}

function identityStatusFields(status: Status): Omit<VectorStatus, "effective" | "effectiveReason" | "invalidFrom"> {
  switch (status.type) {
    case "Active":
      return { status: "active" };
    case "Suspended":
      return {
        status: "suspended",
        holds: status.holds.map((h) => ({ by: signerName(h.by), reason: reasonName(h.reason), since: formatTime(h.since), until: formatTime(h.until) })),
      };
    case "Revoked":
      return compact({
        status: "revoked" as const,
        by: signerName(status.by),
        reason: reasonName(status.reason),
        at: formatTime(status.at),
        successor: status.successor === null ? undefined : canonicalDid(status.successor),
      });
    case "Retired":
      return compact({ status: "retired" as const, at: formatTime(status.at), successor: status.successor === null ? undefined : canonicalDid(status.successor) });
  }
}

function legacyProfile(view: LegacyView, history: RecordHistory, protocol: VectorProfile["protocol"]): VectorProfile {
  const createdAt = history.legacyMint ? formatTime(history.legacyMint.timeMs) : undefined;
  if (!view.profile) return compact({ createdAt });
  return compact({
    name: text(view.profile.name),
    description: text(view.profile.description),
    framework: text(view.profile.framework),
    endpoint: text(view.profile.endpoint),
    protocol,
    capabilities: texts(view.profile.capabilities),
    createdAt,
  });
}

export function ledgerOf(at: PlacedTx, outputIndex: number | null): VectorLedger {
  return compact({
    txId: at.tx.txHash,
    outputIndex: outputIndex ?? undefined,
    blockHash: at.tx.blockHash,
    blockHeight: at.tx.blockHeight,
    slot: at.tx.slot,
    confirmations: at.confirmations,
  });
}

/** `vectorLedger`: the newest counted record output that the base owns; the end transaction for the end of a legacy record. */
export function baseLedger(base: Version, counts: (at: PlacedTx) => boolean): VectorLedger {
  const owned = base.owned.filter((o) => counts(o.at));
  const newest = owned[owned.length - 1];
  return newest ? ledgerOf(newest.at, newest.outputIndex) : ledgerOf(base.made, null);
}

export interface MetadataInput {
  readonly history: RecordHistory;
  readonly base: Version;
  readonly pending: readonly Version[];
  readonly view: RecordView;
  readonly effective: Effective;
  readonly invalidFrom: number | null;
  readonly counts: (at: PlacedTx) => boolean;
  /** `equivalentId` is set for requests in the canonical form. */
  readonly canonicalRequest: boolean;
  readonly legacyPolicyId: string;
  readonly deactivated: boolean;
  /** Requests with a version option: the effective status without options. */
  readonly current: Effective | null;
  readonly metadataError: VectorMetadataError | null;
  /** Values from background fetches (verified organisations, protocol, fetch records). */
  readonly facts: FetchedFacts | undefined;
}

export function buildMetadata(input: MetadataInput): DidDocumentMetadata {
  const { history, base, view, effective, facts } = input;
  const next = history.versions[base.number + 1];
  const statusFields =
    view.kind === "identity"
      ? identityStatusFields(view.status)
      : view.endedAt === null
        ? { status: "active" as const }
        : { status: "retired" as const, at: formatTime(view.endedAt) };

  const identity = view.kind === "identity" ? view : null;
  return compact({
    created: formatTime(history.firstMint.timeMs),
    updated: base.number > 0 ? formatTime(base.made.timeMs) : undefined,
    versionId: String(base.number),
    nextVersionId: next && next.made.confirmations >= CONFIRMATION_DEPTH ? String(next.number) : undefined,
    deactivated: input.deactivated || undefined,
    vectorCurrent: input.current ? compact({ effective: input.current.status, effectiveReason: input.current.reason ?? undefined }) : undefined,
    canonicalId: canonicalDid(history.vectorId),
    equivalentId:
      input.canonicalRequest && history.origin !== "native" ? [`did:vector:agent:${input.legacyPolicyId}:${history.vectorId}`] : undefined,
    vectorOrigin: history.origin,
    vectorStatus: compact<VectorStatus>({
      ...statusFields,
      effective: effective.status,
      effectiveReason: effective.reason ?? undefined,
      invalidFrom: input.invalidFrom === null ? undefined : formatTime(input.invalidFrom),
    }),
    vectorKeys: identity?.keys
      .filter((k) => k.popValid)
      .map((k) => compact<VectorKey>({ id: `#${k.keyHash}`, type: k.keyType === "P256" ? "P-256" : "Ed25519", purposes: purposeNames(k.purposes) })),
    vectorParties: identity?.parties.map((p) => party(p, facts?.verifiedOrganisations ?? [])),
    vectorRecovery:
      identity && identity.guardianThreshold >= 1
        ? compact<VectorRecovery>({
            guardianThreshold: identity.guardianThreshold,
            pendingNewController: identity.pendingRecovery ? keyHash(identity.pendingRecovery.newController) : undefined,
            pendingEffectiveAfter: identity.pendingRecovery ? formatTime(identity.pendingRecovery.effectiveAfter) : undefined,
          })
        : undefined,
    vectorParent:
      identity?.lineage.type === "Subagent"
        ? { parent: canonicalDid(identity.lineage.parent), parentEpoch: identity.lineage.parentEpoch, depth: identity.lineage.depth }
        : undefined,
    vectorProfile:
      view.kind === "identity"
        ? compact<VectorProfile>({
            name: text(view.name),
            description: text(view.description),
            framework: text(view.framework),
            endpoint: text(view.endpoint),
            protocol: facts?.protocol,
            capabilities: texts(view.capabilities),
            createdAt: formatTime(view.createdAt),
          })
        : legacyProfile(view, history, facts?.protocol),
    vectorLedger: baseLedger(base, input.counts),
    vectorPending: input.pending.map((v) => v.made.tx.txHash),
    vectorFetched: facts?.fetched?.map((f) => ({ url: f.url, fetchedAt: f.fetchedAt, sha256: f.sha256 })),
    vectorMetadataError: input.metadataError ?? undefined,
  });
}
