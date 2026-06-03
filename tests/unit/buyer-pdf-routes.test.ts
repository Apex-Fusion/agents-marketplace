/**
 * buyer-pdf-routes.test.ts — the /v1/pdf-* HTTP surface, via supertest against
 * createApp. Auth is unconfigured in these tests (no password/sessionSecret),
 * so the routes are reachable directly — same construction shape as
 * buyer-server-synth-speech.test.ts.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApp } from "../../buyer/src/server.js";
import { JobStore, type RunCallFn } from "../../buyer/src/pdf/summarize-job.js";
import { PdfJobDb } from "../../buyer/src/pdf/job-db.js";
import { loadPdfCaps } from "../../buyer/src/pdf/caps.js";
import type { Chunk } from "../../buyer/src/pdf/types.js";
import type { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import type { SupplierView } from "../../buyer/src/sdk/types.js";
import type { ChainProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";

function supplierView(model: string, ref: string, price: string): SupplierView {
  return {
    utxo_ref: ref,
    supplier_pkh: `pkh_${model}`,
    capability_id: "llm.text.generate.v1",
    model,
    max_output_tokens: 512,
    max_processing_ms: 60000,
    price_lovelace: price,
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "http://supplier",
    detail_uri: "",
    detail_hash: "",
    advertised_at: 0,
    status: "active",
    advert_status: "Active",
    current_escrow_ref: null,
    last_seen_iso: null,
    created_slot: 0,
  };
}

const MARKETPLACE = {
  discoverSuppliers: async () => [supplierView("kimi-k2", `${"a".repeat(64)}#0`, "2000000")],
} as unknown as Marketplace;
const WALLET = { address: "addr_test", pubKeyHash: "pkh", pubKeyHex: "", privateKeyHex: "0".repeat(64) } as WalletKey;
const CHAIN = {} as ChainProvider;

function makeStore(opts?: { balance?: bigint; caps?: Record<string, string>; db?: PdfJobDb }): JobStore {
  let n = 0;
  const runCall: RunCallFn = async (sup) => {
    n += 1;
    return {
      response: `summary ${n}`,
      escrowRef: `${"f".repeat(64)}#${n}`,
      supplierPkh: sup.supplierPkh,
      model: sup.model,
      receipt: {},
      receiptSignature: "sig",
    };
  };
  return new JobStore({
    marketplace: MARKETPLACE,
    chain: CHAIN,
    walletKey: WALLET,
    indexerUrl: "http://indexer",
    caps: loadPdfCaps(opts?.caps ?? {}),
    runCall,
    walletBalance: async () => opts?.balance ?? 10_000_000_000n,
    db: opts?.db,
  });
}

function chunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, text: `chunk ${i}`, tokenEstimate: 5 }));
}

describe("/v1/pdf-* routes", () => {
  it("503s every pdf route when the feature is disabled (no jobStore)", async () => {
    const app = createApp({});
    const { default: request } = await import("supertest");
    const up = await request(app).post("/v1/pdf-upload").send({});
    expect(up.status).toBe(503);
    const job = await request(app).get("/v1/pdf-jobs/whatever");
    expect(job.status).toBe(503);
  });

  it("rejects an upload with no file (400 file_required)", async () => {
    const app = createApp({ jobStore: makeStore(), pdfCaps: loadPdfCaps({}) });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/pdf-upload");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("file_required");
  });

  it("rejects a non-PDF upload (422)", async () => {
    const app = createApp({ jobStore: makeStore(), pdfCaps: loadPdfCaps({}) });
    const { default: request } = await import("supertest");
    const res = await request(app)
      .post("/v1/pdf-upload")
      .attach("file", Buffer.from("this is not a pdf"), "junk.pdf");
    expect(res.status).toBe(422);
    expect(["pdf_parse_failed", "scanned_or_image_pdf", "no_text"]).toContain(res.body.error);
  });

  it("lists jobs newest-first via GET /v1/pdf-jobs", async () => {
    const store = makeStore();
    const a = store.createJob("First.pdf", 1, chunks(1));
    const b = store.createJob("Second.pdf", 2, chunks(2));
    const app = createApp({ jobStore: store, pdfCaps: loadPdfCaps({}) });
    const { default: request } = await import("supertest");
    const res = await request(app).get("/v1/pdf-jobs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.jobs)).toBe(true);
    const ids = res.body.jobs.map((j: { job_id: string }) => j.job_id);
    expect(ids).toContain(a.jobId);
    expect(ids).toContain(b.jobId);
    const found = res.body.jobs.find((j: { job_id: string }) => j.job_id === b.jobId);
    expect(found.filename).toBe("Second.pdf");
    expect(found.status).toBe("estimated");
  });

  it("serves a past (persisted, non-live) job's view, summary.md, and terminal SSE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfroutes-"));
    try {
      const db1 = new PdfJobDb(dir);
      const store1 = makeStore({ db: db1 });
      const seeded = store1.createJob("Past.pdf", 2, chunks(2));
      const app1 = createApp({ jobStore: store1, pdfCaps: loadPdfCaps({}) });
      const { default: request } = await import("supertest");
      await request(app1).post(`/v1/pdf-jobs/${seeded.jobId}/start`).send({ confirm: true });
      let view = seeded.view();
      for (let i = 0; i < 100 && view.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 10));
        view = (await request(app1).get(`/v1/pdf-jobs/${seeded.jobId}`)).body;
      }
      expect(view.status).toBe("completed");
      db1.close();

      // Fresh store (no live job) backed by the same db = "after restart".
      const db2 = new PdfJobDb(dir);
      const store2 = makeStore({ db: db2 });
      const app2 = createApp({ jobStore: store2, pdfCaps: loadPdfCaps({}) });

      const v = await request(app2).get(`/v1/pdf-jobs/${seeded.jobId}`);
      expect(v.status).toBe(200);
      expect(v.body.status).toBe("completed");
      expect(v.body.final_summary_md.length).toBeGreaterThan(0);

      const md = await request(app2).get(`/v1/pdf-jobs/${seeded.jobId}/summary.md`);
      expect(md.status).toBe(200);

      // SSE on a non-live job returns a single terminal frame and ENDS (no hang).
      const ev = await request(app2).get(`/v1/pdf-jobs/${seeded.jobId}/events`).buffer(true);
      expect(ev.text).toContain("event: done");

      const list = await request(app2).get("/v1/pdf-jobs");
      expect(list.body.jobs.find((j: { job_id: string }) => j.job_id === seeded.jobId)?.has_summary).toBe(true);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("404s estimate for an unknown job", async () => {
    const app = createApp({ jobStore: makeStore(), pdfCaps: loadPdfCaps({}) });
    const { default: request } = await import("supertest");
    const res = await request(app).get("/v1/pdf-jobs/nope/estimate");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("job_not_found");
  });

  it("estimate → confirm-gate → start → run → summary (seeded job)", async () => {
    const store = makeStore();
    const seeded = store.createJob("MyBook.pdf", 4, chunks(4));
    const app = createApp({ jobStore: store, pdfCaps: loadPdfCaps({}) });
    const { default: request } = await import("supertest");

    // estimate
    const est = await request(app).get(`/v1/pdf-jobs/${seeded.jobId}/estimate`);
    expect(est.status).toBe(200);
    expect(est.body.mapCalls).toBe(4);
    expect(est.body.would_drop_below_floor).toBe(false);

    // start without confirm → 400
    const noConfirm = await request(app).post(`/v1/pdf-jobs/${seeded.jobId}/start`).send({});
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error).toBe("not_confirmed");

    // start with confirm → 202
    const start = await request(app).post(`/v1/pdf-jobs/${seeded.jobId}/start`).send({ confirm: true });
    expect(start.status).toBe(202);

    // poll until finished
    let view = seeded.view();
    for (let i = 0; i < 100 && view.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const v = await request(app).get(`/v1/pdf-jobs/${seeded.jobId}`);
      view = v.body;
    }
    expect(view.status).toBe("completed");
    expect(view.coverage).toEqual({ done: 4, total: 4 });
    expect(view.escrow_refs.length).toBeGreaterThanOrEqual(4);

    // double-start now 409
    const again = await request(app).post(`/v1/pdf-jobs/${seeded.jobId}/start`).send({ confirm: true });
    expect(again.status).toBe(409);

    // summary download
    const md = await request(app).get(`/v1/pdf-jobs/${seeded.jobId}/summary.md`);
    expect(md.status).toBe(200);
    expect(md.headers["content-type"]).toMatch(/text\/markdown/);
    expect(md.headers["content-disposition"]).toContain("MyBook-summary.md");
    expect(md.text.length).toBeGreaterThan(0);
  });

  it("refuses to start when spend would drop below the wallet floor (402)", async () => {
    const store = makeStore({ balance: 1_000_000n, caps: { PDF_WALLET_FLOOR_LOVELACE: "50000000" } });
    const seeded = store.createJob("book.pdf", 1, chunks(3));
    const app = createApp({ jobStore: store, pdfCaps: loadPdfCaps({ PDF_WALLET_FLOOR_LOVELACE: "50000000" }) });
    const { default: request } = await import("supertest");
    const res = await request(app).post(`/v1/pdf-jobs/${seeded.jobId}/start`).send({ confirm: true });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("below_wallet_floor");
  });
});
