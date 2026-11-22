/**
 * supplier-boot-provider-swap.test.ts — tests for the LIVE_CHAIN env driven
 * provider selection in supplier boot.
 *
 * Tests the `buildChainProvider(config, fetch?)` function exported from
 * `supplier/src/chain.ts`, which is extracted from `supplier/src/index.ts`
 * so it can be tested in isolation without booting the Express server.
 *
 * Contract (M1-F-2, SPEC FIX 2026-04-27): only the literal LIVE_CHAIN="1"
 * opts in. Each test goes from the env through loadConfig to the provider.
 *   - LIVE_CHAIN = "1"                         → LiveOgmiosProvider
 *   - omitted, "true", "yes", "TRUE", "0", ""  → ReadOnlyOgmiosProvider
 *
 * The parsing of LIVE_CHAIN into config.liveChain is tested in
 * supplier-config.test.ts.
 */

import { describe, it, expect } from "vitest";
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

  it.each(["0", "yes", "TRUE", ""])(
    "LIVE_CHAIN=%j → liveChain false and ReadOnlyOgmiosProvider (only '1' opts in)",
    (literal) => {
      const config = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: literal });
      expect(config.liveChain).toBe(false);
      expect(buildChainProvider(config)).toBeInstanceOf(ReadOnlyOgmiosProvider);
    },
  );
});
