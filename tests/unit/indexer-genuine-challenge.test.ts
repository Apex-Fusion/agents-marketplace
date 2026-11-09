/**
 * tests/unit/indexer-genuine-challenge.test.ts — genuine Module-1 challenge outputs
 * (Module-1/jury/SPEC.md §11.1 and §11.2, with Amendments 5, 6 and 8).
 *
 * Rule 1: the transaction minted exactly one challenge token and the output holds it.
 * Rule 2: a SubmitEvidence continuation of a genuine output is genuine only when
 *   - it is the FIRST output of its transaction at the challenge script (SPEC §11.1 rule 2),
 *   - it holds the same token, and the transaction mints and burns nothing under the challenge policy,
 *   - it keeps every datum field of the spent output except evidence_hash and evidence_uri, and
 *   - it holds exactly its stake_amount lovelace.
 * The flag is kept for each output, so a chain of any number of steps is checked step by step.
 * Module-1 checks only the payment credential of an output, so the claim, challenge and verdict
 * outputs are found by their payment credential, with any stake credential (Amendment 8).
 */

import { describe, it, expect } from "vitest";

import { SqliteCache, type JuryOutputRow, type UtxoRow } from "../../indexer/src/db/cache.js";
import { processBlock, type KnownUtxoInfo, type ScriptAddresses } from "../../indexer/src/follower/blockProcessor.js";
import type { IndexerBlock, IndexerTx, TxOutput } from "../../indexer/src/follower/types.js";
import { buildDisputeCases } from "../../indexer/src/disputes/module1.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import { buildJuryView } from "../../indexer/src/jury/view.js";
import { plutusAddressToBech32 } from "../../packages/shared/src/cbor/address.js";
import { decodePlutusDataHex, encodePlutusDataHex, type PlutusData } from "../../packages/shared/src/cbor/plutus-data.js";
import { MockChainSyncSource } from "./__helpers__/MockChainSyncSource.js";
import {
  JURY_ADDRESS,
  JURY_PARAMS,
  JURY_SCRIPT_HASH,
  M1_CHALLENGE_ADDRESS,
  M1_CHALLENGE_HASH,
  M1_CLAIM_ADDRESS,
  M1_CLAIM_HASH,
  M1_PARTY_ADDRESS,
  REFUND_ADDRESS_BECH32,
  caseDatumHex,
  caseToken,
  challengeDatumHex,
  claimDatumHex,
  pd,
  plainOutput,
} from "../fixtures/indexer-side/jury-blocks.js";

const ADDRESSES: ScriptAddresses = {
  advertAddress: "",
  escrowAddress: "",
  module1Addresses: [M1_CLAIM_ADDRESS, M1_CHALLENGE_ADDRESS, M1_PARTY_ADDRESS],
  module1Challenge: { address: M1_CHALLENGE_ADDRESS, policyId: M1_CHALLENGE_HASH },
};

const TOKEN = `63686c5f${"ce".repeat(28)}`;
const OTHER_TOKEN = `63686c5f${"cf".repeat(28)}`;
const CLAIM_TOKEN = `636c6d5f${"75".repeat(28)}`;
const PARTY_HASH = "c3".repeat(28);
const txId = (n: number): string => n.toString(16).padStart(64, "0");

/** An address with the payment credential Script(`hash`) and a stake key: another address, the same script. */
const withStakeKey = (hash: string): string =>
  plutusAddressToBech32(
    {
      paymentCredential: { type: "Script", hash },
      stakeCredential: { type: "Inline", credential: { type: "VerificationKey", hash: "5f".repeat(28) } },
    },
    0,
  );
const SAME_SCRIPT_ADDRESS = withStakeKey(M1_CHALLENGE_HASH);

/** A challenge datum (11 fields); stake_amount is 50 AP3X. */
const datum = (evidenceUri: string): string =>
  challengeDatumHex({
    claimRef: `${txId(1)}#0`,
    auditor: "a2".repeat(32),
    evidenceHash: "e1".repeat(32),
    evidenceUri,
    challengedAt: 1_793_577_600_000,
    resolutionDeadline: 2_592_000_000,
    claimToken: CLAIM_TOKEN,
  });

/** An output at the challenge address with an inline datum; `token` puts one challenge token in it. */
function challengeOutput(token?: string, extra: Partial<TxOutput> = {}): TxOutput {
  return {
    address: M1_CHALLENGE_ADDRESS,
    value: { ada: { lovelace: 50_000_000 }, ...(token ? { [M1_CHALLENGE_HASH]: { [token]: 1 } } : {}) },
    datum: datum("vector-tx:new"),
    ...extra,
  };
}

const SUBMIT_EVIDENCE = encodePlutusDataHex(pd.constr(1, [pd.bytes("e2".repeat(32)), pd.bytes("00")]));
const ORACLE_RESOLVE = encodePlutusDataHex(pd.constr(2, [pd.constr(0), pd.bytes("e3".repeat(32))]));

function spendOf(ref: string, redeemer: string): Pick<IndexerTx, "inputs" | "spendRedeemers"> {
  const [id, index] = ref.split("#");
  return { inputs: [{ transaction: { id: id! }, index: Number(index) }], spendRedeemers: { [ref]: redeemer } };
}

/** The indexer's state of one challenge output that a transaction spends. */
function known(ref: string, token: string, genuine: boolean): Map<string, KnownUtxoInfo> {
  return new Map([[ref, { address: M1_CHALLENGE_ADDRESS, datumHex: datum("vector-tx:old"), token, genuine }]]);
}

const blockOf = (transactions: IndexerTx[]): IndexerBlock => ({ slot: 100, id: "b".repeat(64), height: 10, transactions });

/** [ref, token, genuine] of each Module-1 output that the transactions create, in block order. */
function marks(transactions: IndexerTx[], knownUtxos: Map<string, KnownUtxoInfo> = new Map()) {
  return processBlock(blockOf(transactions), knownUtxos, ADDRESSES).created.map((c) => [c.ref, c.token ?? null, c.genuine ?? null]);
}

describe("rule 1 — the transaction minted exactly one challenge token", () => {
  const T = txId(0x10);
  const open = (mint: Record<string, number>): IndexerTx => ({
    id: T,
    inputs: [],
    outputs: [challengeOutput(TOKEN)],
    mint: { [M1_CHALLENGE_HASH]: mint },
  });

  it("an output that holds the minted token is genuine", () => {
    expect(marks([open({ [TOKEN]: 1 })])).toEqual([[`${T}#0`, TOKEN, true]]);
  });

  it.each([
    ["two entries of the policy", { [TOKEN]: 1, [OTHER_TOKEN]: 1 }],
    ["a quantity of 2", { [TOKEN]: 2 }],
    ["a burn", { [TOKEN]: -1 }],
    ["another token than the one in the output", { [OTHER_TOKEN]: 1 }],
  ])("is not genuine with %s", (_name, mint) => {
    expect(marks([open(mint)])[0]![2]).toBe(false);
  });

  it("is not genuine when the token is minted under another policy, or when no mint is reported", () => {
    const other: IndexerTx = { ...open({}), mint: { ["ff".repeat(28)]: { [TOKEN]: 1 } } };
    expect(marks([other])[0]![2]).toBe(false);
    expect(marks([{ id: T, inputs: [], outputs: [challengeOutput(TOKEN)] }])[0]![2]).toBe(false);
  });
});

describe("rule 2 — a SubmitEvidence continuation, with the first output at the challenge script (Amendment 5)", () => {
  const SOURCE = `${txId(0x10)}#0`;
  const T = txId(0x20);
  const fromGenuine = known(SOURCE, TOKEN, true);
  const submit = (outputs: TxOutput[], extra: Partial<IndexerTx> = {}): IndexerTx => ({
    id: T,
    outputs,
    ...spendOf(SOURCE, SUBMIT_EVIDENCE),
    ...extra,
  });

  it("the first output at the challenge address that holds the same token is genuine", () => {
    expect(marks([submit([challengeOutput(TOKEN)])], fromGenuine)).toEqual([[`${T}#0`, TOKEN, true]]);
  });

  it("the first output at the challenge address counts, not the first output of the transaction", () => {
    const outputs = [plainOutput(REFUND_ADDRESS_BECH32, 2_000_000), challengeOutput(TOKEN)];
    expect(marks([submit(outputs)], fromGenuine)).toEqual([[`${T}#1`, TOKEN, true]]);
  });

  it("a token in a SECOND output at the challenge address is not genuine, and the first output is not either", () => {
    expect(marks([submit([challengeOutput(), challengeOutput(TOKEN)])], fromGenuine)).toEqual([
      [`${T}#0`, null, false],
      [`${T}#1`, TOKEN, false],
    ]);
  });

  it("an output without an inline datum is still the first output at the challenge address", () => {
    const first = challengeOutput(undefined, { datum: undefined, datumHash: "ab".repeat(32) });
    expect(marks([submit([first, challengeOutput(TOKEN)])], fromGenuine)).toEqual([[`${T}#1`, TOKEN, false]]);
  });

  it("an output with the challenge script and a stake key is at the challenge script as well", () => {
    const sameScript = challengeOutput(undefined, { address: SAME_SCRIPT_ADDRESS });
    // Module-1 checks this first output at the script. The token output after it has an unchecked datum.
    expect(marks([submit([sameScript, challengeOutput(TOKEN)])], fromGenuine)).toEqual([
      [`${T}#0`, null, false],
      [`${T}#1`, TOKEN, false],
    ]);
    // After the token output it does not matter: Module-1 checks the token output.
    expect(marks([submit([challengeOutput(TOKEN), sameScript])], fromGenuine)).toEqual([
      [`${T}#0`, TOKEN, true],
      [`${T}#1`, null, false],
    ]);
  });

  it("a continuation at an address with a stake key is genuine, and the spend of the stored output is seen", () => {
    const tx = submit([challengeOutput(TOKEN, { address: SAME_SCRIPT_ADDRESS })]);
    const result = processBlock(blockOf([tx]), fromGenuine, ADDRESSES);
    expect(result.created.map((c) => [c.ref, c.address, c.token, c.genuine])).toEqual([
      [`${T}#0`, M1_CHALLENGE_ADDRESS, TOKEN, true],
    ]);
    expect(result.module1Spends.map((s) => [s.ref, s.txHash])).toEqual([[SOURCE, T]]);
  });

  it("a mint or burn under the challenge policy ends rule 2; a mint under another policy does not", () => {
    const genuineWith = (mint: Record<string, Record<string, number>>) =>
      marks([submit([challengeOutput(TOKEN)], { mint })], fromGenuine)[0]![2];
    expect(genuineWith({ [M1_CHALLENGE_HASH]: { [OTHER_TOKEN]: 1 } })).toBe(false);
    expect(genuineWith({ [M1_CHALLENGE_HASH]: { [OTHER_TOKEN]: -1 } })).toBe(false);
    expect(genuineWith({ ["ff".repeat(28)]: { "01": 1 } })).toBe(true);
  });

  it("needs the same token, a genuine source and the SubmitEvidence redeemer", () => {
    expect(marks([submit([challengeOutput(OTHER_TOKEN)])], fromGenuine)[0]![2]).toBe(false);
    expect(marks([submit([challengeOutput(TOKEN)])], known(SOURCE, TOKEN, false))[0]![2]).toBe(false);
    expect(marks([{ ...submit([challengeOutput(TOKEN)]), ...spendOf(SOURCE, ORACLE_RESOLVE) }], fromGenuine)[0]![2]).toBe(false);
    expect(marks([{ ...submit([challengeOutput(TOKEN)]), spendRedeemers: {} }], fromGenuine)[0]![2]).toBe(false);
  });

  it("a continuation of a fake output is never genuine, in the same block", () => {
    const mint: IndexerTx = {
      id: txId(0x30),
      inputs: [],
      outputs: [challengeOutput(TOKEN)],
      mint: { [M1_CHALLENGE_HASH]: { [TOKEN]: 1 } },
    };
    const fake: IndexerTx = {
      id: txId(0x31),
      outputs: [challengeOutput(), challengeOutput(TOKEN)],
      ...spendOf(`${mint.id}#0`, SUBMIT_EVIDENCE),
    };
    const later: IndexerTx = { id: txId(0x32), outputs: [challengeOutput(TOKEN)], ...spendOf(`${fake.id}#1`, SUBMIT_EVIDENCE) };
    expect(marks([mint, fake, later])).toEqual([
      [`${mint.id}#0`, TOKEN, true],
      [`${fake.id}#0`, null, false],
      [`${fake.id}#1`, TOKEN, false],
      [`${later.id}#0`, TOKEN, false],
    ]);
  });
});

describe("rule 2 — the continuation keeps the datum and the stake (Amendment 6)", () => {
  const SOURCE = `${txId(0x10)}#0`;
  const fromGenuine = known(SOURCE, TOKEN, true);
  const continues = (output: TxOutput): unknown =>
    marks([{ id: txId(0x20), outputs: [output], ...spendOf(SOURCE, SUBMIT_EVIDENCE) }], fromGenuine)[0]![2];

  /** The fixture datum with the field `index` replaced. */
  const datumWith = (index: number, field: PlutusData): string => {
    const data = decodePlutusDataHex(datum("vector-tx:new"));
    if (data.kind !== "constr") throw new Error("the fixture datum is not a constructor");
    return encodePlutusDataHex({ ...data, fields: data.fields.map((f, i) => (i === index ? field : f)) });
  };
  const withDatum = (datumHex: string, lovelace = 50_000_000): TxOutput =>
    challengeOutput(TOKEN, { datum: datumHex, value: { ada: { lovelace }, [M1_CHALLENGE_HASH]: { [TOKEN]: 1 } } });

  it("evidence_hash and evidence_uri may change", () => {
    expect(continues(withDatum(datumWith(4, pd.bytes("e9".repeat(32)))))).toBe(true);
    expect(continues(withDatum(datumWith(5, pd.bytes(Buffer.from("vector-tx:other").toString("hex")))))).toBe(true);
  });

  it("every other field must stay as it is", () => {
    const changes: Array<[number, string, PlutusData]> = [
      [0, "claim_ref", pd.constr(0, [pd.bytes("99".repeat(32)), pd.int(0)])],
      [1, "auditor_did", pd.bytes("a3".repeat(32))],
      [2, "auditor_credential", pd.constr(0, [pd.bytes("32".repeat(28))])],
      [6, "challenged_at", pd.int(1_793_577_600_001)],
      [7, "resolution_deadline", pd.int(1)],
      [8, "eligible_jurors", pd.list([pd.bytes("aa".repeat(32))])],
      [9, "state", pd.constr(1)],
      [10, "claim_token", pd.bytes(`636c6d5f${"76".repeat(28)}`)],
    ];
    for (const [index, name, field] of changes) {
      expect(continues(withDatum(datumWith(index, field))), `field ${index} (${name})`).toBe(false);
    }
  });

  it("the output holds exactly stake_amount lovelace", () => {
    expect(continues(withDatum(datum("vector-tx:new"), 49_999_999))).toBe(false);
    expect(continues(withDatum(datum("vector-tx:new"), 50_000_001))).toBe(false);
    // The datum changes stake_amount and the lovelace follows it: a datum field changed.
    expect(continues(withDatum(datumWith(3, pd.int(60_000_000)), 60_000_000))).toBe(false);
  });

  it("a datum of another shape is not a continuation", () => {
    const data = decodePlutusDataHex(datum("vector-tx:new"));
    if (data.kind !== "constr") throw new Error("the fixture datum is not a constructor");
    const shapes = [
      encodePlutusDataHex({ ...data, fields: [...data.fields, pd.int(0)] }), // 12 fields
      encodePlutusDataHex({ ...data, fields: data.fields.slice(0, 10) }), // 10 fields
      encodePlutusDataHex({ ...data, index: 1n }), // another constructor
      encodePlutusDataHex(pd.int(5)), // not a constructor
      "ff", // not Plutus Data
    ];
    for (const shape of shapes) expect(continues(withDatum(shape))).toBe(false);
  });

  it("is checked step by step, over any number of continuations", () => {
    const steps: IndexerTx[] = [
      { id: txId(0x50), inputs: [], outputs: [challengeOutput(TOKEN)], mint: { [M1_CHALLENGE_HASH]: { [TOKEN]: 1 } } },
    ];
    for (let i = 1; i <= 12; i++) {
      steps.push({
        id: txId(0x50 + i),
        outputs: [challengeOutput(TOKEN, { datum: datum(`vector-tx:step-${i}`) })],
        ...spendOf(`${steps[i - 1]!.id}#0`, SUBMIT_EVIDENCE),
      });
    }
    expect(marks(steps).map((m) => m[2])).toEqual(Array(13).fill(true));

    // One bad step (the auditor changes) ends the chain for every later step.
    const broken = steps.map((s, i) => (i === 6 ? { ...s, outputs: [withDatum(datumWith(1, pd.bytes("a3".repeat(32))))] } : s));
    expect(marks(broken).map((m) => m[2])).toEqual([...Array(6).fill(true), ...Array(7).fill(false)]);
  });
});

describe("Module-1 outputs are found by payment credential (Amendment 8)", () => {
  const claimDatum = claimDatumHex({ claimer: "a1".repeat(32), claimHash: "a1".repeat(32), storageUri: "vector-tx:x" });
  const created = (outputs: TxOutput[]) =>
    processBlock(blockOf([{ id: txId(0x70), inputs: [], outputs }]), new Map(), ADDRESSES).created;

  it("a claim output and a verdict output with a stake key are stored under the configured addresses", () => {
    const outputs: TxOutput[] = [
      { address: withStakeKey(M1_CLAIM_HASH), value: { ada: { lovelace: 50_000_000 } }, datum: claimDatum },
      { address: withStakeKey(PARTY_HASH), value: { ada: { lovelace: 2_000_000 } }, datum: "d87980" },
    ];
    expect(created(outputs).map((c) => [c.ref, c.address])).toEqual([
      [`${txId(0x70)}#0`, M1_CLAIM_ADDRESS],
      [`${txId(0x70)}#1`, M1_PARTY_ADDRESS],
    ]);
  });

  it("a challenge output with a stake key, made by OpenChallenge, is genuine and stored under the challenge address", () => {
    const tx: IndexerTx = {
      id: txId(0x71),
      inputs: [],
      outputs: [challengeOutput(TOKEN, { address: SAME_SCRIPT_ADDRESS })],
      mint: { [M1_CHALLENGE_HASH]: { [TOKEN]: 1 } },
    };
    expect(processBlock(blockOf([tx]), new Map(), ADDRESSES).created.map((c) => [c.address, c.token, c.genuine])).toEqual([
      [M1_CHALLENGE_ADDRESS, TOKEN, true],
    ]);
  });

  it("an output at another script, at a key address, or at no address is not a Module-1 output", () => {
    const outputs: TxOutput[] = [
      { address: withStakeKey("77".repeat(28)), value: { ada: { lovelace: 1 } }, datum: claimDatum },
      plainOutput(REFUND_ADDRESS_BECH32, 2_000_000, claimDatum),
      { address: "not an address", value: { ada: { lovelace: 1 } }, datum: claimDatum },
    ];
    expect(created(outputs)).toEqual([]);
  });
});

describe("the genuine flag is stored and read back across blocks", () => {
  it("a fake continuation stays fake in the next blocks; the first output with the token stays genuine", async () => {
    const cache = new SqliteCache(":memory:");
    const source = new MockChainSyncSource([]);
    const worker = new ChainSyncWorker({ source, cache, networkId: 0, addresses: ADDRESSES });
    await worker.start();
    const push = (slot: number, transactions: IndexerTx[]) =>
      source.pushEvent({ kind: "block", block: { slot, id: slot.toString(16).padStart(64, "0"), height: slot, transactions } });

    const a: IndexerTx = { id: txId(0x40), inputs: [], outputs: [challengeOutput(TOKEN)], mint: { [M1_CHALLENGE_HASH]: { [TOKEN]: 1 } } };
    const b: IndexerTx = { id: txId(0x41), outputs: [challengeOutput(TOKEN, { address: SAME_SCRIPT_ADDRESS })], ...spendOf(`${a.id}#0`, SUBMIT_EVIDENCE) };
    const c: IndexerTx = { id: txId(0x42), outputs: [challengeOutput(), challengeOutput(TOKEN)], ...spendOf(`${b.id}#0`, SUBMIT_EVIDENCE) };
    const d: IndexerTx = { id: txId(0x43), outputs: [challengeOutput(TOKEN)], ...spendOf(`${c.id}#1`, SUBMIT_EVIDENCE) };
    push(100, [a]);
    push(110, [b]);
    push(120, [c]);
    push(130, [d]);

    // b is at an address with a stake key: it is stored under the challenge address, and c still spends it.
    expect(cache.listModule1Outputs([M1_CHALLENGE_ADDRESS]).map((r) => [r.ref, r.token, r.genuine])).toEqual([
      [`${a.id}#0`, TOKEN, 1],
      [`${b.id}#0`, TOKEN, 1],
      [`${c.id}#0`, null, 0],
      [`${c.id}#1`, TOKEN, 0],
      [`${d.id}#0`, TOKEN, 0],
    ]);
    cache.close();
  });
});

describe("the dispute view follows only the genuine continuation of a challenge (§11.1)", () => {
  it("an output at the challenge address that is not genuine does not change the dispute", async () => {
    const cache = new SqliteCache(":memory:");
    const source = new MockChainSyncSource([]);
    const worker = new ChainSyncWorker({ source, cache, networkId: 0, addresses: ADDRESSES });
    await worker.start();
    const push = (slot: number, transactions: IndexerTx[]) =>
      source.pushEvent({ kind: "block", block: { slot, id: slot.toString(16).padStart(64, "0"), height: slot, transactions } });
    const wallet = (): TxOutput => plainOutput(REFUND_ADDRESS_BECH32, 2_000_000);
    const otherData = decodePlutusDataHex(datum("vector-tx:other"));
    if (otherData.kind !== "constr") throw new Error("the fixture datum is not a constructor");
    // State Resolved{AuditorWins, …} (constructor 3), at output #10: it sorts before #2 as text.
    const resolvedState = pd.constr(3, [pd.constr(1), pd.constr(0, [pd.constr(0, [pd.bytes("aa".repeat(28))]), pd.constr(1)])]);
    const notGenuine: TxOutput = {
      ...challengeOutput(),
      datum: encodePlutusDataHex({ ...otherData, fields: otherData.fields.map((f, i) => (i === 9 ? resolvedState : f)) }),
    };

    const claim: IndexerTx = {
      id: txId(1), inputs: [],
      outputs: [plainOutput(M1_CLAIM_ADDRESS, 50_000_000, claimDatumHex({ claimer: "a1".repeat(32), claimHash: "c1".repeat(32), storageUri: "vector-tx:claim" }))],
    };
    const open: IndexerTx = {
      id: txId(0x50), inputs: [{ transaction: { id: claim.id }, index: 0 }],
      outputs: [{ ...challengeOutput(TOKEN), datum: datum("vector-tx:old") }], mint: { [M1_CHALLENGE_HASH]: { [TOKEN]: 1 } },
    };
    const submit: IndexerTx = {
      id: txId(0x51),
      outputs: [wallet(), wallet(), challengeOutput(TOKEN), ...Array.from({ length: 7 }, wallet), notGenuine],
      ...spendOf(`${open.id}#0`, SUBMIT_EVIDENCE),
    };
    push(100, [claim]);
    push(110, [open]);
    push(120, [submit]);

    const rows = cache.listModule1Outputs([M1_CLAIM_ADDRESS, M1_CHALLENGE_ADDRESS, M1_PARTY_ADDRESS]);
    expect(rows.filter((r) => r.address === M1_CHALLENGE_ADDRESS).map((r) => [r.ref, r.genuine])).toEqual([
      [`${open.id}#0`, 1],
      [`${submit.id}#10`, 0],
      [`${submit.id}#2`, 1],
    ]);
    const cases = buildDisputeCases(rows, { claimAddress: M1_CLAIM_ADDRESS, challengeAddress: M1_CHALLENGE_ADDRESS, partyAddress: M1_PARTY_ADDRESS }, 0);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ status: "challenged", resolution: null });
    expect(cases[0]!.challenge).toMatchObject({ genuine: true, fields: { evidence_uri: "vector-tx:new", state: "PendingOracle" } });
    cache.close();
  });
});

describe("§11.2 rule 2 — the challenge_out of a case is genuine and holds the challenge token of the case", () => {
  const OUT = `${txId(0x61)}#0`;
  const caseRow: JuryOutputRow = {
    ref: `${txId(0x60)}#0`,
    deployment: JURY_SCRIPT_HASH,
    token: caseToken(1),
    lovelace: "10000000",
    datum_hex: caseDatumHex({
      challenge: TOKEN,
      claim: CLAIM_TOKEN,
      challengeOut: OUT,
      claimOut: `${txId(0x61)}#1`,
      claimer: "a1".repeat(32),
      auditor: "a2".repeat(32),
      deadline: 1_800_000_000_000,
      openedAt: 1_793_577_700_000,
    }),
    created_slot: 500,
    created_height: 50,
    created_tx: txId(0x60),
    spent_slot: null,
    spent_height: null,
    spent_tx: null,
    redeemer_hex: null,
  };
  const outputRow = (token: string, genuine: number): UtxoRow => ({
    ref: OUT,
    address: M1_CHALLENGE_ADDRESS,
    datum_hex: datum("vector-tx:x"),
    created_slot: 400,
    created_tx: txId(0x61),
    spent_slot: null,
    spent_tx: null,
    agent_id: null,
    token,
    genuine,
  });
  const caseOf = (row: UtxoRow) =>
    buildJuryView({
      rows: [caseRow],
      deployments: [
        { label: "jury-1", address: JURY_ADDRESS, scriptHash: JURY_SCRIPT_HASH, params: JURY_PARAMS, casesFrom: 0, casesUntil: null },
      ],
      documents: () => new Map(),
      outputs: () => new Map([[row.ref, row]]),
      tipHeight: 1_000,
      networkId: 0,
      chainTimeMs: 1_794_000_000_000,
    }).cases[0]!;

  it("counts when challenge_out is genuine and holds the challenge token of the case", () => {
    expect(caseOf(outputRow(TOKEN, 1))).toMatchObject({ genuine_challenge: true, canonical: true });
  });

  it("does not count when challenge_out holds another token, or is not genuine", () => {
    expect(caseOf(outputRow(OTHER_TOKEN, 1))).toMatchObject({ genuine_challenge: false, canonical: false });
    expect(caseOf(outputRow(TOKEN, 0))).toMatchObject({ genuine_challenge: false, canonical: false });
  });
});
