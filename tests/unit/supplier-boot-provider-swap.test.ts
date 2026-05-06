/**
 * supplier-boot-provider-swap.test.ts — RED phase tests for LIVE_CHAIN env
 * driven provider selection in supplier boot.
 *
 * Tests the `buildChainProvider(config, fetch?)` function exported from
 * `supplier/src/chain.ts`, which is extracted from `supplier/src/index.ts`
 * so it can be tested in isolation without booting the Express server.
 *
 * Contract:
 *   - LIVE_CHAIN = "1"          → returns LiveOgmiosProvider instance
 *   - LIVE_CHAIN = "0"          → returns ReadOnlyOgmiosProvider instance
 *   - LIVE_CHAIN = ""           → returns ReadOnlyOgmiosProvider instance
 *   - LIVE_CHAIN = undefined    → returns ReadOnlyOgmiosProvider instance
 *   - LIVE_CHAIN = "true"       → returns ReadOnlyOgmiosProvider (only "1" opts in)
 *   - LIVE_CHAIN = "yes"        → returns ReadOnlyOgmiosProvider (only "1" opts in)
 *   - LIVE_CHAIN = "TRUE"       → returns ReadOnlyOgmiosProvider (only "1" opts in)
 *   - liveChain: true  in config → returns LiveOgmiosProvider
 *   - liveChain: false in config → returns ReadOnlyOgmiosProvider
 *
 * Also covers:
 *   - loadConfig LIVE_CHAIN parsing: true/false/default (liveChain field)
 *   - buildChainProvider logs which provider was selected
 *
 * SPEC FIX 2026-04-27: M1-F-2 supplier boot provider swap RED tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildChainProvider } from "../../supplier/src/chain.js";
import { loadConfig } from "../../supplier/src/config.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import { buildSampleEnv } from "../fixtures/supplier-side/sample-config.js";

// ─── buildChainProvider — provider selection ─────────────────────────────────

describe("buildChainProvider() — LIVE_CHAIN=1 → LiveOgmiosProvider", () => {
  it("returns a LiveOgmiosProvider instance when liveChain is true", () => {
    const config = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "1" });
    const provider = buildChainProvider(config);
    expect(provider).toBeInstanceOf(LiveOgmiosProvider);
  });
});

describe("buildChainProvider() — default → ReadOnlyOgmiosProvider", () => {
  it("returns ReadOnlyOgmiosProvider when liveChain is false", () => {
    const config = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "0" });
    const provider = buildChainProvider(config);
    expect(provider).toBeInstanceOf(ReadOnlyOgmiosProvider);
  });

  it("returns ReadOnlyOgmiosProvider when LIVE_CHAIN is omitted from config", () => {
    // loadConfig defaults liveChain to false when env var is absent
    const config = loadConfig({ ...buildSampleEnv() });
    const provider = buildChainProvider(config);
    expect(provider).toBeInstanceOf(ReadOnlyOgmiosProvider);
  });

  it("returns ReadOnlyOgmiosProvider when liveChain is false (LIVE_CHAIN='true' is rejected)", () => {
    // "true" is NOT the accepted literal — only "1" opts in
    const config = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "true" });
    const provider = buildChainProvider(config);
    expect(provider).toBeInstanceOf(ReadOnlyOgmiosProvider);
  });

  it("returns ReadOnlyOgmiosProvider when liveChain is false (LIVE_CHAIN='yes' is rejected)", () => {
    const config = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "yes" });
    const provider = buildChainProvider(config);
    expect(provider).toBeInstanceOf(ReadOnlyOgmiosProvider);
  });

  it("returns ReadOnlyOgmiosProvider when liveChain is false (LIVE_CHAIN='TRUE' is rejected)", () => {
    const config = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "TRUE" });
    const provider = buildChainProvider(config);
    expect(provider).toBeInstanceOf(ReadOnlyOgmiosProvider);
  });
});

describe("buildChainProvider() — logs provider selection", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs 'LiveOgmiosProvider' when liveChain is true", () => {
    const config = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "1" });
    buildChainProvider(config);
    const loggedLines = (console.log as ReturnType<typeof vi.spyOn>).mock.calls.map(c => c.join(" "));
    expect(loggedLines.some(line => line.includes("LiveOgmiosProvider"))).toBe(true);
  });

  it("logs 'ReadOnlyOgmiosProvider' when liveChain is false", () => {
    const config = loadConfig({ ...buildSampleEnv() });
    buildChainProvider(config);
    const loggedLines = (console.log as ReturnType<typeof vi.spyOn>).mock.calls.map(c => c.join(" "));
    expect(loggedLines.some(line => line.includes("ReadOnlyOgmiosProvider"))).toBe(true);
  });
});

// ─── loadConfig — LIVE_CHAIN parsing ─────────────────────────────────────────
// SPEC FIX 2026-04-27: M1-F-2 LIVE_CHAIN env support — these assertions verify
// that SupplierConfig.liveChain is parsed correctly from the LIVE_CHAIN env var.

describe("loadConfig() — LIVE_CHAIN parsing (M1-F-2)", () => {
  it("LIVE_CHAIN='1' → liveChain: true", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "1" });
    expect(cfg.liveChain).toBe(true);
  });

  it("LIVE_CHAIN='0' → liveChain: false", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "0" });
    expect(cfg.liveChain).toBe(false);
  });

  it("LIVE_CHAIN omitted → liveChain: false (default off)", () => {
    const env = { ...buildSampleEnv() };
    delete (env as Record<string, string | undefined>).LIVE_CHAIN;
    const cfg = loadConfig(env);
    expect(cfg.liveChain).toBe(false);
  });

  it("LIVE_CHAIN='' → liveChain: false", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "" });
    expect(cfg.liveChain).toBe(false);
  });

  it("LIVE_CHAIN='true' → liveChain: false (only literal '1' opts in)", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "true" });
    expect(cfg.liveChain).toBe(false);
  });
});
