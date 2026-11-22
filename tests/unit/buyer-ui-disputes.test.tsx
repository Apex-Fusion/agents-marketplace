// @vitest-environment happy-dom
/**
 * buyer-ui-disputes.test.tsx — the dispute case card (documents on chain, jury, lazy body) and the /disputes page (pages of 25).
 * Ties to Module-1/jury/SPEC.md §10.4. The tests stub globalThis.fetch.
 */

import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { act, cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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

const CLAIM_STATEMENT = "The agent passed the audit.";
const CLAIM_DOC = JSON.stringify({ statement: CLAIM_STATEMENT, summary: "Audit report 7." });
const EVIDENCE_DOC = '{"statement":"The audit report is forged."}';
// The data of the juror record: the tests read these values back from the card.
const MODEL = "qwen-3-27b";
const REASON = "The evidence shows a forged report.";
const OUTPUT_PARTS = ["The two signatures ", "do not verify."];
const HIDDEN_TEXT = "hidden reasoning text";
const RECORD = JSON.stringify({
  type: "vector-jury-record/1",
  model: {
    supplier: `did:vector:${SUPPLIER}`,
    model: MODEL,
    escrow: `${"ab".repeat(32)}#0`,
    receipt: { model: MODEL, prompt_tokens: 812, agent_did: `did:vector:${SUPPLIER}` },
    receipt_signature: "ff".repeat(64),
  },
  response: {
    output: [
      { type: "reasoning", content: [{ type: "output_text", text: HIDDEN_TEXT }] },
      {
        type: "message",
        role: "assistant",
        content: OUTPUT_PARTS.map((text) => ({ type: "output_text", text })),
      },
    ],
    status: "completed",
    incomplete_details: null,
  },
  vote: "AuditorWins",
  reason: REASON,
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
  cleanup();
  vi.useRealTimers();
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

/** Lets the stubbed requests finish and React apply their answers. */
const settle = (): Promise<void> => act(async () => {});

const EXPLORER = "https://vector.apexscan.org/en/transaction/";
/** The explorer link of a transaction (`TxLink`). */
const txUrl = (tx: string): string => `${EXPLORER}${tx}/summary/`;

/** The `href` of each link in an element, in order. */
const hrefsOf = (el: HTMLElement): Array<string | null> => within(el).queryAllByRole("link").map((link) => link.getAttribute("href"));

/** The explorer links in an element: the transactions that it names. */
const txLinksOf = (el: HTMLElement): Array<string | null> => hrefsOf(el).filter((href) => href?.startsWith(EXPLORER));

/** Renders a card, opens it when it is collapsed (a resolved case) and lets its document requests finish. */
async function renderCard(c: DisputeCase) {
  const view = render(<DisputeCaseCard c={c} names={{}} />);
  const card = screen.getByTestId("dispute-case") as HTMLDetailsElement;
  if (!card.open) toggleCard(card, true);
  await settle();
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
  // text kept: no handle. The line that says whether the document hash matches the on-chain hash has no role and no test id,
  // and a wrong state there shows a forged document as verified. Each row asserts one narrow text.
  it.each([
    ["matches", hash(CLAIM_DOC), /hash matches/],
    ["differs from", hash("other bytes"), /hash does not match/],
  ] as const)("reads the claim document through the indexer and tells that its hash %s the on-chain hash", async (_state, claimHash, line) => {
    const fetchSpy = stubFetch();
    const c: DisputeCase = {
      claim_ref: `${"c1".repeat(32)}#0`,
      status: "open",
      claim: { tx: "c1".repeat(32), fields: { storage_uri: uriOf(TX.claimDoc), claim_hash: claimHash } },
      challenge: null,
      resolution: null,
      jury: null,
    };
    await renderCard(c);
    expect(await screen.findByText(line)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(`/v1/indexer/documents/${TX.claimDoc}`, expect.anything());
  });

  it("shows the jury: tally, block of the open transaction, and each juror with a link to the agent page", async () => {
    stubFetch();
    await renderCard(juryCase());
    const jury = screen.getByTestId("jury-section");
    // The data of the jury case: the tally, the block height and the status of each ballot.
    expect(jury).toHaveTextContent(/ClaimerWins\D*1\D*AuditorWins\D*2\D*Inconclusive\D*0/);
    expect(jury).toHaveTextContent("4242");
    const ballots = within(jury).getAllByTestId("jury-ballot");
    expect(ballots).toHaveLength(2);
    expect(ballots[0]).toHaveTextContent("revealed");
    expect(ballots[1]).toHaveTextContent("slashed");
    expect(hrefsOf(ballots[0]!)).toContain(`/agents/${JUROR_A}`);
    expect(hrefsOf(ballots[1]!)).toContain(`/agents/${JUROR_B}`);
    expect(disputeAgentIds(juryCase())).toEqual([CLAIMER, AUDITOR, JUROR_A, JUROR_B]);
  });

  it("offers a record only for a ballot that names its transaction, and links the record transaction only when it is in a separate transaction (SPEC §10.4)", async () => {
    stubFetch();
    const c = juryCase();
    const ballot = { status: "revealed", vote: "AuditorWins", record_hash: hash(RECORD) };
    c.jury!.ballots = [
      { ...ballot, agent_id: JUROR_A, revealed: { tx: TX.revealA }, record_status: "reveal", record: { tx: TX.revealA } },
      { ...ballot, agent_id: JUROR_B, revealed: { tx: "3b".repeat(32) }, record_status: "separate", record: { tx: TX.revealA } },
      { ...ballot, agent_id: "b3".repeat(32), revealed: { tx: "3c".repeat(32) }, record_status: "missing", record: null },
    ];
    await renderCard(c);
    const [inReveal, separate, missing] = screen.getAllByTestId("jury-ballot") as [HTMLElement, HTMLElement, HTMLElement];
    // The record is in the reveal: the ballot links the reveal only.
    expect(inReveal.querySelector("details")).not.toBeNull();
    expect(txLinksOf(inReveal)).toEqual([txUrl(TX.revealA)]);
    // The record is in a separate transaction: the ballot links the reveal and then the record.
    expect(separate.querySelector("details")).not.toBeNull();
    expect(txLinksOf(separate)).toEqual([txUrl("3b".repeat(32)), txUrl(TX.revealA)]);
    // The reveal does not carry or name a record: nothing to open.
    expect(missing.querySelector("details")).toBeNull();
    expect(txLinksOf(missing)).toEqual([txUrl("3c".repeat(32))]);
  });

  it("opens a juror record: reads the reveal transaction only then", async () => {
    const fetchSpy = stubFetch();
    await renderCard(juryCase());
    const recordUrl = `/v1/indexer/documents/${TX.revealA}`;
    expect(fetchSpy).not.toHaveBeenCalledWith(recordUrl, expect.anything());
    const record = await openFirstRecord();
    expect(fetchSpy).toHaveBeenCalledWith(recordUrl, expect.anything());
    // The data of the record (SPEC §10.4): the model, the reason of the vote, the output and the receipt.
    expect(record).toHaveTextContent(MODEL);
    expect(record).toHaveTextContent(REASON);
    expect(record).toHaveTextContent(OUTPUT_PARTS.join(""));
    expect(record).toHaveTextContent("prompt_tokens");
    expect(hrefsOf(record)).toContain(`/agents/${SUPPLIER}`);
  });

  it("reads a document that this site hosts same-origin, and requests no document that is hosted elsewhere", async () => {
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
    expect(urlsOf(fetchSpy)).toEqual(["/evidence/c1.json"]);
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
    expect(urlsOf(fetchSpy)).toEqual([`/v1/evidence/by-hash/${"ab".repeat(32)}`]);
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
    expect(row).toHaveTextContent("250.000000 AP3X");
    expect(row).toHaveTextContent("2026-11-12 10:00 UTC");
    expect(urls).toContain(`/v1/indexer/jury/jurors?agent_id=${JUROR_A}`);
    await settle();
  });
});

// ─── Record response shapes and resolution documents ────────────────────────────

const REVEAL_CUT = "3b".repeat(32);
const CUT_TEXT = "The two signatures do";
const CUT_RECORD = JSON.stringify({
  type: "vector-jury-record/1",
  model: { supplier: `did:vector:${SUPPLIER}`, model: MODEL, escrow: `${"ab".repeat(32)}#0`, receipt_signature: "ff".repeat(64) },
  response: { cut: true, output_text: CUT_TEXT },
  vote: "AuditorWins",
  reason: "The response was cut.",
});
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
  toggleCard(ballot.querySelector("details")!, true);
  return within(ballot).findByTestId("juror-record");
}

describe("<DisputeCaseCard /> — record response shapes and resolution documents", () => {
  it("shows the output_text parts of the message items in order, and no other item", async () => {
    stubFetch();
    await renderCard(juryCase());
    const record = await openFirstRecord();
    expect(record).toHaveTextContent(OUTPUT_PARTS.join(""));
    expect(record).not.toHaveTextContent(HIDDEN_TEXT);
  });

  it("shows the text of a cut response", async () => {
    ON_CHAIN[REVEAL_CUT] = CUT_RECORD;
    stubFetch();
    await renderCard(oneBallotCase(REVEAL_CUT, hash(CUT_RECORD)));
    const record = await openFirstRecord();
    expect(record).toHaveTextContent(CUT_TEXT);
  });

  it.each([
    ["with", TX.resolve, RESOLUTION, [TX.open, TX.fin]],
    ["without", NO_RESULT_TX, NO_RESULT_DOC, [TX.open]],
  ] as const)("a resolution document %s a Finalize transaction links the transactions of its jury case", async (_with, tx, doc, linked) => {
    ON_CHAIN[tx] = doc;
    stubFetch();
    await renderCard(resolvedCase(tx, doc));
    expect(hrefsOf(screen.getByTestId("resolution-document"))).toEqual(linked.map(txUrl));
  });
});

// ─── The card body mounts only while the card is open ───────────────────────────

describe("<DisputeCaseCard /> — the body mounts only while the card is open", () => {
  it("a collapsed resolved card shows its summary and makes no request until it is opened", async () => {
    const fetchSpy = stubFetch();
    render(<DisputeCaseCard c={juryCase()} names={{}} />);
    const card = screen.getByTestId("dispute-case") as HTMLDetailsElement;
    expect(card.open).toBe(false);
    // The data of the case: the claim type, the two DIDs, the time, the status and the outcome.
    for (const value of ["certification", "did:vector:a1a1…a1a1", "did:vector:a2a2…a2a2", "2026-11-09 10:00 UTC", "resolved", "AuditorWins"]) {
      expect(card).toHaveTextContent(value);
    }
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("jury-section")).toBeNull();

    toggleCard(card, true);
    expect(await screen.findByTestId("resolution-document")).toBeInTheDocument();
    await settle();
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
    const card = screen.getByTestId("dispute-case") as HTMLDetailsElement;
    expect(card.open).toBe(true);
    expect(urlsOf(fetchSpy).sort()).toEqual([TX.claimDoc, TX.evidenceDoc].map((tx) => `/v1/indexer/documents/${tx}`).sort());
    await settle();
    // The statement of the claim document: data from the indexer.
    expect(card).toHaveTextContent(CLAIM_STATEMENT);
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
  it("asks for the newest 25 cases, and a click on the show-more button asks for 25 more, until all the cases show", async () => {
    const fetchSpy = stubIndexer(30);
    renderPage();
    // Before the cases load, the page has the lookup button only.
    const lookupButtons = screen.getAllByRole("button").length;
    await waitFor(() => expect(screen.getAllByTestId("dispute-case")).toHaveLength(25));
    expect(urlsOf(fetchSpy)).toContain("/v1/indexer/disputes?limit=25");
    expect(screen.getAllByRole("button")).toHaveLength(lookupButtons + 1);

    // The show-more button comes after the cases.
    fireEvent.click(screen.getAllByRole("button").at(-1)!);
    await waitFor(() => expect(screen.getAllByTestId("dispute-case")).toHaveLength(30));
    expect(urlsOf(fetchSpy)).toContain("/v1/indexer/disputes?limit=50");
    expect(screen.getAllByRole("button")).toHaveLength(lookupButtons);
  });

  const noButtonRows: Array<[string, number, { older?: boolean }]> = [
    ["the indexer sends no total", 30, { older: true }],
    ["all the cases are in the page", 10, {}],
  ];
  it.each(noButtonRows)("shows no show-more button when %s", async (_why, available, options) => {
    const fetchSpy = stubIndexer(available, options);
    renderPage();
    const lookupButtons = screen.getAllByRole("button").length;
    await waitFor(() => expect(screen.getAllByTestId("dispute-case")).toHaveLength(available));
    expect(urlsOf(fetchSpy)).toContain("/v1/indexer/disputes?limit=25");
    expect(screen.getAllByRole("button")).toHaveLength(lookupButtons);
  });

  it("keeps the limit when the page refreshes", async () => {
    // Only the interval timers are fake. The page loads over promises, so `settle` flushes each load.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fetchSpy = stubIndexer(30);
    renderPage();
    await settle();
    expect(screen.getAllByTestId("dispute-case")).toHaveLength(25);
    // The show-more button is the last button of the page.
    fireEvent.click(screen.getAllByRole("button").at(-1)!);
    await settle();
    expect(screen.getAllByTestId("dispute-case")).toHaveLength(30);
    const before = urlsOf(fetchSpy).length;

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    const refreshes = urlsOf(fetchSpy).slice(before).filter((url) => url.startsWith("/v1/indexer/disputes?"));
    expect(refreshes.length).toBeGreaterThan(0);
    expect(new Set(refreshes)).toEqual(new Set(["/v1/indexer/disputes?limit=50"]));
    expect(screen.getAllByTestId("dispute-case")).toHaveLength(30);
  });

  it("makes no document request for the collapsed cards, and shows the identity names of the shown cases", async () => {
    const fetchSpy = stubIndexer(25);
    renderPage();
    await waitFor(() => {
      const cards = screen.getAllByTestId("dispute-case");
      expect(cards).toHaveLength(25);
      for (const card of cards) expect(card).toHaveTextContent("Claimer One");
    });
    expect(screen.getAllByTestId("dispute-case").every((card) => !(card as HTMLDetailsElement).open)).toBe(true);
    expect(urlsOf(fetchSpy).sort()).toEqual(["/v1/identity/summaries?ids=" + CLAIMER, "/v1/indexer/disputes?limit=25"].sort());

    toggleCard(screen.getAllByTestId("dispute-case")[3]!, true);
    expect(await screen.findByTestId("resolution-document")).toBeInTheDocument();
    const documents = urlsOf(fetchSpy).filter((url) => url.startsWith("/v1/indexer/documents/")).sort();
    expect(documents).toEqual([TX.claimDoc, TX.resolve].map((tx) => `/v1/indexer/documents/${tx}`).sort());
  });
});

describe("<AgentIdentity /> — disputes of the agent", () => {
  it("asks for all the cases of the agent (no limit); the cards are collapsed", async () => {
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
  });
});
