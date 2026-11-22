/**
 * tests/unit/indexer-routes.test.ts — the REST routes of the indexer through supertest, on a stub cache that filters nothing (a case checks what the route adds).
 * Ties to a live incident: the indexer stopped at slot 36,987,164 while the chain went on (the healthz lag cases).
 */

import { describe, it, expect } from "vitest";
import request from "supertest";

import { createApp } from "../../indexer/src/server.js";
import { MAX_TIP_AGE_MS } from "../../indexer/src/routes/healthz.js";
import { AmbiguousEscrowLineageError, type EscrowLineage } from "../../indexer/src/db/cache.js";
import { makeIndexerDeps } from "./__helpers__/fakeIndexerDeps.js";
import { makeAdvertRow, makeEscrowRow } from "../fixtures/indexer-side/rows.js";
import {
  INDEXER_SUPPLIER_PKH,
  INDEXER_BUYER_PKH,
  INDEXER_SUPPLIER_ENDPOINT,
  SAMPLE_DELIVER_BY,
  SAMPLE_POSTED_AT,
} from "../fixtures/indexer-side/sample-blocks.js";

const ADVERT_REF = `${"a".repeat(64)}#0`;
const ESCROW_REF = `${"c".repeat(64)}#0`;

// ─── GET /healthz ─────────────────────────────────────────────────────────────
// SPEC FIX 2026-04-27: the path is /healthz (it was /health).

describe("GET /healthz", () => {
  it("returns 200 with the full health body", async () => {
    const app = createApp(makeIndexerDeps({}));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      sync_slot: 1_000_000,
      tip_slot: 1_000_500,
      ogmios_status: "connected",
      db_size_bytes: 4096,
      lag_slots: 500,
      max_sync_lag_slots: 600,
      tip_age_ms: 1_000,
      follower: "following",
      error: null,
    });
  });

  it("health lag: ok is false when the indexer is more than MAX_SYNC_LAG_SLOTS behind the tip", async () => {
    const behind = (lag: number) => makeIndexerDeps({ health: { syncSlot: 36_987_164, tip: { slot: 36_987_164 + lag, id: "f".repeat(64) } } });
    const atLimit = await request(createApp(behind(600))).get("/healthz");
    expect(atLimit.body).toMatchObject({ ok: true, lag_slots: 600, max_sync_lag_slots: 600 });
    const over = await request(createApp(behind(601))).get("/healthz");
    expect(over.status).toBe(200);
    expect(over.body).toMatchObject({ ok: false, lag_slots: 601, sync_slot: 36_987_164, tip_slot: 36_987_765 });
    // The live incident: the indexer stopped at 36,987,164 while the chain went on.
    const stuck = await request(createApp(behind(193_485))).get("/healthz");
    expect(stuck.body).toMatchObject({ ok: false, lag_slots: 193_485 });
  });

  it("health lag: MAX_SYNC_LAG_SLOTS sets the limit", async () => {
    const deps = makeIndexerDeps({ health: { syncSlot: 1_000, tip: { slot: 1_100, id: "f".repeat(64) } } });
    expect((await request(createApp(deps, { maxSyncLagSlots: 99 })).get("/healthz")).body)
      .toMatchObject({ ok: false, lag_slots: 100, max_sync_lag_slots: 99 });
    expect((await request(createApp(deps, { maxSyncLagSlots: 100 })).get("/healthz")).body)
      .toMatchObject({ ok: true, lag_slots: 100, max_sync_lag_slots: 100 });
  });

  it("ok is false when the follower failed, even with no lag", async () => {
    const app = createApp(makeIndexerDeps({
      health: { state: "no_intersection", syncSlot: 1_000_500, error: "no intersection: ... RESYNC_FROM_SLOT ..." },
    }));
    const res = await request(app).get("/healthz");
    expect(res.body).toMatchObject({
      ok: false, lag_slots: 0, follower: "no_intersection", error: "no intersection: ... RESYNC_FROM_SLOT ...",
    });
  });

  it("ok is false before the first tip report, before the first intersection, and with an old tip", async () => {
    const noTip = await request(createApp(makeIndexerDeps({ health: { tip: null, tipAgeMs: null } }))).get("/healthz");
    expect(noTip.body).toMatchObject({ ok: false, tip_slot: 0, lag_slots: null, tip_age_ms: null });
    const starting = await request(createApp(makeIndexerDeps({ health: { state: "starting" } }))).get("/healthz");
    expect(starting.body).toMatchObject({ ok: false, follower: "starting" });
    const old = await request(createApp(makeIndexerDeps({ health: { tipAgeMs: MAX_TIP_AGE_MS + 1 } }))).get("/healthz");
    expect(old.body).toMatchObject({ ok: false, lag_slots: 500 });
  });

  it("ogmios_status follows the chain-sync connection", async () => {
    const res = await request(createApp(makeIndexerDeps({ health: { connected: false } }))).get("/healthz");
    expect(res.body.ogmios_status).toBe("disconnected");
  });
});

// ─── GET /suppliers, GET /suppliers/:pkh ──────────────────────────────────────

describe("GET /suppliers", () => {
  it("maps each advert and its supplier_status to a supplier view; a supplier that was never polled has status unknown", async () => {
    const unpolled = "11".repeat(28);
    const deps = makeIndexerDeps({
      adverts: [
        makeAdvertRow({ utxo_ref: ADVERT_REF }),
        makeAdvertRow({ utxo_ref: `${"b".repeat(64)}#0`, supplier_pkh: unpolled }),
      ],
      statuses: {
        [INDEXER_SUPPLIER_PKH]: { status: "working", current_escrow_ref: ESCROW_REF, last_seen_iso: "2026-04-24T11:30:00.000Z" },
        [unpolled]: null,
      },
    });
    const res = await request(createApp(deps)).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject([
      {
        utxo_ref: ADVERT_REF,
        supplier_pkh: INDEXER_SUPPLIER_PKH,
        capability_id: "llm.text.generate.v1",
        price_lovelace: "2000000",
        endpoint_url: INDEXER_SUPPLIER_ENDPOINT,
        advert_status: "Active",
        status: "working",
        current_escrow_ref: ESCROW_REF,
        last_seen_iso: "2026-04-24T11:30:00.000Z",
      },
      { supplier_pkh: unpolled, status: "unknown", current_escrow_ref: null, last_seen_iso: null },
    ]);
  });
});

describe("GET /suppliers/:pkh", () => {
  it("returns the supplier view of the listed advert", async () => {
    const res = await request(createApp(makeIndexerDeps({}))).get(`/suppliers/${INDEXER_SUPPLIER_PKH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ supplier_pkh: INDEXER_SUPPLIER_PKH, endpoint_url: INDEXER_SUPPLIER_ENDPOINT, status: "free" });
  });

  it("returns 404 when no advert is listed for the pkh", async () => {
    const res = await request(createApp(makeIndexerDeps({ adverts: [] }))).get(`/suppliers/${INDEXER_SUPPLIER_PKH}`);
    expect(res.status).toBe(404);
  });
});

// ─── GET /capabilities, GET /capabilities/:id/suppliers ───────────────────────

describe("GET /capabilities", () => {
  it("counts the listed adverts of each capability", async () => {
    const adverts = [
      makeAdvertRow({ utxo_ref: `${"a".repeat(64)}#0`, capability_id: "llm.text.generate.v1" }),
      makeAdvertRow({ utxo_ref: `${"b".repeat(64)}#0`, capability_id: "llm.text.generate.v1" }),
      makeAdvertRow({ utxo_ref: `${"c".repeat(64)}#0`, capability_id: "speech.transcribe.v1" }),
    ];
    const res = await request(createApp(makeIndexerDeps({ adverts }))).get("/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { capability_id: "llm.text.generate.v1", supplier_count: 2 },
      { capability_id: "speech.transcribe.v1", supplier_count: 1 },
    ]);
  });
});

describe("GET /capabilities/:id/suppliers", () => {
  // The route sorts the views itself. The stub cache gives the adverts in the order S1, S2, S3, S4. S3 and S4 were never polled.
  const pkh = { S1: "11".repeat(28), S2: "22".repeat(28), S3: "33".repeat(28), S4: "44".repeat(28) };
  const deps = () => makeIndexerDeps({
    adverts: [
      makeAdvertRow({ utxo_ref: `${"a".repeat(64)}#0`, supplier_pkh: pkh.S1, price_lovelace: "3000000" }),
      makeAdvertRow({ utxo_ref: `${"b".repeat(64)}#0`, supplier_pkh: pkh.S2, price_lovelace: "1000000" }),
      makeAdvertRow({ utxo_ref: `${"c".repeat(64)}#0`, supplier_pkh: pkh.S3, price_lovelace: "2000000" }),
      makeAdvertRow({ utxo_ref: `${"d".repeat(64)}#0`, supplier_pkh: pkh.S4, price_lovelace: "4000000" }),
    ],
    statuses: {
      [pkh.S1]: { last_seen_iso: "2026-04-24T10:00:00.000Z" },
      [pkh.S2]: { last_seen_iso: "2026-04-24T11:00:00.000Z" },
      [pkh.S3]: null,
      [pkh.S4]: null,
    },
  });

  it.each([
    ["no ?sort keeps the order of the cache", "", ["S1", "S2", "S3", "S4"]],
    ["?sort=price lists the cheapest supplier first", "?sort=price", ["S2", "S3", "S1", "S4"]],
    ["?sort=last_seen lists the supplier that was seen last first, and the suppliers never seen after the others", "?sort=last_seen", ["S2", "S1", "S3", "S4"]],
  ] as const)("%s", async (_title, query, order) => {
    const res = await request(createApp(deps())).get(`/capabilities/llm.text.generate.v1/suppliers${query}`);
    expect(res.status).toBe(200);
    expect(res.body.map((s: { supplier_pkh: string }) => s.supplier_pkh)).toEqual(order.map((name) => pkh[name]));
  });
});

// ─── GET /escrows/:ref, GET /escrows/:ref/lineage, GET /escrows ───────────────

describe("GET /escrows/:ref", () => {
  it("maps the escrow row to the escrow view", async () => {
    const deps = makeIndexerDeps({ escrows: [makeEscrowRow({ utxo_ref: ESCROW_REF })] });
    const res = await request(createApp(deps)).get(`/escrows/${encodeURIComponent(ESCROW_REF)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      utxo_ref: ESCROW_REF,
      buyer_pkh: INDEXER_BUYER_PKH,
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      advert_ref: ADVERT_REF,
      payment_lovelace: "2000000",
      deliver_by: SAMPLE_DELIVER_BY,
      posted_at: SAMPLE_POSTED_AT,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Open",
      routable: true,
    });
  });

  it("returns 404 when escrow ref not found", async () => {
    const res = await request(createApp(makeIndexerDeps({ escrows: [] }))).get("/escrows/unknown%230");
    expect(res.status).toBe(404);
  });
});

describe("GET /escrows/:ref/lineage", () => {
  // The route builds an escrow view for each row and adds its spent_tx; the buyer and the gateway read spent_tx to check the chain of rows.
  it("gives each row as an escrow view with its spent_tx, and the observed terminal event", async () => {
    const originalRef = ESCROW_REF;
    const submittedRef = `${"d".repeat(64)}#1`;
    const terminalTx = "e".repeat(64);
    const lineage: EscrowLineage = {
      original_ref: originalRef,
      rows: [
        { ...makeEscrowRow({ utxo_ref: originalRef }), spent_tx: "d".repeat(64) },
        {
          ...makeEscrowRow({
            utxo_ref: submittedRef,
            state: "Submitted",
            submitted_at: SAMPLE_POSTED_AT + 1_000,
            result_receipt_hash: "f".repeat(64),
          }),
          spent_tx: terminalTx,
        },
      ],
      terminal: { type: "AcceptEscrow", tx_hash: terminalTx },
    };

    const res = await request(createApp(makeIndexerDeps({ lineage }))).get(`/escrows/${encodeURIComponent(originalRef)}/lineage`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      original_ref: originalRef,
      rows: [
        { utxo_ref: originalRef, state: "Open", advert_ref: ADVERT_REF, spent_tx: "d".repeat(64) },
        { utxo_ref: submittedRef, state: "Submitted", result_receipt_hash: "f".repeat(64), spent_tx: terminalTx },
      ],
    });
    expect(res.body.terminal).toEqual({ type: "AcceptEscrow", tx_hash: terminalTx });
  });

  it("returns 404 when the origin is not in the active indexed history", async () => {
    const res = await request(createApp(makeIndexerDeps({ lineage: null }))).get("/escrows/missing%230/lineage");
    expect(res.status).toBe(404);
  });

  it("returns 409 rather than choosing an ambiguous continuation", async () => {
    const deps = makeIndexerDeps({ lineageError: new AmbiguousEscrowLineageError("ambiguous#0") });
    const res = await request(createApp(deps)).get("/escrows/ambiguous%230/lineage");
    expect(res.status).toBe(409);
  });
});

describe("GET /escrows", () => {
  it("returns 400 when neither buyer nor supplier filter is provided", async () => {
    const res = await request(createApp(makeIndexerDeps({}))).get("/escrows");
    expect(res.status).toBe(400);
  });
});

// ─── Unknown routes ───────────────────────────────────────────────────────────

describe("createApp — unknown routes", () => {
  it("returns 404 for unknown path /nonexistent-path", async () => {
    const res = await request(createApp(makeIndexerDeps({}))).get("/nonexistent-path");
    expect(res.status).toBe(404);
  });
});
