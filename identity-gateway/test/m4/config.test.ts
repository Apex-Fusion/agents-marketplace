// The M4 settings from the environment: the two status-list intervals and the timing rule that they
// must meet. A list is valid for LIST_VALIDITY_MS; the timer starts a build when the lists are older
// than the background interval; an interval plus BUILD_ALLOWANCE_MS must fit in the validity.

import { describe, expect, test } from "vitest";
import { loadM4Config } from "../../src/m4/config.js";
import { BUILD_ALLOWANCE_MS, DEFAULT_BACKGROUND_REFRESH_MS, LIST_VALIDITY_MS } from "../../src/m4/status-lists.js";

const BASE_URL = "https://id.vector.apexfusion.org";
const KEYS = { GATEWAY_ED25519_KEY_FILE: "/run/secrets/ed25519.pem", GATEWAY_P256_KEY_FILE: "/run/secrets/p256.pem", GATEWAY_VECTOR_ID: "ab".repeat(32) };

/** The refresh interval and the background interval (ms) that the environment gives. */
function intervals(env: Record<string, string> = {}): [number, number] {
  const config = loadM4Config({ ...KEYS, ...env }, BASE_URL);
  if (config === null) throw new Error("the key files are set, so the M4 services are configured");
  return [config.statusListRefreshMs, config.statusListBackgroundRefreshMs ?? NaN];
}

const REFRESH = "STATUS_LIST_REFRESH_SECONDS";
const BACKGROUND = "STATUS_LIST_BACKGROUND_REFRESH_SECONDS";
/** The longest interval in seconds: the validity of a list less the allowance. */
const LONGEST = (LIST_VALIDITY_MS - BUILD_ALLOWANCE_MS) / 1000;

describe("the status-list intervals", () => {
  test("the defaults: a request builds lists that are 60 s old, the timer lists that are 600 s old", () => {
    expect(intervals()).toEqual([60_000, 600_000]);
    expect(intervals({ [REFRESH]: "", [BACKGROUND]: "" })).toEqual([60_000, 600_000]);
    expect(DEFAULT_BACKGROUND_REFRESH_MS).toBe(600_000);
  });

  test("the environment sets both, up to the longest interval that the timing rule allows", () => {
    expect(intervals({ [REFRESH]: "120", [BACKGROUND]: "900" })).toEqual([120_000, 900_000]);
    expect(intervals({ [REFRESH]: "1", [BACKGROUND]: "60" })).toEqual([1_000, 60_000]);
    expect(LONGEST).toBe(2_700);
    expect(intervals({ [REFRESH]: String(LONGEST), [BACKGROUND]: String(LONGEST) })).toEqual([LONGEST * 1000, LONGEST * 1000]);
  });

  test.each<[string, Record<string, string>, RegExp]>([
    ["a background interval of 59 s", { [BACKGROUND]: "59" }, /STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be from 60 to 2700 s, got 59\./],
    ["a background interval above the longest", { [BACKGROUND]: String(LONGEST + 1) }, /STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be from 60 to 2700 s, got 2701\./],
    ["a refresh interval of 0", { [REFRESH]: "0" }, /STATUS_LIST_REFRESH_SECONDS must be from 1 to 2700 s, got 0\./],
    ["a refresh interval above the longest", { [REFRESH]: String(LONGEST + 1), [BACKGROUND]: String(LONGEST) }, /STATUS_LIST_REFRESH_SECONDS must be from 1 to 2700 s, got 2701\./],
    ["a refresh interval of the whole validity, which the setting allowed before", { [REFRESH]: "3600", [BACKGROUND]: "600" }, /STATUS_LIST_REFRESH_SECONDS must be from 1 to 2700 s, got 3600\./],
    ["a background interval that is shorter than the refresh interval", { [REFRESH]: "900", [BACKGROUND]: "600" }, /STATUS_LIST_BACKGROUND_REFRESH_SECONDS must not be shorter than STATUS_LIST_REFRESH_SECONDS/],
  ])("%s is refused", (_name, env, message) => {
    expect(() => intervals(env)).toThrow(message);
  });

  test("a background interval as long as the refresh interval is accepted", () => {
    expect(intervals({ [REFRESH]: "600", [BACKGROUND]: "600" })).toEqual([600_000, 600_000]);
  });

  test.each(["60.5", "abc", "-1", "1e3", " 60", "0x3c"])("a value that is not a whole number of seconds is refused: %j", (value) => {
    expect(() => intervals({ [BACKGROUND]: value })).toThrow(/STATUS_LIST_BACKGROUND_REFRESH_SECONDS must be a whole number of seconds/);
    expect(() => intervals({ [REFRESH]: value })).toThrow(/STATUS_LIST_REFRESH_SECONDS must be a whole number of seconds/);
  });

  test("a refusal states the rule: the validity of a list and the allowance for the timer check and a build", () => {
    let message = "";
    try {
      intervals({ [BACKGROUND]: String(LONGEST + 1) });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain(`A list is valid for ${LIST_VALIDITY_MS / 1000} s`);
    expect(message).toContain(`${BUILD_ALLOWANCE_MS / 1000} s for the check of the timer and for a build`);
  });
});
