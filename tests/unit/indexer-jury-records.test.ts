/**
 * tests/unit/indexer-jury-records.test.ts — ballots with an empty commit, the link from a reveal to
 * its juror record, and the prompt of a registration (Module-1/jury/SPEC.md §5.3, §6.10 rule 6, §10.3, §10.4).
 *
 * CaseReveal replaces the commit of a ballot with empty bytes and sets Revealed { vote }. CaseClaim
 * keeps the empty commit and sets Paid { vote }. A reveal carries its record in its own metadata
 * (type juror-record), or it refers to it: the juror publishes the record first in another transaction,
 * and the reveal carries a document of type juror-record-ref whose text is the vector-tx: URI of that
 * transaction. The record is checked against record_hash of the reveal redeemer. A record of that hash in
 * any other transaction is not the record: the reference reader (vector_jury find_record) looks only in
 * these two places. The prompt of a juror is the juror-prompt document of its registration transaction.
 */

import { describe, it, expect } from "vitest";

import { SqliteCache } from "../../indexer/src/db/cache.js";
import { vectorTxUri } from "../../indexer/src/documents/document.js";
import { ballotFromData, decodeJuryDatum } from "../../indexer/src/jury/codec.js";
import { loadJuryView } from "../../indexer/src/jury/view.js";
import {
  JURY_ADDRESS,
  JURY_PARAMS,
  JURY_SCRIPT_HASH,
  M1_CHALLENGE_ADDRESS,
  ballotData,
  caseAction,
  caseDatumHex,
  caseToken,
  challengeDatumHex,
  jurorDatumHex,
  jurorToken,
  textHash,
} from "../fixtures/indexer-side/jury-blocks.js";

const AGENT = "b1".repeat(32);
const JUROR = jurorToken(1);

const DEPLOYMENT = {
  label: "jury-1",
  address: JURY_ADDRESS,
  scriptHash: JURY_SCRIPT_HASH,
  params: JURY_PARAMS,
  casesFrom: 0,
  casesUntil: null,
};

describe("ballots with an empty commit (§6.10 rule 6)", () => {
  it("a Revealed or Paid ballot may have an empty commit", () => {
    expect(ballotFromData(ballotData({ agent: AGENT, juror: JUROR, commit: "", status: { revealed: "AuditorWins" } }))).toEqual({
      agent: AGENT,
      juror: JUROR,
      commit: "",
      status: { kind: "Revealed", vote: "AuditorWins" },
    });
    expect(ballotFromData(ballotData({ agent: AGENT, juror: JUROR, commit: "", status: { paid: "Inconclusive" } }))).toEqual({
      agent: AGENT,
      juror: JUROR,
      commit: "",
      status: { kind: "Paid", vote: "Inconclusive" },
    });
  });

  it("a Committed ballot needs a commit of 32 bytes", () => {
    expect(ballotFromData(ballotData({ agent: AGENT, juror: JUROR, commit: "cc".repeat(32) }))?.status).toEqual({ kind: "Committed" });
    expect(ballotFromData(ballotData({ agent: AGENT, juror: JUROR, commit: "" }))).toBeNull();
    expect(ballotFromData(ballotData({ agent: AGENT, juror: JUROR, commit: "cc".repeat(31) }))).toBeNull();
  });

  it("a Revealed ballot with a commit of another size is refused", () => {
    expect(ballotFromData(ballotData({ agent: AGENT, juror: JUROR, commit: "cc".repeat(31), status: { revealed: "ClaimerWins" } }))).toBeNull();
  });

  it("a case datum with revealed and paid ballots that have empty commits decodes", () => {
    const hex = caseDatumHex({
      challenge: `63686c5f${"ce".repeat(28)}`,
      claim: `636c6d5f${"75".repeat(28)}`,
      claimer: "a1".repeat(32),
      auditor: "a2".repeat(32),
      deadline: 9_000_000,
      openedAt: 1_000,
      ballots: [
        { agent: "b3".repeat(32), juror: jurorToken(3), commit: "", status: { paid: "AuditorWins" } },
        { agent: "b2".repeat(32), juror: jurorToken(2), commit: "", status: { revealed: "AuditorWins" } },
        { agent: AGENT, juror: JUROR, commit: "cc".repeat(32) },
      ],
      tally: [0, 2, 0],
    });
    const decoded = decodeJuryDatum(hex);
    if (decoded?.variant !== "Case") throw new Error("the case datum does not decode");
    expect(decoded.ballots.map((b) => [b.status.kind, b.commit])).toEqual([
      ["Paid", ""],
      ["Revealed", ""],
      ["Committed", "cc".repeat(32)],
    ]);
  });
});

describe("the record of a reveal (§10.4)", () => {
  const CHALLENGE = `63686c5f${"ce".repeat(28)}`;
  const CLAIM = `636c6d5f${"75".repeat(28)}`;
  const RECORD = '{"type":"vector-jury-record/1","vote":"AuditorWins"}';
  const OTHER_RECORD = '{"type":"vector-jury-record/1","vote":"ClaimerWins"}';
  const T0 = "a0".repeat(32); // opens the case, with the ballot of the juror
  const T1 = "a1".repeat(32); // the reveal
  const TR = "a2".repeat(32); // a separate transaction with the record
  const TX_OUT = "a3".repeat(32); // makes the challenge output that the case read

  interface SeedDocument {
    txHash: string;
    type: string;
    text: string;
  }

  /** A database with one case, one revealed ballot with an empty commit, and these documents on chain. */
  function seed(documents: SeedDocument[]): SqliteCache {
    const cache = new SqliteCache(":memory:");
    const base = {
      challenge: CHALLENGE,
      claim: CLAIM,
      challengeOut: `${TX_OUT}#0`,
      claimOut: `${TX_OUT}#1`,
      claimer: "a1".repeat(32),
      auditor: "a2".repeat(32),
      deadline: 1_800_000_000_000,
      openedAt: 1_793_577_700_000,
    };
    const before = caseDatumHex({ ...base, ballots: [{ agent: AGENT, juror: JUROR, commit: "cc".repeat(32) }] });
    const after = caseDatumHex({
      ...base,
      ballots: [{ agent: AGENT, juror: JUROR, commit: "", status: { revealed: "AuditorWins" } }],
      tally: [0, 1, 0],
    });
    cache.insertUtxo(`${T0}#0`, JURY_ADDRESS, before, 500, T0);
    cache.insertJuryOutput({ ref: `${T0}#0`, deployment: JURY_SCRIPT_HASH, token: caseToken(1), lovelace: "10000000", slot: 500, blockHeight: 50 });
    cache.insertUtxo(`${T1}#0`, JURY_ADDRESS, after, 600, T1);
    cache.insertJuryOutput({ ref: `${T1}#0`, deployment: JURY_SCRIPT_HASH, token: caseToken(1), lovelace: "10000000", slot: 600, blockHeight: 60 });
    cache.spendUtxo(`${T0}#0`, 600, T1);
    cache.recordJurySpend(`${T0}#0`, 600, 60, T1, caseAction.reveal(JUROR, "AuditorWins", "5a".repeat(32), textHash(RECORD)));
    // The challenge output that the case read: genuine, with the challenge token of the case.
    const challengeDatum = challengeDatumHex({
      claimRef: `${"c1".repeat(32)}#0`,
      auditor: "a2".repeat(32),
      evidenceHash: "a2".repeat(32),
      evidenceUri: "vector-tx:x",
      challengedAt: 1_793_577_600_000,
      resolutionDeadline: 2_592_000_000,
      claimToken: CLAIM,
    });
    cache.insertUtxo(`${TX_OUT}#0`, M1_CHALLENGE_ADDRESS, challengeDatum, 400, TX_OUT, null, CHALLENGE, true);
    for (const d of documents) {
      cache.insertDocument({
        txHash: d.txHash,
        slot: 600,
        blockHeight: 60,
        type: d.type,
        mediaType: "application/json",
        hash: textHash(d.text),
        bytes: new TextEncoder().encode(d.text),
      });
    }
    cache.saveCursor(700, "7".repeat(64), 100);
    return cache;
  }

  const ballotOf = (documents: SeedDocument[]) => {
    const cache = seed(documents);
    try {
      return loadJuryView(cache, [DEPLOYMENT], 0).cases[0]!.ballots[0]!;
    } finally {
      cache.close();
    }
  };

  it("a revealed ballot has an empty commit and a vote", () => {
    expect(ballotOf([])).toMatchObject({ status: "revealed", commit: "", vote: "AuditorWins", record_hash: textHash(RECORD) });
  });

  it("the record is in the reveal transaction", () => {
    expect(ballotOf([{ txHash: T1, type: "juror-record", text: RECORD }])).toMatchObject({
      record_status: "reveal",
      record: { tx: T1, type: "juror-record", hash: textHash(RECORD), matches: true },
    });
  });

  it("the reveal refers to a record that another transaction holds (overflow)", () => {
    const documents = [
      { txHash: TR, type: "juror-record", text: RECORD },
      { txHash: T1, type: "juror-record-ref", text: vectorTxUri(TR) },
    ];
    expect(ballotOf(documents)).toMatchObject({
      record_status: "separate",
      record: { tx: TR, type: "juror-record", hash: textHash(RECORD), matches: true },
    });
    // White space around the URI does not matter.
    expect(ballotOf([documents[0]!, { ...documents[1]!, text: `${vectorTxUri(TR)}\n` }])).toMatchObject({ record_status: "separate" });
  });

  it("a record that another transaction holds does not count when the reveal does not refer to it", () => {
    // The same bytes and the same hash, but nothing in the reveal leads to that transaction.
    expect(ballotOf([{ txHash: TR, type: "juror-record", text: RECORD }])).toMatchObject({ record_status: "missing", record: null });
  });

  it("the record is missing without a record, with a record of another hash, and with a reference that gives none", () => {
    const ref = (text: string): SeedDocument => ({ txHash: T1, type: "juror-record-ref", text });
    const cases: Array<[string, SeedDocument[]]> = [
      ["no document", []],
      ["a record of another hash in the reveal", [{ txHash: T1, type: "juror-record", text: OTHER_RECORD }]],
      ["a reference to a record of another hash", [{ txHash: TR, type: "juror-record", text: OTHER_RECORD }, ref(vectorTxUri(TR))]],
      ["a reference to a document of another type", [{ txHash: TR, type: "claim", text: RECORD }, ref(vectorTxUri(TR))]],
      ["a reference to a transaction without a document", [ref(vectorTxUri(TR))]],
      ["a reference that is not a vector-tx URI", [ref("https://example.org/record.json")]],
      // The record is on chain, but the reveal does not lead to it.
      ["a reference to another transaction, and the record elsewhere", [{ txHash: TR, type: "juror-record", text: RECORD }, ref(vectorTxUri(TX_OUT))]],
      [
        "a record of another hash in the reveal, and the record elsewhere",
        [{ txHash: T1, type: "juror-record", text: OTHER_RECORD }, { txHash: TR, type: "juror-record", text: RECORD }],
      ],
    ];
    for (const [name, documents] of cases) {
      expect(ballotOf(documents), name).toMatchObject({ record_status: "missing", record: null });
    }
  });
});

describe("the prompt of a registration (§10.3)", () => {
  const PROMPT = `{"type":"vector-jury-prompt/1","juror":"did:vector:${AGENT}"}`;
  const OTHER_PROMPT = `{"type":"vector-jury-prompt/1","juror":"did:vector:${"b2".repeat(32)}"}`;
  const REGISTER = "b0".repeat(32);

  /** The only juror of a database whose registration transaction carries this document (null: no document). */
  function jurorWith(document: { type: string; text: string } | null) {
    const cache = new SqliteCache(":memory:");
    try {
      const datum = jurorDatumHex({ agent: AGENT, promptHash: textHash(PROMPT), registeredAt: 1_793_577_600_000 });
      cache.insertUtxo(`${REGISTER}#0`, JURY_ADDRESS, datum, 500, REGISTER);
      cache.insertJuryOutput({ ref: `${REGISTER}#0`, deployment: JURY_SCRIPT_HASH, token: JUROR, lovelace: "250000000", slot: 500, blockHeight: 50 });
      if (document) {
        cache.insertDocument({
          txHash: REGISTER,
          slot: 500,
          blockHeight: 50,
          type: document.type,
          mediaType: "application/json",
          hash: textHash(document.text),
          bytes: new TextEncoder().encode(document.text),
        });
      }
      cache.saveCursor(700, "7".repeat(64), 100);
      return loadJuryView(cache, [DEPLOYMENT], 0).jurors[0]!;
    } finally {
      cache.close();
    }
  }

  it("is the juror-prompt document of the registration transaction", () => {
    expect(jurorWith({ type: "juror-prompt", text: PROMPT })).toMatchObject({
      prompt_hash: textHash(PROMPT),
      prompt: { tx: REGISTER, type: "juror-prompt", hash: textHash(PROMPT), matches: true },
    });
  });

  it("a juror-prompt document with another hash is shown, and it does not match the prompt hash", () => {
    expect(jurorWith({ type: "juror-prompt", text: OTHER_PROMPT })).toMatchObject({
      prompt: { tx: REGISTER, type: "juror-prompt", hash: textHash(OTHER_PROMPT), matches: false },
    });
  });

  it("a document of another type in the registration transaction is no prompt, also with the prompt hash", () => {
    for (const type of ["juror-record", "juror-record-ref", "claim", "evidence", "resolution"]) {
      expect(jurorWith({ type, text: PROMPT }), type).toMatchObject({ prompt_hash: textHash(PROMPT), prompt: null });
    }
    expect(jurorWith(null)).toMatchObject({ prompt: null });
  });
});
