/**
 * indexer/src/jury/view.ts — jurors and cases of the followed jury deployments
 * (Module-1/jury/SPEC.md).
 *
 * The follower keeps each jury output (utxos and jury_outputs rows) and the
 * spend redeemer of each spent one (jury_spends). A jury token is in one
 * output at a time: each spend of the output creates the next output with
 * the token, until a transaction burns the token (Exit, a Finalize without
 * fee shares, Close). This module follows the outputs of each token, decodes
 * the datums and redeemers (codec.ts) and builds:
 *
 *   - jurors (§5.2, §6.4–§6.8): registration, bond, eligibility, exit, open
 *     commitments and slashes, and the prompt document of the registration;
 *   - cases (§5.3, §6.9–§6.13): windows, ballots with their commit, reveal,
 *     claim and slash transactions, the record document of each reveal, the
 *     tally, the result (§8), the state and the canonical flag (§11).
 *
 * "Now" is the chain time: the time of the last block that the indexer
 * applied. So a result shows only after the indexed chain passed reveal_end,
 * and then the tally holds every reveal.
 *
 * The canonical case of a challenge (§11) is the case whose opening
 * transaction is first on chain, over all followed deployments. A block has
 * one slot and a later block has a later slot, so the order of the opening
 * slots is the order of the block numbers. In one block, the lowest case
 * token name wins.
 */

import { VECTOR_MAINNET, VECTOR_TESTNET, slotToPosixMs, type NetworkId } from "@marketplace/shared";
import { encodePlutusAddress, plutusAddressToBech32, type PlutusAddress } from "@marketplace/shared/cbor";
import type { JuryDeployment, JuryParams } from "../config.js";
import type { DocumentSummary, JuryOutputRow, SqliteCache, UtxoRow } from "../db/cache.js";
import { decodeChallengeDatum, decodeClaimDatum } from "../disputes/module1.js";
import { documentRef, txIdFromVectorTxUri, type DocumentRef } from "../documents/document.js";
import {
  CASE_TOKEN_PREFIX,
  JUROR_TOKEN_PREFIX,
  decodeJuryDatum,
  decodeJurySpendAction,
  type CaseDatum,
  type JurorDatum,
  type JurySpendAction,
  type Tally,
  type Vote,
} from "./codec.js";

/** A transaction in a block. */
export interface TxPoint {
  tx: string;
  slot: number;
  height: number | null;
  time: string;
}

export type BallotStatusName = "committed" | "revealed" | "paid" | "unrevealed" | "slashed";

export interface BallotView {
  agent_id: string;
  /** Juror token name. */
  juror: string;
  commit: string;
  /** unrevealed: still committed after reveal_end; slashed: a Slash of the juror for this case is on chain. */
  status: BallotStatusName;
  vote: Vote | null;
  committed: TxPoint | null;
  revealed: TxPoint | null;
  /** record_hash of the reveal redeemer. */
  record_hash: string | null;
  /** The juror record (§10.4): the document with record_hash, in the reveal transaction or in the transaction that its juror-record-ref names. */
  record: DocumentRef | null;
  /** Where the record is (SPEC §10.4): the reveal transaction, a separate transaction (overflow), or missing; null before the reveal. */
  record_status: "reveal" | "separate" | "missing" | null;
  paid: TxPoint | null;
  slashed: TxPoint | null;
}

export interface JuryCaseView {
  /** Deployment label. */
  deployment: string;
  script_hash: string;
  /** Case token name. */
  case: string;
  /** The case is the canonical case of its challenge (§11). */
  canonical: boolean;
  /** Module-1 challenge and claim token names. */
  challenge: string;
  claim: string;
  claimer_agent_id: string;
  auditor_agent_id: string;
  claim_hash: string;
  /** OutputReferences of the Module-1 challenge and claim outputs that the opening read. */
  challenge_out: string;
  claim_out: string;
  /** challenge_out is a genuine challenge output (§11.1) that holds the case's challenge token. */
  genuine_challenge: boolean;
  /** challenged_at of challenge_out; null when the indexer does not hold that output. */
  challenged_at: string | null;
  /** Blocks on top of the opening block (§11.2 needs 10); null when a height is unknown. */
  depth: number | null;
  /** URIs from the claim_out (storage_uri) and challenge_out (evidence_uri) outputs (§10.2); null when unknown. */
  claim_uri: string | null;
  evidence_hash: string;
  evidence_uri: string | null;
  deadline: string;
  opened_at: string;
  commit_end: string;
  reveal_end: string;
  /** Window at the chain time: commit before commit_end, reveal before reveal_end, then ended. */
  window: "commit" | "reveal" | "ended";
  /** closed: the case token is burned. */
  state: "open" | "settling" | "closed";
  fee_lovelace: string;
  share_lovelace: string | null;
  /** Lovelace in the last case output. */
  lovelace: string;
  refund_to: string;
  rule: { quorum: number; majority_num: number; majority_den: number };
  /** In commit order. */
  ballots: BallotView[];
  tally: Record<Vote, number>;
  revealed: number;
  /** §8 outcome of the tally once the chain time is at or after reveal_end; null before. */
  result: Vote | null;
  opened: TxPoint;
  finalized: (TxPoint & { result: Vote }) | null;
  closed: TxPoint | null;
  /** The current case output; null when the case is closed. */
  ref: string | null;
}

export interface JurorView {
  deployment: string;
  script_hash: string;
  /** Juror token name. */
  juror: string;
  agent_id: string;
  owner: string;
  status: "registered" | "exit_requested" | "exited";
  /**
   * The juror can commit at the chain time by the rules of §6.4 on time, exit
   * and bond. The identity check of the DID is not part of it.
   */
  eligible: boolean;
  registered: TxPoint;
  registered_at: string;
  eligible_from: string;
  exit_after: string | null;
  exited: TxPoint | null;
  /** Lovelace in the last juror output. */
  bond_lovelace: string;
  open: Array<{ case: string; reveal_end: string; overdue: boolean }>;
  slashes: Array<{ case: string } & TxPoint>;
  prompt_hash: string;
  /** The prompt document (§10.3) in the metadata of the registration transaction. */
  prompt: DocumentRef | null;
  /** The current juror output; null after the exit. */
  ref: string | null;
}

export interface JuryView {
  /** The chain time of the view: the time of the last applied block. */
  chain_time: string;
  /** Newest registration first. */
  jurors: JurorView[];
  /** Newest opening first. */
  cases: JuryCaseView[];
}

export interface JuryViewInput {
  rows: JuryOutputRow[];
  deployments: readonly JuryDeployment[];
  /** Documents (without bytes) of these transactions. */
  documents: (txHashes: string[]) => Map<string, DocumentSummary>;
  networkId: NetworkId;
  /** POSIX ms of the last applied block. */
  chainTimeMs: number;
  /** Block number of the last applied block; null when unknown. */
  tipHeight: number | null;
  /** Module-1 outputs (spent or not) by reference: challenge_out and claim_out. */
  outputs: (refs: string[]) => Map<string, UtxoRow>;
  /** juror-record documents (without bytes) by hash, oldest first: a record that another transaction holds, found without a reference. */
  records: (hashes: string[]) => Map<string, DocumentSummary[]>;
  /**
   * The record transaction that the juror-record-ref document of a reveal transaction names (SPEC §10.4,
   * overflow): reveal transaction → record transaction. Absent: no reference is followed.
   */
  recordRefs?: (revealTxs: string[]) => Map<string, string>;
}

/** The result rule (§8). */
export function juryOutcome(tally: Tally, params: Pick<JuryParams, "quorum" | "majority_num" | "majority_den">): Vote {
  const n = tally.claimer + tally.auditor + tally.inconclusive;
  if (n >= params.quorum && tally.claimer * params.majority_den >= n * params.majority_num) return "ClaimerWins";
  if (n >= params.quorum && tally.auditor * params.majority_den >= n * params.majority_num) return "AuditorWins";
  return "Inconclusive";
}

interface Step<D> {
  row: JuryOutputRow;
  datum: D;
  /** Redeemer of the spend of `row`; null when unspent or not decodable. */
  action: JurySpendAction | null;
}

/** The outputs of one token in chain order: each spend creates the next output with the token. */
function lineage(rows: JuryOutputRow[]): JuryOutputRow[] {
  const byCreatedTx = new Map(rows.map((r) => [r.created_tx, r]));
  const spentTxs = new Set(rows.map((r) => r.spent_tx));
  let current: JuryOutputRow | undefined = rows.find((r) => !spentTxs.has(r.created_tx)) ?? rows[0];
  const out: JuryOutputRow[] = [];
  const seen = new Set<string>();
  while (current && !seen.has(current.ref)) {
    out.push(current);
    seen.add(current.ref);
    current = current.spent_tx ? byCreatedTx.get(current.spent_tx) : undefined;
  }
  return out;
}

/** The steps of a lineage while the datums decode as `variant`. */
function steps<D extends JurorDatum | CaseDatum>(rows: JuryOutputRow[], variant: D["variant"]): Step<D>[] {
  const out: Step<D>[] = [];
  for (const row of lineage(rows)) {
    const datum = decodeJuryDatum(row.datum_hex);
    if (datum?.variant !== variant) break;
    out.push({ row, datum: datum as D, action: row.redeemer_hex ? decodeJurySpendAction(row.redeemer_hex) : null });
  }
  return out;
}

/** §11.2: a case becomes canonical when at least this many blocks are on top of its opening block. */
const CANONICAL_DEPTH = 10;

function addressText(address: PlutusAddress, networkId: NetworkId): string {
  try {
    return plutusAddressToBech32(address, networkId);
  } catch {
    return encodePlutusAddress(address);
  }
}

export function buildJuryView(input: JuryViewInput): JuryView {
  const network = input.networkId === 1 ? VECTOR_MAINNET : VECTOR_TESTNET;
  const now = input.chainTimeMs;
  const iso = (ms: number): string => {
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
  };
  const point = (tx: string, slot: number, height: number | null): TxPoint => ({
    tx, slot, height, time: iso(slotToPosixMs(slot, network)),
  });
  const spendPoint = (row: JuryOutputRow): TxPoint | null =>
    row.spent_tx !== null && row.spent_slot !== null ? point(row.spent_tx, row.spent_slot, row.spent_height) : null;

  const groups = new Map<string, JuryOutputRow[]>();
  for (const row of input.rows) {
    const key = `${row.deployment}:${row.token}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const jurorLines: Array<{ deployment: JuryDeployment; steps: Step<JurorDatum>[] }> = [];
  const caseLines: Array<{ deployment: JuryDeployment; steps: Step<CaseDatum>[] }> = [];
  const deployments = new Map(input.deployments.map((d) => [d.scriptHash, d]));
  for (const rows of groups.values()) {
    const deployment = deployments.get(rows[0]!.deployment);
    if (!deployment) continue;
    const token = rows[0]!.token;
    if (token.startsWith(JUROR_TOKEN_PREFIX)) {
      const s = steps<JurorDatum>(rows, "Juror");
      if (s.length > 0) jurorLines.push({ deployment, steps: s });
    } else if (token.startsWith(CASE_TOKEN_PREFIX)) {
      const s = steps<CaseDatum>(rows, "Case");
      if (s.length > 0) caseLines.push({ deployment, steps: s });
    }
  }

  // Slash of a juror for a case: a juror-side spend, the case output stays.
  const slashes = new Map<string, TxPoint>();
  for (const { deployment, steps: s } of jurorLines) {
    for (const step of s) {
      const at = spendPoint(step.row);
      if (at && step.action?.on === "Juror" && step.action.action.kind === "Slash") {
        slashes.set(`${deployment.scriptHash}:${step.row.token}:${step.action.action.case}`, at);
      }
    }
  }

  // Documents: the prompt of each registration and the record of each reveal.
  const documentTxs: string[] = jurorLines.map((l) => l.steps[0]!.row.created_tx);
  for (const { steps: s } of caseLines) {
    for (const step of s) {
      if (step.action?.on === "Case" && step.action.action.kind === "CaseReveal" && step.row.spent_tx) {
        documentTxs.push(step.row.spent_tx);
      }
    }
  }
  const documents = documentTxs.length > 0 ? input.documents(documentTxs) : new Map<string, DocumentSummary>();
  const recordHashes: string[] = [];
  const outputRefs: string[] = [];
  for (const { steps: s } of caseLines) {
    outputRefs.push(s[0]!.datum.challengeOut, s[0]!.datum.claimOut);
    for (const step of s) {
      if (step.action?.on === "Case" && step.action.action.kind === "CaseReveal") recordHashes.push(step.action.action.recordHash);
    }
  }
  const records = recordHashes.length > 0 ? input.records(recordHashes) : new Map<string, DocumentSummary[]>();
  const outputs = outputRefs.length > 0 ? input.outputs(outputRefs) : new Map<string, UtxoRow>();
  // §10.4 overflow: a reveal that carries a juror-record-ref names the transaction that holds the record.
  const refCandidates = documentTxs.filter((tx) => documents.get(tx)?.type === "juror-record-ref");
  const recordRefs = refCandidates.length > 0 && input.recordRefs ? input.recordRefs(refCandidates) : new Map<string, string>();
  const referenced = recordRefs.size > 0 ? input.documents([...recordRefs.values()]) : new Map<string, DocumentSummary>();

  const jurors = jurorLines.map(({ deployment, steps: s }): JurorView => {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    const p = deployment.params;
    const exited = last.row.spent_tx !== null && last.action?.on === "Juror" && last.action.action.kind === "Exit"
      ? spendPoint(last.row)
      : null;
    const bond = BigInt(last.row.lovelace);
    const open = exited ? [] : last.datum.open;
    const status = exited ? "exited" : last.datum.exitAfter !== null ? "exit_requested" : "registered";
    const eligibleFrom = first.datum.registeredAt + p.eligibility_delay;
    const prompt = documents.get(first.row.created_tx);
    return {
      deployment: deployment.label,
      script_hash: deployment.scriptHash,
      juror: first.row.token,
      agent_id: first.datum.agent,
      owner: first.datum.owner,
      status,
      eligible: status === "registered" && now >= eligibleFrom && bond >= BigInt(p.bond_min),
      registered: point(first.row.created_tx, first.row.created_slot, first.row.created_height),
      registered_at: iso(first.datum.registeredAt),
      eligible_from: iso(eligibleFrom),
      exit_after: last.datum.exitAfter === null ? null : iso(last.datum.exitAfter),
      exited,
      bond_lovelace: last.row.lovelace,
      open: open.map((o) => ({ case: o.case, reveal_end: iso(o.revealEnd), overdue: now >= o.revealEnd })),
      slashes: s.flatMap((step) => {
        const at = spendPoint(step.row);
        return at && step.action?.on === "Juror" && step.action.action.kind === "Slash"
          ? [{ case: step.action.action.case, ...at }]
          : [];
      }),
      prompt_hash: first.datum.promptHash,
      prompt: prompt ? documentRef(prompt, first.datum.promptHash) : null,
      ref: last.row.spent_tx === null ? last.row.ref : null,
    };
  });

  const cases = caseLines.map(({ deployment, steps: s }): JuryCaseView => {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    const opening = first.datum;
    const current = last.datum;
    const p = deployment.params;
    const caseName = first.row.token;

    const commits = new Map<string, TxPoint>();
    const reveals = new Map<string, { at: TxPoint; recordHash: string }>();
    const claims = new Map<string, TxPoint>();
    let finalized: JuryCaseView["finalized"] = null;
    for (const step of s) {
      const at = spendPoint(step.row);
      if (!at || step.action?.on !== "Case") continue;
      const action = step.action.action;
      if (action.kind === "CaseCommit") commits.set(action.juror, at);
      else if (action.kind === "CaseReveal") reveals.set(action.juror, { at, recordHash: action.recordHash });
      else if (action.kind === "CaseClaim") claims.set(action.juror, at);
      else if (action.kind === "Finalize") finalized = { ...at, result: action.result };
    }
    const closed = last.row.spent_tx !== null ? spendPoint(last.row) : null;
    const ended = now >= current.revealEnd;

    const ballots = [...current.ballots].reverse().map((b): BallotView => {
      const reveal = reveals.get(b.juror) ?? null;
      const slashed = slashes.get(`${deployment.scriptHash}:${b.juror}:${caseName}`) ?? null;
      // §10.4: the record is in the reveal transaction, or the reveal refers to the transaction that holds it
      // (overflow). A record that another transaction holds is found by its hash as well.
      const recordHash = reveal?.recordHash ?? null;
      const isJurorRecord = (d: DocumentSummary | undefined): d is DocumentSummary => d?.type === "juror-record" && d.hash === recordHash;
      const inReveal = reveal ? documents.get(reveal.at.tx) : undefined;
      const refTx = reveal ? recordRefs.get(reveal.at.tx) : undefined;
      const viaRef = refTx ? referenced.get(refTx) : undefined;
      const byHash = recordHash !== null ? records.get(recordHash)?.find((d) => d.tx_hash !== reveal?.at.tx) : undefined;
      const found = isJurorRecord(inReveal) ? inReveal : isJurorRecord(viaRef) ? viaRef : byHash;
      const status: BallotStatusName =
        b.status.kind === "Revealed" ? "revealed"
          : b.status.kind === "Paid" ? "paid"
            : slashed ? "slashed"
              : ended ? "unrevealed"
                : "committed";
      return {
        agent_id: b.agent,
        juror: b.juror,
        commit: b.commit,
        status,
        vote: b.status.kind === "Committed" ? null : b.status.vote,
        committed: commits.get(b.juror) ?? null,
        revealed: reveal?.at ?? null,
        record_hash: reveal?.recordHash ?? null,
        record: found && reveal ? documentRef(found, reveal.recordHash) : null,
        record_status: !reveal ? null : !found ? "missing" : found === inReveal ? "reveal" : "separate",
        paid: claims.get(b.juror) ?? null,
        slashed,
      };
    });

    const challengeOut = outputs.get(opening.challengeOut);
    const claimOut = outputs.get(opening.claimOut);
    const challengeInfo = challengeOut ? decodeChallengeDatum(challengeOut.datum_hex) : null;
    const claimInfo = claimOut ? decodeClaimDatum(claimOut.datum_hex) : null;
    const challengedAt = challengeInfo?.fields.challenged_at_ms;
    const t = current.tally;
    const openedHeight = first.row.created_height;
    return {
      deployment: deployment.label,
      script_hash: deployment.scriptHash,
      case: caseName,
      canonical: false,
      challenge: opening.challenge,
      claim: opening.claim,
      challenge_out: opening.challengeOut,
      claim_out: opening.claimOut,
      genuine_challenge: challengeOut?.genuine === 1 && challengeOut.token === opening.challenge,
      challenged_at: typeof challengedAt === "number" ? iso(challengedAt) : null,
      claimer_agent_id: opening.claimer,
      auditor_agent_id: opening.auditor,
      claim_hash: opening.claimHash,
      claim_uri: typeof claimInfo?.fields.storage_uri === "string" ? claimInfo.fields.storage_uri : null,
      evidence_hash: opening.evidenceHash,
      evidence_uri: typeof challengeInfo?.fields.evidence_uri === "string" ? challengeInfo.fields.evidence_uri : null,
      deadline: iso(opening.deadline),
      opened_at: iso(opening.openedAt),
      commit_end: iso(opening.commitEnd),
      reveal_end: iso(opening.revealEnd),
      window: now < current.commitEnd ? "commit" : now < current.revealEnd ? "reveal" : "ended",
      state: closed ? "closed" : current.state.kind === "Settling" ? "settling" : "open",
      fee_lovelace: current.fee.toString(),
      share_lovelace: current.state.kind === "Settling" ? current.state.share.toString() : null,
      lovelace: last.row.lovelace,
      refund_to: addressText(current.refundTo, input.networkId),
      rule: { quorum: p.quorum, majority_num: p.majority_num, majority_den: p.majority_den },
      ballots,
      tally: { ClaimerWins: t.claimer, AuditorWins: t.auditor, Inconclusive: t.inconclusive },
      revealed: t.claimer + t.auditor + t.inconclusive,
      result: ended ? juryOutcome(t, p) : null,
      opened: point(first.row.created_tx, first.row.created_slot, openedHeight),
      depth: input.tipHeight !== null && openedHeight !== null ? input.tipHeight - openedHeight : null,
      finalized,
      closed,
      ref: closed ? null : last.row.ref,
    };
  });

  // §11.2: per claim token, the cases of the deployment that was current at challenged_at,
  // with a genuine challenge_out, at least 10 blocks deep; the first opening on chain wins,
  // in one block the lowest case token name.
  const isCurrent = (c: JuryCaseView): boolean => {
    const at = c.challenged_at === null ? NaN : Date.parse(c.challenged_at);
    const d = deployments.get(c.script_hash);
    return d !== undefined && d.casesFrom !== null && at >= d.casesFrom && (d.casesUntil === null || at < d.casesUntil);
  };
  const canonical = new Map<string, JuryCaseView>();
  for (const c of cases) {
    if (!c.genuine_challenge || !isCurrent(c) || c.depth === null || c.depth < CANONICAL_DEPTH) continue;
    const best = canonical.get(c.claim);
    if (!best || c.opened.slot < best.opened.slot || (c.opened.slot === best.opened.slot && c.case < best.case)) {
      canonical.set(c.claim, c);
    }
  }
  for (const c of canonical.values()) c.canonical = true;

  jurors.sort((a, b) => b.registered.slot - a.registered.slot || (a.juror < b.juror ? -1 : a.juror > b.juror ? 1 : 0));
  cases.sort((a, b) => b.opened.slot - a.opened.slot || (a.case < b.case ? -1 : a.case > b.case ? 1 : 0));
  return { chain_time: iso(now), jurors, cases };
}

/** POSIX ms of the last block that the indexer applied; the clock for a new database. */
export function chainTimeMs(cache: Pick<SqliteCache, "getCursor">, networkId: NetworkId): number {
  const cursor = cache.getCursor();
  return cursor ? slotToPosixMs(cursor.slot, networkId === 1 ? VECTOR_MAINNET : VECTOR_TESTNET) : Date.now();
}

/** The jury view of the indexed data: the deployments' outputs, their documents and the chain time. */
export function loadJuryView(
  cache: Pick<
    SqliteCache,
    "listJuryOutputs" | "getDocument" | "getDocumentSummaries" | "getDocumentSummariesByHash" | "getUtxosByRefs" | "getCursor" | "getTipHeight"
  >,
  deployments: readonly JuryDeployment[],
  networkId: NetworkId,
): JuryView {
  return buildJuryView({
    rows: deployments.length > 0 ? cache.listJuryOutputs(deployments.map((d) => d.scriptHash)) : [],
    deployments,
    documents: (txHashes) => cache.getDocumentSummaries(txHashes),
    networkId,
    chainTimeMs: chainTimeMs(cache, networkId),
    tipHeight: cache.getTipHeight(),
    outputs: (refs) => new Map(cache.getUtxosByRefs(refs).map((u) => [u.ref, u])),
    records: (hashes) => cache.getDocumentSummariesByHash(hashes, "juror-record"),
    recordRefs: (revealTxs) => {
      const refs = new Map<string, string>();
      for (const tx of revealTxs) {
        const doc = cache.getDocument(tx);
        const target = doc?.type === "juror-record-ref" ? txIdFromVectorTxUri(new TextDecoder().decode(doc.bytes).trim()) : null;
        if (target) refs.set(tx, target);
      }
      return refs;
    },
  });
}
