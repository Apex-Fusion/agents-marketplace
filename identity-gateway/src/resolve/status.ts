// Base and pending versions (Part 1 Section 7.2) and the effective status (Part 1 Section 7.3) of a
// record and its ancestors at the request time t.

import type { Lineage } from "../codec/identity-datum.js";
import type { PlacedTx, RecordHistory, Version } from "./history.js";
import { CONFIRMATION_DEPTH, type ResolverSettings } from "./settings.js";
import { blockTimeMs } from "./time.js";
import { buildView, viewIsTombstone, type RecordView } from "./view.js";

export type EffectiveStatus = "active" | "suspended" | "revoked" | "retired";

/** The reason names of Part 1 Section 7.3. */
export type EffectiveReason =
  | "invalidated"
  | "parentRevoked"
  | "parentRetired"
  | "deactivationPending"
  | "parentSuspended"
  | "notAuthentic"
  | "unaccountable";

export interface Effective {
  readonly status: EffectiveStatus;
  readonly reason: EffectiveReason | null;
}

/** Which versions a request sees. */
export interface Selection {
  /** Request time t, POSIX milliseconds. */
  readonly t: number;
  /** The transactions that count. */
  readonly counts: (at: PlacedTx) => boolean;
  /** For a versionId request: the number of the base version. */
  readonly version: number | null;
}

export interface RecordState {
  readonly base: Version;
  readonly pending: readonly Version[];
  readonly view: RecordView;
}

export interface Evaluation {
  readonly state: RecordState;
  readonly effective: Effective;
  /** The earliest "invalid from" time in the newest confirmed versions of the record and its ancestors (POSIX ms). */
  readonly invalidFrom: number | null;
}

/** "actual": confirmations as the tip gives them. "allConfirmed": as if every version were confirmed (rule 4). */
type Mode = "actual" | "allConfirmed";

const isConfirmed = (v: Version, mode: Mode): boolean => mode === "allConfirmed" || v.made.confirmations >= CONFIRMATION_DEPTH;

/** Part 1 Section 7.2, "Base and pending versions". Null when no base exists. */
export function selectState(history: RecordHistory, selection: Selection, mode: Mode = "actual"): RecordState | null {
  let base: Version | undefined;
  let pending: Version[] = [];
  if (selection.version !== null) {
    base = history.versions[selection.version];
    if (!base || !isConfirmed(base, mode)) return null;
  } else {
    const counted = history.versions.filter((v) => selection.counts(v.made));
    let i = counted.length - 1;
    while (i >= 0 && !isConfirmed(counted[i]!, mode)) i--;
    if (i < 0) return null;
    base = counted[i]!;
    pending = counted.slice(i + 1);
  }
  return { base, pending, view: buildView(history.vectorId, base, pending) };
}

function newestVersion(history: RecordHistory, mode: Mode): Version | null {
  for (let i = history.versions.length - 1; i >= 0; i--) if (isConfirmed(history.versions[i]!, mode)) return history.versions[i]!;
  return null;
}

function invalidFromOf(version: Version | null): number | null {
  if (version?.content.kind !== "identity") return null;
  const status = version.content.datum.status;
  return status.type === "Revoked" ? status.invalidFrom : null;
}

/** The lineage of an identity-registry record (it never changes); Root for a legacy record. */
export function lineageOf(history: RecordHistory): Lineage {
  for (const v of history.versions) if (v.content.kind === "identity") return v.content.datum.lineage;
  return { type: "Root" };
}

/**
 * Part 1 Section 7.3 for chain[0], where chain[i + 1] is the parent of chain[i]. `selection` applies
 * to the record, `ancestorSelection` to its ancestors (the same t). Returns null when the record has
 * no base version.
 */
export function evaluate(
  chain: readonly RecordHistory[],
  selection: Selection,
  ancestorSelection: Selection,
  settings: ResolverSettings,
): Evaluation | null {
  const { t } = selection;
  const cutoffSlot = settings.registries.cutoffSlot;
  const cutoffTime = cutoffSlot === null ? null : blockTimeMs(cutoffSlot, settings.network);
  const selectionOf = (i: number): Selection => (i === 0 ? selection : ancestorSelection);

  const states = new Map<string, RecordState | null>();
  function state(i: number, mode: Mode): RecordState {
    const key = `${i}:${mode}`;
    if (!states.has(key)) states.set(key, selectState(chain[i]!, selectionOf(i), mode));
    const found = states.get(key);
    if (!found) throw new Error("an ancestor has no version at the request time");
    return found;
  }

  // Rules 1-3: the results that end the DID.
  const terminalMemo = new Map<string, Effective | null>();
  function terminal(i: number, mode: Mode): Effective | null {
    const key = `${i}:${mode}`;
    if (terminalMemo.has(key)) return terminalMemo.get(key)!;
    const result = terminalRules(i, mode);
    terminalMemo.set(key, result);
    return result;
  }
  function terminalRules(i: number, mode: Mode): Effective | null {
    const { view } = state(i, mode);
    if (viewIsTombstone(view)) {
      const revoked = view.kind === "identity" && view.status.type === "Revoked";
      return { status: revoked ? "revoked" : "retired", reason: null };
    }
    for (let j = i; j < chain.length; j++) {
      const from = invalidFromOf(newestVersion(chain[j]!, mode));
      if (from !== null && from <= t) return { status: "revoked", reason: j === i ? "invalidated" : "parentRevoked" };
    }
    if (i + 1 < chain.length) {
      const parent = mode === "actual" ? full(i + 1) : terminal(i + 1, mode);
      if (parent?.status === "revoked") return { status: "revoked", reason: "parentRevoked" };
      if (parent?.status === "retired") return { status: "retired", reason: "parentRetired" };
      const parentBase = state(i + 1, mode).base.content;
      const lineage = lineageOf(chain[i]!);
      if (lineage.type === "Subagent" && parentBase.kind === "identity" && parentBase.datum.subagentEpoch > lineage.parentEpoch) {
        return { status: "revoked", reason: "parentRevoked" };
      }
    }
    return null;
  }

  // Rules 1-9 with the actual confirmations.
  const fullMemo = new Map<number, Effective>();
  function full(i: number): Effective {
    const known = fullMemo.get(i);
    if (known) return known;
    const result = fullRules(i);
    fullMemo.set(i, result);
    return result;
  }
  function fullRules(i: number): Effective {
    const ended = terminal(i, "actual");
    if (ended) return ended;
    if (terminal(i, "allConfirmed")) return { status: "suspended", reason: "deactivationPending" };
    if (i + 1 < chain.length && full(i + 1).status === "suspended") return { status: "suspended", reason: "parentSuspended" };
    const moves = chain[i]!.tokenMoves.filter((m) => selectionOf(i).counts(m.at));
    if (moves[moves.length - 1]?.place === "notAuthentic") return { status: "suspended", reason: "notAuthentic" };
    const { view } = state(i, "actual");
    if (view.kind === "identity") {
      if (view.status.type === "Suspended" && view.status.holds.some((h) => h.until > t)) return { status: "suspended", reason: null };
      const accountable = view.parties.some((p) => p.role === "Accountable" && p.notBefore <= t && (p.notAfter === null || p.notAfter >= t));
      if (!accountable) return { status: "suspended", reason: "unaccountable" };
    } else if (cutoffTime !== null && t >= cutoffTime) {
      // A legacy version names no Accountable Party: rule 8 applies from the cutoff slot on.
      return { status: "suspended", reason: "unaccountable" };
    }
    return { status: "active", reason: null };
  }

  const subject = selectState(chain[0]!, selection);
  if (!subject) return null;
  states.set("0:actual", subject);
  const invalidFroms = chain.map((h) => invalidFromOf(newestVersion(h, "actual"))).filter((x): x is number => x !== null);
  return {
    state: subject,
    effective: full(0),
    invalidFrom: invalidFroms.length ? Math.min(...invalidFroms) : null,
  };
}
