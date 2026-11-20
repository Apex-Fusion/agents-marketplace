// The setting STATUS_LIST_FOLLOW_SECONDS: how often the timer reads the changes of the chain into the
// status lists. It is 0 (the lists change only when a build ends) or a multiple of the timer tick, up
// to MAX_FOLLOW_MS. The default is one tick.

import { describe, expect, test } from "vitest";
import { loadM4Config } from "../../src/m4/config.js";
import { DEFAULT_FOLLOW_MS, MAX_FOLLOW_MS, REFRESH_TICK_MS, checkTiming } from "../../src/m4/status-lists.js";
import { LedgerBuilder } from "../support/ledger.js";
import { listsOn } from "./status-list-support.js";
import { NOW } from "./support.js";

const BASE_URL = "https://id.vector.apexfusion.org";
const KEYS = { GATEWAY_ED25519_KEY_FILE: "/run/secrets/ed25519.pem", GATEWAY_P256_KEY_FILE: "/run/secrets/p256.pem", GATEWAY_VECTOR_ID: "ab".repeat(32) };
const FOLLOW = "STATUS_LIST_FOLLOW_SECONDS";

/** The follow interval (ms) that the environment gives. */
function follow(env: Record<string, string> = {}): number {
  const config = loadM4Config({ ...KEYS, ...env }, BASE_URL);
  if (config === null) throw new Error("the key files are set, so the M4 services are configured");
  return config.statusListFollowMs ?? NaN;
}

describe("the follow interval", () => {
  test("the default is one tick of the timer, 10 s", () => {
    expect(follow()).toBe(10_000);
    expect(follow({ [FOLLOW]: "" })).toBe(10_000);
    expect(DEFAULT_FOLLOW_MS).toBe(REFRESH_TICK_MS);
    expect(MAX_FOLLOW_MS).toBe(300_000);
  });

  test.each([
    ["0", 0],
    ["10", 10_000],
    ["30", 30_000],
    ["120", 120_000],
    ["300", 300_000],
  ])("the environment gives %s s", (value, ms) => {
    expect(follow({ [FOLLOW]: value })).toBe(ms);
  });

  test.each([
    ["5 s, less than a tick", "5", 5],
    ["15 s, not a multiple of the tick", "15", 15],
    ["305 s", "305", 305],
    ["310 s, above the longest", "310", 310],
    ["an hour", "3600", 3600],
  ])("%s is refused", (_name, value, shown) => {
    expect(() => follow({ [FOLLOW]: value })).toThrow(
      `${FOLLOW} must be 0 (the lists do not follow the chain) or a multiple of 10 s from 10 to 300 s, got ${shown}.`,
    );
  });

  test.each(["10.5", "abc", "-10", "1e1", " 10", "0x0a"])("a value that is not a whole number of seconds is refused: %j", (value) => {
    expect(() => follow({ [FOLLOW]: value })).toThrow(`${FOLLOW} must be a whole number of seconds`);
  });

  test("the other two intervals keep their limits, and they are checked first", () => {
    expect(() => follow({ STATUS_LIST_BACKGROUND_REFRESH_SECONDS: "59", [FOLLOW]: "15" })).toThrow(/STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be from 60 to 2700 s/);
    expect(() => checkTiming(60_000, 600_000)).not.toThrow();
    expect(() => checkTiming(60_000, 600_000, 0)).not.toThrow();
    expect(() => checkTiming(60_000, 600_000, 20_000)).not.toThrow();
    expect(() => checkTiming(60_000, 600_000, 25_000)).toThrow(`${FOLLOW} must be 0`);
  });

  test("the services refuse a follow interval that breaks the rule, with the same message", () => {
    const options = { clock: { now: NOW } };
    expect(() => listsOn(new LedgerBuilder(), { ...options, followMs: 15_000 })).toThrow(`${FOLLOW} must be 0`);
    expect(() => listsOn(new LedgerBuilder(), { ...options, followMs: 310_000 })).toThrow(`${FOLLOW} must be 0`);
    expect(() => listsOn(new LedgerBuilder(), { ...options, followMs: 0 })).not.toThrow();
    expect(() => listsOn(new LedgerBuilder(), { ...options, followMs: 300_000 })).not.toThrow();
    expect(() => listsOn(new LedgerBuilder(), options)).not.toThrow();
  });
});
