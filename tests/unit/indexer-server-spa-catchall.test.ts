/**
 * tests/unit/indexer-server-spa-catchall.test.ts — RED phase (M1-F-5)
 *
 * Category G: Express SPA catch-all extension (~8 tests)
 * supertest-driven.
 *
 * All tests marked "RED" FAIL until M1-F-5-green because createApp does not yet
 * accept uiDistDir and does not mount static files or the SPA catch-all.
 *
 * Design contract for Catherine:
 *   - createApp(deps, options) gains an optional third-ish arg: options.uiDistDir
 *   - When uiDistDir is provided:
 *       (a) express.static(uiDistDir) is added AFTER all JSON routes
 *       (b) app.get('*', (req, res) => res.sendFile('index.html', {root: uiDistDir}))
 *           is added as the SPA catch-all LAST
 *   - When uiDistDir is NOT provided (default, existing unit tests), behavior is unchanged:
 *       unknown paths return 404 (Express default)
 *   - JSON endpoints at /healthz, /suppliers, /capabilities, /escrows, /events
 *     still return JSON 200 / correct status (priority preserved)
 *
 * Test setup:
 *   - Creates a real temp directory with a minimal index.html so sendFile works
 *   - Uses supertest against the returned Application (no actual listening port)
 *
 * NOTE: The existing "unknown routes" tests in indexer-routes.test.ts still pass
 * because they use createApp(deps) without uiDistDir — backwards-compatible.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createApp } from "../../indexer/src/server.js";
import type { IndexerDeps } from "../../indexer/src/server.js";
import type { AdvertRow } from "../../indexer/src/db/cache.js";
import {
  INDEXER_SUPPLIER_PKH,
  INDEXER_SUPPLIER_ENDPOINT,
} from "../fixtures/indexer-side/sample-blocks.js";

// ─── Temp dist directory ─────────────────────────────────────────────────────
// Created once for all SPA tests; holds a minimal index.html and a fake JS file.

let distDir: string;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), "indexer-ui-dist-"));
  writeFileSync(join(distDir, "index.html"), "<!DOCTYPE html><html><body>IndexerUI</body></html>");
  writeFileSync(join(distDir, "app.js"), "// fake bundle");
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

// ─── Mock deps ────────────────────────────────────────────────────────────────

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
    advertised_at: 1_745_500_000,
    status: "Active",
    created_slot: 1_000_000,
    datum_hex: "",
    rolled_back: 0,
    ...overrides,
  } as AdvertRow;
}

function makeMockDeps(): IndexerDeps {
  const cache = {
    listActiveAdvertisements: vi.fn(() => [sampleAdvert()]),
    getAdvertisementByRef: vi.fn(() => null),
    getEscrowByRef: vi.fn(() => null),
    listEscrowsByBuyer: vi.fn(() => []),
    listEscrowsBySupplier: vi.fn(() => []),
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
    getCurrentSlot: vi.fn(() => 1_000_000),
    getTipSlot: vi.fn(() => 1_001_000),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as IndexerDeps["worker"];

  return { cache, worker };
}

// ─── JSON route priority preserved ───────────────────────────────────────────

describe("SPA catch-all — JSON route priority preserved", () => {
  it("RED: GET /healthz still returns JSON 200 when uiDistDir is set", async () => {
    // RED: createApp does not yet accept uiDistDir option — fails until M1-F-5-green
    const app = createApp(makeMockDeps(), { uiDistDir: distDir } as never);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("RED: GET /suppliers still returns JSON when uiDistDir is set", async () => {
    const app = createApp(makeMockDeps(), { uiDistDir: distDir } as never);
    const res = await request(app).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("RED: GET /capabilities still returns JSON when uiDistDir is set", async () => {
    const app = createApp(makeMockDeps(), { uiDistDir: distDir } as never);
    const res = await request(app).get("/capabilities");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("RED: GET /escrows?buyer=<pkh> still returns JSON when uiDistDir is set", async () => {
    const app = createApp(makeMockDeps(), { uiDistDir: distDir } as never);
    const res = await request(app).get(`/escrows?buyer=${INDEXER_SUPPLIER_PKH}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("RED: GET /events?stream=1 still returns text/event-stream when uiDistDir is set", async () => {
    // Test the SSE route using the Node http module directly to get headers
    // without waiting for the body (supertest awaits the full response which
    // never arrives for a long-lived SSE stream, so we use http.get instead).
    const http = await import("http");
    const app = createApp(makeMockDeps(), { uiDistDir: distDir } as never);

    const contentType = await new Promise<string>((resolve, reject) => {
      // Start a server on a random port, make one request, grab the header, destroy.
      const server = http.createServer(app).listen(0, () => {
        const { port } = server.address() as { port: number };
        const req = http.get(`http://127.0.0.1:${port}/events?stream=1`, (res) => {
          resolve(res.headers["content-type"] ?? "");
          req.destroy();
          server.close();
        });
        req.on("error", (err) => {
          // Ignore "socket hang up" that results from req.destroy()
          if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
          reject(err);
        });
      });
      server.on("error", reject);
    });

    expect(contentType).toMatch(/event-stream/);
  }, 10_000);
});

// ─── SPA catch-all behaviour ─────────────────────────────────────────────────

describe("SPA catch-all — index.html served", () => {
  it("RED: GET / returns text/html (index.html) when uiDistDir is set", async () => {
    const app = createApp(makeMockDeps(), { uiDistDir: distDir } as never);
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("IndexerUI");
  });

  it("RED: GET /some-spa-route returns the same index.html (SPA catch-all)", async () => {
    const app = createApp(makeMockDeps(), { uiDistDir: distDir } as never);
    const res = await request(app).get("/some-spa-route");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("IndexerUI");
  });

  it("RED: GET /app.js returns the static JS file from dist", async () => {
    const app = createApp(makeMockDeps(), { uiDistDir: distDir } as never);
    const res = await request(app).get("/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("fake bundle");
  });
});
