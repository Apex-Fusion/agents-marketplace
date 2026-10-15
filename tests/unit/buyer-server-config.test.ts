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
import request from "supertest";

// ─── loadConfig tests ─────────────────────────────────────────────────────────

describe("loadConfig(env)", () => {
  const VALID_ENV = {
    BUYER_PRIV_KEY_HEX: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae3942",
    INDEXER_URL: "http://localhost:3001",
    BUYER_PORT: "3002",
    NETWORK_ID: "0",
  };

  it("returns a BuyerConfig when all required env vars are present", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.privKeyHex).toBe(VALID_ENV.BUYER_PRIV_KEY_HEX);
    expect(config.indexerUrl).toBe(VALID_ENV.INDEXER_URL);
    expect(config.port).toBe(3002);
    expect(config.networkId).toBe(0);
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

  it("defaults pdfEnabled to true when PDF_ENABLED is not provided", () => {
    expect(loadConfig(VALID_ENV).pdfEnabled).toBe(true);
  });

  it('honours PDF_ENABLED="0" (summarizer kill switch)', () => {
    const config = loadConfig({ ...VALID_ENV, PDF_ENABLED: "0" });
    expect(config.pdfEnabled).toBe(false);
  });

  it("throws when PDF_ENABLED is not 0 or 1", () => {
    expect(() => loadConfig({ ...VALID_ENV, PDF_ENABLED: "false" })).toThrow(/PDF_ENABLED/);
  });

  it("normalizes the private resale dashboard URL", () => {
    const config = loadConfig({
      ...VALID_ENV,
      SURPLUS_DASHBOARD_URL:
        "http://surplus-seller:8080/internal/resale-dashboard/",
    });
    expect(config.resaleDashboardUrl).toBe(
      "http://surplus-seller:8080/internal/resale-dashboard",
    );
  });

  it("rejects a resale dashboard URL with an unsupported protocol", () => {
    expect(() => loadConfig({
      ...VALID_ENV,
      SURPLUS_DASHBOARD_URL: "file:///tmp/dashboard.json",
    })).toThrow(/SURPLUS_DASHBOARD_URL/);
  });

  it("requires the Paper2Agent control URL and token together", () => {
    const token = "t".repeat(32);
    expect(loadConfig(VALID_ENV).paper2agentControlUrl).toBe("");
    expect(() => loadConfig({ ...VALID_ENV, PAPER2AGENT_CONTROL_URL: "http://control:8095" }))
      .toThrow(/PAPER2AGENT_CONTROL_URL and PAPER2AGENT_CONTROL_TOKEN/);
    expect(() => loadConfig({ ...VALID_ENV, PAPER2AGENT_CONTROL_TOKEN: token }))
      .toThrow(/PAPER2AGENT_CONTROL_URL and PAPER2AGENT_CONTROL_TOKEN/);
    const config = loadConfig({
      ...VALID_ENV,
      PAPER2AGENT_CONTROL_URL: "http://control:8095/",
      PAPER2AGENT_CONTROL_TOKEN: token,
    });
    expect(config.paper2agentControlUrl).toBe("http://control:8095");
    expect(config.paper2agentControlToken).toBe(token);
  });

  it("rejects a weak Paper2Agent control token or an unsafe control URL", () => {
    const pair = (url: string, token: string) => ({
      ...VALID_ENV,
      PAPER2AGENT_CONTROL_URL: url,
      PAPER2AGENT_CONTROL_TOKEN: token,
    });
    expect(() => loadConfig(pair("http://control:8095", "t".repeat(31)))).toThrow(/PAPER2AGENT_CONTROL_TOKEN/);
    expect(() => loadConfig(pair("file:///run/control.sock", "t".repeat(32)))).toThrow(/PAPER2AGENT_CONTROL_URL/);
    expect(() => loadConfig(pair("http://user:secret@control:8095", "t".repeat(32))))
      .toThrow(/PAPER2AGENT_CONTROL_URL/);
  });

  it("reads the Paper2Agent auto exclude list as trimmed, comma-separated model names", () => {
    expect(loadConfig(VALID_ENV).paper2agentModelAutoExclude).toEqual([]);
    expect(loadConfig({ ...VALID_ENV, PAPER2AGENT_MODEL_AUTO_EXCLUDE: " swarm-qwen38-27b-gptq4 ,, org/model:7b " })
      .paper2agentModelAutoExclude).toEqual(["swarm-qwen38-27b-gptq4", "org/model:7b"]);
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

  it("keeps upstream errors and the admin token out of the API key list response", async () => {
    const app = createApp({
      gatewayInternalUrl: "http://gateway.internal",
      gatewayAdminToken: "operator-token-".repeat(4),
      fetchImpl: async () => new Response("private upstream error details", { status: 500 }),
    });
    const res = await request(app).get("/v1/api-keys");
    expect(res.status).toBe(502);
    expect(res.text).not.toContain("private upstream error details");
    expect(res.text).not.toContain("operator-token-");
  });
});
