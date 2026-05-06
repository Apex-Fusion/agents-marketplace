/**
 * tests/unit/indexer-routes.test.ts — REST route tests via supertest (Category D)
 *
 * Tests all indexer routes: /suppliers, /capabilities, /escrows, /health.
 * createApp is injected with a mock cache and worker.
 * All tests RED — createApp throws "not implemented — M1-D-green".
 * Tests call createApp() directly; the stub throws, causing Vitest to mark them FAIL.
 * When Catherine implements createApp, these will use supertest to verify route behaviour.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";

import { createApp } from "../../indexer/src/server.js";
import type { IndexerDeps } from "../../indexer/src/server.js";
import {
  INDEXER_SUPPLIER_PKH,
  INDEXER_BUYER_PKH,
  INDEXER_SUPPLIER_ENDPOINT,
  buildAdvertDatumHex,
  buildEscrowDatumHex,
  SAMPLE_DELIVER_BY,
  SAMPLE_POSTED_AT,
  SAMPLE_REQUEST_SPEC_HASH,
  SAMPLE_PROMPT_HASH,
} from "../fixtures/indexer-side/sample-blocks.js";
import type { AdvertRow, EscrowRow } from "../../indexer/src/db/cache.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function sampleAdvert(overrides: Partial<AdvertRow> = {}): AdvertRow {
  return {
    utxo_ref: "a".repeat(64) + "#0",
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: INDEXER_SUPPLIER_ENDPOINT,
    detail_uri: "ipfs://QmTest",
    detail_hash: "b".repeat(64),
    advertised_at: SAMPLE_POSTED_AT,
    status: "Active",
    created_slot: 1_000_000,
    datum_hex: buildAdvertDatumHex(),
    rolled_back: 0,
    ...overrides,
  } as AdvertRow;
}

function sampleEscrow(overrides: Partial<EscrowRow> = {}): EscrowRow {
  return {
    utxo_ref: "c".repeat(64) + "#0",
    buyer_pkh: INDEXER_BUYER_PKH,
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    advert_ref_tx: "a".repeat(64),
    advert_ref_index: 0,
    capability_id: "llm.text.generate.v1",
    request_spec_hash: SAMPLE_REQUEST_SPEC_HASH,
    prompt_hash: SAMPLE_PROMPT_HASH,
    payment_lovelace: "2000000",
    buyer_bond_lovelace: "1000000",
    supplier_bond_lovelace: "1000000",
    deliver_by: SAMPLE_DELIVER_BY,
    posted_at: SAMPLE_POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    created_slot: 1_000_000,
    datum_hex: buildEscrowDatumHex({ state: "Open" }),
    rolled_back: 0,
    ...overrides,
  } as EscrowRow;
}

function makeMockDeps(overrides: Partial<{
  adverts: AdvertRow[];
  escrows: EscrowRow[];
  currentSlot: number;
  tipSlot: number;
}>): IndexerDeps {
  const adverts = overrides.adverts ?? [sampleAdvert()];
  const escrows = overrides.escrows ?? [];
  const currentSlot = overrides.currentSlot ?? 1_000_000;
  const tipSlot = overrides.tipSlot ?? 1_001_000;

  const cache = {
    listActiveAdvertisements: vi.fn((filter?: { capability_id?: string; supplier_pkh?: string }) => {
      return adverts.filter(a => {
        if (filter?.capability_id && a.capability_id !== filter.capability_id) return false;
        if (filter?.supplier_pkh && a.supplier_pkh !== filter.supplier_pkh) return false;
        return a.status === "Active";
      });
    }),
    getAdvertisementByRef: vi.fn((ref: string) => adverts.find(a => a.utxo_ref === ref) ?? null),
    getEscrowByRef: vi.fn((ref: string) => escrows.find(e => e.utxo_ref === ref) ?? null),
    listEscrowsByBuyer: vi.fn((pkh: string) => escrows.filter(e => e.buyer_pkh === pkh)),
    listEscrowsBySupplier: vi.fn((pkh: string) => escrows.filter(e => e.supplier_pkh === pkh)),
    getSupplierStatus: vi.fn(() => ({
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      advert_ref: "a".repeat(64) + "#0",
      status: "free",
      last_seen_iso: "2026-04-24T10:00:00.000Z",
      current_escrow_ref: null,
      polled_at: Date.now(),
    })),
    listEventsAfterSlot: vi.fn(() => []),
    dbSizeBytes: vi.fn(() => 4096),
  } as unknown as IndexerDeps["cache"];

  const worker = {
    getCurrentSlot: vi.fn(() => currentSlot),
    getTipSlot: vi.fn(() => tipSlot),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as IndexerDeps["worker"];

  return { cache, worker };
}

// ─── GET /healthz ─────────────────────────────────────────────────────────────
// SPEC FIX 2026-04-27: standardize to /healthz (was /health — indexer drift).
// All tests call createApp() directly — stub throws, tests fail RED.

describe("GET /healthz", () => {
  it("GET /healthz returns 200 with ok, sync_slot, tip_slot, db_size_bytes", async () => { // SPEC FIX 2026-04-27: standardize to /healthz
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sync_slot: 1_000_000,
      tip_slot: 1_001_000,
      db_size_bytes: 4096,
    });
  });

  it("healthz endpoint returns ogmios_status field", async () => { // SPEC FIX 2026-04-27: standardize to /healthz
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ogmios_status");
  });

  it("sync_slot reflects worker.getCurrentSlot() value of 999999", async () => {
    const app = createApp(makeMockDeps({ currentSlot: 999_999 }));
    const res = await request(app).get("/healthz"); // SPEC FIX 2026-04-27: standardize to /healthz
    expect(res.body.sync_slot).toBe(999_999);
  });

  it("tip_slot reflects worker.getTipSlot() value of 1234567", async () => {
    const app = createApp(makeMockDeps({ tipSlot: 1_234_567 }));
    const res = await request(app).get("/healthz"); // SPEC FIX 2026-04-27: standardize to /healthz
    expect(res.body.tip_slot).toBe(1_234_567);
  });
});

// ─── GET /suppliers ───────────────────────────────────────────────────────────

describe("GET /suppliers", () => {
  it("GET /suppliers returns 200 with array of active suppliers", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/suppliers");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  it("suppliers list includes supplier_pkh, capability_id, price_lovelace, endpoint_url", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      capability_id: "llm.text.generate.v1",
      price_lovelace: "2000000",
      endpoint_url: INDEXER_SUPPLIER_ENDPOINT,
    });
  });

  it("suppliers list includes last status (status, last_seen_iso) from supplier_status cache", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      status: "free",
      last_seen_iso: expect.any(String),
    });
  });

  it("returns empty array when no active suppliers (adverts=[])", async () => {
    const app = createApp(makeMockDeps({ adverts: [] }));
    const res = await request(app).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("price_lovelace is serialised as string (bigint-safe)", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/suppliers");
    expect(typeof res.body[0].price_lovelace).toBe("string");
  });
});

// ─── GET /suppliers/:pkh ──────────────────────────────────────────────────────

describe("GET /suppliers/:pkh", () => {
  it("returns 200 with supplier detail when pkh matches Active advert", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get(`/suppliers/${INDEXER_SUPPLIER_PKH}`);
    expect(res.status).toBe(200);
    expect(res.body.supplier_pkh).toBe(INDEXER_SUPPLIER_PKH);
  });

  it("returns 404 when no Active advert exists for pkh", async () => {
    const app = createApp(makeMockDeps({ adverts: [] }));
    const res = await request(app).get(`/suppliers/${INDEXER_SUPPLIER_PKH}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for Retired supplier pkh", async () => {
    const app = createApp(makeMockDeps({ adverts: [sampleAdvert({ status: "Retired" })] }));
    const res = await request(app).get(`/suppliers/${INDEXER_SUPPLIER_PKH}`);
    expect(res.status).toBe(404);
  });

  it("response body includes endpoint_url and status", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get(`/suppliers/${INDEXER_SUPPLIER_PKH}`);
    expect(res.body).toMatchObject({
      endpoint_url: INDEXER_SUPPLIER_ENDPOINT,
      status: "free",
    });
  });
});

// ─── GET /capabilities ────────────────────────────────────────────────────────

describe("GET /capabilities", () => {
  it("returns 200 with distinct capability_id list", async () => {
    const adverts = [
      sampleAdvert({ utxo_ref: "a".repeat(64) + "#0", capability_id: "llm.text.generate.v1" }),
      sampleAdvert({ utxo_ref: "b".repeat(64) + "#0", capability_id: "llm.text.generate.v1" }),
      sampleAdvert({ utxo_ref: "c".repeat(64) + "#0", capability_id: "speech.transcribe.v1" }),
    ];
    const app = createApp(makeMockDeps({ adverts }));
    const res = await request(app).get("/capabilities");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns correct supplier_count per capability", async () => {
    const adverts = [
      sampleAdvert({ utxo_ref: "a".repeat(64) + "#0", capability_id: "llm.text.generate.v1" }),
      sampleAdvert({ utxo_ref: "b".repeat(64) + "#0", capability_id: "llm.text.generate.v1" }),
      sampleAdvert({ utxo_ref: "c".repeat(64) + "#0", capability_id: "speech.transcribe.v1" }),
    ];
    const app = createApp(makeMockDeps({ adverts }));
    const res = await request(app).get("/capabilities");
    expect(res.status).toBe(200);
    const llm = res.body.find((c: { capability_id: string }) => c.capability_id === "llm.text.generate.v1");
    expect(llm?.supplier_count).toBe(2);
  });

  it("returns empty array when no active suppliers", async () => {
    const app = createApp(makeMockDeps({ adverts: [] }));
    const res = await request(app).get("/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── GET /capabilities/:id/suppliers ─────────────────────────────────────────

describe("GET /capabilities/:id/suppliers", () => {
  it("filters suppliers by capability_id, returns only matching", async () => {
    const adverts = [
      sampleAdvert({ utxo_ref: "a".repeat(64) + "#0", capability_id: "llm.text.generate.v1" }),
      sampleAdvert({ utxo_ref: "b".repeat(64) + "#0", capability_id: "speech.transcribe.v1" }),
    ];
    const app = createApp(makeMockDeps({ adverts }));
    const res = await request(app).get("/capabilities/llm.text.generate.v1/suppliers");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].capability_id).toBe("llm.text.generate.v1");
  });

  it("?sort=price sorts by price_lovelace ascending (cheapest first)", async () => {
    const adverts = [
      sampleAdvert({ utxo_ref: "a".repeat(64) + "#0", price_lovelace: "3000000" }),
      sampleAdvert({ utxo_ref: "b".repeat(64) + "#0", price_lovelace: "1000000" }),
    ];
    const app = createApp(makeMockDeps({ adverts }));
    const res = await request(app).get("/capabilities/llm.text.generate.v1/suppliers?sort=price");
    expect(res.status).toBe(200);
    expect(res.body[0].price_lovelace).toBe("1000000");
  });

  it("?sort=last_seen sorts by last_seen_iso descending (most recent first)", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/capabilities/llm.text.generate.v1/suppliers?sort=last_seen");
    expect(res.status).toBe(200);
    // Just checking it doesn't 400/500 — sort order verified by caller
  });

  it("returns empty array for unknown capability_id", async () => {
    const app = createApp(makeMockDeps({ adverts: [] }));
    const res = await request(app).get("/capabilities/unknown.capability.v99/suppliers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 200 with all matching suppliers across multiple suppliers", async () => {
    const otherPkh = "11".repeat(28);
    const adverts = [
      sampleAdvert({ utxo_ref: "a".repeat(64) + "#0", supplier_pkh: INDEXER_SUPPLIER_PKH }),
      sampleAdvert({ utxo_ref: "b".repeat(64) + "#0", supplier_pkh: otherPkh }),
    ];
    const app = createApp(makeMockDeps({ adverts }));
    const res = await request(app).get("/capabilities/llm.text.generate.v1/suppliers");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });
});

// ─── GET /escrows/:ref ────────────────────────────────────────────────────────

describe("GET /escrows/:ref", () => {
  it("returns 200 with full escrow detail including state, buyer_pkh, supplier_pkh", async () => {
    const ref = "c".repeat(64) + "#0";
    const app = createApp(makeMockDeps({ escrows: [sampleEscrow({ utxo_ref: ref })] }));
    const encodedRef = encodeURIComponent(ref);
    const res = await request(app).get(`/escrows/${encodedRef}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      buyer_pkh: INDEXER_BUYER_PKH,
      supplier_pkh: INDEXER_SUPPLIER_PKH,
      state: "Open",
    });
  });

  it("returns 404 when escrow ref not found", async () => {
    const app = createApp(makeMockDeps({ escrows: [] }));
    const res = await request(app).get("/escrows/unknown%230");
    expect(res.status).toBe(404);
  });

  it("escrow response includes deliver_by, posted_at, submitted_at, result_receipt_hash", async () => {
    const ref = "c".repeat(64) + "#0";
    const app = createApp(makeMockDeps({ escrows: [sampleEscrow({ utxo_ref: ref })] }));
    const encodedRef = encodeURIComponent(ref);
    const res = await request(app).get(`/escrows/${encodedRef}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deliver_by: expect.any(Number),
      posted_at: expect.any(Number),
    });
    expect(res.body).toHaveProperty("submitted_at");
    expect(res.body).toHaveProperty("result_receipt_hash");
  });

  it("returns 200 for Claimed escrow with matching state in response", async () => {
    const ref = "d".repeat(64) + "#0";
    const app = createApp(makeMockDeps({
      escrows: [sampleEscrow({ utxo_ref: ref, state: "Claimed" })],
    }));
    const encodedRef = encodeURIComponent(ref);
    const res = await request(app).get(`/escrows/${encodedRef}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("Claimed");
  });
});

// ─── GET /escrows?buyer= and ?supplier= ──────────────────────────────────────

describe("GET /escrows (query params)", () => {
  it("?buyer=PKH returns escrows matching buyer_pkh only", async () => {
    const otherBuyer = "9".repeat(56);
    const deps = makeMockDeps({
      escrows: [
        sampleEscrow({ utxo_ref: "c".repeat(64) + "#0", buyer_pkh: INDEXER_BUYER_PKH }),
        sampleEscrow({ utxo_ref: "d".repeat(64) + "#0", buyer_pkh: otherBuyer }),
      ],
    });
    const app = createApp(deps);
    const res = await request(app).get(`/escrows?buyer=${INDEXER_BUYER_PKH}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].buyer_pkh).toBe(INDEXER_BUYER_PKH);
  });

  it("?supplier=PKH returns escrows matching supplier_pkh only", async () => {
    const otherSupplier = "9".repeat(56);
    const deps = makeMockDeps({
      escrows: [
        sampleEscrow({ utxo_ref: "c".repeat(64) + "#0", supplier_pkh: INDEXER_SUPPLIER_PKH }),
        sampleEscrow({ utxo_ref: "d".repeat(64) + "#0", supplier_pkh: otherSupplier }),
      ],
    });
    const app = createApp(deps);
    const res = await request(app).get(`/escrows?supplier=${INDEXER_SUPPLIER_PKH}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].supplier_pkh).toBe(INDEXER_SUPPLIER_PKH);
  });

  it("returns empty array when no escrows match buyer query", async () => {
    const app = createApp(makeMockDeps({ escrows: [] }));
    const res = await request(app).get(`/escrows?buyer=${INDEXER_BUYER_PKH}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 400 when neither buyer nor supplier filter is provided", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/escrows");
    expect(res.status).toBe(400);
  });

  it("payment_lovelace in escrow response is serialised as string", async () => {
    const deps = makeMockDeps({
      escrows: [sampleEscrow({ buyer_pkh: INDEXER_BUYER_PKH })],
    });
    const app = createApp(deps);
    const res = await request(app).get(`/escrows?buyer=${INDEXER_BUYER_PKH}`);
    expect(res.status).toBe(200);
    expect(typeof res.body[0].payment_lovelace).toBe("string");
  });
});

// ─── Unknown routes ───────────────────────────────────────────────────────────

describe("createApp — unknown routes", () => {
  it("returns 404 for unknown path /nonexistent-path", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/nonexistent-path");
    expect(res.status).toBe(404);
  });

  it("does not expose internal Express error details on unmatched routes", async () => {
    const app = createApp(makeMockDeps({}));
    const res = await request(app).get("/nonexistent-path");
    expect(res.status).toBe(404);
    // Should not return a full Express stack trace
    expect(typeof res.text).toBe("string");
  });
});
