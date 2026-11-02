/**
 * tests/unit/indexer-identity-config.test.ts — identity registry settings in loadConfig.
 */

import { describe, it, expect } from "vitest";

import { loadConfig } from "../../indexer/src/config.js";
import { ADVERT_SCRIPT_ADDRESS, ESCROW_SCRIPT_ADDRESS } from "../fixtures/indexer-side/sample-blocks.js";
import {
  IDENTITY_ADDRESS,
  IDENTITY_ADVERT_SCRIPT_ADDRESS,
  IDENTITY_ESCROW_SCRIPT_ADDRESS,
  IDENTITY_POLICY_ID,
  THIRD_PARTY_ADDRESS,
} from "../fixtures/indexer-side/identity-blocks.js";

const BASE = { OGMIOS_URL: "ws://localhost:1337", DB_PATH: "/tmp/indexer.db", NETWORK_ID: "0" };
const IDENTITY = {
  ...BASE,
  ADVERT_SCRIPT_ADDRESS,
  ESCROW_SCRIPT_ADDRESS,
  IDENTITY_POLICY_ID,
  IDENTITY_ADVERT_SCRIPT_ADDRESS,
  IDENTITY_ESCROW_SCRIPT_ADDRESS,
  IDENTITY_GATEWAY_URL: "http://identity-gateway:8080/",
};

describe("loadConfig — watched addresses", () => {
  it("reads the legacy addresses; identity support is off without IDENTITY_POLICY_ID", () => {
    const config = loadConfig({ ...BASE, ADVERT_SCRIPT_ADDRESS, ESCROW_SCRIPT_ADDRESS });
    expect(config).toMatchObject({
      advertAddress: ADVERT_SCRIPT_ADDRESS,
      escrowAddress: ESCROW_SCRIPT_ADDRESS,
      identity: null,
      switchSlot: null,
      resyncFrom: null,
    });
  });

  it("unset legacy addresses are empty (not watched)", () => {
    const config = loadConfig(BASE);
    expect([config.advertAddress, config.escrowAddress]).toEqual(["", ""]);
  });
});

describe("loadConfig — identity registry", () => {
  it("derives the identity address from the policy and applies the defaults", () => {
    expect(loadConfig(IDENTITY).identity).toEqual({
      policyId: IDENTITY_POLICY_ID,
      address: IDENTITY_ADDRESS,
      advertAddress: IDENTITY_ADVERT_SCRIPT_ADDRESS,
      escrowAddress: IDENTITY_ESCROW_SCRIPT_ADDRESS,
      gatewayUrl: "http://identity-gateway:8080",
      refreshMs: 60_000,
      loadAtStart: false,
    });
  });

  it("accepts IDENTITY_ADDRESS only when it is the enterprise address of the policy", () => {
    expect(loadConfig({ ...IDENTITY, IDENTITY_ADDRESS }).identity!.address).toBe(IDENTITY_ADDRESS);
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_ADDRESS: IDENTITY_ADVERT_SCRIPT_ADDRESS })).toThrow(/IDENTITY_ADDRESS must be/);
  });

  it.each(["IDENTITY_GATEWAY_URL", "IDENTITY_ADVERT_SCRIPT_ADDRESS", "SWITCH_SLOT", "IDENTITY_LOAD_AT_START"])(
    "%s without IDENTITY_POLICY_ID is an error",
    (name) => {
      expect(() => loadConfig({ ...BASE, [name]: "1" })).toThrow(new RegExp(`${name} needs IDENTITY_POLICY_ID`));
    },
  );

  it.each(["IDENTITY_ADVERT_SCRIPT_ADDRESS", "IDENTITY_ESCROW_SCRIPT_ADDRESS", "IDENTITY_GATEWAY_URL"])(
    "%s is required with IDENTITY_POLICY_ID",
    (name) => {
      expect(() => loadConfig({ ...IDENTITY, [name]: undefined })).toThrow(new RegExp(`${name} is required`));
    },
  );

  it("refuses a policy ID that is not 56 lowercase hex characters", () => {
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_POLICY_ID: IDENTITY_POLICY_ID.toUpperCase() })).toThrow(/IDENTITY_POLICY_ID/);
  });

  it("refuses a new contract address that is not an enterprise script address on NETWORK_ID", () => {
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_ESCROW_SCRIPT_ADDRESS: THIRD_PARTY_ADDRESS })).toThrow(/enterprise script address/);
    expect(() => loadConfig({ ...IDENTITY, NETWORK_ID: "1" })).toThrow(/enterprise script address on NETWORK_ID 1/);
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_ADVERT_SCRIPT_ADDRESS: "addr_test1notbech32" })).toThrow(/not a bech32 address/);
  });

  it("refuses a gateway URL that is not http or https", () => {
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_GATEWAY_URL: "identity-gateway:8080" })).toThrow(/http or https|not a URL/);
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_GATEWAY_URL: "ftp://gw" })).toThrow(/http or https/);
  });

  it("IDENTITY_REFRESH_MS must stay below the 10-minute limit of a kept answer", () => {
    expect(loadConfig({ ...IDENTITY, IDENTITY_REFRESH_MS: "30000" }).identity!.refreshMs).toBe(30_000);
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_REFRESH_MS: "600000" })).toThrow(/IDENTITY_REFRESH_MS/);
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_REFRESH_MS: "999" })).toThrow(/IDENTITY_REFRESH_MS/);
  });

  it("IDENTITY_LOAD_AT_START takes 1/true/0/false", () => {
    expect(loadConfig({ ...IDENTITY, IDENTITY_LOAD_AT_START: "1" }).identity!.loadAtStart).toBe(true);
    expect(loadConfig({ ...IDENTITY, IDENTITY_LOAD_AT_START: "false" }).identity!.loadAtStart).toBe(false);
    expect(() => loadConfig({ ...IDENTITY, IDENTITY_LOAD_AT_START: "yes" })).toThrow(/IDENTITY_LOAD_AT_START/);
  });

  it("SWITCH_SLOT is a slot number", () => {
    expect(loadConfig({ ...IDENTITY, SWITCH_SLOT: "123456" }).switchSlot).toBe(123_456);
    expect(() => loadConfig({ ...IDENTITY, SWITCH_SLOT: "-1" })).toThrow(/SWITCH_SLOT/);
  });

  it("every watched address must differ", () => {
    expect(() => loadConfig({ ...IDENTITY, ADVERT_SCRIPT_ADDRESS: IDENTITY_ADVERT_SCRIPT_ADDRESS })).toThrow(/must all differ/);
  });
});

describe("loadConfig — resync point", () => {
  const HASH = "ab".repeat(32);

  it("reads RESYNC_FROM_SLOT with RESYNC_FROM_BLOCK_HASH", () => {
    expect(loadConfig({ ...BASE, RESYNC_FROM_SLOT: "5000", RESYNC_FROM_BLOCK_HASH: HASH }).resyncFrom).toEqual({ slot: 5_000, blockHash: HASH });
  });

  it("needs both values, a 64-hex block hash, and a slot not below SKIP_BEFORE_SLOT", () => {
    expect(() => loadConfig({ ...BASE, RESYNC_FROM_SLOT: "5000" })).toThrow(/go together/);
    expect(() => loadConfig({ ...BASE, RESYNC_FROM_SLOT: "5000", RESYNC_FROM_BLOCK_HASH: "xyz" })).toThrow(/RESYNC_FROM_BLOCK_HASH/);
    expect(() => loadConfig({ ...BASE, SKIP_BEFORE_SLOT: "6000", RESYNC_FROM_SLOT: "5000", RESYNC_FROM_BLOCK_HASH: HASH }))
      .toThrow(/SKIP_BEFORE_SLOT/);
  });
});
