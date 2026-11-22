/**
 * buyer-accept-find-submitted.test.ts — findSubmittedEscrowRef of the accept flow.
 *
 * Covers buyer/src/cli/acceptFlow.ts:105-135. submitPrompt returns the Open ref, and Claim and Submit have spent it. The function
 * polls GET <indexer>/escrows?buyer=<pkh> with the global fetch until the indexer lists a Submitted row with the prompt hash. It
 * returns the parsed utxo_ref of the newest such row, and throws when the timeout is over.
 *
 * The function waits delay(2_000) between two polls. These tests replace node:timers/promises by a delay that moves a fake clock
 * (the global Date) and does not wait. No test waits for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TimersPromises from "node:timers/promises";
import { findSubmittedEscrowRef } from "../../buyer/src/cli/acceptFlow.js";

/** The waits that the function asks for, in ms. */
const waits = vi.hoisted(() => ({ ms: [] as number[] }));

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: async (ms: number): Promise<void> => {
    waits.ms.push(ms);
    vi.advanceTimersByTime(ms);
  },
}));

const INDEXER = "http://indexer.test";
const BUYER_PKH = "f79cd20a58306c2277cfced6924befbd0f68c95e2187830d707b20b5";
const PROMPT_HASH = "c3".repeat(32);
const OTHER_PROMPT_HASH = "d4".repeat(32);
const TIMEOUT_MS = 10_000;

/** The fields of an indexer escrow row that the function reads. */
interface Row {
  utxo_ref: string;
  prompt_hash: string;
  state: string;
  submitted_at: number | null;
}

const refText = (byte: string, index: number): string => `${byte.repeat(32)}#${index}`;
const outputRef = (byte: string, index: number) => ({ txHash: byte.repeat(32), index });

/** A Submitted row of the prompt hash. `changes` replaces fields. */
const row = (utxoRef: string, changes: Partial<Row> = {}): Row => ({
  utxo_ref: utxoRef, prompt_hash: PROMPT_HASH, state: "Submitted", submitted_at: 1_000, ...changes,
});

type Answer = () => Response;
const listing = (rows: Row[]): Answer => () => Response.json(rows);

/** Stubs the global fetch. Poll n gets answer n. Each poll after the last answer gets the last answer. */
function serve(...answers: Answer[]) {
  let polls = 0;
  const fetchStub = vi.fn(async (_url: string) => {
    // A function that never stops polling must fail the test, and not hang it.
    if (polls >= 50) throw new Error("the function polls without end");
    return answers[Math.min(polls++, answers.length - 1)]!();
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

const find = (indexerUrl = INDEXER) => findSubmittedEscrowRef(indexerUrl, BUYER_PKH, PROMPT_HASH, TIMEOUT_MS);

beforeEach(() => {
  waits.ms.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("findSubmittedEscrowRef", () => {
  it("returns the ref of the Submitted row at once, with the output index as a number (control)", async () => {
    const fetchStub = serve(listing([row(refText("a1", 3))]));

    expect(await find()).toEqual(outputRef("a1", 3));

    expect(fetchStub).toHaveBeenCalledOnce();
    expect(waits.ms).toEqual([]);
  });

  it("takes the newest of several Submitted rows of the prompt hash", async () => {
    // The newest row is in the middle: a first, a last or an oldest-first pick gives another ref.
    serve(listing([
      row(refText("a1", 0), { submitted_at: 2_000 }),
      row(refText("a2", 0), { submitted_at: 3_000 }),
      row(refText("a3", 0), { submitted_at: 1_000 }),
    ]));

    expect(await find()).toEqual(outputRef("a2", 0));
  });

  it("skips a Submitted row of another prompt hash, even when it is newer", async () => {
    serve(listing([
      row(refText("b1", 0), { prompt_hash: OTHER_PROMPT_HASH, submitted_at: 9_000 }),
      row(refText("a1", 0), { submitted_at: 1_000 }),
    ]));

    expect(await find()).toEqual(outputRef("a1", 0));
  });

  const retries: Array<[name: string, first: Answer]> = [
    ["an error status of the indexer", () => Response.json({ error: "unavailable" }, { status: 503 })],
    ["a row of the prompt hash that is still Open", listing([row(refText("a0", 0), { state: "Open", submitted_at: null })])],
    ["a row of the prompt hash with a utxo_ref that is no ref", listing([row("not-a-ref")])],
  ];

  it.each(retries)("waits once and polls again after %s", async (_name, first) => {
    const fetchStub = serve(first, listing([row(refText("a1", 0))]));

    expect(await find()).toEqual(outputRef("a1", 0));

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(waits.ms).toHaveLength(1);
  });

  it("throws when the timeout is over, with an error that names the prompt hash and the timeout", async () => {
    const fetchStub = serve(listing([]));
    const start = Date.now();

    await expect(find()).rejects.toThrow(`no Submitted escrow with prompt_hash=${PROMPT_HASH} within ${TIMEOUT_MS}ms`);

    expect(Date.now() - start).toBeGreaterThanOrEqual(TIMEOUT_MS);
    expect(fetchStub.mock.calls.length).toBeGreaterThan(1);
  });

  it.each(["http://indexer.test", "http://indexer.test/", "http://indexer.test///"])(
    "asks the indexer at %s with no trailing slash before the path",
    async (indexerUrl) => {
      const fetchStub = serve(listing([row(refText("a1", 0))]));

      await find(indexerUrl);

      expect(fetchStub.mock.calls).toEqual([[`http://indexer.test/escrows?buyer=${BUYER_PKH}`]]);
    },
  );
});
