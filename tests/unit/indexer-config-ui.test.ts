/**
 * tests/unit/indexer-config-ui.test.ts — RED phase (M1-F-5)
 *
 * Category H: INDEXER_UI_DIST config extension (~3 tests)
 *
 * Tests FAIL until M1-F-5-green because loadConfig does not yet accept or
 * return uiDistDir.
 *
 * Design contract for Catherine:
 *   - loadConfig(env) extended with optional INDEXER_UI_DIST env var
 *   - When INDEXER_UI_DIST is set, IndexerConfig.uiDistDir = <value>
 *   - When INDEXER_UI_DIST is absent, IndexerConfig.uiDistDir is undefined
 *     (no UI mount, backwards-compatible)
 *   - INDEXER_UI_DIST is NOT validated (any string is accepted — directory
 *     existence is checked at server startup, not config load time)
 */

import { describe, it, expect } from "vitest";
import { loadConfig } from "../../indexer/src/config.js";

const VALID_BASE_ENV = {
  OGMIOS_URL: "ws://localhost:1337",
  DB_PATH: "/tmp/indexer.db",
  NETWORK_ID: "0",
};

describe("loadConfig — INDEXER_UI_DIST", () => {
  it("RED: INDEXER_UI_DIST=/some/path → config.uiDistDir === '/some/path'", () => {
    // RED: loadConfig does not yet return uiDistDir — M1-F-5-green adds it.
    const config = loadConfig({ ...VALID_BASE_ENV, INDEXER_UI_DIST: "/some/path" }) as ReturnType<typeof loadConfig> & { uiDistDir?: string };
    expect(config.uiDistDir).toBe("/some/path");
  });

  it("RED: uiDistDir is undefined when INDEXER_UI_DIST is absent (no UI mount)", () => {
    // RED: currently loadConfig has no uiDistDir field. After green it must be
    // present but undefined when the env var is absent.
    const config = loadConfig({ ...VALID_BASE_ENV }) as ReturnType<typeof loadConfig> & { uiDistDir?: string };
    expect(config.uiDistDir).toBeUndefined();
  });

  it("RED: INDEXER_UI_DIST accepts any non-empty string (no directory existence check at config time)", () => {
    // Any string path is valid; directory existence is checked at server startup.
    const config = loadConfig({
      ...VALID_BASE_ENV,
      INDEXER_UI_DIST: "/repo/indexer-ui/dist",
    }) as ReturnType<typeof loadConfig> & { uiDistDir?: string };
    expect(config.uiDistDir).toBe("/repo/indexer-ui/dist");
  });
});
