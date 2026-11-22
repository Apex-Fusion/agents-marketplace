// The status-list settings of the M4 services (src/m4/config.ts): STATUS_LIST_REFRESH_SECONDS (how old
// lists are before a request builds them again), STATUS_LIST_BACKGROUND_REFRESH_SECONDS (before the
// timer builds them again) and STATUS_LIST_FOLLOW_SECONDS (how often the timer reads the changes of the
// chain into the lists). A list is valid for LIST_VALIDITY_MS, and an interval plus BUILD_ALLOWANCE_MS
// must fit in that time (`checkTiming`). The follow interval is 0 (the lists change only when a build
// ends) or a multiple of the timer tick, up to MAX_FOLLOW_MS.

import { describe, expect, test } from "vitest";
import { loadM4Config } from "../../src/m4/config.js";
import { checkTiming } from "../../src/m4/status-lists.js";
import { LedgerBuilder } from "../support/ledger.js";
import { listsOn, type ServiceOptions } from "./status-list-support.js";
import { NOW } from "./support.js";

const BASE_URL = "https://id.vector.apexfusion.org";
const KEYS = { GATEWAY_ED25519_KEY_FILE: "/run/secrets/ed25519.pem", GATEWAY_P256_KEY_FILE: "/run/secrets/p256.pem", GATEWAY_VECTOR_ID: "ab".repeat(32) };
const REFRESH = "STATUS_LIST_REFRESH_SECONDS";
const BACKGROUND = "STATUS_LIST_BACKGROUND_REFRESH_SECONDS";
const FOLLOW = "STATUS_LIST_FOLLOW_SECONDS";

interface Intervals {
  readonly refresh: number;
  readonly background: number;
  readonly follow: number;
}

/** The three intervals (ms) that the environment gives. */
function load(env: Record<string, string>): Intervals {
  const config = loadM4Config({ ...KEYS, ...env }, BASE_URL);
  if (config === null) throw new Error("the key files are set, so the M4 services are configured");
  return { refresh: config.statusListRefreshMs, background: config.statusListBackgroundRefreshMs ?? NaN, follow: config.statusListFollowMs ?? NaN };
}

/** The refusal of a follow interval that `seconds` names. */
const followRefusal = (seconds: number): string =>
  `${FOLLOW} must be 0 (the lists do not follow the chain) or a multiple of 10 s from 10 to 300 s, got ${seconds}.`;

describe("the status-list settings", () => {
  test.each<[string, Record<string, string>, Partial<Intervals>]>([
    ["the shortest refresh and background intervals", { [REFRESH]: "1", [BACKGROUND]: "60" }, { refresh: 1_000, background: 60_000 }],
    ["the longest refresh and background intervals, which are equal", { [REFRESH]: "2400", [BACKGROUND]: "2400" }, { refresh: 2_400_000, background: 2_400_000 }],
    ["no follow steps", { [FOLLOW]: "0" }, { follow: 0 }],
    ["the shortest follow interval, one tick of the timer", { [FOLLOW]: "10" }, { follow: 10_000 }],
    ["the longest follow interval", { [FOLLOW]: "300" }, { follow: 300_000 }],
  ])("the environment gives %s", (_name, env, expected) => {
    expect(load(env)).toMatchObject(expected);
  });

  test.each<[string, Record<string, string>, string | RegExp]>([
    ["a refresh interval of 0", { [REFRESH]: "0" }, /STATUS_LIST_REFRESH_SECONDS must be from 1 to 2400 s, got 0\./],
    // The setting allowed the whole validity of a list before the allowance for a build was raised.
    ["a refresh interval of the whole validity", { [REFRESH]: "3600", [BACKGROUND]: "600" }, /STATUS_LIST_REFRESH_SECONDS must be from 1 to 2400 s, got 3600\./],
    ["a background interval of 59 s", { [BACKGROUND]: "59" }, /STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be from 60 to 2400 s, got 59\./],
    [
      "a background interval that is shorter than the refresh interval",
      { [REFRESH]: "900", [BACKGROUND]: "600" },
      /STATUS_LIST_BACKGROUND_REFRESH_SECONDS must not be shorter than STATUS_LIST_REFRESH_SECONDS/,
    ],
    ["a follow interval of 5 s, less than a tick", { [FOLLOW]: "5" }, followRefusal(5)],
    ["a follow interval of 15 s, not a multiple of the tick", { [FOLLOW]: "15" }, followRefusal(15)],
    ["a follow interval of 310 s, above the longest", { [FOLLOW]: "310" }, followRefusal(310)],
  ])("%s is refused", (_name, env, message) => {
    expect(() => load(env)).toThrow(message);
  });

  test.each(["60.5", "-1", "1e3"])("a value that is not a whole number of seconds is refused for each setting: %j", (value) => {
    for (const name of [REFRESH, BACKGROUND, FOLLOW]) {
      expect(() => load({ [name]: value }), name).toThrow(`${name} must be a whole number of seconds`);
    }
  });

  test("the other two intervals keep their limits, and they are checked first", () => {
    expect(() => load({ [BACKGROUND]: "59", [FOLLOW]: "15" })).toThrow(/STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be from 60 to 2400 s/);
    expect(() => checkTiming(60_000, 600_000)).not.toThrow();
    expect(() => checkTiming(60_000, 600_000, 0)).not.toThrow();
    expect(() => checkTiming(60_000, 600_000, 20_000)).not.toThrow();
    expect(() => checkTiming(60_000, 600_000, 25_000)).toThrow(`${FOLLOW} must be 0`);
  });

  test("the longest interval is 2400 s with the steps on or off, so a list cannot expire before a build of up to 590 s ends", () => {
    for (const followMs of [0, 10_000, 300_000]) {
      expect(() => checkTiming(2_400_000, 2_400_000, followMs)).not.toThrow();
      expect(() => checkTiming(60_000, 2_401_000, followMs)).toThrow(/STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be from 60 to 2400 s, got 2401\./);
      expect(() => checkTiming(2_401_000, 2_401_000, followMs)).toThrow(/STATUS_LIST_REFRESH_SECONDS must be from 1 to 2400 s, got 2401\./);
    }
    // The intervals that the rule allowed before this limit.
    expect(() => checkTiming(2_700_000, 2_700_000, 0)).toThrow(/STATUS_LIST_REFRESH_SECONDS must be from 1 to 2400 s, got 2700\./);
    expect(() => checkTiming(60_000, 2_700_000, 0)).toThrow(/STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be from 60 to 2400 s, got 2700\./);
    // The refusal states the rule with the allowance of this limit.
    expect(() => checkTiming(60_000, 2_401_000, 0)).toThrow("1200 s for the check of the timer and for a build");
  });
});

describe("the status-list service", () => {
  type Settings = Pick<ServiceOptions, "refreshMs" | "backgroundRefreshMs" | "followMs">;

  // Each row names one of the three arguments of `checkTiming` that the constructor passes, or their order.
  test.each<[string, Settings, string]>([
    ["a follow interval that is not a multiple of the tick", { followMs: 15_000 }, `${FOLLOW} must be 0`],
    ["a background interval of 59 s", { backgroundRefreshMs: 59_000 }, "STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be from 60 to 2400 s"],
    ["a refresh interval above the longest", { refreshMs: 2_401_000, backgroundRefreshMs: 2_400_000 }, "STATUS_LIST_REFRESH_SECONDS must be from 1 to 2400 s"],
    ["a background interval that is shorter than the refresh interval", { refreshMs: 900_000, backgroundRefreshMs: 600_000 }, "must not be shorter than STATUS_LIST_REFRESH_SECONDS"],
  ])("refuses %s, with the message of the setting", (_name, settings, message) => {
    expect(() => listsOn(new LedgerBuilder(), { clock: { now: NOW }, ...settings })).toThrow(message);
  });

  test("accepts the limits of the settings and the defaults", () => {
    const accepted: Settings[] = [{}, { followMs: 0 }, { followMs: 300_000 }, { backgroundRefreshMs: 60_000 }, { backgroundRefreshMs: 2_400_000 }, { refreshMs: 600_000, backgroundRefreshMs: 600_000 }];
    for (const settings of accepted) {
      expect(() => listsOn(new LedgerBuilder(), { clock: { now: NOW }, ...settings })).not.toThrow();
    }
  });
});
