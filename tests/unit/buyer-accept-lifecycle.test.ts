/**
 * buyer-accept-lifecycle.test.ts — the escrow output that POST /v1/accept accepts.
 *
 * Covers buyer/src/server.ts:1179-1207 (the direct hit and the lifecycle lookup) and :1248-1251 (the 200 answer).
 *
 * A lifecycle keeps its posted_at through Open, Claimed and Submitted. The caller usually holds the Open ref that submitPrompt
 * returned, and that output is spent by now. So the route reads the rows of the buyer, takes the posted_at of the row that the
 * caller named, and accepts the Submitted row with the same posted_at. A Submitted row of ANOTHER lifecycle of the same buyer is
 * another job. Accepting it pays a supplier for work that the caller did not name.
 *
 * Each case runs the real route over a MockChainProvider and a stub indexer. The mock chain holds the Submitted outputs that the
 * indexer lists (the Open output of a lifecycle is spent). The Accept that the route submits shows the output that it spends.
 * The escrows use the legacy datum layout. The lookup does not read the layout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, type IndexerEscrowRow } from "../../buyer/src/server.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

const TIP_SLOT = 1_745_500_000;
const NOW_MS = TIP_SLOT * 1000; // the mock chain reads a slot as slot * 1000 ms
const INDEXER = "http://indexer.test";
const ESCROW_ADDRESS = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";
const buyer = buildBuyerWalletKey();

/** An escrow output that the indexer lists for the buyer. */
interface Listed {
  ref: OutputReference;
  state: EscrowDatum["state"];
  postedAt: number;
}

const refText = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;
const outputRef = (byte: string): OutputReference => ({ txHash: byte.repeat(32), index: 0 });

// Lifecycle A is the one that the caller names. Lifecycle B is another job of the same buyer.
const POSTED_A = NOW_MS - 60_000;
const POSTED_B = NOW_MS - 120_000;
const OPEN_A: Listed = { ref: outputRef("a1"), state: "Open", postedAt: POSTED_A };
const SUBMITTED_A: Listed = { ref: outputRef("a2"), state: "Submitted", postedAt: POSTED_A };
const SUBMITTED_B: Listed = { ref: outputRef("b2"), state: "Submitted", postedAt: POSTED_B };

function escrowDatum({ state, postedAt }: Listed): EscrowDatum {
  const submitted = state === "Submitted";
  return {
    buyer_pkh: buyer.pubKeyHash,
    supplier_pkh: "ab".repeat(28),
    advert_ref: { txHash: "b".repeat(64), index: 0 },
    capability_id: "llm.text.generate.v1",
    request_spec_hash: "c".repeat(64),
    prompt_hash: "d".repeat(64),
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: NOW_MS + 60_000,
    posted_at: postedAt,
    submitted_at: submitted ? NOW_MS - 5_000 : null,
    result_receipt_hash: submitted ? "e".repeat(64) : null,
    state,
  };
}

function indexerRow(listed: Listed): IndexerEscrowRow {
  const datum = escrowDatum(listed);
  return {
    utxo_ref: refText(listed.ref),
    buyer_pkh: datum.buyer_pkh,
    supplier_pkh: datum.supplier_pkh,
    state: datum.state,
    posted_at: datum.posted_at,
    submitted_at: datum.submitted_at,
    result_receipt_hash: datum.result_receipt_hash,
    capability_id: datum.capability_id,
    prompt_hash: datum.prompt_hash,
    payment_lovelace: datum.payment_lovelace.toString(),
    buyer_bond_lovelace: datum.buyer_bond_lovelace.toString(),
    supplier_bond_lovelace: datum.supplier_bond_lovelace.toString(),
    deliver_by: datum.deliver_by,
    created_slot: 1,
  };
}

/** The route, with the escrows of the buyer in the order of `listed`. */
function acceptApp(listed: Listed[]) {
  const chain = new MockChainProvider();
  chain.advanceSlot(TIP_SLOT);
  for (const escrow of listed) {
    if (escrow.state !== "Submitted") continue;
    chain.seed({
      ref: escrow.ref, address: ESCROW_ADDRESS, lovelace: 4_000_000n, assets: {},
      datumHex: encodeEscrowDatum(escrowDatum(escrow)), scriptRef: null,
    });
  }
  const rows = listed.map(indexerRow);
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
    String(url) === `${INDEXER}/escrows?buyer=${buyer.pubKeyHash}`
      ? Response.json(rows)
      : Response.json({ error: "unexpected request" }, { status: 500 }));
  const app = createApp({ chain, walletKey: buyer, indexerUrl: INDEXER, fetchImpl });
  return { app, submit: vi.spyOn(chain, "submitTx") };
}

/** The part of a mock-chain transaction that these tests read. The mock chain reads a transaction as 4 bytes of length, then JSON. */
interface MockTxBody {
  inputs: OutputReference[];
}

/** The outputs that a submitted transaction spends. */
function spentOutputs(txHex: string): OutputReference[] {
  const json = Buffer.from(txHex.slice(8, 8 + 2 * parseInt(txHex.slice(0, 8), 16)), "hex").toString("utf8");
  const body: MockTxBody = JSON.parse(json);
  return body.inputs;
}

beforeEach(() => {
  // The route writes "[accept] accepting escrow" to stderr.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const accepts: Array<[name: string, given: Listed, listed: Listed[]]> = [
  ["the given ref is the Submitted row (control)", SUBMITTED_A, [OPEN_A, SUBMITTED_A]],
  ["the given ref is the Open row of the lifecycle", OPEN_A, [OPEN_A, SUBMITTED_A]],
  [
    "the given ref is the Open row and a Submitted row of another lifecycle is listed first",
    OPEN_A,
    [SUBMITTED_B, OPEN_A, SUBMITTED_A],
  ],
];

const refuses: Array<[name: string, status: number, error: string, given: Listed, listed: Listed[]]> = [
  ["the given ref is in no row of the buyer", 404, "escrow_not_found", OPEN_A, [SUBMITTED_B]],
  ["the lifecycle has no Submitted row", 409, "no_submitted_state", OPEN_A, [OPEN_A]],
  ["only another lifecycle has a Submitted row and it is listed first", 409, "no_submitted_state", OPEN_A, [SUBMITTED_B, OPEN_A]],
];

describe("POST /v1/accept", () => {
  it.each(accepts)("accepts the Submitted output of the lifecycle: %s", async (_name, given, listed) => {
    const { app, submit } = acceptApp(listed);

    const res = await request(app).post("/v1/accept").send({ escrow_ref: refText(given.ref) });

    expect(res.status).toBe(200);
    expect(res.body.accepted_ref).toBe(refText(SUBMITTED_A.ref));
    expect(res.body.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(submit).toHaveBeenCalledOnce();
    expect(spentOutputs(submit.mock.calls[0]![0])).toEqual([SUBMITTED_A.ref]);
  });

  it.each(refuses)("sends no transaction when %s: answers %i %s", async (_name, status, error, given, listed) => {
    const { app, submit } = acceptApp(listed);

    const res = await request(app).post("/v1/accept").send({ escrow_ref: refText(given.ref) });

    expect(res.status).toBe(status);
    expect(res.body.error).toBe(error);
    expect(submit).not.toHaveBeenCalled();
  });
});
