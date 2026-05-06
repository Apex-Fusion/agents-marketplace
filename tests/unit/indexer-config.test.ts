/**
 * tests/unit/indexer-config.test.ts — config loading tests (Category F)
 *
 * loadConfig(env) is a PURE function — no process.env mutation.
 * All happy-path tests RED — loadConfig throws "not implemented — M1-D-green".
 * Missing-field and malformed-value tests GREEN immediately (stub throws = "throws" assertion passes).
 *
 * SPEC FIX 2026-04-27: NETWORK_ID standardized to numeric "0"|"1" across all services.
 * Tests previously used "testnet"/"mainnet" (indexer drift); now align with supplier/buyer.
 * Two new RED tests added: rejects legacy "testnet" value; rejects out-of-range "2".
 */

import { describe, it, expect } from "vitest";
import { loadConfig } from "../../indexer/src/config.js";

// SPEC FIX 2026-04-27: NETWORK_ID standardized to numeric "0"|"1"
const VALID_ENV = {
  OGMIOS_URL: "ws://localhost:1337",
  DB_PATH: "/tmp/indexer.db",
  NETWORK_ID: "0",
};

// ─── Happy path — RED ─────────────────────────────────────────────────────────
// These tests call loadConfig() directly; the stub throws, failing the test (RED).
// When Catherine implements loadConfig, they turn GREEN by asserting correct values.

describe("loadConfig — happy path", () => {
  it("returns config object with all required fields from env", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.ogmiosUrl).toBe("ws://localhost:1337");
    expect(config.dbPath).toBe("/tmp/indexer.db");
    // SPEC FIX 2026-04-27: NETWORK_ID standardized to numeric "0"|"1"
    expect(config.networkId).toBe(0);
  });

  it("INDEXER_PORT defaults to 8090 when not provided", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.indexerPort).toBe(8090);
  });

  it("STATUS_POLL_MS defaults to 20000 when not provided", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.statusPollMs).toBe(20_000);
  });

  it("SKIP_BEFORE_SLOT defaults to 0 when not provided", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.skipBeforeSlot).toBe(0);
  });

  it("INDEXER_PORT is parsed from env string to number", () => {
    const config = loadConfig({ ...VALID_ENV, INDEXER_PORT: "9090" });
    expect(config.indexerPort).toBe(9090);
  });

  it("STATUS_POLL_MS is parsed from env string to number", () => {
    const config = loadConfig({ ...VALID_ENV, STATUS_POLL_MS: "5000" });
    expect(config.statusPollMs).toBe(5_000);
  });

  it("SKIP_BEFORE_SLOT is parsed from env string to number", () => {
    const config = loadConfig({ ...VALID_ENV, SKIP_BEFORE_SLOT: "22900000" });
    expect(config.skipBeforeSlot).toBe(22_900_000);
  });

  // SPEC FIX 2026-04-27: NETWORK_ID standardized to numeric "0"|"1"
  it("NETWORK_ID='1' (mainnet) is accepted and maps to networkId=1", () => {
    const config = loadConfig({ ...VALID_ENV, NETWORK_ID: "1" });
    expect(config.networkId).toBe(1);
  });
});

// ─── Missing required fields — these tests work regardless ────────────────────
// The stub throws for all inputs, satisfying the "throws" assertion.
// When implemented, these must throw for the correct reason (missing field).

describe("loadConfig — missing required fields", () => {
  it("throws when OGMIOS_URL is missing", () => {
    expect(() => {
      // SPEC FIX 2026-04-27: NETWORK_ID standardized to numeric "0"|"1"
      const env = { DB_PATH: "/tmp/indexer.db", NETWORK_ID: "0" };
      loadConfig(env);
    }).toThrow();
  });

  it("throws when DB_PATH is missing", () => {
    expect(() => {
      // SPEC FIX 2026-04-27: NETWORK_ID standardized to numeric "0"|"1"
      const env = { OGMIOS_URL: "ws://localhost:1337", NETWORK_ID: "0" };
      loadConfig(env);
    }).toThrow();
  });

  it("throws when NETWORK_ID is missing", () => {
    expect(() => {
      const env = { OGMIOS_URL: "ws://localhost:1337", DB_PATH: "/tmp/indexer.db" };
      loadConfig(env);
    }).toThrow();
  });
});

// ─── Malformed values — these tests work regardless ───────────────────────────

describe("loadConfig — malformed values", () => {
  it("throws when NETWORK_ID is not '0'|'1' (e.g. 'preprod')", () => {
    expect(() => {
      loadConfig({ ...VALID_ENV, NETWORK_ID: "preprod" });
    }).toThrow();
  });

  it("throws when INDEXER_PORT is non-numeric", () => {
    expect(() => {
      loadConfig({ ...VALID_ENV, INDEXER_PORT: "not-a-number" });
    }).toThrow();
  });

  it("throws when STATUS_POLL_MS is negative", () => {
    expect(() => {
      loadConfig({ ...VALID_ENV, STATUS_POLL_MS: "-1" });
    }).toThrow();
  });

  it("throws when OGMIOS_URL is empty string", () => {
    expect(() => {
      loadConfig({ ...VALID_ENV, OGMIOS_URL: "" });
    }).toThrow();
  });

  // ─── NEW RED: NETWORK_ID standardization — M1-F-1 ─────────────────────
  // SPEC FIX 2026-04-27: NETWORK_ID standardized to numeric "0"|"1"

  it("RED: rejects legacy NETWORK_ID='testnet' string with a clear error", () => {
    // Previously accepted; must now throw to enforce cross-service contract.
    // Catherine: loadConfig must reject any value outside "0"|"1".
    expect(() => {
      loadConfig({ ...VALID_ENV, NETWORK_ID: "testnet" });
    }).toThrow(/NETWORK_ID/);
  });

  it("RED: rejects out-of-range NETWORK_ID='2' with a clear error", () => {
    // Only "0" (testnet) and "1" (mainnet) are valid per NetworkId = 0 | 1.
    // Catherine: loadConfig must reject numeric-string values outside that range.
    expect(() => {
      loadConfig({ ...VALID_ENV, NETWORK_ID: "2" });
    }).toThrow(/NETWORK_ID/);
  });
});
