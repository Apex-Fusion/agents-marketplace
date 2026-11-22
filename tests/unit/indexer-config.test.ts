/**
 * tests/unit/indexer-config.test.ts — loadConfig of the indexer: the base settings and INDEXER_UI_DIST (identity settings: indexer-identity-config.test.ts).
 * SPEC FIX 2026-04-27: NETWORK_ID is "0" or "1" in every service; the old labels "testnet" and "mainnet" are refused.
 */

import { describe, it, expect } from "vitest";
import { loadConfig } from "../../indexer/src/config.js";

const VALID_ENV = {
  OGMIOS_URL: "ws://localhost:1337",
  DB_PATH: "/tmp/indexer.db",
  NETWORK_ID: "0",
};

describe("loadConfig — settings", () => {
  it.each([
    ["INDEXER_PORT", "indexerPort", "9090", 9090],
    ["STATUS_POLL_MS", "statusPollMs", "5000", 5_000],
    ["SKIP_BEFORE_SLOT", "skipBeforeSlot", "22900000", 22_900_000],
    ["MAX_SYNC_LAG_SLOTS", "maxSyncLagSlots", "120", 120],
  ] as const)("%s is parsed from the env string to a number", (name, key, raw, expected) => {
    expect(loadConfig({ ...VALID_ENV, [name]: raw })[key]).toBe(expected);
  });

  it("an empty MAX_SYNC_LAG_SLOTS counts as unset", () => {
    expect(loadConfig({ ...VALID_ENV, MAX_SYNC_LAG_SLOTS: "" }).maxSyncLagSlots).toBe(loadConfig(VALID_ENV).maxSyncLagSlots);
  });

  it("INDEXER_UI_DIST comes back as uiDistDir; an absent or empty one gives undefined (no UI mount)", () => {
    expect(loadConfig({ ...VALID_ENV, INDEXER_UI_DIST: "/repo/indexer-ui/dist" }).uiDistDir).toBe("/repo/indexer-ui/dist");
    expect(loadConfig(VALID_ENV).uiDistDir).toBeUndefined();
    expect(loadConfig({ ...VALID_ENV, INDEXER_UI_DIST: "" }).uiDistDir).toBeUndefined();
  });
});

describe("loadConfig — NETWORK_ID", () => {
  it.each([
    ["0", 0],
    ["1", 1],
  ] as const)("NETWORK_ID='%s' is accepted and maps to networkId=%i", (raw, networkId) => {
    expect(loadConfig({ ...VALID_ENV, NETWORK_ID: raw }).networkId).toBe(networkId);
  });

  // The legacy label and the out-of-range number must throw to keep the contract of the services.
  it.each(["preprod", "testnet", "2"])("rejects NETWORK_ID='%s' with a clear error", (raw) => {
    expect(() => loadConfig({ ...VALID_ENV, NETWORK_ID: raw })).toThrow(/NETWORK_ID must be "0"/);
  });
});

describe("loadConfig — missing and malformed settings", () => {
  it.each([
    ["OGMIOS_URL", undefined],
    ["OGMIOS_URL", ""],
    ["DB_PATH", undefined],
    ["NETWORK_ID", undefined],
  ])("throws and names %s when it is %j", (name, value) => {
    expect(() => loadConfig({ ...VALID_ENV, [name]: value })).toThrow(new RegExp(`${name} is required`));
  });

  it.each([
    ["INDEXER_PORT", "not-a-number"],
    ["STATUS_POLL_MS", "-1"],
    ["MAX_SYNC_LAG_SLOTS", "-1"],
    ["MAX_SYNC_LAG_SLOTS", "ten"],
  ])("throws and names %s when it is %j", (name, raw) => {
    expect(() => loadConfig({ ...VALID_ENV, [name]: raw })).toThrow(new RegExp(`${name} must be a non-negative integer`));
  });
});
