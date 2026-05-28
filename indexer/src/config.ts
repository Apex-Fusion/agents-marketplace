/**
 * indexer/src/config.ts — environment loading for the indexer.
 *
 * loadConfig(env) is a PURE function: it reads from the supplied env map,
 * validates required fields, and returns a typed config object.
 * This makes it trivially testable without process.env mutation.
 *
 * Required env vars:
 *   OGMIOS_URL      — WebSocket URL for Ogmios (e.g. ws://localhost:1337)
 *   DB_PATH         — path to the SQLite database file
 *   NETWORK_ID      — "0" (Vector testnet) | "1" (Vector mainnet)
 *
 * SPEC FIX 2026-04-27: NETWORK_ID standardized across all services to the
 * numeric string form "0"|"1" (mapped to NetworkId 0|1). This aligns the
 * indexer with supplier/buyer (previous indexer-side drift used the labels
 * "testnet"/"mainnet"). Legacy values are now rejected.
 *
 * Optional env vars (with defaults):
 *   INDEXER_PORT                — HTTP port (default 8090)
 *   STATUS_POLL_MS              — status poll interval in ms (default 20000)
 *   SKIP_BEFORE_SLOT            — skip blocks before this slot (default 0)
 *   OGMIOS_RESPONSE_TIMEOUT_MS  — watchdog timeout; reconnect Ogmios WS if no
 *                                 response in this window (default 90000, 0 = off)
 */

import type { NetworkId } from "@marketplace/shared";

export interface IndexerConfig {
  ogmiosUrl: string;
  dbPath: string;
  networkId: NetworkId;
  indexerPort: number;
  statusPollMs: number;
  skipBeforeSlot: number;
  ogmiosResponseTimeoutMs: number;
  /**
   * Optional path to the bundled indexer-ui dist directory. When set, the
   * Express app mounts static assets + SPA catch-all so the same process
   * serves both API and dashboard. When unset, the indexer is API-only.
   * NOT validated at config-load time — directory existence is checked at
   * server startup (or implicitly by express.static / sendFile).
   */
  uiDistDir?: string;
}

function parseNonNegativeInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`loadConfig: ${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): IndexerConfig {
  const ogmiosUrl = env.OGMIOS_URL;
  const dbPath = env.DB_PATH;
  const networkIdRaw = env.NETWORK_ID;

  if (!ogmiosUrl) {
    throw new Error("loadConfig: OGMIOS_URL is required");
  }
  if (!dbPath) {
    throw new Error("loadConfig: DB_PATH is required");
  }
  if (!networkIdRaw) {
    throw new Error("loadConfig: NETWORK_ID is required");
  }
  let networkId: NetworkId;
  if (networkIdRaw === "0") {
    networkId = 0;
  } else if (networkIdRaw === "1") {
    networkId = 1;
  } else {
    throw new Error(
      `loadConfig: NETWORK_ID must be "0" (Vector testnet) or "1" (Vector mainnet), ` +
      `got ${JSON.stringify(networkIdRaw)}`,
    );
  }

  const indexerPort = env.INDEXER_PORT !== undefined
    ? parseNonNegativeInt("INDEXER_PORT", env.INDEXER_PORT)
    : 8090;

  const statusPollMs = env.STATUS_POLL_MS !== undefined
    ? parseNonNegativeInt("STATUS_POLL_MS", env.STATUS_POLL_MS)
    : 20_000;

  const skipBeforeSlot = env.SKIP_BEFORE_SLOT !== undefined
    ? parseNonNegativeInt("SKIP_BEFORE_SLOT", env.SKIP_BEFORE_SLOT)
    : 0;

  const ogmiosResponseTimeoutMs = env.OGMIOS_RESPONSE_TIMEOUT_MS !== undefined
    ? parseNonNegativeInt("OGMIOS_RESPONSE_TIMEOUT_MS", env.OGMIOS_RESPONSE_TIMEOUT_MS)
    : 90_000;

  // Optional INDEXER_UI_DIST: any non-empty string is accepted; directory
  // existence is checked at startup, not here. Absent → undefined (API-only).
  const uiDistDir = typeof env.INDEXER_UI_DIST === "string" && env.INDEXER_UI_DIST.length > 0
    ? env.INDEXER_UI_DIST
    : undefined;

  return {
    ogmiosUrl,
    dbPath,
    networkId,
    indexerPort,
    statusPollMs,
    skipBeforeSlot,
    ogmiosResponseTimeoutMs,
    uiDistDir,
  };
}
