/**
 * buyer-server-config.test.ts — RED phase (M1-E)
 *
 * Category H: Server / config (~5 tests)
 *
 * All tests FAIL until M1-E-green.
 */

import { describe, it, expect } from "vitest";
import { join } from "path";
import { loadConfig } from "../../buyer/src/config.js";
import { createApp } from "../../buyer/src/server.js";

// ─── loadConfig tests ─────────────────────────────────────────────────────────

describe("loadConfig(env)", () => {
  const VALID_ENV = {
    BUYER_PRIV_KEY_HEX: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae3942",
    INDEXER_URL: "http://localhost:3001",
    BUYER_PORT: "3002",
    NETWORK_ID: "0",
    BUYER_PASSWORD: "hunter2",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };

  it("returns a BuyerConfig when all required env vars are present", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.privKeyHex).toBe(VALID_ENV.BUYER_PRIV_KEY_HEX);
    expect(config.indexerUrl).toBe(VALID_ENV.INDEXER_URL);
    expect(config.port).toBe(3002);
    expect(config.networkId).toBe(0);
    expect(config.password).toBe(VALID_ENV.BUYER_PASSWORD);
    expect(config.sessionSecret).toBe(VALID_ENV.SESSION_SECRET);
    expect(config.cookieSecure).toBe(true);
  });

  it("throws when BUYER_PRIV_KEY_HEX is missing", () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).BUYER_PRIV_KEY_HEX;
    expect(() => loadConfig(env)).toThrow();
  });

  it("throws when INDEXER_URL is missing", () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).INDEXER_URL;
    expect(() => loadConfig(env)).toThrow();
  });

  it("defaults BUYER_PORT to 3002 when not provided", () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).BUYER_PORT;
    const config = loadConfig(env);
    expect(config.port).toBe(3002);
  });

  it("defaults NETWORK_ID to 0 (testnet) when not provided", () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).NETWORK_ID;
    const config = loadConfig(env);
    expect(config.networkId).toBe(0);
  });

  it("throws when BUYER_PASSWORD is missing", () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).BUYER_PASSWORD;
    expect(() => loadConfig(env)).toThrow(/BUYER_PASSWORD/);
  });

  it("throws when SESSION_SECRET is missing", () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).SESSION_SECRET;
    expect(() => loadConfig(env)).toThrow(/SESSION_SECRET/);
  });

  it("throws when SESSION_SECRET is shorter than 32 chars", () => {
    const env = { ...VALID_ENV, SESSION_SECRET: "too-short" };
    expect(() => loadConfig(env)).toThrow(/SESSION_SECRET/);
  });

  it('honours COOKIE_SECURE="0" for plain-HTTP loopback dev', () => {
    const env = { ...VALID_ENV, COOKIE_SECURE: "0" };
    const config = loadConfig(env);
    expect(config.cookieSecure).toBe(false);
  });

  it("throws when COOKIE_SECURE is not 0 or 1", () => {
    const env = { ...VALID_ENV, COOKIE_SECURE: "true" };
    expect(() => loadConfig(env)).toThrow(/COOKIE_SECURE/);
  });
});

// ─── createApp tests ──────────────────────────────────────────────────────────

describe("createApp(deps)", () => {
  it("GET /healthz returns { ok: true } with status 200", async () => {
    const app = createApp({});
    // Use supertest-style in-process request
    const { default: request } = await import("supertest");
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("serves static dist/ directory when distPath exists", async () => {
    // The dist path doesn't exist yet; createApp should mount it without crashing.
    // We test that the app at least starts up with the distPath option.
    const app = createApp({ distPath: "/tmp/nonexistent-dist" });
    const { default: request } = await import("supertest");
    // /healthz still works regardless of distPath
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown routes when dist/ is not set", async () => {
    const app = createApp({});
    const { default: request } = await import("supertest");
    const res = await request(app).get("/this-page-does-not-exist");
    expect(res.status).toBe(404);
  });
});
