/**
 * tests/unit/supplier-routes-healthz.test.ts — RED phase (M1-F-1)
 *
 * Tests for GET /healthz on the supplier service.
 *
 * Mirrors the pattern of supplier-routes-status.test.ts:
 *   - createApp(deps) via supertest
 *   - MockChainProvider (empty; /healthz must NOT touch chain)
 *   - SupplierState injection to verify state-independence
 *
 * ALL TESTS RED until Catherine:
 *   1. Adds a GET /healthz handler to supplier/src/server.ts
 *   2. Returns 200 { ok: true } unconditionally
 *   3. Sets Cache-Control: no-store
 *
 * SPEC: §5 endpoint table — every service exposes GET /healthz → 200 { ok: true }.
 *       /healthz is INDEPENDENT of supplier /status (free/working/offline).
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { SupplierState } from "../../supplier/src/state.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ESCROW_REF = `${"f".repeat(64)}#0`;

/** Build a supplier app with a throwing-if-called chain mock for healthz tests. */
function makeApp(state: SupplierState, chain?: MockChainProvider): Application {
  return createApp({
    chain: chain ?? new MockChainProvider(), // intentionally empty — /healthz must not call chain
    state,
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
  });
}

// ─── Status 200 + body shape ─────────────────────────────────────────────────

describe("GET /healthz — status and body", () => {
  it("returns 200", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("returns { ok: true } in body", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/healthz");
    expect(res.body).toMatchObject({ ok: true });
  });

  it("body has no extra fields beyond 'ok'", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/healthz");
    expect(Object.keys(res.body)).toEqual(["ok"]);
  });
});

// ─── State independence ───────────────────────────────────────────────────────

describe("GET /healthz — state independence (free/working/offline)", () => {
  it("returns 200 when supplier state is free", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 200 when supplier state is working", async () => {
    const state = new SupplierState();
    state.tryAcquire(ESCROW_REF);
    const res = await request(makeApp(state)).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 200 when supplier state is offline", async () => {
    const state = new SupplierState();
    state.markOffline();
    const res = await request(makeApp(state)).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─── Chain isolation ──────────────────────────────────────────────────────────

describe("GET /healthz — does NOT touch chain", () => {
  it("returns 200 even when chain throws if called", async () => {
    // If the handler incorrectly queries chain, the spy will throw — catching
    // a 500 here would mean the handler touched chain. /healthz must never do that.
    const state = new SupplierState();
    const chain = new MockChainProvider(); // empty — no UTxOs
    const querySpy = vi.spyOn(chain, "queryUtxo").mockRejectedValue(
      new Error("chain must not be called from /healthz")
    );
    const app = createApp({
      chain,
      state,
      config: buildSampleConfig(),
      supplierKey: buildSupplierWalletKey(),
    });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("does NOT depend on advert UTxO being present on chain", async () => {
    // Distinct from the spy test: just ensures no UTxO needed, regardless of
    // whether the chain impl throws or returns null.
    const state = new SupplierState();
    const chain = new MockChainProvider(); // seeded with nothing
    const res = await request(makeApp(state, chain)).get("/healthz");
    expect(res.status).toBe(200);
  });
});

// ─── Cache-Control header ─────────────────────────────────────────────────────

describe("GET /healthz — Cache-Control header", () => {
  it("response has Cache-Control: no-store", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/healthz");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
