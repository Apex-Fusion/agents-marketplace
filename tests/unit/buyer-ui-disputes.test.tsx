// @vitest-environment happy-dom
/**
 * buyer-ui-disputes.test.tsx — the dispute case card with the jury
 * (Module-1/jury/SPEC.md).
 *
 * The card reads documents on chain through the indexer proxy
 * (GET /v1/indexer/documents/<tx>) and checks blake2b-256 of the exact bytes
 * against the hash on chain: the claim and evidence documents of `vector-tx:`
 * URIs, the juror records of the reveals and the resolution document. Site
 * documents still load same-origin. Tests stub globalThis.fetch.
 *
 * The card body (the documents and the jury) mounts only while the card is
 * open, so a collapsed card makes no request. The /disputes page asks the
 * indexer for 25 cases at a time and shows "Show 25 more".
 */

import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { blake2b } from "@noble/hashes/blake2b";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Disputes, { DisputeCaseCard, disputeAgentIds, vectorTxId, type DisputeCase } from "../../buyer/src/ui/pages/Disputes.js";
import AgentIdentity from "../../buyer/src/ui/pages/AgentIdentity.js";

const hash = (text: string): string => Buffer.from(blake2b(new TextEncoder().encode(text), { dkLen: 32 })).toString("hex");
const uriOf = (tx: string): string => `vector-tx:${Buffer.from(tx, "hex").toString("base64url")}`;
const hexText = (text: string): string => Buffer.from(text, "utf8").toString("hex");

const CLAIMER = "a1".repeat(32);
const AUDITOR = "a2".repeat(32);
const JUROR_A = "b1".repeat(32);
const JUROR_B = "b2".repeat(32);
const SUPPLIER = "5e".repeat(32);
const TX = { claimDoc: "d1".repeat(32), evidenceDoc: "d2".repeat(32), open: "0e".repeat(32), revealA: "3a".repeat(32), fin: "50".repeat(32), resolve: "60".repeat(32) };
const CASE = `6361735f${"01".repeat(28)}`;

const CLAIM_DOC = '{"statement":"The agent passed the audit.","summary":"Audit report 7."}';
const EVIDENCE_DOC = '{"statement":"The audit report is forged."}';
const RECORD = JSON.stringify({
  type: "vector-jury-record/1",
  model: {
    supplier: `did:vector:${SUPPLIER}`,
    model: "qwen-3-27b",
    escrow: `${"ab".repeat(32)}#0`,
    receipt: { model: "qwen-3-27b", prompt_tokens: 812, agent_did: `did:vector:${SUPPLIER}` },
    receipt_signature: "ff".repeat(64),
  },
  response: {
    output: [
      { type: "reasoning", content: [{ type: "output_text", text: "hidden reasoning text" }] },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "The two signatures " },
          { type: "output_text", text: "do not verify." },
        ],
      },
    ],
    status: "completed",
    incomplete_details: null,
  },
  vote: "AuditorWins",
  reason: "The evidence shows a forged report.",
});
const RESOLUTION = JSON.stringify({
  type: "vector-jury-resolution/1",
  verdict: "AuditorWins",
  basis: "jury",
  jury: {
    case: CASE,
    opened_in: TX.open,
    finalized_in: TX.fin,
    tally: { ClaimerWins: 1, AuditorWins: 2, Inconclusive: 0 },
    reveals: [{ juror: `did:vector:${JUROR_A}`, vote: "AuditorWins", tx: TX.revealA }],
  },
});

/** Documents on chain by transaction: the stubbed indexer answers with their exact bytes. */
const ON_CHAIN: Record<string, string> = {
  [TX.claimDoc]: CLAIM_DOC,
  [TX.evidenceDoc]: EVIDENCE_DOC,
  [TX.revealA]: RECORD,
  [TX.resolve]: RESOLUTION,
};

/** Stubs fetch: the documents on chain (ON_CHAIN), the site documents and, first, the URLs that `routes` answers. */
function stubFetch(site: Record<string, string> = {}, routes: (url: string) => Response | undefined = () => undefined) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const routed = routes(url);
    if (routed) return routed;
    const onChain = /^\/v1\/indexer\/documents\/([0-9a-f]{64})$/.exec(url);
    if (onChain) {
      const text = ON_CHAIN[onChain[1]!];
      return text === undefined
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json({ tx: onChain[1], type: "x", hash: hash(text), bytes_hex: hexText(text) });
    }
    if (url in site) return new Response(site[url]!, { status: 200 });
    if (url.startsWith("/v1/evidence/by-hash/")) return Response.json({ error: "not_found" }, { status: 404 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URLs that a stubbed fetch received, in order. */
const urlsOf = (fetchSpy: Mock): string[] => fetchSpy.mock.calls.map(([url]) => String(url));

/** Opens or closes a card the way the browser does after a click on its summary: `open` changes, then `toggle` fires. */
function toggleCard(card: HTMLElement, open: boolean): void {
  act(() => {
    (card as HTMLDetailsElement).open = open;
  });
  fireEvent(card, new Event("toggle"));
}

/** Renders a card, opens it when it is collapsed (a resolved case), and waits until every document check has an answer. */
async function renderCard(c: DisputeCase) {
  const view = render(<DisputeCaseCard c={c} names={{}} />);
  const card = screen.getByTestId("dispute-case") as HTMLDetailsElement;
  if (!card.open) toggleCard(card, true);
  await waitFor(() => {
    expect(screen.queryByText(/Checking the document…|Reading the resolution document…|Looking up the reasoning document…|Reading the record…/)).toBeNull();
  });
  return view;
}

function juryCase(): DisputeCase {
  return {
    claim_ref: `${"c1".repeat(32)}#0`,
    claimer_agent_id: CLAIMER,
    status: "resolved",
    claim: {
      tx: "c1".repeat(32),
      time: "2026-11-09T10:00:00.000Z",
      stake_lovelace: "50000000",
      fields: { storage_uri: uriOf(TX.claimDoc), claim_hash: hash(CLAIM_DOC), claim_type: "certification" },
    },
    challenge: {
      tx: "c2".repeat(32),
      time: "2026-11-09T11:00:00.000Z",
      auditor_agent_id: AUDITOR,
      stake_lovelace: "50000000",
      // The evidence hash on chain names other bytes than the document in the transaction.
      fields: { evidence_uri: uriOf(TX.evidenceDoc), evidence_hash: hash("other bytes") },
    },
    jury: {
      deployment: "jury-1",
      case: CASE,
      window: "ended",
      state: "closed",
      deadline: "2026-12-09T11:00:00.000Z",
      commit_end: "2026-11-09T14:00:00.000Z",
      reveal_end: "2026-11-09T16:00:00.000Z",
      rule: { quorum: 3, majority_num: 2, majority_den: 3 },
      tally: { ClaimerWins: 1, AuditorWins: 2, Inconclusive: 0 },
      revealed: 3,
      result: "AuditorWins",
      opened: { tx: TX.open, time: "2026-11-09T12:00:00.000Z", height: 4242 },
      finalized: { tx: TX.fin, time: "2026-11-09T16:05:00.000Z", result: "AuditorWins" },
      ballots: [
        {
          agent_id: JUROR_A, juror: `6a72725f${"01".repeat(28)}`, status: "revealed", vote: "AuditorWins", revealed: { tx: TX.revealA },
          record_hash: hash(RECORD), record_status: "reveal", record: { tx: TX.revealA },
        },
        { agent_id: JUROR_B, juror: `6a72725f${"02".repeat(28)}`, status: "slashed", vote: null, slashed: { tx: "4b".repeat(32) } },
      ],
    },
    resolution: { tx: TX.resolve, time: "2026-11-09T16:10:00.000Z", outcome: "AuditorWins", reasoning_hash: hash(RESOLUTION) },
    resolution_document: { tx: TX.resolve },
    verdict: null,
  };
}

describe("vectorTxId", () => {
  it("decodes a vector-tx URI into the transaction id and refuses other texts", () => {
    expect(vectorTxId(uriOf(TX.claimDoc))).toBe(TX.claimDoc);
    expect(vectorTxId(`${uriOf(TX.claimDoc).slice(0, -1)}B`)).toBeNull();
    expect(vectorTxId("vector-tx:abc")).toBeNull();
    expect(vectorTxId("https://example.org/doc.json")).toBeNull();
  });
});

describe("<DisputeCaseCard /> — jury and documents on chain", () => {
  it("checks the claim and evidence documents of vector-tx URIs through the indexer", async () => {
    const fetchSpy = stubFetch();
    await renderCard(juryCase());
    expect(await screen.findByText("“The agent passed the audit.”")).toBeInTheDocument();
    expect(await screen.findByText(/document hash does not match/)).toBeInTheDocument();
    expect(screen.getAllByText(/document hash matches the on-chain hash/).length).toBeGreaterThanOrEqual(1);
    expect(fetchSpy).toHaveBeenCalledWith(`/v1/indexer/documents/${TX.claimDoc}`, expect.anything());
    expect(fetchSpy).toHaveBeenCalledWith(`/v1/indexer/documents/${TX.evidenceDoc}`, expect.anything());
  });

  it("shows the jury: windows, rule, tally, result and each juror with a DID link", async () => {
    stubFetch();
    await renderCard(juryCase());
    const jury = screen.getByTestId("jury-section");
    expect(within(jury).getByText(/at least 3 revealed votes and at least 2\/3 of them\. Otherwise the result is Inconclusive\./)).toBeInTheDocument();
    expect(within(jury).getByText(/ClaimerWins 1 · AuditorWins 2 · Inconclusive 0/)).toBeInTheDocument();
    expect(within(jury).getByText("voting ended")).toBeInTheDocument();
    expect(within(jury).getByText(/block 4242/)).toBeInTheDocument();
    const ballots = within(jury).getAllByTestId("jury-ballot");
    expect(ballots).toHaveLength(2);
    expect(within(ballots[0]!).getByRole("link", { name: /did:vector:b1b1…b1b1/ })).toHaveAttribute("href", `/agents/${JUROR_A}`);
    expect(within(ballots[0]!).getByText("revealed")).toBeInTheDocument();
    expect(within(ballots[1]!).getByText("slashed")).toBeInTheDocument();
    expect(disputeAgentIds(juryCase())).toEqual([CLAIMER, AUDITOR, JUROR_A, JUROR_B]);
  });

  it("says where the record of each ballot is; a missing record is one that the reveal does not carry or name (SPEC §10.4)", async () => {
    stubFetch();
    const c = juryCase();
    const ballot = { status: "revealed", vote: "AuditorWins", record_hash: hash(RECORD) };
    c.jury!.ballots = [
      { ...ballot, agent_id: JUROR_A, revealed: { tx: TX.revealA }, record_status: "reveal", record: { tx: TX.revealA } },
      { ...ballot, agent_id: JUROR_B, revealed: { tx: "3b".repeat(32) }, record_status: "separate", record: { tx: TX.revealA } },
      { ...ballot, agent_id: "b3".repeat(32), revealed: { tx: "3c".repeat(32) }, record_status: "missing", record: null },
    ];
    await renderCard(c);
    const ballots = screen.getAllByTestId("jury-ballot");
    expect(within(ballots[0]!).getByText("Record in the reveal transaction.")).toBeInTheDocument();
    expect(within(ballots[1]!).getByText(/^Record in a separate transaction \(overflow\)\./)).toBeInTheDocument();
    expect(within(ballots[2]!).getByText("The reveal does not carry or name a juror record with this hash.")).toBeInTheDocument();
    expect(screen.queryByText("No record with this hash on chain.")).toBeNull();
  });

  it("opens a juror record: reads the reveal transaction and checks the record hash", async () => {
    const fetchSpy = stubFetch();
    await renderCard(juryCase());
    const ballot = screen.getAllByTestId("jury-ballot")[0]!;
    expect(fetchSpy).not.toHaveBeenCalledWith(`/v1/indexer/documents/${TX.revealA}`, expect.anything());
    const details = ballot.querySelector("details")!;
    act(() => {
      details.open = true;
    });
    fireEvent(details, new Event("toggle"));
    const record = await within(ballot).findByTestId("juror-record");
    expect(within(record).getByText(/document hash matches the on-chain hash/)).toBeInTheDocument();
    expect(within(record).getAllByText("qwen-3-27b").length).toBeGreaterThanOrEqual(1);
    expect(within(record).getByText("The evidence shows a forged report.")).toBeInTheDocument();
    expect(within(record).getByText("The two signatures do not verify.")).toBeInTheDocument();
    expect(within(record).getByText("prompt_tokens")).toBeInTheDocument();
    expect(within(record).getByRole("link", { name: /did:vector:5e5e…5e5e/ })).toHaveAttribute("href", `/agents/${SUPPLIER}`);
  });

  it("shows the resolution document of the OracleResolve: verdict, basis, case and tally", async () => {
    stubFetch();
    await renderCard(juryCase());
    expect(screen.getByText(/The jury decides\. The Foundation relay signs the Module-1 resolution with the jury result\./)).toBeInTheDocument();
    const doc = await screen.findByTestId("resolution-document");
    expect(within(doc).getByText("jury")).toBeInTheDocument();
    expect(within(doc).getByText("The jury result.")).toBeInTheDocument();
    expect(within(doc).getByText(/tally ClaimerWins 1 · AuditorWins 2 · Inconclusive 0/)).toBeInTheDocument();
    expect(within(doc).getByText(/document hash matches the on-chain hash/)).toBeInTheDocument();
  });

  it("keeps the site-hosted documents and the site reasoning lookup", async () => {
    const fetchSpy = stubFetch({ "/evidence/c1.json": CLAIM_DOC });
    const c: DisputeCase = {
      claim_ref: `${"c3".repeat(32)}#0`,
      claimer_agent_id: CLAIMER,
      status: "challenged",
      claim: { tx: "c3".repeat(32), fields: { storage_uri: "https://marketplace.vector.apexfusion.org/evidence/c1.json", claim_hash: hash(CLAIM_DOC) } },
      challenge: { tx: "c4".repeat(32), auditor_agent_id: AUDITOR, fields: { evidence_uri: "https://elsewhere.example/e.json", evidence_hash: "00".repeat(32) } },
      resolution: null,
      jury: null,
    };
    await renderCard(c);
    expect(await screen.findByText(/document hash matches the on-chain hash/)).toBeInTheDocument();
    expect(screen.getByText(/hosted elsewhere/)).toBeInTheDocument();
    expect(screen.getByText(/No jury case yet\./)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/evidence/c1.json", expect.anything());
  });

  it("an old oracle resolution without a document on chain uses the site reasoning lookup", async () => {
    const fetchSpy = stubFetch();
    const c: DisputeCase = {
      claim_ref: `${"c5".repeat(32)}#0`,
      status: "resolved",
      claim: { tx: "c5".repeat(32), fields: {} },
      challenge: { tx: "c6".repeat(32), fields: {} },
      resolution: { tx: "c7".repeat(32), outcome: "ClaimerWins", reasoning_hash: "ab".repeat(32) },
      resolution_document: null,
    };
    await renderCard(c);
    expect(await screen.findByText(/Reasoning: no document matches the on-chain hash\./)).toBeInTheDocument();
    expect(screen.getByText("No jury case was opened for this challenge.")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(`/v1/evidence/by-hash/${"ab".repeat(32)}`, expect.anything());
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  });
});

describe("<AgentIdentity /> — juror registrations", () => {
  it("lists the juror registrations of the agent from /v1/indexer/jury/jurors", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === `/v1/identity/resolve/did:vector:${JUROR_A}`) {
        return Response.json({ didDocumentMetadata: { vectorProfile: { name: "Juror A" }, vectorStatus: { effective: "active" } } });
      }
      if (url === `/v1/indexer/disputes?agent_id=${JUROR_A}`) return Response.json({ cases: [] });
      if (url === `/v1/indexer/jury/jurors?agent_id=${JUROR_A}`) {
        return Response.json({
          jurors: [{
            juror: `6a72725f${"01".repeat(28)}`,
            agent_id: JUROR_A,
            status: "registered",
            eligible: true,
            bond_lovelace: "250000000",
            eligible_from: "2026-11-12T10:00:00.000Z",
            exit_after: null,
            open: [{ case: CASE }],
            slashes: [],
            registered: { tx: "1a".repeat(32), time: "2026-11-09T10:00:00.000Z" },
          }],
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }));
    render(
      <MemoryRouter initialEntries={[`/agents/${JUROR_A}`]}>
        <Routes>
          <Route path="/agents/:id" element={<AgentIdentity />} />
        </Routes>
      </MemoryRouter>,
    );
    const row = await screen.findByTestId("juror-registration");
    expect(within(row).getByText("250.000000 AP3X")).toBeInTheDocument();
    expect(within(row).getByText(/can vote now/)).toBeInTheDocument();
    expect(within(row).getByText("2026-11-12 10:00 UTC")).toBeInTheDocument();
    expect(urls).toContain(`/v1/indexer/jury/jurors?agent_id=${JUROR_A}`);
    await waitFor(() => expect(screen.queryAllByText("Loading…")).toHaveLength(0));
  });
});

// ─── Record response shapes and resolution bases ────────────────────────────────

const REVEAL_CUT = "3b".repeat(32);
const CUT_RECORD = JSON.stringify({
  type: "vector-jury-record/1",
  model: { supplier: `did:vector:${SUPPLIER}`, model: "qwen-3-27b", escrow: `${"ab".repeat(32)}#0`, receipt_signature: "ff".repeat(64) },
  response: { cut: true, output_text: "The two signatures do" },
  vote: "AuditorWins",
  reason: "The response was cut.",
});
const NO_JURY_TX = "6a".repeat(32);
const NO_JURY_DOC = JSON.stringify({ type: "vector-jury-resolution/1", verdict: "Inconclusive", basis: "no-jury", jury: null });
const NO_RESULT_TX = "6b".repeat(32);
const NO_RESULT_DOC = JSON.stringify({
  type: "vector-jury-resolution/1",
  verdict: "Inconclusive",
  basis: "no-result",
  jury: { case: CASE, opened_in: TX.open, finalized_in: null, tally: { ClaimerWins: 1, AuditorWins: 1, Inconclusive: 0 } },
});

function oneBallotCase(revealTx: string, recordHash: string): DisputeCase {
  return {
    claim_ref: `${"c8".repeat(32)}#0`,
    status: "resolved",
    claim: { tx: "c8".repeat(32), fields: {} },
    challenge: { tx: "c9".repeat(32), fields: {} },
    resolution: null,
    jury: {
      deployment: "jury-1",
      case: CASE,
      window: "ended",
      state: "closed",
      rule: { quorum: 3, majority_num: 2, majority_den: 3 },
      tally: { ClaimerWins: 0, AuditorWins: 1, Inconclusive: 0 },
      revealed: 1,
      ballots: [
        {
          agent_id: JUROR_A,
          juror: `6a72725f${"01".repeat(28)}`,
          status: "revealed",
          vote: "AuditorWins",
          revealed: { tx: revealTx },
          record_hash: recordHash,
          record_status: "reveal",
          record: { tx: revealTx },
        },
      ],
    },
  };
}

function resolvedCase(tx: string, text: string): DisputeCase {
  return {
    claim_ref: `${"c8".repeat(32)}#0`,
    status: "resolved",
    claim: { tx: "c8".repeat(32), fields: {} },
    challenge: { tx: "c9".repeat(32), fields: {} },
    resolution: { tx, outcome: "Inconclusive", reasoning_hash: hash(text) },
    resolution_document: { tx },
    jury: null,
  };
}

async function openFirstRecord() {
  const ballot = screen.getAllByTestId("jury-ballot")[0]!;
  const details = ballot.querySelector("details")!;
  act(() => {
    details.open = true;
  });
  fireEvent(details, new Event("toggle"));
  return within(ballot).findByTestId("juror-record");
}

describe("<DisputeCaseCard /> — record response shapes and resolution bases", () => {
  it("shows the output_text parts of the message items in order, and no other item", async () => {
    stubFetch();
    await renderCard(juryCase());
    const record = await openFirstRecord();
    expect(within(record).getByText("The two signatures do not verify.")).toBeInTheDocument();
    expect(within(record).queryByText(/hidden reasoning text/)).toBeNull();
    expect(within(record).queryByText(/cut to fit/)).toBeNull();
  });

  it("shows the text of a cut response and says that it is cut", async () => {
    ON_CHAIN[REVEAL_CUT] = CUT_RECORD;
    stubFetch();
    await renderCard(oneBallotCase(REVEAL_CUT, hash(CUT_RECORD)));
    const record = await openFirstRecord();
    expect(within(record).getByText("The two signatures do")).toBeInTheDocument();
    expect(within(record).getByText("Model output (cut to fit the transaction)")).toBeInTheDocument();
  });

  it("explains the basis no-jury", async () => {
    ON_CHAIN[NO_JURY_TX] = NO_JURY_DOC;
    stubFetch();
    await renderCard(resolvedCase(NO_JURY_TX, NO_JURY_DOC));
    const doc = await screen.findByTestId("resolution-document");
    expect(within(doc).getByText("no-jury")).toBeInTheDocument();
    expect(within(doc).getByText("No followed jury deployment covered the time of the challenge. The result is Inconclusive.")).toBeInTheDocument();
  });

  it("says when a resolution has no Finalize transaction", async () => {
    ON_CHAIN[NO_RESULT_TX] = NO_RESULT_DOC;
    stubFetch();
    await renderCard(resolvedCase(NO_RESULT_TX, NO_RESULT_DOC));
    const doc = await screen.findByTestId("resolution-document");
    expect(within(doc).getByText(/no Finalize transaction/)).toBeInTheDocument();
    expect(within(doc).queryByText(/finalized in/)).toBeNull();
  });
});

// ─── The card body mounts only while the card is open ───────────────────────────

describe("<DisputeCaseCard /> — the body mounts only while the card is open", () => {
  it("a collapsed resolved card shows its summary line and makes no request until it is opened", async () => {
    const fetchSpy = stubFetch();
    render(<DisputeCaseCard c={juryCase()} names={{}} />);
    const card = screen.getByTestId("dispute-case") as HTMLDetailsElement;
    expect(card.open).toBe(false);
    for (const text of ["certification", "did:vector:a1a1…a1a1", "did:vector:a2a2…a2a2", "2026-11-09 10:00 UTC", "2 juror votes", "resolved", "AuditorWins"]) {
      expect(card).toHaveTextContent(text);
    }
    await act(async () => {
      await delay(0);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("jury-section")).toBeNull();
    expect(screen.queryByText("Claim document")).toBeNull();

    toggleCard(card, true);
    expect(await screen.findByTestId("resolution-document")).toBeInTheDocument();
    expect(await screen.findByText("“The agent passed the audit.”")).toBeInTheDocument();
    expect(urlsOf(fetchSpy).sort()).toEqual([TX.claimDoc, TX.evidenceDoc, TX.resolve].map((tx) => `/v1/indexer/documents/${tx}`).sort());
  });

  it("unmounts the body when the card is closed and mounts it again when the card is opened", async () => {
    stubFetch();
    await renderCard(juryCase());
    const card = screen.getByTestId("dispute-case") as HTMLDetailsElement;
    expect(screen.getByTestId("jury-section")).toBeInTheDocument();
    toggleCard(card, false);
    expect(screen.queryByTestId("jury-section")).toBeNull();
    expect(card).toHaveTextContent("AuditorWins");
    toggleCard(card, true);
    expect(screen.getByTestId("jury-section")).toBeInTheDocument();
    expect(await screen.findByTestId("resolution-document")).toBeInTheDocument();
  });

  it("a card without a resolution starts open and reads its documents at once", async () => {
    const fetchSpy = stubFetch();
    const c: DisputeCase = { ...juryCase(), status: "challenged", resolution: null, resolution_document: null, jury: null };
    render(<DisputeCaseCard c={c} names={{}} />);
    expect((screen.getByTestId("dispute-case") as HTMLDetailsElement).open).toBe(true);
    expect(urlsOf(fetchSpy).sort()).toEqual([TX.claimDoc, TX.evidenceDoc].map((tx) => `/v1/indexer/documents/${tx}`).sort());
    expect(await screen.findByText("“The agent passed the audit.”")).toBeInTheDocument();
  });
});

// ─── The /disputes page: pages of 25 cases ──────────────────────────────────────

/** A resolved case with documents on chain: its card starts collapsed. */
function pageCase(i: number): DisputeCase {
  const tx = i.toString(16).padStart(64, "0");
  return {
    claim_ref: `${tx}#0`,
    claimer_agent_id: CLAIMER,
    status: "resolved",
    claim: {
      tx,
      time: "2026-11-09T10:00:00.000Z",
      stake_lovelace: "50000000",
      fields: { claim_type: "certification", storage_uri: uriOf(TX.claimDoc), claim_hash: hash(CLAIM_DOC) },
    },
    challenge: null,
    resolution: { tx: TX.resolve, time: "2026-11-09T16:10:00.000Z", outcome: "ClaimerWins", reasoning_hash: hash(RESOLUTION) },
    resolution_document: { tx: TX.resolve },
    jury: null,
    verdict: null,
  };
}

/**
 * A stubbed indexer with `available` cases, newest first. It gives the newest `limit` cases and `total`.
 * `older` is an older indexer: it ignores `limit` and gives all the cases and no `total`.
 */
function stubIndexer(available: number, { older = false } = {}) {
  return stubFetch({}, (url) => {
    if (url.startsWith("/v1/indexer/disputes?")) {
      const limit = older ? available : Number(new URL(url, "http://localhost").searchParams.get("limit"));
      const cases = Array.from({ length: Math.min(limit, available) }, (_, i) => pageCase(i));
      return Response.json(older ? { cases } : { cases, total: available });
    }
    if (url.startsWith("/v1/identity/summaries?ids=")) {
      return Response.json({
        [CLAIMER]: { did: `did:vector:${CLAIMER}`, status: 0, name: "Claimer One", origin: null, effective: "active", effectiveReason: null, accountable: true, module1: false },
      });
    }
    return undefined;
  });
}

const renderPage = () => render(<MemoryRouter><Disputes /></MemoryRouter>);

describe("<Disputes /> — pages of 25 cases", () => {
  it("asks for the newest 25 cases, shows the count, and a click on Show 25 more asks for 25 more", async () => {
    const fetchSpy = stubIndexer(60);
    renderPage();
    expect(await screen.findByText("Showing 25 of 60 cases")).toBeInTheDocument();
    expect(urlsOf(fetchSpy)).toContain("/v1/indexer/disputes?limit=25");
    expect(screen.getAllByTestId("dispute-case")).toHaveLength(25);

    fireEvent.click(screen.getByText("Show 25 more"));
    expect(await screen.findByText("Showing 50 of 60 cases")).toBeInTheDocument();
    expect(urlsOf(fetchSpy)).toContain("/v1/indexer/disputes?limit=50");
    expect(screen.getAllByTestId("dispute-case")).toHaveLength(50);

    fireEvent.click(screen.getByText("Show 25 more"));
    await waitFor(() => expect(screen.getAllByTestId("dispute-case")).toHaveLength(60));
    expect(urlsOf(fetchSpy)).toContain("/v1/indexer/disputes?limit=75");
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(screen.queryByText("Show 25 more")).toBeNull();
  });

  it("shows no count and no button when the indexer sends no total", async () => {
    const fetchSpy = stubIndexer(30, { older: true });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("dispute-case")).toHaveLength(30));
    expect(urlsOf(fetchSpy)).toContain("/v1/indexer/disputes?limit=25");
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(screen.queryByText("Show 25 more")).toBeNull();
  });

  it("shows no count and no button when all the cases are in the page", async () => {
    stubIndexer(10);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("dispute-case")).toHaveLength(10));
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(screen.queryByText("Show 25 more")).toBeNull();
  });

  it("stops at 200 cases, the largest page of the indexer, and says how to find older cases", async () => {
    const fetchSpy = stubIndexer(500);
    renderPage();
    for (let shown = 25; shown < 200; shown += 25) {
      await screen.findByText(`Showing ${shown} of 500 cases`);
      fireEvent.click(screen.getByText("Show 25 more"));
    }
    expect(await screen.findByText("Showing 200 of 500 cases")).toBeInTheDocument();
    expect(screen.queryByText("Show 25 more")).toBeNull();
    expect(screen.getByText(/newest 200 cases at most/)).toBeInTheDocument();
    const limits = urlsOf(fetchSpy).flatMap((url) => /^\/v1\/indexer\/disputes\?limit=(\d+)$/.exec(url)?.[1] ?? []).map(Number);
    expect(Math.max(...limits)).toBe(200);
  });

  it("keeps the limit at the 15-second refresh", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const fetchSpy = stubIndexer(60);
      renderPage();
      await screen.findByText("Showing 25 of 60 cases");
      fireEvent.click(screen.getByText("Show 25 more"));
      await screen.findByText("Showing 50 of 60 cases");
      const refreshes = setIntervalSpy.mock.calls.filter(([, ms]) => ms === 15_000);
      const before = urlsOf(fetchSpy).length;
      await act(async () => {
        (refreshes[refreshes.length - 1]![0] as () => void)();
      });
      expect(urlsOf(fetchSpy).slice(before)).toEqual(["/v1/indexer/disputes?limit=50"]);
      expect(await screen.findByText("Showing 50 of 60 cases")).toBeInTheDocument();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("makes no document request for the collapsed cards, and shows the identity names of the shown cases", async () => {
    const fetchSpy = stubIndexer(25);
    renderPage();
    await waitFor(() => expect(screen.getAllByText("Claimer One")).toHaveLength(25));
    expect(screen.getAllByTestId("dispute-case").every((card) => !(card as HTMLDetailsElement).open)).toBe(true);
    expect(urlsOf(fetchSpy).sort()).toEqual(["/v1/identity/summaries?ids=" + CLAIMER, "/v1/indexer/disputes?limit=25"].sort());

    toggleCard(screen.getAllByTestId("dispute-case")[3]!, true);
    expect(await screen.findByTestId("resolution-document")).toBeInTheDocument();
    const documents = urlsOf(fetchSpy).filter((url) => url.startsWith("/v1/indexer/documents/")).sort();
    expect(documents).toEqual([TX.claimDoc, TX.resolve].map((tx) => `/v1/indexer/documents/${tx}`).sort());
  });
});

describe("<AgentIdentity /> — disputes of the agent", () => {
  it("asks for all the cases of the agent (no limit); the cards are collapsed and there is no count or button", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === `/v1/identity/resolve/did:vector:${CLAIMER}`) {
        return Response.json({ didDocumentMetadata: { vectorProfile: { name: "Claimer One" }, vectorStatus: { effective: "active" } } });
      }
      if (url === `/v1/indexer/disputes?agent_id=${CLAIMER}`) return Response.json({ cases: [juryCase()], total: 1 });
      return Response.json({ error: "not_found" }, { status: 404 });
    }));
    render(
      <MemoryRouter initialEntries={[`/agents/${CLAIMER}`]}>
        <Routes>
          <Route path="/agents/:id" element={<AgentIdentity />} />
        </Routes>
      </MemoryRouter>,
    );
    const card = await screen.findByTestId("dispute-case");
    expect(card).toHaveTextContent("AuditorWins");
    expect((card as HTMLDetailsElement).open).toBe(false);
    expect(urls).toContain(`/v1/indexer/disputes?agent_id=${CLAIMER}`);
    expect(urls.filter((url) => url.includes("limit="))).toEqual([]);
    expect(urls.filter((url) => url.startsWith("/v1/indexer/documents/"))).toEqual([]);
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(screen.queryByText("Show 25 more")).toBeNull();
  });
});
