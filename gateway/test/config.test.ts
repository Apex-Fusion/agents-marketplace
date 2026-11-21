import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE_ENV = {
  GATEWAY_MASTER_KEY: "c7".repeat(32),
  INDEXER_URL: "http://indexer.test",
  OGMIOS_URL: "http://ogmios.test",
  LIVE_CHAIN: "1",
};

// Tests shorten these waits through a setting. A value that is no positive
// integer stops the boot (0 would poll in a tight loop).
describe("config: wait settings", () => {
  it.each([
    ["ONE_SHOT_POLL_INTERVAL_MS", "oneShotPollIntervalMs"],
    ["WALLET_CONFIRM_POLL_INTERVAL_MS", "walletConfirmPollIntervalMs"],
  ] as const)("%s takes only a positive integer", (name, field) => {
    expect(loadConfig({ ...BASE_ENV, [name]: "20" })[field]).toBe(20);
    for (const value of ["0", "-1", "1.5", "20ms"]) {
      expect(() => loadConfig({ ...BASE_ENV, [name]: value })).toThrow(name);
    }
  });
});
