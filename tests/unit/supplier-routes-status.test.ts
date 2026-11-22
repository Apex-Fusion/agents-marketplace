/**
 * supplier-routes-status.test.ts: GET /status and GET /healthz
 *
 * Both routes are static: they answer from memory and never call the chain.
 * Uses supertest against createApp(deps) from supplier/src/server.ts.
 * A real SupplierState sets each status.
 *
 * Covers:
 *   - /status in each state (free, working, offline, free with slots left): 200 and the exact body.
 *     current_escrow_ref is present only when every slot is taken.
 *   - /healthz in each state: 200 { ok: true } with Cache-Control: no-store
 *     (SPEC: every service exposes GET /healthz; M1-F-1). It does not depend on /status.
 *   - Neither route calls the chain.
 * The reseller part of /status is in supplier-reseller-routes.test.ts.
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

/** The app on an empty chain: a route that reads the chain finds no advert. */
function makeApp(state: SupplierState, chain: MockChainProvider = new MockChainProvider()): Application {
  return createApp({ chain, state, config: buildSampleConfig(), supplierKey: buildSupplierWalletKey() });
}

/** The empty chain, wrapped so that each method call is recorded. */
function recordingChain(): { chain: MockChainProvider; calls: string[] } {
  const calls: string[] = [];
  const chain = new Proxy(new MockChainProvider(), {
    get(target, name, receiver) {
      const member = Reflect.get(target, name, receiver);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        calls.push(String(name));
        return member.apply(target, args);
      };
    },
  });
  return { chain, calls };
}

/** A supplier state, and the body that GET /status must give for it (without last_seen). */
const STATES: ReadonlyArray<{ name: string; make: () => SupplierState; status: Record<string, unknown> }> = [
  { name: "free", make: () => new SupplierState(), status: { status: "free", active_sessions: 0, max_sessions: 1 } },
  {
    name: "working",
    make: () => {
      const state = new SupplierState();
      state.tryAcquire(ESCROW_REF);
      return state;
    },
    status: { status: "working", active_sessions: 1, max_sessions: 1, current_escrow_ref: ESCROW_REF },
  },
  {
    name: "offline",
    make: () => {
      const state = new SupplierState();
      state.markOffline();
      return state;
    },
    status: { status: "offline", active_sessions: 0, max_sessions: 1 },
  },
  {
    name: "free with slots left",
    make: () => {
      const state = new SupplierState(3);
      state.tryAcquire(ESCROW_REF);
      return state;
    },
    status: { status: "free", active_sessions: 1, max_sessions: 3 },
  },
];

describe("GET /status", () => {
  it.each(STATES)("reports the $name state", async ({ make, status }) => {
    const state = make();
    const res = await request(makeApp(state)).get("/status");
    expect(res.status).toBe(200);
    // toEqual allows no other field: a free or offline supplier gives no current_escrow_ref.
    expect(res.body).toEqual({ ...status, last_seen: state.snapshot().lastSeenIso });
    expect(new Date(res.body.last_seen).toISOString()).toBe(res.body.last_seen);
  });
});

describe("GET /healthz", () => {
  it.each(STATES)("answers 200 { ok: true } with no-store when the supplier is $name", async ({ make }) => {
    const res = await request(makeApp(make())).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("the static routes do not touch the chain", () => {
  it.each(["/status", "/healthz"])("GET %s makes no chain call", async (path) => {
    const { chain, calls } = recordingChain();
    const res = await request(makeApp(new SupplierState(), chain)).get(path);
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
