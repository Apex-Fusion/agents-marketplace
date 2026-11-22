/**
 * supplier-routes-refusals.test.ts — the refusals before the Claim in the chat, TTS, OCR and chat-session routes.
 *
 * Each of the four routes checks the escrow in its own code. This file covers the pairs of route and refusal that no other file
 * reaches (`supplier-routes-chat.test.ts` covers the chat route, but not `escrow_decode_failed`), and the 408 deadline of TTS, OCR
 * and chat-session start. A refused request builds no Claim and leaves the slot as it was. A control for each route shows that the
 * same request with a good escrow is served, so that a broken harness cannot pass a table.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { mockSlotToWallclockMs } from "../../packages/shared/src/tx/internal/constants.js";
import type { TestTxBody } from "../../packages/shared/src/tx/internal/testTxBody.js";
import { recordSubmissions } from "../fixtures/supplier-side/identity.js";
import { POSTED_AT } from "../fixtures/supplier-side/sample-escrow-state.js";
import {
  advertUtxoOf, escrowUtxoOf, refString, ROUTE_KINDS, routeOf, serve, stubUpstreams, type Route, type RouteKind, type Served,
} from "../fixtures/supplier-side/route-kinds.js";

const ESCROW: OutputReference = { txHash: "e1".repeat(32), index: 0 };
/** The escrow of the job that holds the slot. */
const OTHER = refString({ txHash: "e2".repeat(32), index: 0 });

/** A supplier app over a stand-in chain, with the synthetic transactions that the chain received. */
interface World extends Served {
  route: Route;
  bodies: TestTxBody[];
}

/** The world of `kind` with the tip at slot `tip`, its advert, and the escrow that `escrow` builds. */
function world(kind: RouteKind, escrow: (route: Route) => Utxo, tip = 1_000): World {
  const route = routeOf(kind);
  const chain = new MockChainProvider();
  chain.advanceSlot(tip);
  chain.seed(advertUtxoOf(route));
  chain.seed(escrow(route));
  const bodies = recordSubmissions(chain);
  return { route, bodies, ...serve(route, chain) };
}

/** The request is refused with `status` and `reason`, no Claim is built, and the slot is free, or held by `held` only. */
async function expectRefused(w: World, status: number, reason: string, held: string[] = []): Promise<void> {
  const res = await request(w.app).post(w.route.path).set("X-Escrow-Ref", refString(ESCROW)).send(w.route.body);
  expect(res.status).toBe(status);
  expect(res.body.reason).toBe(reason);
  expect(w.bodies).toEqual([]);
  expect(w.state.snapshot()).toMatchObject({ status: held.length === 0 ? "free" : "working", activeEscrowRefs: held });
}

/** The request is served: its Claim and Submit are the only transactions, and the slot is free again. */
async function expectServed(w: World): Promise<void> {
  const res = await request(w.app).post(w.route.path).set("X-Escrow-Ref", refString(ESCROW)).send(w.route.body);
  if (w.route.kind === "chat-session") {
    expect(res.status).toBe(200);
    expect((await request(w.app).post("/v1/chat/end").set("X-Escrow-Ref", refString(ESCROW)).send({})).status).toBe(200);
  } else {
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(w.jobs.get(res.body.job_id)?.status).toBe("done"), { interval: 5, timeout: 5_000 });
  }
  expect(w.bodies).toMatchObject([{ type: "claim", inputs: [ESCROW] }, { type: "submit" }]);
  expect(w.state.snapshot().status).toBe("free");
}

beforeEach(() => stubUpstreams());
afterEach(() => { vi.unstubAllGlobals(); });

describe("refusals between the header check and the Claim", () => {
  /** For each reason: the answer, the escrow that triggers it, and the escrows of the jobs that hold the slot before the request. */
  const BRANCHES: Record<string, { status: number; escrow: (route: Route) => Utxo; held?: string[] }> = {
    escrow_decode_failed: { status: 404, escrow: (route) => ({ ...escrowUtxoOf(route, ESCROW), datumHex: "deadbeef" }) },
    escrow_not_claimable: { status: 409, escrow: (route) => escrowUtxoOf(route, ESCROW, { state: "Claimed" }) },
    wrong_supplier: { status: 403, escrow: (route) => escrowUtxoOf(route, ESCROW, { supplier_pkh: "9".repeat(56) }) },
    capability_mismatch: { status: 409, escrow: (route) => escrowUtxoOf(route, ESCROW, { capability_id: "speech.transcribe.v1" }) },
    request_spec_mismatch: { status: 409, escrow: (route) => escrowUtxoOf(route, ESCROW, { request_spec_hash: "0".repeat(64) }) },
    prompt_mismatch: { status: 409, escrow: (route) => escrowUtxoOf(route, ESCROW, { prompt_hash: "1".repeat(64) }) },
    supplier_busy: { status: 409, escrow: (route) => escrowUtxoOf(route, ESCROW), held: [OTHER] },
  };
  /**
   * The branches of each route that no other test reaches. `supplier-routes-chat.test.ts` reaches all of them for the chat route
   * but `escrow_decode_failed`. `supplier-chat-session-ticket.test.ts` reaches `wrong_supplier` and `supplier_busy` for the chat
   * session, and `supplier-withheld-datum.test.ts` reaches `escrow_not_found` for all four routes.
   */
  const UNTESTED: Record<RouteKind, string[]> = {
    chat: ["escrow_decode_failed"],
    tts: Object.keys(BRANCHES),
    ocr: Object.keys(BRANCHES),
    "chat-session": ["escrow_decode_failed", "escrow_not_claimable", "capability_mismatch", "request_spec_mismatch", "prompt_mismatch"],
  };

  it.each(ROUTE_KINDS.flatMap((kind) => UNTESTED[kind].map((reason) => [kind, reason] as const)))(
    "%s: refuses with %s, builds no Claim, and leaves the slot as it was",
    async (kind, reason) => {
      const { status, escrow, held = [] } = BRANCHES[reason];
      const w = world(kind, escrow);
      for (const ref of held) w.state.tryAcquire(ref);

      await expectRefused(w, status, reason, held);
    },
  );

  it.each(ROUTE_KINDS)("%s: serves the same request with a good escrow", (kind) => expectServed(world(kind, (route) => escrowUtxoOf(route, ESCROW))));
});

describe("the 408 deadline of TTS, OCR and chat-session start", () => {
  /** The tip is 100 s after the escrow was posted, so that the clock of the route is the tip time. */
  const TIP = POSTED_AT / 1000 + 100;
  /** The world whose tip time is `late` ms past `deliver_by`. */
  const lateBy = (kind: RouteKind, late: number) =>
    world(kind, (route) => escrowUtxoOf(route, ESCROW, { deliver_by: mockSlotToWallclockMs(TIP) - late }), TIP);
  const KINDS = ["tts", "ocr", "chat-session"] as const;

  it.each(KINDS.flatMap((kind) => [0, 1].map((late) => [kind, late] as const)))(
    "%s: refuses a tip time %d ms past deliver_by with 408 past_deliver_by",
    (kind, late) => expectRefused(lateBy(kind, late), 408, "past_deliver_by"),
  );

  it.each(KINDS)("%s: serves a tip time 1 ms before deliver_by", (kind) => expectServed(lateBy(kind, -1)));
});
