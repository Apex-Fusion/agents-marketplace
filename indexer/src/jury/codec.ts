/**
 * indexer/src/jury/codec.ts — decoders of the jury contract data (jury SPEC §5).
 *
 *   JuryDatum   = Juror (Constr 0, 6 fields) | Case (Constr 1, 17 fields)
 *   Juror       : agent, owner, prompt_hash, registered_at, exit_after: Option<Int>, open: List<OpenVote>
 *   OpenVote    : Constr 0 [case, reveal_end]
 *   Case        : challenge, claim, challenge_out: OutputReference, claim_out: OutputReference,
 *                 claimer, auditor, claim_hash, evidence_hash, deadline, opened_at, commit_end,
 *                 reveal_end, refund_to: Address,
 *                 fee, ballots: List<Ballot>, tally: Tally, state: CaseState
 *   Ballot      : Constr 0 [agent, juror, commit, status]; commit has 32 bytes while the ballot is Committed, and
 *                 is empty after the reveal (CaseReveal sets it to #"", CaseClaim keeps it; §6.10 rule 6)
 *   BallotStatus: Committed (0) | Revealed { vote } (1) | Paid { vote } (2)
 *   Tally       : Constr 0 [claimer, auditor, inconclusive]
 *   CaseState   : Open (0) | Settling { share } (1)
 *   Vote        : ClaimerWins (0) | AuditorWins (1) | Inconclusive (2)
 *   MintAction  : Register { seed } (0) | Open { seed } (1) | Burn (2); seed = OutputReference
 *   SpendAction : OnJuror(JurorAction) (0) | OnCase(CaseAction) (1)
 *   JurorAction : Commit { case } 0, Reveal { case } 1, Claim { case } 2, Slash { case } 3,
 *                 RequestExit 4, Exit 5, TopUp 6
 *   CaseAction  : CaseCommit { juror, commit } 0, CaseReveal { juror, vote, salt, record_hash } 1,
 *                 Finalize { result } 2, CaseClaim { juror } 3, Close 4
 *
 * The decoders are strict: the constructor index, the number of fields and the
 * kind of each field must match, and the byte strings that the validator
 * checks (§6.1 rule 4, §6.9 rule 5, §6.10 rule 4) and the token names must
 * have their size. Each decoder returns null for any other value. Byte strings
 * are lowercase hex; times are POSIX milliseconds; lovelace is a bigint.
 */

import { decodePlutusDataHex, plutusAddressFromData, type PlutusAddress, type PlutusData } from "@marketplace/shared/cbor";

export type Vote = "ClaimerWins" | "AuditorWins" | "Inconclusive";
export const VOTES: readonly Vote[] = ["ClaimerWins", "AuditorWins", "Inconclusive"];

/** Token name prefixes (SPEC §4): `jrr_` for a juror token, `cas_` for a case token. */
export const JUROR_TOKEN_PREFIX = "6a72725f";
export const CASE_TOKEN_PREFIX = "6361735f";

export interface OpenVote {
  case: string;
  revealEnd: number;
}

export interface JurorDatum {
  variant: "Juror";
  agent: string;
  owner: string;
  promptHash: string;
  registeredAt: number;
  exitAfter: number | null;
  open: OpenVote[];
}

export type BallotStatus =
  | { kind: "Committed" }
  | { kind: "Revealed"; vote: Vote }
  | { kind: "Paid"; vote: Vote };

export interface Ballot {
  agent: string;
  juror: string;
  commit: string;
  status: BallotStatus;
}

export interface Tally {
  claimer: number;
  auditor: number;
  inconclusive: number;
}

export type CaseState = { kind: "Open" } | { kind: "Settling"; share: bigint };

export interface CaseDatum {
  variant: "Case";
  challenge: string;
  claim: string;
  /** "<tx>#<index>" of the challenge output that the opening transaction read. */
  challengeOut: string;
  /** "<tx>#<index>" of the claim output that the opening transaction read. */
  claimOut: string;
  claimer: string;
  auditor: string;
  claimHash: string;
  evidenceHash: string;
  deadline: number;
  openedAt: number;
  commitEnd: number;
  revealEnd: number;
  refundTo: PlutusAddress;
  fee: bigint;
  /** Newest commit first (a commit puts its ballot at the head of the list). */
  ballots: Ballot[];
  tally: Tally;
  state: CaseState;
}

export type JuryDatum = JurorDatum | CaseDatum;

export type JuryMintAction =
  | { kind: "Register"; seed: string }
  | { kind: "Open"; seed: string }
  | { kind: "Burn" };

export type JurorAction =
  | { kind: "Commit" | "Reveal" | "Claim" | "Slash"; case: string }
  | { kind: "RequestExit" | "Exit" | "TopUp" };

export type CaseAction =
  | { kind: "CaseCommit"; juror: string; commit: string }
  | { kind: "CaseReveal"; juror: string; vote: Vote; salt: string; recordHash: string }
  | { kind: "Finalize"; result: Vote }
  | { kind: "CaseClaim"; juror: string }
  | { kind: "Close" };

export type JurySpendAction =
  | { on: "Juror"; action: JurorAction }
  | { on: "Case"; action: CaseAction };

// ─── Plutus Data helpers ─────────────────────────────────────────────────

/** The fields of a constructor with this index and field count; null otherwise. */
function fieldsOf(d: PlutusData | undefined, index: number, count: number): PlutusData[] | null {
  return d?.kind === "constr" && d.index === BigInt(index) && d.fields.length === count ? d.fields : null;
}

function constrIndex(d: PlutusData | undefined): number | null {
  return d?.kind === "constr" && d.index <= 100n ? Number(d.index) : null;
}

/** A byte string as lowercase hex; with `size`, only of that many bytes. */
function bytesOf(d: PlutusData | undefined, size?: number): string | null {
  if (d?.kind !== "bytes") return null;
  const hex = d.hex.toLowerCase();
  return size === undefined || hex.length === size * 2 ? hex : null;
}

/** A time (POSIX ms) or a count: a safe integer. */
function intOf(d: PlutusData | undefined): number | null {
  if (d?.kind !== "int") return null;
  const n = Number(d.value);
  return Number.isSafeInteger(n) ? n : null;
}

function listOf<T>(d: PlutusData | undefined, item: (x: PlutusData) => T | null): T[] | null {
  if (d?.kind !== "list") return null;
  const out: T[] = [];
  for (const x of d.items) {
    const decoded = item(x);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

function decodeHex(hex: string): PlutusData | null {
  try {
    return decodePlutusDataHex(hex);
  } catch {
    return null;
  }
}

/** OutputReference Constr 0 [transaction_id, output_index] → "<tx>#<index>". */
function outRefOf(d: PlutusData | undefined): string | null {
  const f = fieldsOf(d, 0, 2);
  const tx = bytesOf(f?.[0], 32);
  const index = intOf(f?.[1]);
  return tx !== null && index !== null && index >= 0 ? `${tx}#${index}` : null;
}

// ─── Data types ─────────────────────────────────────────────────────────

export function voteFromData(d: PlutusData): Vote | null {
  const index = constrIndex(d);
  return index !== null && fieldsOf(d, index, 0) ? (VOTES[index] ?? null) : null;
}

function openVoteFromData(d: PlutusData): OpenVote | null {
  const f = fieldsOf(d, 0, 2);
  const caseName = bytesOf(f?.[0], 32);
  const revealEnd = intOf(f?.[1]);
  return caseName !== null && revealEnd !== null ? { case: caseName, revealEnd } : null;
}

function ballotStatusFromData(d: PlutusData): BallotStatus | null {
  if (fieldsOf(d, 0, 0)) return { kind: "Committed" };
  for (const [index, kind] of [[1, "Revealed"], [2, "Paid"]] as const) {
    const f = fieldsOf(d, index, 1);
    const vote = f ? voteFromData(f[0]!) : null;
    if (vote) return { kind, vote };
  }
  return null;
}

/**
 * A ballot. The commit of a Committed ballot has 32 bytes. CaseReveal replaces it with empty bytes and CaseClaim
 * keeps it (§6.10 rule 6), so a Revealed or Paid ballot has an empty commit; 32 bytes are accepted as well.
 */
export function ballotFromData(d: PlutusData): Ballot | null {
  const f = fieldsOf(d, 0, 4);
  if (!f) return null;
  const agent = bytesOf(f[0]);
  const juror = bytesOf(f[1], 32);
  const commit = bytesOf(f[2]);
  const status = ballotStatusFromData(f[3]!);
  if (agent === null || juror === null || commit === null || !status) return null;
  const size = commit.length / 2;
  const commitOk = status.kind === "Committed" ? size === 32 : size === 0 || size === 32;
  return commitOk ? { agent, juror, commit, status } : null;
}

export function tallyFromData(d: PlutusData): Tally | null {
  const f = fieldsOf(d, 0, 3);
  const [claimer, auditor, inconclusive] = [intOf(f?.[0]), intOf(f?.[1]), intOf(f?.[2])];
  return claimer !== null && auditor !== null && inconclusive !== null && claimer >= 0 && auditor >= 0 && inconclusive >= 0
    ? { claimer, auditor, inconclusive }
    : null;
}

export function caseStateFromData(d: PlutusData): CaseState | null {
  if (fieldsOf(d, 0, 0)) return { kind: "Open" };
  const share = fieldsOf(d, 1, 1)?.[0];
  return share?.kind === "int" ? { kind: "Settling", share: share.value } : null;
}

function addressOf(d: PlutusData | undefined): PlutusAddress | null {
  if (!d) return null;
  try {
    return plutusAddressFromData(d);
  } catch {
    return null;
  }
}

function jurorFromFields(f: PlutusData[]): JurorDatum | null {
  const agent = bytesOf(f[0], 32);
  const owner = bytesOf(f[1], 28);
  const promptHash = bytesOf(f[2], 32);
  const registeredAt = intOf(f[3]);
  let exitAfter: number | null | undefined;
  if (fieldsOf(f[4], 1, 0)) exitAfter = null;
  else {
    const t = intOf(fieldsOf(f[4], 0, 1)?.[0]);
    exitAfter = t === null ? undefined : t;
  }
  const open = listOf(f[5], openVoteFromData);
  if (agent === null || owner === null || promptHash === null || registeredAt === null || exitAfter === undefined || !open) {
    return null;
  }
  return { variant: "Juror", agent, owner, promptHash, registeredAt, exitAfter, open };
}

function caseFromFields(f: PlutusData[]): CaseDatum | null {
  const challenge = bytesOf(f[0], 32);
  const claim = bytesOf(f[1], 32);
  const challengeOut = outRefOf(f[2]);
  const claimOut = outRefOf(f[3]);
  const claimer = bytesOf(f[4]);
  const auditor = bytesOf(f[5]);
  const claimHash = bytesOf(f[6]);
  const evidenceHash = bytesOf(f[7]);
  const [deadline, openedAt, commitEnd, revealEnd] = [intOf(f[8]), intOf(f[9]), intOf(f[10]), intOf(f[11])];
  const refundTo = addressOf(f[12]);
  const feeData = f[13];
  const fee = feeData?.kind === "int" ? feeData.value : null;
  const ballots = listOf(f[14], ballotFromData);
  const tally = f[15] ? tallyFromData(f[15]) : null;
  const state = f[16] ? caseStateFromData(f[16]) : null;
  if (
    challenge === null || claim === null || challengeOut === null || claimOut === null || claimer === null ||
    auditor === null || claimHash === null || evidenceHash === null || deadline === null || openedAt === null ||
    commitEnd === null || revealEnd === null || refundTo === null || fee === null || !ballots || !tally || !state
  ) {
    return null;
  }
  return {
    variant: "Case", challenge, claim, challengeOut, claimOut, claimer, auditor, claimHash, evidenceHash,
    deadline, openedAt, commitEnd, revealEnd, refundTo, fee, ballots, tally, state,
  };
}

/** A juror or case datum (inline datum of a jury output); null for any other value. */
export function decodeJuryDatum(datumHex: string): JuryDatum | null {
  const d = decodeHex(datumHex);
  const juror = fieldsOf(d ?? undefined, 0, 6);
  if (juror) return jurorFromFields(juror);
  const caseFields = fieldsOf(d ?? undefined, 1, 17);
  return caseFields ? caseFromFields(caseFields) : null;
}

/** A mint redeemer of the jury policy; null for any other value. */
export function decodeJuryMintAction(redeemerHex: string): JuryMintAction | null {
  const d = decodeHex(redeemerHex) ?? undefined;
  for (const [index, kind] of [[0, "Register"], [1, "Open"]] as const) {
    const f = fieldsOf(d, index, 1);
    const seed = f ? outRefOf(f[0]) : null;
    if (seed) return { kind, seed };
  }
  return fieldsOf(d, 2, 0) ? { kind: "Burn" } : null;
}

const CASE_ARG_ACTIONS = ["Commit", "Reveal", "Claim", "Slash"] as const;
const PLAIN_JUROR_ACTIONS = ["RequestExit", "Exit", "TopUp"] as const;

function jurorActionFromData(d: PlutusData): JurorAction | null {
  const index = constrIndex(d);
  if (index === null) return null;
  if (index < 4) {
    const caseName = bytesOf(fieldsOf(d, index, 1)?.[0], 32);
    return caseName !== null ? { kind: CASE_ARG_ACTIONS[index]!, case: caseName } : null;
  }
  const kind = PLAIN_JUROR_ACTIONS[index - 4];
  return kind && fieldsOf(d, index, 0) ? { kind } : null;
}

function caseActionFromData(d: PlutusData): CaseAction | null {
  switch (constrIndex(d)) {
    case 0: {
      const f = fieldsOf(d, 0, 2);
      const [juror, commit] = [bytesOf(f?.[0], 32), bytesOf(f?.[1], 32)];
      return juror !== null && commit !== null ? { kind: "CaseCommit", juror, commit } : null;
    }
    case 1: {
      const f = fieldsOf(d, 1, 4);
      if (!f) return null;
      const juror = bytesOf(f[0], 32);
      const vote = voteFromData(f[1]!);
      const salt = bytesOf(f[2], 32);
      const recordHash = bytesOf(f[3], 32);
      return juror !== null && vote && salt !== null && recordHash !== null
        ? { kind: "CaseReveal", juror, vote, salt, recordHash }
        : null;
    }
    case 2: {
      const f = fieldsOf(d, 2, 1);
      const result = f ? voteFromData(f[0]!) : null;
      return result ? { kind: "Finalize", result } : null;
    }
    case 3: {
      const juror = bytesOf(fieldsOf(d, 3, 1)?.[0], 32);
      return juror !== null ? { kind: "CaseClaim", juror } : null;
    }
    case 4:
      return fieldsOf(d, 4, 0) ? { kind: "Close" } : null;
    default:
      return null;
  }
}

/** A spend redeemer of a jury output; null for any other value. */
export function decodeJurySpendAction(redeemerHex: string): JurySpendAction | null {
  const d = decodeHex(redeemerHex) ?? undefined;
  const onJuror = fieldsOf(d, 0, 1);
  if (onJuror) {
    const action = jurorActionFromData(onJuror[0]!);
    return action ? { on: "Juror", action } : null;
  }
  const onCase = fieldsOf(d, 1, 1);
  const action = onCase ? caseActionFromData(onCase[0]!) : null;
  return action ? { on: "Case", action } : null;
}
