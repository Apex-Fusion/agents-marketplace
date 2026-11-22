/**
 * supplier-chat-deadline-live.test.ts — the deadline check of the chat route with a live chain (M1-F-time-cleanup)
 *
 * With a LiveOgmiosProvider the route takes `now` from the wall clock (Date.now()). With any other provider it takes `now` from
 * the tip slot (mockSlotToWallclockMs). The mock clock is covered by supplier-routes-chat.test.ts: its happy path accepts a deadline
 * that the wall clock has passed.
 *
 * The tip slot of the live chain is 1,000: its tip clock is 1,000,000 ms, far below the wall clock. A deadline between the two is
 * the discriminating value. A route that read the tip clock would see no expiry. Fake timers fix the wall clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { SupplierState } from "../../supplier/src/state.js";
import { chainWith, makeApp, postChat } from "../fixtures/supplier-side/chat-harness.js";
import { buildOpenEscrowUtxo } from "../fixtures/supplier-side/sample-escrow-state.js";

const FAKE_NOW = new Date("2026-04-28T12:00:00Z");
const NOW_MS = FAKE_NOW.getTime();

/** The open sample escrow with another deliver_by. */
function escrowDueAt(deliverBy: number): Utxo {
  const open = buildOpenEscrowUtxo();
  return { ...open, datumHex: encodeEscrowDatum({ ...decodeEscrowDatum(open.datumHex!), deliver_by: deliverBy }) };
}

/** A live chain that reads its tip (slot 1,000), the advert and `escrow` from a stand-in chain, and has no network. */
function liveChainWith(escrow: Utxo): LiveOgmiosProvider {
  const standIn = chainWith(escrow);
  const live = new LiveOgmiosProvider({
    ogmiosUrl: "http://ogmios.invalid:1337",
    fetch: async () => { throw new Error("no network in this test"); },
  });
  vi.spyOn(live, "tip").mockImplementation(() => standIn.tip());
  vi.spyOn(live, "queryUtxo").mockImplementation((ref) => standIn.queryUtxo(ref));
  return live;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /v1/responses with a live chain", () => {
  it("takes `now` from the wall clock: a deadline after the tip clock and before the wall clock is past", async () => {
    const { app } = makeApp(liveChainWith(escrowDueAt(NOW_MS - 1_000)));

    const res = await postChat(app);

    expect(res.status).toBe(408);
    expect(res.body.reason).toBe("past_deliver_by");
    // The message names the wall clock (1.7e12 ms), not the tip clock (1e6 ms).
    expect(res.body.message).toBe(`now ${NOW_MS} >= deliver_by ${NOW_MS - 1_000}`);
  });

  it("does not refuse a deadline after the wall clock: the request reaches the next check, supplier_busy", async () => {
    const state = new SupplierState();
    state.tryAcquire(`${"e".repeat(64)}#0`);
    const { app } = makeApp(liveChainWith(escrowDueAt(NOW_MS + 300_000)), { state });

    const res = await postChat(app);

    // supplier_busy comes right after the deadline check, so the deadline did not refuse the request.
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("supplier_busy");
  });
});
