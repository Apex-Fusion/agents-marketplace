/**
 * tests/unit/indexer-jury.test.ts — the jury in the indexer (Module-1/jury/SPEC.md).
 *
 * Covers the decoders of the jury data (§5; CBOR fixtures built from the
 * field orders of the specification), the JURY_DEPLOYMENTS configuration, the
 * capture of jury outputs and spends, the view (result rule §8, ballots,
 * eligibility, canonical case §11), and one chain from the claim to the
 * OracleResolve through the worker and the routes: /jury, /jury/jurors,
 * /jury/cases and the jury and document fields of /disputes.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";

import { VECTOR_TESTNET, slotToPosixMs } from "@marketplace/shared";
import { loadConfig } from "../../indexer/src/config.js";
import type { JuryOutputRow, UtxoRow } from "../../indexer/src/db/cache.js";
import { SqliteCache } from "../../indexer/src/db/cache.js";
import { vectorTxUri } from "../../indexer/src/documents/document.js";
import { processBlock } from "../../indexer/src/follower/blockProcessor.js";
import type { IndexerBlock, IndexerTx, TxOutput } from "../../indexer/src/follower/types.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import {
  ballotFromData,
  caseStateFromData,
  decodeJuryDatum,
  decodeJuryMintAction,
  decodeJurySpendAction,
  tallyFromData,
} from "../../indexer/src/jury/codec.js";
import { buildJuryView, juryOutcome } from "../../indexer/src/jury/view.js";
import { createApp } from "../../indexer/src/server.js";
import { encodePlutusDataHex } from "../../packages/shared/src/cbor/plutus-data.js";
import { MockChainSyncSource } from "./__helpers__/MockChainSyncSource.js";
import {
  JURY_ADDRESS,
  JURY_PARAMS,
  JURY_SCRIPT_HASH,
  M1_CHALLENGE_ADDRESS,
  M1_CHALLENGE_HASH,
  M1_CLAIM_ADDRESS,
  M1_PARTY_ADDRESS,
  OTHER_JURY_SCRIPT_HASH,
  REFUND_ADDRESS,
  REFUND_ADDRESS_BECH32,
  TREASURY_ADDRESS,
  ballotData,
  caseAction,
  caseDatumData,
  caseDatumHex,
  caseToken,
  challengeDatumHex,
  claimDatumHex,
  documentMetadatum,
  juryDeploymentJson,
  juryOutput,
  jurorAction,
  jurorDatumHex,
  jurorToken,
  mintAction,
  oracleResolveHex,
  pd,
  plainOutput,
  textHash,
  type BallotOpts,
  type BallotStatusOpts,
  type CaseDatumOpts,
} from "../fixtures/indexer-side/jury-blocks.js";

const t = (slot: number): number => slotToPosixMs(slot, VECTOR_TESTNET);
const txId = (n: number): string => n.toString(16).padStart(64, "0");
const AGENT = { A: "b1".repeat(32), B: "b2".repeat(32), C: "b3".repeat(32), D: "b4".repeat(32) };
const CLAIMER = "a1".repeat(32);
const AUDITOR = "a2".repeat(32);
const CHALLENGE_TOKEN = `63686c5f${"ce".repeat(28)}`;
const CLAIM_TOKEN = `636c6d5f${"75".repeat(28)}`;

// ─── Decoders (§5) ────────────────────────────────────────────────────────────

describe("jury decoders — SPEC §5", () => {
  const caseOpts: CaseDatumOpts = {
    challenge: CHALLENGE_TOKEN,
    claim: CLAIM_TOKEN,
    claimer: CLAIMER,
    auditor: AUDITOR,
    deadline: 9_000_000,
    openedAt: 1_000,
    fee: 30n,
    ballots: [
      { agent: AGENT.C, juror: jurorToken(3), status: { paid: "Inconclusive" } },
      { agent: AGENT.B, juror: jurorToken(2), status: { revealed: "AuditorWins" } },
      { agent: AGENT.A, juror: jurorToken(1) },
    ],
    tally: [0, 1, 1],
    settlingShare: 15n,
  };

  it("decodes a Juror datum (Constr 0, 6 fields) with an exit time and open votes", () => {
    const hex = jurorDatumHex({
      agent: AGENT.A,
      owner: "0e".repeat(28),
      promptHash: "9a".repeat(32),
      registeredAt: 1_000,
      exitAfter: 5_000,
      open: [{ case: caseToken(1), revealEnd: 3_000 }],
    });
    expect(decodeJuryDatum(hex)).toEqual({
      variant: "Juror",
      agent: AGENT.A,
      owner: "0e".repeat(28),
      promptHash: "9a".repeat(32),
      registeredAt: 1_000,
      exitAfter: 5_000,
      open: [{ case: caseToken(1), revealEnd: 3_000 }],
    });
    expect(decodeJuryDatum(jurorDatumHex({ agent: AGENT.A, registeredAt: 1 }))).toMatchObject({ exitAfter: null, open: [] });
  });

  it("decodes a Case datum (Constr 1, 17 fields): ballots, tally and state", () => {
    const decoded = decodeJuryDatum(caseDatumHex(caseOpts));
    expect(decoded).toMatchObject({
      variant: "Case",
      challenge: CHALLENGE_TOKEN,
      claim: CLAIM_TOKEN,
      claimer: CLAIMER,
      auditor: AUDITOR,
      challengeOut: `${"c2".repeat(32)}#0`,
      claimOut: `${"c2".repeat(32)}#1`,
      deadline: 9_000_000,
      openedAt: 1_000,
      commitEnd: 1_000 + 7_200_000,
      revealEnd: 1_000 + 14_400_000,
      refundTo: REFUND_ADDRESS,
      fee: 30n,
      tally: { claimer: 0, auditor: 1, inconclusive: 1 },
      state: { kind: "Settling", share: 15n },
    });
    if (decoded?.variant !== "Case") throw new Error("not a case");
    expect(decoded.ballots.map((b) => [b.agent, b.status])).toEqual([
      [AGENT.C, { kind: "Paid", vote: "Inconclusive" }],
      [AGENT.B, { kind: "Revealed", vote: "AuditorWins" }],
      [AGENT.A, { kind: "Committed" }],
    ]);
  });

  it("refuses data of another shape: the 18-field case with deposit, short byte strings, a wrong variant", () => {
    const data = caseDatumData(caseOpts);
    if (data.kind !== "constr") throw new Error("not a constr");
    const withDeposit = pd.constr(1, [...data.fields.slice(0, 13), pd.int(5), ...data.fields.slice(13)]);
    expect(decodeJuryDatum(encodePlutusDataHex(withDeposit))).toBeNull();
    expect(decodeJuryDatum(jurorDatumHex({ agent: AGENT.A, owner: "0e".repeat(27), registeredAt: 1 }))).toBeNull();
    expect(decodeJuryDatum(encodePlutusDataHex(pd.constr(2, [])))).toBeNull();
    expect(decodeJuryDatum("zz")).toBeNull();
  });

  it("decodes Ballot, Tally and CaseState on their own", () => {
    expect(ballotFromData(ballotData({ agent: AGENT.A, juror: jurorToken(1), commit: "cd".repeat(32), status: { revealed: "ClaimerWins" } })))
      .toEqual({ agent: AGENT.A, juror: jurorToken(1), commit: "cd".repeat(32), status: { kind: "Revealed", vote: "ClaimerWins" } });
    expect(ballotFromData(ballotData({ agent: AGENT.A, juror: jurorToken(1), commit: "cd".repeat(31) }))).toBeNull();
    expect(tallyFromData(pd.constr(0, [pd.int(1), pd.int(2), pd.int(3)]))).toEqual({ claimer: 1, auditor: 2, inconclusive: 3 });
    expect(tallyFromData(pd.constr(0, [pd.int(1), pd.int(2)]))).toBeNull();
    expect(caseStateFromData(pd.constr(0))).toEqual({ kind: "Open" });
    expect(caseStateFromData(pd.constr(1, [pd.int(7)]))).toEqual({ kind: "Settling", share: 7n });
    expect(caseStateFromData(pd.constr(2))).toBeNull();
  });

  it("decodes each MintAction", () => {
    expect(decodeJuryMintAction(mintAction.register("ab".repeat(32), 3))).toEqual({ kind: "Register", seed: `${"ab".repeat(32)}#3` });
    expect(decodeJuryMintAction(mintAction.open("cd".repeat(32), 0))).toEqual({ kind: "Open", seed: `${"cd".repeat(32)}#0` });
    expect(decodeJuryMintAction(mintAction.burn())).toEqual({ kind: "Burn" });
    expect(decodeJuryMintAction(encodePlutusDataHex(pd.constr(3)))).toBeNull();
    expect(decodeJuryMintAction(encodePlutusDataHex(pd.constr(0, [pd.constr(0, [pd.bytes("ab"), pd.int(0)])])))).toBeNull();
  });

  it("decodes each SpendAction: OnJuror(JurorAction) and OnCase(CaseAction)", () => {
    const c = caseToken(1);
    const j = jurorToken(1);
    expect([
      jurorAction.commit(c), jurorAction.reveal(c), jurorAction.claim(c), jurorAction.slash(c),
      jurorAction.requestExit(), jurorAction.exit(), jurorAction.topUp(),
    ].map(decodeJurySpendAction)).toEqual([
      { on: "Juror", action: { kind: "Commit", case: c } },
      { on: "Juror", action: { kind: "Reveal", case: c } },
      { on: "Juror", action: { kind: "Claim", case: c } },
      { on: "Juror", action: { kind: "Slash", case: c } },
      { on: "Juror", action: { kind: "RequestExit" } },
      { on: "Juror", action: { kind: "Exit" } },
      { on: "Juror", action: { kind: "TopUp" } },
    ]);
    expect([
      caseAction.commit(j, "cc".repeat(32)),
      caseAction.reveal(j, "AuditorWins", "5a".repeat(32), "7c".repeat(32)),
      caseAction.finalize("Inconclusive"),
      caseAction.claim(j),
      caseAction.close(),
    ].map(decodeJurySpendAction)).toEqual([
      { on: "Case", action: { kind: "CaseCommit", juror: j, commit: "cc".repeat(32) } },
      { on: "Case", action: { kind: "CaseReveal", juror: j, vote: "AuditorWins", salt: "5a".repeat(32), recordHash: "7c".repeat(32) } },
      { on: "Case", action: { kind: "Finalize", result: "Inconclusive" } },
      { on: "Case", action: { kind: "CaseClaim", juror: j } },
      { on: "Case", action: { kind: "Close" } },
    ]);
    expect(decodeJurySpendAction(caseAction.reveal(j, "AuditorWins", "5a".repeat(31), "7c".repeat(32)))).toBeNull();
    expect(decodeJurySpendAction(encodePlutusDataHex(pd.constr(0, [pd.constr(7)])))).toBeNull();
    expect(decodeJurySpendAction(encodePlutusDataHex(pd.constr(2, [pd.constr(0)])))).toBeNull();
  });
});

// ─── Configuration ────────────────────────────────────────────────────────────

describe("JURY_DEPLOYMENTS", () => {
  const base = {
    OGMIOS_URL: "ws://localhost:1337",
    DB_PATH: ":memory:",
    NETWORK_ID: "0",
    MODULE1_CLAIM_ADDRESS: M1_CLAIM_ADDRESS,
    MODULE1_CHALLENGE_ADDRESS: M1_CHALLENGE_ADDRESS,
    MODULE1_PARTY_ADDRESS: M1_PARTY_ADDRESS,
  };
  const load = (deployments: unknown) => loadConfig({ ...base, JURY_DEPLOYMENTS: JSON.stringify(deployments) });

  it("is off when unset or empty", () => {
    expect(loadConfig(base).jury).toEqual([]);
    expect(load([]).jury).toEqual([]);
  });

  it("reads each deployment: label, address, script hash and the 16 parameters", () => {
    const entry = { ...juryDeploymentJson("jury-1"), network: "testnet", params_cbor: "d879" };
    const [d] = load([{ ...entry, params: { ...entry.params, quorum: "3" } }]).jury;
    expect(d).toEqual({ label: "jury-1", address: JURY_ADDRESS, scriptHash: JURY_SCRIPT_HASH, params: JURY_PARAMS, casesFrom: 0, casesUntil: null });
  });

  it("refuses wrong values", () => {
    const good = juryDeploymentJson("jury-1");
    expect(() => loadConfig({ ...base, JURY_DEPLOYMENTS: "{" })).toThrow(/not JSON/);
    expect(() => load(good)).toThrow(/JSON list/);
    expect(() => load([good, { ...juryDeploymentJson("jury-1", OTHER_JURY_SCRIPT_HASH) }])).toThrow(/occurs twice/);
    expect(() => load([{ ...good, address: TREASURY_ADDRESS }])).toThrow(/enterprise address of script_hash/);
    expect(() => load([{ ...good, script_hash: "XY" }])).toThrow(/script_hash/);
    expect(() => load([juryDeploymentJson("j", JURY_SCRIPT_HASH, { majority_den: 5 })])).toThrow(/majority_num/);
    expect(() => load([juryDeploymentJson("j", JURY_SCRIPT_HASH, { bond_min: 20_000_000 })])).toThrow(/bond_min/);
    expect(() => load([juryDeploymentJson("j", JURY_SCRIPT_HASH, { quorum: 0 })])).toThrow(/quorum must be a positive integer/);
    expect(() => load([juryDeploymentJson("j", JURY_SCRIPT_HASH, { treasury: "nope" })])).toThrow(/treasury/);
    expect(() => load([juryDeploymentJson("j", JURY_SCRIPT_HASH, { m1_claim: "c9".repeat(28) })])).toThrow(/Module-1 addresses/);
    expect(() => load([{ label: "j", address: JURY_ADDRESS, script_hash: JURY_SCRIPT_HASH, cases_from: 0 }])).toThrow(/params must be a JSON object/);
    expect(() => load([juryDeploymentJson("j", JURY_SCRIPT_HASH, { majority_den: 4 })])).toThrow(/majority_den < 2 \* majority_num/);
    expect(() => load([{ ...good, cases_from: -1 }])).toThrow(/cases_from/);
    expect(() => load([{ ...good, cases_from: null, cases_until: 1_000 }])).toThrow(/cases_until/);
    // SPEC §12.1: no cases_from — the jury is followed, and it is current for no challenge.
    expect(load([{ ...good, cases_from: undefined }]).jury[0]).toMatchObject({ casesFrom: null, casesUntil: null });
    expect(load([{ ...good, cases_from: null }, { ...juryDeploymentJson("j2", OTHER_JURY_SCRIPT_HASH), cases_from: 0 }]).jury)
      .toHaveLength(2);
    expect(() => load([{ ...good, cases_until: 1_000 }, { ...juryDeploymentJson("j2", OTHER_JURY_SCRIPT_HASH), cases_from: 500 }]))
      .toThrow(/overlap/);
    expect(load([{ ...good, cases_until: 1_000 }, { ...juryDeploymentJson("j2", OTHER_JURY_SCRIPT_HASH), cases_from: 1_000 }]).jury)
      .toHaveLength(2);
    expect(() => loadConfig({ ...base, ADVERT_SCRIPT_ADDRESS: JURY_ADDRESS, JURY_DEPLOYMENTS: JSON.stringify([good]) }))
      .toThrow(/must all differ/);
  });
});

// ─── Follower ─────────────────────────────────────────────────────────────────

describe("follower — jury outputs and spends", () => {
  const addresses = { advertAddress: "", escrowAddress: "", jury: [{ address: JURY_ADDRESS, scriptHash: JURY_SCRIPT_HASH }] };
  const datum = jurorDatumHex({ agent: AGENT.A, registeredAt: 1 });

  it("keeps an output with one jury token and an inline datum; leaves out other outputs at the address", () => {
    const tx: IndexerTx = {
      id: txId(1),
      inputs: [],
      outputs: [
        juryOutput(jurorToken(1), datum, 250_000_000),
        { address: JURY_ADDRESS, value: { ada: { lovelace: 5 } }, datum },
        { address: JURY_ADDRESS, value: { ada: { lovelace: 5 }, [JURY_SCRIPT_HASH]: { [jurorToken(2)]: 1, [jurorToken(3)]: 1 } }, datum },
        { address: JURY_ADDRESS, value: { ada: { lovelace: 5 }, [JURY_SCRIPT_HASH]: { [jurorToken(4)]: 1 } } },
      ],
    };
    const result = processBlock({ slot: 10, id: "b".repeat(64), transactions: [tx] }, new Map(), addresses);
    expect(result.juryOutputs).toEqual([{ ref: `${txId(1)}#0`, deployment: JURY_SCRIPT_HASH, token: jurorToken(1), lovelace: "250000000" }]);
    expect(result.created.map((c) => c.ref)).toEqual([`${txId(1)}#0`]);
  });

  it("records a spend of a jury output with its redeemer", () => {
    const known = new Map([[`${txId(1)}#0`, { address: JURY_ADDRESS, datumHex: datum }]]);
    const tx: IndexerTx = {
      id: txId(2),
      inputs: [{ transaction: { id: txId(1) }, index: 0 }],
      outputs: [],
      spendRedeemers: { [`${txId(1)}#0`]: jurorAction.exit() },
    };
    const result = processBlock({ slot: 20, id: "c".repeat(64), transactions: [tx] }, known, addresses);
    expect(result.jurySpends).toEqual([{ ref: `${txId(1)}#0`, slot: 20, txHash: txId(2), redeemerHex: jurorAction.exit() }]);
  });
});

// ─── View ─────────────────────────────────────────────────────────────────────

describe("result rule (§8)", () => {
  it.each([
    [[0, 0, 0], "Inconclusive"],
    [[2, 0, 0], "Inconclusive"],
    [[2, 1, 0], "ClaimerWins"],
    [[1, 2, 0], "AuditorWins"],
    [[2, 0, 1], "ClaimerWins"],
    [[1, 1, 1], "Inconclusive"],
    [[3, 2, 0], "Inconclusive"],
    [[4, 1, 1], "ClaimerWins"],
    [[1, 4, 1], "AuditorWins"],
  ] as const)("tally %j gives %s", ([claimer, auditor, inconclusive], expected) => {
    expect(juryOutcome({ claimer, auditor, inconclusive }, JURY_PARAMS)).toBe(expected);
  });
});

describe("jury view — cases, ballots, jurors, canonical case", () => {
  const DEPLOYMENTS = [
    { label: "jury-1", address: JURY_ADDRESS, scriptHash: JURY_SCRIPT_HASH, params: JURY_PARAMS, casesFrom: 0, casesUntil: null },
    { label: "jury-2", address: "", scriptHash: OTHER_JURY_SCRIPT_HASH, params: JURY_PARAMS, casesFrom: 0, casesUntil: null },
  ];

  function row(o: Partial<JuryOutputRow> & Pick<JuryOutputRow, "ref" | "token" | "datum_hex" | "created_slot">): JuryOutputRow {
    return {
      deployment: JURY_SCRIPT_HASH,
      lovelace: "10000000",
      created_height: o.created_slot / 10,
      created_tx: o.ref.split("#")[0]!,
      spent_slot: null,
      spent_height: null,
      spent_tx: null,
      redeemer_hex: null,
      ...o,
    };
  }

  /** A Module-1 challenge output as the follower stores it (genuine 1 or 0, §11.1). */
  const challengeRow = (ref: string, token: string, genuine = 1, challengedAt = t(50)): UtxoRow => ({
    ref, address: M1_CHALLENGE_ADDRESS, created_slot: 50, created_tx: ref.split("#")[0]!, spent_slot: null, spent_tx: null,
    agent_id: null, token, genuine,
    datum_hex: challengeDatumHex({
      claimRef: `${"c1".repeat(32)}#0`, auditor: AUDITOR, evidenceHash: "a2".repeat(32), evidenceUri: "https://example.org/e.json",
      challengedAt, resolutionDeadline: 2_592_000_000, claimToken: CLAIM_TOKEN,
    }),
  });

  const view = (rows: JuryOutputRow[], nowSlot: number, extra: { outputs?: UtxoRow[]; tipHeight?: number; deployments?: typeof DEPLOYMENTS } = {}) =>
    buildJuryView({
      rows,
      deployments: extra.deployments ?? DEPLOYMENTS,
      documents: () => new Map(),
      records: () => new Map(),
      outputs: () => new Map((extra.outputs ?? []).map((u) => [u.ref, u])),
      tipHeight: extra.tipHeight ?? 1_000_000,
      networkId: 0,
      chainTimeMs: t(nowSlot),
    });

  const openCase = (slot: number, token: string, claim = CLAIM_TOKEN, deployment = JURY_SCRIPT_HASH) =>
    row({
      ref: `${txId(slot)}#0`,
      token,
      deployment,
      created_slot: slot,
      datum_hex: caseDatumHex({
        challenge: CHALLENGE_TOKEN, claim, challengeOut: `${"c9".repeat(32)}#${slot}`, claimer: CLAIMER, auditor: AUDITOR,
        deadline: t(900_000), openedAt: t(slot),
      }),
    });

  it("§11.2: per claim token, the first genuine opening of the current deployment, 10 blocks deep", () => {
    const later = openCase(500, caseToken(1));
    const earlier = openCase(400, caseToken(9), CLAIM_TOKEN, OTHER_JURY_SCRIPT_HASH);
    const otherClaim = `636c6d5f${"dd".repeat(28)}`;
    const sameBlockHigh = openCase(600, caseToken(5), otherClaim);
    const sameBlockLow = row({ ...openCase(600, caseToken(3), otherClaim), ref: `${txId(601)}#0`, created_tx: txId(601) });
    const rows = [later, earlier, sameBlockHigh, sameBlockLow];
    const genuine = [400, 500, 600].map((slot) => challengeRow(`${"c9".repeat(32)}#${slot}`, CHALLENGE_TOKEN));
    const canonical = (v: ReturnType<typeof view>) => Object.fromEntries(v.cases.map((c) => [c.case, c.canonical]));

    const v = view(rows, 700, { outputs: genuine });
    expect(canonical(v)).toEqual({ [caseToken(1)]: false, [caseToken(9)]: true, [caseToken(5)]: false, [caseToken(3)]: true });
    expect(v.cases.find((c) => c.case === caseToken(9))).toMatchObject({ deployment: "jury-2", genuine_challenge: true, depth: 1_000_000 - 40 });
    // Not genuine: the case does not count.
    const fake = [challengeRow(`${"c9".repeat(32)}#400`, CHALLENGE_TOKEN, 0), ...genuine.slice(1)];
    expect(canonical(view(rows, 700, { outputs: fake }))[caseToken(1)]).toBe(true);
    // Fewer than 10 blocks on the opening block (height 60): no canonical case yet for the 600 cases.
    expect(canonical(view(rows, 700, { outputs: genuine, tipHeight: 69 }))).toMatchObject({ [caseToken(9)]: true, [caseToken(3)]: false });
    // jury-2 is not current at challenged_at: its case does not count.
    const windows = [DEPLOYMENTS[0]!, { ...DEPLOYMENTS[1]!, casesFrom: t(60), casesUntil: null }];
    expect(canonical(view(rows, 700, { outputs: genuine, deployments: windows }))).toMatchObject({ [caseToken(9)]: false, [caseToken(1)]: true });
    // jury-2 without cases_from (SPEC §12.1) is current for no challenge.
    const notYet = [DEPLOYMENTS[0]!, { ...DEPLOYMENTS[1]!, casesFrom: null, casesUntil: null }];
    expect(canonical(view(rows, 700, { outputs: genuine, deployments: notYet }))).toMatchObject({ [caseToken(9)]: false, [caseToken(1)]: true });
  });
  it("windows, ballot statuses and the result follow the chain time", () => {
    const opened = 1_000;
    const juror = jurorToken(1);
    const base = { challenge: CHALLENGE_TOKEN, claim: CLAIM_TOKEN, claimer: CLAIMER, auditor: AUDITOR, deadline: t(900_000), openedAt: t(opened) };
    const ballots = [
      { agent: AGENT.C, juror: jurorToken(3), status: { revealed: "AuditorWins" as const } },
      { agent: AGENT.B, juror: jurorToken(2), status: { revealed: "AuditorWins" as const } },
      { agent: AGENT.A, juror },
    ];
    const caseRows = [
      row({ ref: `${txId(1)}#0`, token: caseToken(1), created_slot: opened, datum_hex: caseDatumHex(base),
        spent_slot: 1_100, spent_height: 110, spent_tx: txId(2), redeemer_hex: caseAction.commit(juror, "cc".repeat(32)) }),
      row({ ref: `${txId(2)}#1`, token: caseToken(1), created_slot: 1_100, datum_hex: caseDatumHex({ ...base, ballots, tally: [0, 2, 0] }) }),
    ];
    const jurorRows = [
      row({ ref: `${txId(5)}#0`, token: juror, created_slot: 10, lovelace: "250000000",
        datum_hex: jurorDatumHex({ agent: AGENT.A, registeredAt: t(10) }),
        spent_slot: 1_100, spent_height: 110, spent_tx: txId(2), redeemer_hex: jurorAction.commit(caseToken(1)) }),
      row({ ref: `${txId(2)}#0`, token: juror, created_slot: 1_100, lovelace: "250000000",
        datum_hex: jurorDatumHex({ agent: AGENT.A, registeredAt: t(10), open: [{ case: caseToken(1), revealEnd: t(opened + 14_400) }] }) }),
    ];

    const commit = view([...caseRows, ...jurorRows], opened + 100).cases[0]!;
    expect(commit).toMatchObject({ window: "commit", state: "open", result: null, revealed: 2, ref: `${txId(2)}#1` });
    expect(commit.ballots.map((b) => [b.agent_id, b.status, b.vote])).toEqual([
      [AGENT.A, "committed", null],
      [AGENT.B, "revealed", "AuditorWins"],
      [AGENT.C, "revealed", "AuditorWins"],
    ]);
    expect(commit.ballots[0]!.committed).toMatchObject({ tx: txId(2), slot: 1_100, height: 110 });
    expect(view([...caseRows, ...jurorRows], opened + 7_300).cases[0]!.window).toBe("reveal");

    const ended = view([...caseRows, ...jurorRows], opened + 14_400);
    expect(ended.cases[0]).toMatchObject({ window: "ended", result: "Inconclusive" });
    expect(ended.cases[0]!.ballots[0]!.status).toBe("unrevealed");
    expect(ended.jurors[0]!.open).toEqual([{ case: caseToken(1), reveal_end: new Date(t(opened + 14_400)).toISOString(), overdue: true }]);

    // A slash of the juror for this case.
    const slashed = [
      jurorRows[0]!,
      { ...jurorRows[1]!, spent_slot: 16_000, spent_height: 1_600, spent_tx: txId(9), redeemer_hex: jurorAction.slash(caseToken(1)) },
      row({ ref: `${txId(9)}#0`, token: juror, created_slot: 16_000, lovelace: "225000000",
        datum_hex: jurorDatumHex({ agent: AGENT.A, registeredAt: t(10) }) }),
    ];
    const after = view([...caseRows, ...slashed], 16_100);
    expect(after.cases[0]!.ballots[0]).toMatchObject({ status: "slashed", slashed: { tx: txId(9), slot: 16_000 } });
    expect(after.jurors[0]).toMatchObject({ bond_lovelace: "225000000", open: [], slashes: [{ case: caseToken(1), tx: txId(9) }] });
  });

  it("a juror can vote after the eligibility delay, with enough bond and without an exit request", () => {
    const registered = 100;
    const juror = (o: { exitAfter?: number; lovelace?: string; open?: number }) => row({
      ref: `${txId(7)}#0`,
      token: jurorToken(7),
      created_slot: registered,
      lovelace: o.lovelace ?? "250000000",
      datum_hex: jurorDatumHex({
        agent: AGENT.D,
        registeredAt: t(registered),
        exitAfter: o.exitAfter,
        open: Array.from({ length: o.open ?? 0 }, (_, i) => ({ case: caseToken(i + 1), revealEnd: t(10_000_000) })),
      }),
    });
    const delay = JURY_PARAMS.eligibility_delay / 1000;
    expect(view([juror({})], registered + delay - 1).jurors[0]).toMatchObject({ status: "registered", eligible: false });
    expect(view([juror({})], registered + delay).jurors[0]).toMatchObject({
      status: "registered",
      eligible: true,
      eligible_from: new Date(t(registered + delay)).toISOString(),
    });
    expect(view([juror({ exitAfter: t(registered + 2 * delay) })], registered + delay).jurors[0])
      .toMatchObject({ status: "exit_requested", eligible: false });
    // Below bond_min: no vote. Open votes do not limit the commits any more.
    expect(view([juror({ open: 9 })], registered + delay).jurors[0]!.eligible).toBe(true);
    expect(view([juror({ lovelace: "249999999" })], registered + delay).jurors[0]!.eligible).toBe(false);
  });
});

// ─── One chain through the worker and the routes ──────────────────────────────

describe("from the claim to the OracleResolve — worker, /jury and /disputes", () => {
  const CLAIM_DOC = '{"statement":"The agent passed the audit.","summary":"Audit report 7."}';
  const EVIDENCE_DOC = '{"statement":"The audit report is forged.","summary":"Two signatures do not verify."}';
  const prompt = (who: string) => `{"type":"vector-jury-prompt/1","juror":"did:vector:${who}"}`;
  const record = (who: string, vote: string) =>
    JSON.stringify({ type: "vector-jury-record/1", juror: `did:vector:${who}`, vote, reason: `${vote} because of the evidence.` });

  const S = { claim: 1_000, challenge: 2_000, register: 3_000 } as const;
  const OPEN = S.register + 259_200 + 100;
  const SLOTS = {
    open: OPEN,
    open2: OPEN + 50,
    commit1: OPEN + 1_000,
    commit2: OPEN + 2_000,
    reveal1: OPEN + 7_300,
    reveal2: OPEN + 7_400,
    end: OPEN + 14_500,
    resolve: OPEN + 14_600,
  };
  const TX = {
    docClaim: txId(0xd1), claim: txId(0xc1), docEvidence: txId(0xd2), challenge: txId(0xc2),
    regA: txId(0x1a), regB: txId(0x1b), regC: txId(0x1c), regD: txId(0x1d),
    open: txId(0x0e), open2: txId(0x0f),
    commitA: txId(0x2a), commitB: txId(0x2b), commitC: txId(0x2c), commitD: txId(0x2d),
    revealA: txId(0x3a), revealC: txId(0x3c), revealD: txId(0x3d),
    slashB: txId(0x4b), finalize: txId(0x50), resolve: txId(0x60), recordC: txId(0x3e),
  };
  const J = { A: jurorToken(1), B: jurorToken(2), C: jurorToken(3), D: jurorToken(4) };
  const CAS1 = caseToken(1);
  const CAS2 = caseToken(2);
  const BOND = 250_000_000;
  const revealEnd = t(OPEN + 14_400);
  const resolution = JSON.stringify({
    type: "vector-jury-resolution/1",
    challenge: CHALLENGE_TOKEN,
    claim: CLAIM_TOKEN,
    verdict: "AuditorWins",
    basis: "jury",
    jury: { deployment: JURY_SCRIPT_HASH, case: CAS1, opened_in: TX.open, finalized_in: TX.finalize, tally: { ClaimerWins: 1, AuditorWins: 2, Inconclusive: 0 }, reveals: [] },
  });

  const caseBase: CaseDatumOpts = {
    challenge: CHALLENGE_TOKEN,
    claim: CLAIM_TOKEN,
    claimer: CLAIMER,
    auditor: AUDITOR,
    claimHash: textHash(CLAIM_DOC),
    claimOut: `${TX.challenge}#1`,
    evidenceHash: textHash(EVIDENCE_DOC),
    challengeOut: `${TX.challenge}#0`,
    deadline: t(S.challenge) + 2_592_000_000,
    openedAt: t(OPEN),
  };
  const jurorDatum = (who: keyof typeof AGENT, open: boolean) => jurorDatumHex({
    agent: AGENT[who],
    promptHash: textHash(prompt(AGENT[who])),
    registeredAt: t(S.register),
    open: open ? [{ case: CAS1, revealEnd }] : [],
  });
  const ballot = (who: keyof typeof AGENT, status?: BallotStatusOpts): BallotOpts =>
    ({ agent: AGENT[who], juror: J[who], commit: "cc".repeat(32), status });
  const input = (ref: string) => {
    const [id, index] = ref.split("#");
    return { transaction: { id: id! }, index: Number(index) };
  };
  const tx = (id: string, o: Partial<IndexerTx> = {}): IndexerTx => ({ id, inputs: [], outputs: [], ...o });
  const doc = (type: string, body: string) => ({ "22084": documentMetadatum(type, body) });
  const blockAt = (slot: number, height: number, transactions: IndexerTx[]): IndexerBlock =>
    ({ slot, id: slot.toString(16).padStart(64, "0"), height: height * 10, transactions });
  const withChallengeToken = (o: TxOutput): TxOutput => ({ ...o, value: { ...o.value, [M1_CHALLENGE_HASH]: { [CHALLENGE_TOKEN]: 1 } } });
  const withoutRecord = (t: IndexerTx): IndexerTx => ({ ...t, metadata: undefined });

  const commitTx = (id: string, who: keyof typeof AGENT, jurorIn: string, caseIn: string, ballots: BallotOpts[]) => tx(id, {
    inputs: [input(jurorIn), input(caseIn)],
    spendRedeemers: { [jurorIn]: jurorAction.commit(CAS1), [caseIn]: caseAction.commit(J[who], "cc".repeat(32)) },
    outputs: [juryOutput(J[who], jurorDatum(who, true), BOND), juryOutput(CAS1, caseDatumHex({ ...caseBase, ballots }), 10_000_000)],
  });
  const revealTx = (
    id: string, who: keyof typeof AGENT, vote: "ClaimerWins" | "AuditorWins", jurorIn: string, caseIn: string,
    ballots: BallotOpts[], tally: [number, number, number], recordHash = textHash(record(AGENT[who], vote)),
  ) => tx(id, {
    inputs: [input(jurorIn), input(caseIn)],
    spendRedeemers: { [jurorIn]: jurorAction.reveal(CAS1), [caseIn]: caseAction.reveal(J[who], vote, "5a".repeat(32), recordHash) },
    outputs: [juryOutput(J[who], jurorDatum(who, false), BOND), juryOutput(CAS1, caseDatumHex({ ...caseBase, ballots, tally }), 10_000_000)],
    metadata: doc("juror-record", record(AGENT[who], vote)),
  });

  const blocks: IndexerBlock[] = [
    blockAt(S.claim, 1, [
      tx(TX.docClaim, { metadata: doc("claim", CLAIM_DOC) }),
      tx(TX.claim, { outputs: [plainOutput(M1_CLAIM_ADDRESS, 50_000_000, claimDatumHex({
        claimer: CLAIMER, claimHash: textHash(CLAIM_DOC), storageUri: vectorTxUri(TX.docClaim),
      }))] }),
    ]),
    blockAt(S.challenge, 2, [
      tx(TX.docEvidence, { metadata: doc("evidence", EVIDENCE_DOC) }),
      tx(TX.challenge, {
        inputs: [input(`${TX.claim}#0`)],
        spendRedeemers: { [`${TX.claim}#0`]: encodePlutusDataHex(pd.constr(2)) },
        mint: { [M1_CHALLENGE_HASH]: { [CHALLENGE_TOKEN]: 1 } },
        outputs: [
          withChallengeToken(plainOutput(M1_CHALLENGE_ADDRESS, 50_000_000, challengeDatumHex({
            claimRef: `${TX.claim}#0`, auditor: AUDITOR, evidenceHash: textHash(EVIDENCE_DOC), evidenceUri: vectorTxUri(TX.docEvidence),
            challengedAt: t(S.challenge), resolutionDeadline: 2_592_000_000, claimToken: CLAIM_TOKEN,
          }))),
          plainOutput(M1_CLAIM_ADDRESS, 50_000_000, claimDatumHex({
            claimer: CLAIMER, claimHash: textHash(CLAIM_DOC), storageUri: vectorTxUri(TX.docClaim), state: 1,
          })),
        ],
      }),
    ]),
    blockAt(S.register, 3, (["A", "B", "C", "D"] as const).map((who) => tx(TX[`reg${who}`], {
      outputs: [juryOutput(J[who], jurorDatum(who, false), BOND)],
      metadata: doc("juror-prompt", prompt(AGENT[who])),
    }))),
    blockAt(SLOTS.open, 4, [tx(TX.open, { outputs: [juryOutput(CAS1, caseDatumHex(caseBase), 10_000_000)] })]),
    blockAt(SLOTS.open2, 5, [tx(TX.open2, {
      outputs: [juryOutput(CAS2, caseDatumHex({ ...caseBase, openedAt: t(SLOTS.open2) }), 10_000_000, OTHER_JURY_SCRIPT_HASH)],
    })]),
    blockAt(SLOTS.commit1, 6, [
      commitTx(TX.commitA, "A", `${TX.regA}#0`, `${TX.open}#0`, [ballot("A")]),
      commitTx(TX.commitB, "B", `${TX.regB}#0`, `${TX.commitA}#1`, [ballot("B"), ballot("A")]),
    ]),
    blockAt(SLOTS.commit2, 7, [
      commitTx(TX.commitC, "C", `${TX.regC}#0`, `${TX.commitB}#1`, [ballot("C"), ballot("B"), ballot("A")]),
      commitTx(TX.commitD, "D", `${TX.regD}#0`, `${TX.commitC}#1`, [ballot("D"), ballot("C"), ballot("B"), ballot("A")]),
    ]),
    blockAt(SLOTS.reveal1, 8, [
      revealTx(TX.revealA, "A", "AuditorWins", `${TX.commitA}#0`, `${TX.commitD}#1`,
        [ballot("D"), ballot("C"), ballot("B"), ballot("A", { revealed: "AuditorWins" })], [0, 1, 0]),
      withoutRecord(revealTx(TX.revealC, "C", "AuditorWins", `${TX.commitC}#0`, `${TX.revealA}#1`,
        [ballot("D"), ballot("C", { revealed: "AuditorWins" }), ballot("B"), ballot("A", { revealed: "AuditorWins" })], [0, 2, 0])),
      // Overflow (SPEC §10.4): C's record is in a separate transaction of the reveal window.
      tx(TX.recordC, { metadata: doc("juror-record", record(AGENT.C, "AuditorWins")) }),
    ]),
    blockAt(SLOTS.reveal2, 9, [
      // D's redeemer names another record hash than the hash of its record document.
      revealTx(TX.revealD, "D", "ClaimerWins", `${TX.commitD}#0`, `${TX.revealC}#1`,
        [ballot("D", { revealed: "ClaimerWins" }), ballot("C", { revealed: "AuditorWins" }), ballot("B"), ballot("A", { revealed: "AuditorWins" })],
        [1, 2, 0], "ee".repeat(32)),
    ]),
    blockAt(SLOTS.end, 10, [
      tx(TX.slashB, {
        inputs: [input(`${TX.commitB}#0`)],
        spendRedeemers: { [`${TX.commitB}#0`]: jurorAction.slash(CAS1) },
        outputs: [juryOutput(J.B, jurorDatum("B", false), BOND - 25_000_000), plainOutput(TREASURY_ADDRESS, 25_000_000)],
      }),
      tx(TX.finalize, {
        inputs: [input(`${TX.revealD}#1`)],
        spendRedeemers: { [`${TX.revealD}#1`]: caseAction.finalize("AuditorWins") },
        outputs: [plainOutput(REFUND_ADDRESS_BECH32, 10_000_000, encodePlutusDataHex(pd.bytes(CAS1)))],
      }),
    ]),
    blockAt(SLOTS.resolve, 11, [
      tx(TX.resolve, {
        inputs: [input(`${TX.challenge}#0`), input(`${TX.challenge}#1`)],
        spendRedeemers: { [`${TX.challenge}#0`]: oracleResolveHex("AuditorWins", textHash(resolution)) },
        outputs: [plainOutput(TREASURY_ADDRESS, 100_000_000)],
        metadata: doc("resolution", resolution),
      }),
    ]),
  ];

  async function indexed(until = blocks.length) {
    const cache = new SqliteCache(":memory:");
    const source = new MockChainSyncSource([]);
    const deployments = [
      { label: "jury-1", address: JURY_ADDRESS, scriptHash: JURY_SCRIPT_HASH, params: JURY_PARAMS, casesFrom: 0, casesUntil: null },
      {
        label: "jury-2", address: juryDeploymentJson("jury-2", OTHER_JURY_SCRIPT_HASH).address, scriptHash: OTHER_JURY_SCRIPT_HASH,
        params: JURY_PARAMS, casesFrom: 0, casesUntil: null,
      },
    ];
    const module1 = { claimAddress: M1_CLAIM_ADDRESS, challengeAddress: M1_CHALLENGE_ADDRESS, partyAddress: M1_PARTY_ADDRESS };
    const worker = new ChainSyncWorker({
      source,
      cache,
      networkId: 0,
      addresses: {
        advertAddress: "",
        escrowAddress: "",
        module1Addresses: [M1_CLAIM_ADDRESS, M1_CHALLENGE_ADDRESS, M1_PARTY_ADDRESS],
        module1Challenge: { address: M1_CHALLENGE_ADDRESS, policyId: M1_CHALLENGE_HASH },
        jury: deployments.map((d) => ({ address: d.address, scriptHash: d.scriptHash })),
      },
    });
    await worker.start();
    for (const b of blocks.slice(0, until)) source.pushEvent({ kind: "block", block: b });
    const app = createApp({ cache, worker }, { networkId: 0, module1, jury: deployments });
    return { cache, source, app };
  }

  it("GET /jury/cases: the canonical case with its ballots, records, tally, result and transactions", async () => {
    const { app } = await indexed();
    const res = await request(app).get("/jury/cases");
    expect(res.status).toBe(200);
    expect(res.body.cases.map((c: { case: string; canonical: boolean; deployment: string }) => [c.case, c.canonical, c.deployment]))
      .toEqual([[CAS2, false, "jury-2"], [CAS1, true, "jury-1"]]);
    const c = res.body.cases[1];
    expect(c).toMatchObject({
      challenge: CHALLENGE_TOKEN,
      claim: CLAIM_TOKEN,
      claimer_agent_id: CLAIMER,
      auditor_agent_id: AUDITOR,
      claim_uri: vectorTxUri(TX.docClaim),
      evidence_uri: vectorTxUri(TX.docEvidence),
      challenge_out: `${TX.challenge}#0`,
      claim_out: `${TX.challenge}#1`,
      genuine_challenge: true,
      depth: 70,
      window: "ended",
      state: "closed",
      tally: { ClaimerWins: 1, AuditorWins: 2, Inconclusive: 0 },
      revealed: 3,
      result: "AuditorWins",
      rule: { quorum: 3, majority_num: 2, majority_den: 3 },
      refund_to: REFUND_ADDRESS_BECH32,
      opened: { tx: TX.open, slot: SLOTS.open, height: 40 },
      finalized: { tx: TX.finalize, slot: SLOTS.end, height: 100, result: "AuditorWins" },
      closed: { tx: TX.finalize },
      ref: null,
      reveal_end: new Date(revealEnd).toISOString(),
    });
    expect(c.ballots.map((b: { agent_id: string; status: string; vote: string | null }) => [b.agent_id, b.status, b.vote])).toEqual([
      [AGENT.A, "revealed", "AuditorWins"],
      [AGENT.B, "slashed", null],
      [AGENT.C, "revealed", "AuditorWins"],
      [AGENT.D, "revealed", "ClaimerWins"],
    ]);
    expect(c.ballots.map((b: { committed: { tx: string } }) => b.committed.tx)).toEqual([TX.commitA, TX.commitB, TX.commitC, TX.commitD]);
    expect(c.ballots.map((b: { revealed: { tx: string } | null }) => b.revealed?.tx ?? null)).toEqual([TX.revealA, null, TX.revealC, TX.revealD]);
    expect(c.ballots[0]).toMatchObject({
      record_status: "reveal",
      record: { tx: TX.revealA, type: "juror-record", hash: textHash(record(AGENT.A, "AuditorWins")), matches: true },
    });
    expect(c.ballots[2]).toMatchObject({ record_status: "separate", record: { tx: TX.recordC, matches: true } });
    expect(c.ballots[3]).toMatchObject({ record_status: "missing", record: null });
    expect(c.ballots[1].slashed).toMatchObject({ tx: TX.slashB, slot: SLOTS.end });

    const filtered = await request(app).get(`/jury/cases?challenge=${CHALLENGE_TOKEN.toUpperCase()}`);
    expect(filtered.body.cases).toHaveLength(2);
    expect((await request(app).get(`/jury/cases?challenge=${"0".repeat(64)}`)).body.cases).toEqual([]);
    expect((await request(app).get("/jury/cases?challenge=xyz")).status).toBe(400);
  });

  it("GET /jury/jurors: registration, bond, open votes, slashes and the prompt document", async () => {
    const { app } = await indexed();
    const res = await request(app).get("/jury/jurors");
    expect(res.status).toBe(200);
    expect(res.body.jurors).toHaveLength(4);
    const byAgent = Object.fromEntries(res.body.jurors.map((j: { agent_id: string }) => [j.agent_id, j]));
    expect(byAgent[AGENT.B]).toMatchObject({
      juror: J.B,
      status: "registered",
      bond_lovelace: String(BOND - 25_000_000),
      open: [],
      slashes: [{ case: CAS1, tx: TX.slashB }],
      registered: { tx: TX.regB, slot: S.register, height: 30 },
      eligible_from: new Date(t(S.register) + JURY_PARAMS.eligibility_delay).toISOString(),
      prompt: { tx: TX.regB, type: "juror-prompt", matches: true },
    });
    expect(byAgent[AGENT.A]).toMatchObject({ bond_lovelace: String(BOND), open: [], eligible: true, ref: `${TX.revealA}#0` });

    const one = await request(app).get(`/jury/jurors?agent_id=${AGENT.C}`);
    expect(one.body.jurors.map((j: { juror: string }) => j.juror)).toEqual([J.C]);
    expect((await request(app).get("/jury/jurors?agent_id=nope")).status).toBe(400);
  });

  it("GET /jury: the deployments and their parameters", async () => {
    const { app } = await indexed();
    const res = await request(app).get("/jury");
    expect(res.body.deployments).toEqual([
      { label: "jury-1", script_hash: JURY_SCRIPT_HASH, address: JURY_ADDRESS, params: JURY_PARAMS },
      expect.objectContaining({ label: "jury-2", script_hash: OTHER_JURY_SCRIPT_HASH }),
    ]);
    expect(res.body.chain_time).toBe(new Date(t(SLOTS.resolve)).toISOString());
  });

  it("GET /disputes: the jury case, the resolution document and the vector-tx documents of the case", async () => {
    const { app } = await indexed();
    const res = await request(app).get("/disputes");
    expect(res.body.cases).toHaveLength(1);
    const c = res.body.cases[0];
    expect(c).toMatchObject({
      status: "resolved",
      resolution: { tx: TX.resolve, outcome: "AuditorWins", reasoning_hash: textHash(resolution) },
      resolution_document: { tx: TX.resolve, type: "resolution", hash: textHash(resolution), matches: true, json: { basis: "jury", verdict: "AuditorWins" } },
      claim: { document: { uri: vectorTxUri(TX.docClaim), tx: TX.docClaim, captured: { type: "claim", matches: true } } },
      challenge: { genuine: true, document: { uri: vectorTxUri(TX.docEvidence), tx: TX.docEvidence, captured: { type: "evidence", matches: true } } },
      jury: { case: CAS1, canonical: true, result: "AuditorWins" },
    });
    expect(c.jury.ballots).toHaveLength(4);
  });

  it("a rollback takes back the slash, the finalize and the resolution", async () => {
    const { app, source } = await indexed();
    source.pushEvent({ kind: "rollback", point: { slot: SLOTS.reveal2, id: SLOTS.reveal2.toString(16).padStart(64, "0") } });
    const cases = (await request(app).get(`/jury/cases?challenge=${CHALLENGE_TOKEN}`)).body.cases;
    const c = cases.find((x: { case: string }) => x.case === CAS1);
    expect(c).toMatchObject({ window: "reveal", state: "open", result: null, finalized: null, closed: null, ref: `${TX.revealD}#1` });
    expect(c.ballots[1]).toMatchObject({ agent_id: AGENT.B, status: "committed", slashed: null });
    const disputes = (await request(app).get("/disputes")).body.cases;
    expect(disputes[0]).toMatchObject({ status: "challenged", resolution: null, resolution_document: null, jury: { case: CAS1, result: null } });
    expect((await request(app).get(`/documents/${TX.resolve}`)).status).toBe(404);
  });

  it("without jury deployments the lists are empty and a dispute has no jury case", async () => {
    const cache = new SqliteCache(":memory:");
    const source = new MockChainSyncSource([]);
    const worker = new ChainSyncWorker({ source, cache, networkId: 0, addresses: { advertAddress: "", escrowAddress: "" } });
    await worker.start();
    const app = createApp({ cache, worker }, { networkId: 0 });
    expect((await request(app).get("/jury")).body.deployments).toEqual([]);
    expect((await request(app).get("/jury/cases")).body.cases).toEqual([]);
    expect((await request(app).get("/jury/jurors")).body.jurors).toEqual([]);
  });
});
