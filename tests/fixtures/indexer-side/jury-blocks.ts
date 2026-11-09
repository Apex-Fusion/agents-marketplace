/**
 * tests/fixtures/indexer-side/jury-blocks.ts — jury fixtures for indexer tests
 * (Module-1/jury/SPEC.md §5, §10, §11).
 *
 * Builders of the jury data as Plutus Data with the field orders of SPEC §5
 * (JuryDatum Juror/Case, Ballot, Tally, CaseState, MintAction, SpendAction),
 * of the Module-1 claim and challenge datums that the dispute view reads, of
 * label 22084 documents, and of IndexerTx outputs at the jury address.
 *
 * Indexer-side only (see sample-blocks.ts). Addresses are testnet enterprise
 * script addresses of synthetic script hashes, so that the config validation
 * accepts them.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { plutusAddressToBech32, plutusAddressToData, type PlutusAddress } from "../../../packages/shared/src/cbor/address.js";
import { encodePlutusDataHex, type PlutusData } from "../../../packages/shared/src/cbor/plutus-data.js";
import type { JuryParams } from "../../../indexer/src/config.js";
import type { Metadatum, TxOutput } from "../../../indexer/src/follower/types.js";

// ─── Addresses, hashes and parameters ────────────────────────────────────────

const scriptAddress = (hash: string): string =>
  plutusAddressToBech32({ paymentCredential: { type: "Script", hash }, stakeCredential: null }, 0);

export const JURY_SCRIPT_HASH = "4a".repeat(28);
export const JURY_ADDRESS = scriptAddress(JURY_SCRIPT_HASH);
export const OTHER_JURY_SCRIPT_HASH = "4b".repeat(28);
export const OTHER_JURY_ADDRESS = scriptAddress(OTHER_JURY_SCRIPT_HASH);

export const M1_CLAIM_HASH = "c1".repeat(28);
export const M1_CLAIM_ADDRESS = scriptAddress(M1_CLAIM_HASH);
export const M1_CHALLENGE_HASH = "c2".repeat(28);
export const M1_CHALLENGE_ADDRESS = scriptAddress(M1_CHALLENGE_HASH);
export const M1_PARTY_ADDRESS = scriptAddress("c3".repeat(28));

export const TREASURY_ADDRESS = scriptAddress("7e".repeat(28));
export const REFUND_ADDRESS: PlutusAddress = {
  paymentCredential: { type: "VerificationKey", hash: "5f".repeat(28) },
  stakeCredential: null,
};
export const REFUND_ADDRESS_BECH32 = plutusAddressToBech32(REFUND_ADDRESS, 0);

/** The mainnet parameter values of SPEC §3, with this file's Module-1 hashes. */
export const JURY_PARAMS: JuryParams = {
  identity_hash: "1d".repeat(28),
  m1_claim: M1_CLAIM_HASH,
  m1_challenge: M1_CHALLENGE_HASH,
  treasury: TREASURY_ADDRESS,
  bond_min: 250_000_000,
  slash: 25_000_000,
  juror_floor: 10_000_000,
  eligibility_delay: 259_200_000,
  exit_notice: 259_200_000,
  commit_window: 7_200_000,
  reveal_window: 7_200_000,
  resolve_margin: 7_200_000,
  claim_period: 2_592_000_000,
  quorum: 3,
  majority_num: 2,
  majority_den: 3,
};

/** One JURY_DEPLOYMENTS entry (the env JSON form). */
export function juryDeploymentJson(label: string, scriptHash = JURY_SCRIPT_HASH, params: Partial<JuryParams> = {}) {
  return {
    label, address: scriptAddress(scriptHash), script_hash: scriptHash, params: { ...JURY_PARAMS, ...params },
    cases_from: 0, cases_until: null as number | null,
  };
}

const splitRef = (ref: string): [string, number] => {
  const [tx, index] = ref.split("#");
  return [tx!, Number(index)];
};

// ─── Plutus Data ─────────────────────────────────────────────────────────────

export const pd = {
  constr: (index: number, fields: PlutusData[] = []): PlutusData => ({ kind: "constr", index: BigInt(index), fields }),
  bytes: (hex: string): PlutusData => ({ kind: "bytes", hex }),
  int: (n: number | bigint): PlutusData => ({ kind: "int", value: BigInt(n) }),
  list: (items: PlutusData[]): PlutusData => ({ kind: "list", items }),
};

const utf8Hex = (text: string): string => Buffer.from(text, "utf8").toString("hex");

export type VoteName = "ClaimerWins" | "AuditorWins" | "Inconclusive";
const VOTE_INDEX: Record<VoteName, number> = { ClaimerWins: 0, AuditorWins: 1, Inconclusive: 2 };
export const voteData = (vote: VoteName): PlutusData => pd.constr(VOTE_INDEX[vote]);

/** A 32-byte token name: the prefix (`jrr_` 6a72725f, `cas_` 6361735f) and 28 bytes from `n`. */
export const jurorToken = (n: number): string => `6a72725f${n.toString(16).padStart(2, "0").repeat(28)}`;
export const caseToken = (n: number): string => `6361735f${n.toString(16).padStart(2, "0").repeat(28)}`;

export interface JurorDatumOpts {
  agent: string;
  owner?: string;
  promptHash?: string;
  registeredAt: number;
  exitAfter?: number | null;
  open?: Array<{ case: string; revealEnd: number }>;
}

export function jurorDatumData(o: JurorDatumOpts): PlutusData {
  return pd.constr(0, [
    pd.bytes(o.agent),
    pd.bytes(o.owner ?? "0e".repeat(28)),
    pd.bytes(o.promptHash ?? "9a".repeat(32)),
    pd.int(o.registeredAt),
    o.exitAfter === undefined || o.exitAfter === null ? pd.constr(1) : pd.constr(0, [pd.int(o.exitAfter)]),
    pd.list((o.open ?? []).map((e) => pd.constr(0, [pd.bytes(e.case), pd.int(e.revealEnd)]))),
  ]);
}

export const jurorDatumHex = (o: JurorDatumOpts): string => encodePlutusDataHex(jurorDatumData(o));

export type BallotStatusOpts = "Committed" | { revealed: VoteName } | { paid: VoteName };

export interface BallotOpts {
  agent: string;
  juror: string;
  commit?: string;
  status?: BallotStatusOpts;
}

export function ballotData(b: BallotOpts): PlutusData {
  const status = b.status ?? "Committed";
  return pd.constr(0, [
    pd.bytes(b.agent),
    pd.bytes(b.juror),
    pd.bytes(b.commit ?? "cc".repeat(32)),
    status === "Committed"
      ? pd.constr(0)
      : "revealed" in status
        ? pd.constr(1, [voteData(status.revealed)])
        : pd.constr(2, [voteData(status.paid)]),
  ]);
}

export interface CaseDatumOpts {
  challenge: string;
  claim: string;
  claimer: string;
  auditor: string;
  claimHash?: string;
  evidenceHash?: string;
  /** "<tx>#<index>" of the challenge output that the opening read. */
  challengeOut?: string;
  /** "<tx>#<index>" of the claim output that the opening read. */
  claimOut?: string;
  deadline: number;
  openedAt: number;
  commitWindow?: number;
  revealWindow?: number;
  refundTo?: PlutusAddress;
  fee?: bigint;
  /** In datum order: the newest commit first. */
  ballots?: BallotOpts[];
  tally?: [number, number, number];
  /** null: Open; a number: Settling { share }. */
  settlingShare?: bigint | null;
}

export function caseDatumData(o: CaseDatumOpts): PlutusData {
  const commitEnd = o.openedAt + (o.commitWindow ?? JURY_PARAMS.commit_window);
  const revealEnd = commitEnd + (o.revealWindow ?? JURY_PARAMS.reveal_window);
  const [claimer, auditor, inconclusive] = o.tally ?? [0, 0, 0];
  return pd.constr(1, [
    pd.bytes(o.challenge),
    pd.bytes(o.claim),
    outRef(...splitRef(o.challengeOut ?? `${"c2".repeat(32)}#0`)),
    outRef(...splitRef(o.claimOut ?? `${"c2".repeat(32)}#1`)),
    pd.bytes(o.claimer),
    pd.bytes(o.auditor),
    pd.bytes(o.claimHash ?? "a1".repeat(32)),
    pd.bytes(o.evidenceHash ?? "a2".repeat(32)),
    pd.int(o.deadline),
    pd.int(o.openedAt),
    pd.int(commitEnd),
    pd.int(revealEnd),
    plutusAddressToData(o.refundTo ?? REFUND_ADDRESS),
    pd.int(o.fee ?? 0n),
    pd.list((o.ballots ?? []).map(ballotData)),
    pd.constr(0, [pd.int(claimer), pd.int(auditor), pd.int(inconclusive)]),
    o.settlingShare === undefined || o.settlingShare === null ? pd.constr(0) : pd.constr(1, [pd.int(o.settlingShare)]),
  ]);
}

export const caseDatumHex = (o: CaseDatumOpts): string => encodePlutusDataHex(caseDatumData(o));

// ─── Redeemers ───────────────────────────────────────────────────────────────

const onJuror = (action: PlutusData): string => encodePlutusDataHex(pd.constr(0, [action]));
const onCase = (action: PlutusData): string => encodePlutusDataHex(pd.constr(1, [action]));

export const jurorAction = {
  commit: (caseName: string) => onJuror(pd.constr(0, [pd.bytes(caseName)])),
  reveal: (caseName: string) => onJuror(pd.constr(1, [pd.bytes(caseName)])),
  claim: (caseName: string) => onJuror(pd.constr(2, [pd.bytes(caseName)])),
  slash: (caseName: string) => onJuror(pd.constr(3, [pd.bytes(caseName)])),
  requestExit: () => onJuror(pd.constr(4)),
  exit: () => onJuror(pd.constr(5)),
  topUp: () => onJuror(pd.constr(6)),
};

export const caseAction = {
  commit: (juror: string, commit: string) => onCase(pd.constr(0, [pd.bytes(juror), pd.bytes(commit)])),
  reveal: (juror: string, vote: VoteName, salt: string, recordHash: string) =>
    onCase(pd.constr(1, [pd.bytes(juror), voteData(vote), pd.bytes(salt), pd.bytes(recordHash)])),
  finalize: (result: VoteName) => onCase(pd.constr(2, [voteData(result)])),
  claim: (juror: string) => onCase(pd.constr(3, [pd.bytes(juror)])),
  close: () => onCase(pd.constr(4)),
};

const outRef = (tx: string, index: number): PlutusData => pd.constr(0, [pd.bytes(tx), pd.int(index)]);

export const mintAction = {
  register: (tx: string, index: number) => encodePlutusDataHex(pd.constr(0, [outRef(tx, index)])),
  open: (tx: string, index: number) => encodePlutusDataHex(pd.constr(1, [outRef(tx, index)])),
  burn: () => encodePlutusDataHex(pd.constr(2)),
};

// ─── Module-1 datums and redeemers (Module-1 types.ak field order) ───────────

export interface ClaimDatumOpts {
  claimer: string;
  claimHash: string;
  storageUri: string;
  stake?: number;
  submittedAt?: number;
  window?: number;
  /** 0 Open, 1 Challenged. */
  state?: number;
}

export function claimDatumHex(o: ClaimDatumOpts): string {
  return encodePlutusDataHex(pd.constr(0, [
    pd.bytes(o.claimer),
    pd.constr(0, [pd.bytes("8c".repeat(28))]),
    pd.bytes(o.claimHash),
    pd.bytes(utf8Hex("certification")),
    pd.bytes(utf8Hex(o.storageUri)),
    pd.int(o.stake ?? 50_000_000),
    pd.int(o.submittedAt ?? 1_793_577_600_000),
    pd.int(o.window ?? 3_600_000),
    pd.constr(o.state ?? 0),
  ]));
}

export interface ChallengeDatumOpts {
  claimRef: string;
  auditor: string;
  evidenceHash: string;
  evidenceUri: string;
  challengedAt: number;
  resolutionDeadline: number;
  claimToken: string;
}

export function challengeDatumHex(o: ChallengeDatumOpts): string {
  const [tx, index] = o.claimRef.split("#");
  return encodePlutusDataHex(pd.constr(0, [
    outRef(tx!, Number(index)),
    pd.bytes(o.auditor),
    pd.constr(0, [pd.bytes("31".repeat(28))]),
    pd.int(50_000_000),
    pd.bytes(o.evidenceHash),
    pd.bytes(utf8Hex(o.evidenceUri)),
    pd.int(o.challengedAt),
    pd.int(o.resolutionDeadline),
    pd.list([]),
    pd.constr(0),
    pd.bytes(o.claimToken),
  ]));
}

export const oracleResolveHex = (vote: VoteName, reasoningHash: string): string =>
  encodePlutusDataHex(pd.constr(2, [voteData(vote), pd.bytes(reasoningHash)]));

// ─── Documents (SPEC §10.1) ──────────────────────────────────────────────────

export const blake2b256 = (bytes: Uint8Array): string => Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex");
export const textHash = (text: string): string => blake2b256(new TextEncoder().encode(text));

/** UTF-8 chunks of at most 64 bytes, split at character boundaries. */
export function chunks(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text) {
    if (Buffer.byteLength(current + ch, "utf8") > 64) {
      out.push(current);
      current = "";
    }
    current += ch;
  }
  if (current !== "" || out.length === 0) out.push(current);
  return out;
}

/** The label 22084 value of a document, as the Metadatum that the follower gives. */
export function documentMetadatum(type: string, text: string, mediaType = "application/json"): Metadatum {
  const textItem = (value: string): Metadatum => ({ kind: "text", value });
  return {
    kind: "map",
    entries: [
      [textItem("v"), { kind: "int", value: 1n }],
      [textItem("t"), textItem(type)],
      [textItem("m"), textItem(mediaType)],
      [textItem("d"), { kind: "list", items: chunks(text).map(textItem) }],
    ],
  };
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

/** An output at a jury address that holds one jury token. */
export function juryOutput(token: string, datumHex: string, lovelace: number, scriptHash = JURY_SCRIPT_HASH): TxOutput {
  return {
    address: scriptAddress(scriptHash),
    value: { ada: { lovelace }, [scriptHash]: { [token]: 1 } },
    datum: datumHex,
  };
}

export const plainOutput = (address: string, lovelace: number, datum?: string): TxOutput => ({
  address,
  value: { ada: { lovelace } },
  ...(datum ? { datum } : {}),
});
