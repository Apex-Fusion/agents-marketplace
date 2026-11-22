/**
 * rate-limits.test.ts — the per-IP signup limit and the per-key request limit of createApp.
 *
 * Security path: POST /signup mints a wallet for anyone, and a key makes paid requests. Both are bounded by a limiter that answers
 * 429 with Retry-After once the count of a window is used. The signup limit counts each IP, the key limit counts each key, and a window
 * that has ended lets the caller in again. The limits are set here (the values of the production defaults), because the other
 * tests set `max: 1000`. Only `Date` is fake: the clock moves with `vi.setSystemTime`, and no test waits. The client IP comes
 * from `X-Forwarded-For`, as behind the proxy of the gateway.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import type { GatewayDeps } from "../src/deps.js";

const SIGNUP = { max: 5, windowMs: 60 * 60 * 1000 };
const KEY = { max: 60, windowMs: 60 * 1000 };
const START = Date.UTC(2026, 10, 22, 12, 0, 0);

// Two clients of the documentation range, and one more that only makes the keys of the key limit rows.
const IP_A = "203.0.113.10";
const IP_B = "203.0.113.11";
const IP_KEYS = "192.0.2.1";

const unexpected: typeof globalThis.fetch = async (input) => {
  throw new Error(`unexpected request: ${String(input)}`);
};

const closers: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) close();
});

function makeWorld() {
  const dbDir = join(tmpdir(), `gw-rate-limits-${randomUUID()}`);
  const store = new GatewayStore(dbDir);
  const config = {
    ...loadConfig({
      GATEWAY_MASTER_KEY: "ab".repeat(32),
      INDEXER_URL: "http://indexer.invalid",
      OGMIOS_URL: "http://ogmios.invalid",
      LIVE_CHAIN: "1",
    }),
    dbDir,
    signupRate: SIGNUP,
    keyRate: KEY,
  };
  const chain = new LiveOgmiosProvider({ ogmiosUrl: config.ogmiosUrl, fetch: unexpected });
  const registry = new SdkRegistry({
    chain, store, indexerUrl: config.indexerUrl, networkId: config.networkId, masterKeyHex: config.masterKeyHex, max: config.sdkRegistryMax,
  });
  const deps: GatewayDeps = { config, store, chain, registry, fetchFn: unexpected };
  const app = createApp(deps);
  closers.push(() => {
    store["db"].close();
    rmSync(dbDir, { recursive: true, force: true });
  });
  return {
    store,
    signup: (ip: string) => request(app).post("/signup").set("X-Forwarded-For", ip).send({}),
    /** A stored Response that no row holds: the route answers 404 when the limiter lets the request in. */
    read: (apiKey: string, ip: string) =>
      request(app).get("/openai/v1/responses/resp_none").set("authorization", `Bearer ${apiKey}`).set("X-Forwarded-For", ip),
  };
}

/** The answer of a limiter that has used the count of its window, `seconds` before the window ends. */
function expectRateLimited(response: request.Response, seconds: number): void {
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBe(String(seconds));
  expect(response.body).toEqual({
    error: { message: `rate limit exceeded; retry in ${seconds}s`, type: "rate_limit_error", code: "rate_limit_exceeded", param: null },
  });
}

describe("POST /signup", () => {
  it("lets each IP sign up up to the limit, answers 429 after it, and lets the IP in again when the window ends", async () => {
    const world = makeWorld();
    // The accepted control: the requests up to the limit.
    for (let n = 0; n < SIGNUP.max; n += 1) expect((await world.signup(IP_A)).status).toBe(201);

    expectRateLimited(await world.signup(IP_A), 3600);
    expect(world.store.listAllKeys()).toHaveLength(SIGNUP.max); // the refused request minted no wallet
    expect((await world.signup(IP_B)).status).toBe(201); // another IP has its own count

    vi.setSystemTime(START + SIGNUP.windowMs - 1);
    expectRateLimited(await world.signup(IP_A), 1);
    vi.setSystemTime(START + SIGNUP.windowMs);
    for (let n = 0; n < SIGNUP.max; n += 1) expect((await world.signup(IP_A)).status).toBe(201);
    expectRateLimited(await world.signup(IP_A), 3600);
  });
});

describe("GET /openai/v1/responses/:id", () => {
  it("lets each key read up to the limit, answers 429 after it, and lets the key in again when the window ends", async () => {
    const world = makeWorld();
    const keyA: string = (await world.signup(IP_KEYS)).body.api_key;
    const keyB: string = (await world.signup(IP_KEYS)).body.api_key;

    // The accepted control: the requests up to the limit reach the handler.
    for (let n = 0; n < KEY.max; n += 1) {
      const response = await world.read(keyA, IP_A);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("response_not_found");
    }

    expectRateLimited(await world.read(keyA, IP_A), 60);
    expectRateLimited(await world.read(keyA, IP_B), 60); // the limit follows the key, not the IP
    expect((await world.read(keyB, IP_A)).status).toBe(404); // another key has its own count

    vi.setSystemTime(START + KEY.windowMs - 1);
    expectRateLimited(await world.read(keyA, IP_A), 1);
    vi.setSystemTime(START + KEY.windowMs);
    expect((await world.read(keyA, IP_A)).status).toBe(404);
  });
});
