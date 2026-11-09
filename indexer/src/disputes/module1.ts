/**
 * indexer/src/disputes/module1.ts — Module-1 dispute cases from the indexed outputs.
 *
 * The follower keeps every output with an inline datum at the Module-1 claim,
 * challenge and identity_party (verdict) addresses as a row of utxos, and the
 * spend redeemer of each spent one in module1_spends. This module decodes the
 * datums by the Aiken field order (Module-1/contracts/lib/adversarial_auditing/
 * types.ak) and links the outputs into cases:
 *
 *   ClaimDatum (9 fields): claimer_did, claimer_credential, claim_hash,
 *     claim_type, storage_uri, stake_amount, submitted_at, challenge_window, state
 *   ChallengeDatum (11 fields): claim_ref, auditor_did, auditor_credential,
 *     stake_amount, evidence_hash, evidence_uri, challenged_at,
 *     resolution_deadline, eligible_jurors, state, claim_token
 *   IdentityVerdict (6 fields): agent, action, duration, challenge, deposit_to, expires_at
 *   ChallengeAction (challenge spend redeemer): OracleResolve = Constr 2
 *     [verdict, reasoning_hash]; TimeoutResolve = Constr 4
 *
 * Case: the claim output of SubmitClaim (case id = its ref). OpenChallenge
 * spends it (MarkChallenged) and creates the Challenged claim output (same
 * fields 0-7) and the challenge output (claim_ref = the spent claim). A
 * continuing output (claim or challenge) is an output of the spending
 * transaction with the same claim fields or the same claim_ref. The
 * resolution is the spend of the last challenge output: its redeemer gives
 * the outcome. A verdict output names the challenge output that the
 * resolution spends; its spend at or before expires_at is the application
 * (ApplyVerdict), a later spend is the expiry.
 *
 * Jury and documents (Module-1/jury/SPEC.md), through DisputeLinks:
 *   - `jury`: the canonical jury case (§11) of the challenge, found by the
 *     claim token (ChallengeDatum field 10; the jury case copies it);
 *   - `resolution_document`: the document (§10.5) in the metadata of the
 *     OracleResolve transaction; `matches` compares its hash with reasoning_hash;
 *   - `claim.document`, `challenge.document`: for a `vector-tx:` URI, the
 *     document of the named transaction; `matches` compares its hash with
 *     claim_hash or evidence_hash.
 *
 * Fields that do not decode as the Aiken type stay as Plutus Data CBOR hex.
 */

import { VECTOR_MAINNET, VECTOR_TESTNET, slotToPosixMs, type NetworkId } from "@marketplace/shared";
import { decodePlutusDataHex, encodePlutusDataHex, type PlutusData } from "@marketplace/shared/cbor";
import type { DocumentRow, DocumentSummary, Module1OutputRow } from "../db/cache.js";
import {
  VECTOR_TX_PREFIX,
  documentRef,
  txIdFromVectorTxUri,
  type DocumentRef,
  type VectorTxDocument,
} from "../documents/document.js";
import type { JuryCaseView } from "../jury/view.js";

export interface Module1Addresses {
  claimAddress: string;
  challengeAddress: string;
  partyAddress: string;
}

export type DisputeFields = Record<string, string | number | null>;
export type DisputeOutcome = "ClaimerWins" | "AuditorWins" | "Inconclusive" | "Timeout";
export type DisputeStatus = "open" | "challenged" | "resolved";

/** The resolution document (jury SPEC §10.5): a captured document and its JSON. */
export interface ResolutionDocument extends DocumentRef {
  /** The document parsed as JSON; null when it is not JSON. */
  json: unknown;
}

export interface DisputeCase {
  claim_ref: string;
  claimer_agent_id: string | null;
  status: DisputeStatus;
  claim: {
    tx: string;
    slot: number;
    time: string;
    stake_lovelace: string;
    challenge_deadline: string | null;
    text: string | null;
    fields: DisputeFields;
    /** The document of a `vector-tx:` storage_uri; null for any other URI. */
    document: VectorTxDocument | null;
  };
  challenge: null | {
    tx: string;
    slot: number;
    time: string;
    auditor_agent_id: string | null;
    /**
     * The challenge output is genuine (jury SPEC §11.1). A case is challenged only by a genuine
     * challenge; another output that names the claim is shown with genuine false and gives no dispute.
     */
    genuine: boolean;
    stake_lovelace: string;
    text: string | null;
    fields: DisputeFields;
    /** The document of a `vector-tx:` evidence_uri; null for any other URI. */
    document: VectorTxDocument | null;
  };
  resolution: null | {
    tx: string;
    slot: number;
    time: string;
    outcome: DisputeOutcome;
    reasoning_hash?: string;
  };
  verdict: null | {
    ref: string;
    action: string;
    duration_ms: number | null;
    expires_at: string | null;
    applied_tx: string | null;
    applied_time: string | null;
  };
  /** The canonical jury case of the challenge; null when there is none. */
  jury: JuryCaseView | null;
  /** The document in the metadata of the OracleResolve transaction; null when there is none. */
  resolution_document: ResolutionDocument | null;
}

/** Lookups of the jury cases and the documents that the cases link to. */
export interface DisputeLinks {
  /** The canonical jury case whose claim token is `claimToken`. */
  juryCase(claimToken: string): JuryCaseView | null;
  /** The document of a transaction, without its bytes. */
  documentSummary(txHash: string): DocumentSummary | null;
  /** The document of a transaction, with its bytes. */
  document(txHash: string): DocumentRow | null;
}

// ─── Plutus Data helpers ─────────────────────────────────────────────────

const CLAIM_STATES = ["Open", "Challenged", "Validated", "Invalidated"];
const CHALLENGE_STATES = ["PendingOracle", "PendingJury", "Voting", "Resolved"];
const VERDICTS: DisputeOutcome[] = ["ClaimerWins", "AuditorWins", "Inconclusive"];
const VERDICT_ACTIONS = ["suspend", "revoke"];
const ORACLE_RESOLVE = 2;
const TIMEOUT_RESOLVE = 4;

function decode(hex: string | null): PlutusData | null {
  if (!hex) return null;
  try {
    return decodePlutusDataHex(hex);
  } catch {
    return null;
  }
}

function constrOf(d: PlutusData | undefined): { index: number; fields: PlutusData[] } | null {
  return d?.kind === "constr" ? { index: Number(d.index), fields: d.fields } : null;
}

function raw(d: PlutusData | undefined): string | null {
  return d === undefined ? null : encodePlutusDataHex(d);
}

function bytesOf(d: PlutusData | undefined): string | null {
  return d?.kind === "bytes" ? d.hex.toLowerCase() : null;
}

function intOf(d: PlutusData | undefined): number | null {
  if (d?.kind !== "int") return null;
  const n = Number(d.value);
  return Number.isSafeInteger(n) ? n : null;
}

function bigintText(d: PlutusData | undefined): string | null {
  return d?.kind === "int" ? d.value.toString() : null;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 text of a byte string; hex when the bytes are not printable UTF-8. */
function textOf(d: PlutusData | undefined): string | null {
  const hex = bytesOf(d);
  if (hex === null) return raw(d);
  try {
    const text = UTF8.decode(Buffer.from(hex, "hex"));
    return /[\u0000-\u0008\u000e-\u001f\u007f]/.test(text) ? hex : text;
  } catch {
    return hex;
  }
}

/** Identifier (32 bytes, 64 lowercase hex), or null. */
function agentOf(d: PlutusData | undefined): string | null {
  const hex = bytesOf(d);
  return hex !== null && hex.length === 64 ? hex : null;
}

/** Credential (VerificationKey = Constr 0, Script = Constr 1) → the hash hex. */
function credentialOf(d: PlutusData | undefined): string | null {
  const c = constrOf(d);
  return c && c.fields.length === 1 ? bytesOf(c.fields[0]) : null;
}

/** OutputReference Constr 0 [transaction_id, output_index] → "<txHash>#<index>". */
function outRefOf(d: PlutusData | undefined): string | null {
  const c = constrOf(d);
  if (!c || c.index !== 0 || c.fields.length !== 2) return null;
  const tx = bytesOf(c.fields[0]);
  const index = intOf(c.fields[1]);
  return tx !== null && tx.length === 64 && index !== null ? `${tx}#${index}` : null;
}

function enumOf(d: PlutusData | undefined, names: readonly string[]): string | null {
  const c = constrOf(d);
  return c ? (names[c.index] ?? null) : null;
}

/** Fields after the known ones: kept as hex under field_<index>. */
function extraFields(fields: PlutusData[], known: number, out: DisputeFields): void {
  for (let i = known; i < fields.length; i++) out[`field_${i}`] = raw(fields[i]);
}

// ─── Datums ─────────────────────────────────────────────────────────────

interface ClaimInfo {
  claimer: string | null;
  stake: string;
  deadlineMs: number | null;
  state: string | null;
  /** Fields 0-7 (all but the state): equal for a claim and its continuing output. */
  key: string;
  fields: DisputeFields;
}

export function decodeClaimDatum(datumHex: string): ClaimInfo | null {
  const c = constrOf(decode(datumHex) ?? undefined);
  if (!c || c.index !== 0 || c.fields.length < 9) return null;
  const f = c.fields;
  const submittedAt = intOf(f[6]);
  const window = intOf(f[7]);
  const state = enumOf(f[8], CLAIM_STATES);
  const fields: DisputeFields = {
    claimer_did: bytesOf(f[0]) ?? raw(f[0]),
    credential: credentialOf(f[1]) ?? raw(f[1]),
    claim_hash: bytesOf(f[2]) ?? raw(f[2]),
    claim_type: textOf(f[3]),
    storage_uri: textOf(f[4]),
    stake_amount: bigintText(f[5]) ?? raw(f[5]),
    submitted_at_ms: submittedAt ?? raw(f[6]),
    challenge_window_ms: window ?? raw(f[7]),
    state: state ?? raw(f[8]),
  };
  extraFields(f, 9, fields);
  return {
    claimer: agentOf(f[0]),
    stake: bigintText(f[5]) ?? "0",
    deadlineMs: submittedAt !== null && window !== null ? submittedAt + window : null,
    state,
    key: f.slice(0, 8).map((x) => raw(x)).join(""),
    fields,
  };
}

interface ChallengeInfo {
  claimRef: string | null;
  auditor: string | null;
  stake: string;
  /** Verdict of a Resolved state (jury resolution), else null. */
  resolved: DisputeOutcome | null;
  /** Claim token name (field 10): the jury case copies it. */
  claimToken: string | null;
  fields: DisputeFields;
}

export function decodeChallengeDatum(datumHex: string): ChallengeInfo | null {
  const c = constrOf(decode(datumHex) ?? undefined);
  if (!c || c.index !== 0 || c.fields.length < 11) return null;
  const f = c.fields;
  const state = constrOf(f[9]);
  const stateName = state ? (CHALLENGE_STATES[state.index] ?? null) : null;
  const resolved = stateName === "Resolved" ? (VERDICTS[constrOf(state!.fields[0])?.index ?? -1] ?? null) : null;
  const fields: DisputeFields = {
    claim_ref: outRefOf(f[0]) ?? raw(f[0]),
    auditor_did: bytesOf(f[1]) ?? raw(f[1]),
    auditor_credential: credentialOf(f[2]) ?? raw(f[2]),
    stake_amount: bigintText(f[3]) ?? raw(f[3]),
    evidence_hash: bytesOf(f[4]) ?? raw(f[4]),
    evidence_uri: textOf(f[5]),
    challenged_at_ms: intOf(f[6]) ?? raw(f[6]),
    resolution_deadline_ms: intOf(f[7]) ?? raw(f[7]),
    eligible_jurors: f[8]?.kind === "list" ? f[8].items.length : raw(f[8]),
    state: stateName ?? raw(f[9]),
    claim_token: bytesOf(f[10]) ?? raw(f[10]),
  };
  extraFields(f, 11, fields);
  return {
    claimRef: outRefOf(f[0]),
    auditor: agentOf(f[1]),
    stake: bigintText(f[3]) ?? "0",
    resolved,
    claimToken: bytesOf(f[10]),
    fields,
  };
}

interface VerdictInfo {
  agent: string | null;
  action: string;
  durationMs: number | null;
  challengeRef: string | null;
  expiresAtMs: number | null;
}

export function decodeVerdictDatum(datumHex: string): VerdictInfo | null {
  const c = constrOf(decode(datumHex) ?? undefined);
  if (!c || c.index !== 0 || c.fields.length < 6) return null;
  const f = c.fields;
  return {
    agent: agentOf(f[0]),
    action: enumOf(f[1], VERDICT_ACTIONS) ?? raw(f[1]) ?? "unknown",
    durationMs: intOf(f[2]),
    challengeRef: outRefOf(f[3]),
    expiresAtMs: intOf(f[5]),
  };
}

/** The outcome of a challenge spend redeemer: OracleResolve or TimeoutResolve; null for the others. */
export function decodeResolveRedeemer(
  redeemerHex: string | null,
): { outcome: DisputeOutcome; reasoningHash: string | null } | null {
  const c = constrOf(decode(redeemerHex) ?? undefined);
  if (!c) return null;
  if (c.index === TIMEOUT_RESOLVE) return { outcome: "Timeout", reasoningHash: null };
  if (c.index !== ORACLE_RESOLVE) return null;
  const outcome = VERDICTS[constrOf(c.fields[0])?.index ?? -1];
  return outcome ? { outcome, reasoningHash: bytesOf(c.fields[1]) } : null;
}

// ─── Cases ──────────────────────────────────────────────────────────────

interface Entry<T> {
  row: Module1OutputRow;
  info: T;
}

/**
 * Follow continuing outputs: `next` of an entry is the output of its
 * spending transaction for which `same` holds. Returns the chain from `start`.
 */
function chain<T>(start: Entry<T>, byTx: Map<string, Entry<T>[]>, same: (a: Entry<T>, b: Entry<T>) => boolean): Entry<T>[] {
  const out = [start];
  const seen = new Set([start.row.ref]);
  let current = start;
  for (;;) {
    const spentTx = current.row.spent_tx;
    if (!spentTx) return out;
    const next = (byTx.get(spentTx) ?? []).find((e) => !seen.has(e.row.ref) && same(current, e));
    if (!next) return out;
    out.push(next);
    seen.add(next.row.ref);
    current = next;
  }
}

function groupByTx<T>(entries: Entry<T>[]): Map<string, Entry<T>[]> {
  const map = new Map<string, Entry<T>[]>();
  for (const e of entries) {
    const list = map.get(e.row.created_tx) ?? [];
    list.push(e);
    map.set(e.row.created_tx, list);
  }
  return map;
}

function entries<T>(rows: Module1OutputRow[], address: string, decodeDatum: (hex: string) => T | null): Entry<T>[] {
  const out: Entry<T>[] = [];
  for (const row of rows) {
    if (row.address !== address) continue;
    const info = decodeDatum(row.datum_hex);
    if (info) out.push({ row, info });
  }
  return out;
}

const UTF8_TEXT = new TextDecoder();

/** The document that a `vector-tx:` URI names; null for any other URI. */
function vectorTxDocument(
  uri: string | number | null | undefined,
  expectedHash: string | number | null | undefined,
  links: DisputeLinks | undefined,
): VectorTxDocument | null {
  if (typeof uri !== "string" || !uri.startsWith(VECTOR_TX_PREFIX)) return null;
  const tx = txIdFromVectorTxUri(uri);
  const summary = tx && links ? links.documentSummary(tx) : null;
  return { uri, tx, captured: summary ? documentRef(summary, typeof expectedHash === "string" ? expectedHash : null) : null };
}

/** The document of an OracleResolve transaction (the resolution with a reasoning_hash). */
function resolutionDocument(
  resolution: DisputeCase["resolution"],
  links: DisputeLinks | undefined,
): ResolutionDocument | null {
  const reasoningHash = resolution?.reasoning_hash;
  const doc = resolution && reasoningHash && links ? links.document(resolution.tx) : null;
  if (!reasoningHash || !doc) return null;
  let json: unknown = null;
  try {
    json = JSON.parse(UTF8_TEXT.decode(doc.bytes));
  } catch {
    json = null;
  }
  return { ...documentRef(doc, reasoningHash), json };
}

/** All cases, newest first. `links` adds the jury cases and the documents on chain. */
export function buildDisputeCases(
  rows: Module1OutputRow[],
  addresses: Module1Addresses,
  networkId: NetworkId,
  links?: DisputeLinks,
): DisputeCase[] {
  const params = networkId === 1 ? VECTOR_MAINNET : VECTOR_TESTNET;
  const iso = (ms: number): string | null => {
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  const slotTime = (slot: number): string => iso(slotToPosixMs(slot, params)) ?? "";

  const claims = entries(rows, addresses.claimAddress, decodeClaimDatum);
  const challenges = entries(rows, addresses.challengeAddress, decodeChallengeDatum);
  const verdicts = entries(rows, addresses.partyAddress, decodeVerdictDatum);

  const claimsByTx = groupByTx(claims);
  const challengesByTx = groupByTx(challenges);
  const sameClaim = (a: Entry<ClaimInfo>, b: Entry<ClaimInfo>): boolean => a.info.key === b.info.key;
  // Jury SPEC §11.1: only the genuine continuation (it holds the same challenge token) continues a
  // challenge; other outputs at the challenge address are ignored.
  const sameChallenge = (a: Entry<ChallengeInfo>, b: Entry<ChallengeInfo>): boolean =>
    b.row.genuine === 1 && b.row.token !== null && b.row.token === a.row.token && a.info.claimRef === b.info.claimRef;

  // A continuing claim output is not a case of its own.
  const continued = new Set<string>();
  for (const c of claims) for (const e of chain(c, claimsByTx, sameClaim).slice(1)) continued.add(e.row.ref);
  const continuedChallenges = new Set<string>();
  for (const c of challenges) {
    for (const e of chain(c, challengesByTx, sameChallenge).slice(1)) continuedChallenges.add(e.row.ref);
  }

  const cases: DisputeCase[] = [];
  for (const origin of claims) {
    if (continued.has(origin.row.ref)) continue;
    const claimChain = chain(origin, claimsByTx, sameClaim);
    const claimRefs = new Set(claimChain.map((e) => e.row.ref));
    const lastClaim = claimChain[claimChain.length - 1]!;

    const named = challenges.filter(
      (c) => !continuedChallenges.has(c.row.ref) && c.info.claimRef !== null && claimRefs.has(c.info.claimRef),
    );
    const challengeOrigin = named.find((c) => c.row.genuine === 1) ?? named[0];
    const genuine = challengeOrigin?.row.genuine === 1;
    const challengeChain = challengeOrigin ? chain(challengeOrigin, challengesByTx, sameChallenge) : [];
    const lastChallenge = challengeChain[challengeChain.length - 1];

    let resolution: DisputeCase["resolution"] = null;
    if (lastChallenge?.info.resolved) {
      const r = lastChallenge.row;
      resolution = { tx: r.created_tx, slot: r.created_slot, time: slotTime(r.created_slot), outcome: lastChallenge.info.resolved };
    } else if (lastChallenge?.row.spent_tx && lastChallenge.row.spent_slot !== null) {
      const decoded = decodeResolveRedeemer(lastChallenge.row.redeemer_hex);
      if (decoded) {
        resolution = {
          tx: lastChallenge.row.spent_tx,
          slot: lastChallenge.row.spent_slot,
          time: slotTime(lastChallenge.row.spent_slot),
          outcome: decoded.outcome,
          ...(decoded.reasoningHash ? { reasoning_hash: decoded.reasoningHash } : {}),
        };
      }
    }

    const challengeRefs = new Set(challengeChain.map((e) => e.row.ref));
    const verdictEntry = verdicts.find((v) => v.info.challengeRef !== null && challengeRefs.has(v.info.challengeRef));
    let verdict: DisputeCase["verdict"] = null;
    if (verdictEntry) {
      const v = verdictEntry.row;
      const expiresAt = verdictEntry.info.expiresAtMs;
      const spentMs = v.spent_slot === null ? null : slotToPosixMs(v.spent_slot, params);
      const applied = v.spent_tx !== null && spentMs !== null && (expiresAt === null || spentMs <= expiresAt);
      verdict = {
        ref: v.ref,
        action: verdictEntry.info.action,
        duration_ms: verdictEntry.info.durationMs,
        expires_at: expiresAt === null ? null : iso(expiresAt),
        applied_tx: applied ? v.spent_tx : null,
        applied_time: applied && v.spent_slot !== null ? slotTime(v.spent_slot) : null,
      };
    }

    const resolved =
      resolution !== null ||
      (lastChallenge ? lastChallenge.row.spent_tx !== null : lastClaim.row.spent_tx !== null);
    const status: DisputeStatus = resolved ? "resolved" : genuine ? "challenged" : "open";

    const o = origin.row;
    const claimFields: DisputeFields = { ...origin.info.fields, state: lastClaim.info.fields.state ?? null };
    const claimToken = genuine ? challengeOrigin?.info.claimToken ?? null : null;
    cases.push({
      claim_ref: o.ref,
      claimer_agent_id: origin.info.claimer,
      status,
      claim: {
        tx: o.created_tx,
        slot: o.created_slot,
        time: slotTime(o.created_slot),
        stake_lovelace: origin.info.stake,
        challenge_deadline: origin.info.deadlineMs === null ? null : iso(origin.info.deadlineMs),
        text: null,
        fields: claimFields,
        document: vectorTxDocument(claimFields.storage_uri, claimFields.claim_hash, links),
      },
      challenge:
        challengeOrigin && lastChallenge
          ? {
              tx: challengeOrigin.row.created_tx,
              slot: challengeOrigin.row.created_slot,
              time: slotTime(challengeOrigin.row.created_slot),
              auditor_agent_id: challengeOrigin.info.auditor,
              genuine,
              stake_lovelace: challengeOrigin.info.stake,
              text: null,
              fields: lastChallenge.info.fields,
              document: vectorTxDocument(
                lastChallenge.info.fields.evidence_uri,
                lastChallenge.info.fields.evidence_hash,
                links,
              ),
            }
          : null,
      resolution,
      verdict,
      jury: claimToken && links ? links.juryCase(claimToken) : null,
      resolution_document: resolutionDocument(resolution, links),
    });
  }

  cases.sort((a, b) => b.claim.slot - a.claim.slot || (a.claim_ref < b.claim_ref ? 1 : a.claim_ref > b.claim_ref ? -1 : 0));
  return cases;
}
