/**
 * supplier-routes-status.test.ts — RED phase tests for GET /status
 *
 * Uses supertest against createApp(deps) from supplier/src/server.ts.
 * Injects a real SupplierState to control status transitions.
 *
 * Covers:
 *   - 200 in all states (free / working / offline)
 *   - Response shape: { status, last_seen }
 *   - current_escrow_ref only present when working
 *   - Never touches chain (MockChainProvider with no UTxOs)
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { SupplierState } from "../../supplier/src/state.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ESCROW_REF = `${"f".repeat(64)}#0`;

function makeApp(state: SupplierState): Application {
  return createApp({
    chain: new MockChainProvider(), // empty — /status must NOT touch chain
    state,
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
  });
}

// ─── Always 200 ──────────────────────────────────────────────────────────────

describe("GET /status — always 200", () => {
  it("returns 200 when status is free", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/status");
    expect(res.status).toBe(200);
  });

  it("returns 200 when status is working", async () => {
    const state = new SupplierState();
    state.tryAcquire(ESCROW_REF);
    const res = await request(makeApp(state)).get("/status");
    expect(res.status).toBe(200);
  });

  it("returns 200 when status is offline", async () => {
    const state = new SupplierState();
    state.markOffline();
    const res = await request(makeApp(state)).get("/status");
    expect(res.status).toBe(200);
  });
});

// ─── Response shape ──────────────────────────────────────────────────────────

describe("GET /status — response body when free", () => {
  it("body.status is 'free'", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/status");
    expect(res.body.status).toBe("free");
  });

  it("body.last_seen is an ISO timestamp", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/status");
    expect(res.body.last_seen).toBeTruthy();
    expect(new Date(res.body.last_seen).getTime()).not.toBeNaN();
  });

  it("body does NOT contain current_escrow_ref when free", async () => {
    const state = new SupplierState();
    const res = await request(makeApp(state)).get("/status");
    expect(res.body.current_escrow_ref).toBeUndefined();
  });
});

describe("GET /status — response body when working", () => {
  it("body.status is 'working'", async () => {
    const state = new SupplierState();
    state.tryAcquire(ESCROW_REF);
    const res = await request(makeApp(state)).get("/status");
    expect(res.body.status).toBe("working");
  });

  it("body.current_escrow_ref matches the acquired escrow ref", async () => {
    const state = new SupplierState();
    state.tryAcquire(ESCROW_REF);
    const res = await request(makeApp(state)).get("/status");
    expect(res.body.current_escrow_ref).toBe(ESCROW_REF);
  });

  it("body.last_seen is present when working", async () => {
    const state = new SupplierState();
    state.tryAcquire(ESCROW_REF);
    const res = await request(makeApp(state)).get("/status");
    expect(new Date(res.body.last_seen).getTime()).not.toBeNaN();
  });
});

describe("GET /status — response body when offline", () => {
  it("body.status is 'offline'", async () => {
    const state = new SupplierState();
    state.markOffline();
    const res = await request(makeApp(state)).get("/status");
    expect(res.body.status).toBe("offline");
  });

  it("body does NOT contain current_escrow_ref when offline", async () => {
    const state = new SupplierState();
    state.markOffline();
    const res = await request(makeApp(state)).get("/status");
    expect(res.body.current_escrow_ref).toBeUndefined();
  });
});

describe("GET /status — does not touch chain", () => {
  it("returns 200 even when chain has no UTxOs seeded", async () => {
    // If the handler incorrectly touches chain, it would throw because
    // advert UTxO is absent — but /status must not query chain at all.
    const state = new SupplierState();
    const chain = new MockChainProvider(); // intentionally empty
    const app = createApp({
      chain,
      state,
      config: buildSampleConfig(),
      supplierKey: buildSupplierWalletKey(),
    });
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
  });
});
