/**
 * cli-post-advert-cli.test.ts — parseCliArgs(argv, env) of the `tx:post-advert` CLI.
 *
 * Tests the pure argument-parsing function in supplier/src/cli/post-advert.ts.
 * No subprocess spawning; no real Ogmios.
 *
 * Each table row reaches one branch of parseCliArgs. The first case is the accepted control:
 * the refusal rows change one variable of the same full env.
 *
 * Spec: supplier/src/cli/post-advert.ts + ARCHITECTURE.md §4.1.
 */

import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../../supplier/src/cli/post-advert.js";
import {
  buildCliEnv,
  SHA256_EMPTY,
  CLI_ADVERT_MAX_OUTPUT_TOKENS,
  CLI_ADVERT_MAX_PROCESSING_MS,
  CLI_ADVERT_PRICE_LOVELACE,
  CLI_ADVERT_SUPPLIER_BOND_LOVELACE,
  CLI_ADVERT_BUYER_BOND_LOVELACE,
} from "../fixtures/supplier-side/sample-advert-datum.js";
import { SUPPLIER_PRIVATE_KEY_HEX } from "../fixtures/supplier-side/wallet-keys.js";

type Env = Record<string, string | undefined>;

describe("parseCliArgs() — full env, no flags", () => {
  it("parses the key, the network and the numbers of a full env", () => {
    expect(parseCliArgs([], buildCliEnv())).toMatchObject({
      privKeyHex: SUPPLIER_PRIVATE_KEY_HEX,
      networkId: 0,
      maxOutputTokens: CLI_ADVERT_MAX_OUTPUT_TOKENS,
      maxProcessingMs: CLI_ADVERT_MAX_PROCESSING_MS,
      priceLovelace: CLI_ADVERT_PRICE_LOVELACE,
      supplierBondLovelace: CLI_ADVERT_SUPPLIER_BOND_LOVELACE,
      buyerBondLovelace: CLI_ADVERT_BUYER_BOND_LOVELACE,
    });
  });
});

describe("parseCliArgs() — flags", () => {
  it.each([
    ["--dry-run", "dryRun"],
    ["--mock", "useMock"],
  ])("%s sets %s: true", (flag, field) => {
    expect(parseCliArgs([flag], buildCliEnv())).toMatchObject({ [field]: true });
  });

  it("--priv-key overrides SUPPLIER_PRIV_KEY_HEX", () => {
    const flagPrivKey = "1".repeat(64);
    expect(parseCliArgs(["--priv-key", flagPrivKey], buildCliEnv()).privKeyHex).toBe(flagPrivKey);
  });

  it("--priv-key refuses a value that is not 64 hex chars", () => {
    expect(() => parseCliArgs(["--priv-key", "short"], buildCliEnv())).toThrow(/64 lowercase hex/);
  });

  it("--await-timeout-ms parses as integer ms", () => {
    expect(parseCliArgs(["--await-timeout-ms", "60000"], buildCliEnv()).awaitTimeoutMs).toBe(60_000);
  });

  it("throws 'unknown flag: <flag>' on an unrecognised --flag, also after a known flag", () => {
    expect(() => parseCliArgs(["--dry-run", "--bogus"], buildCliEnv())).toThrow(/unknown flag: --bogus/);
  });
});

describe("parseCliArgs() — ogmiosUrl", () => {
  const FLAG_URL = "https://flag.ogmios.example.com";
  const ENV_URL = "https://env.ogmios.example.com";

  it.each([
    ["the --ogmios-url flag, over OGMIOS_URL", ["--ogmios-url", FLAG_URL], ENV_URL, FLAG_URL],
    ["OGMIOS_URL", [], ENV_URL, ENV_URL],
    ["the public testnet default, when OGMIOS_URL is absent and NETWORK_ID is 0", [], undefined, "https://ogmios.vector.testnet.apexfusion.org"],
  ])("takes ogmiosUrl from %s", (_source, argv, envUrl, expected) => {
    const env: Env = { ...buildCliEnv(), OGMIOS_URL: envUrl };
    expect(parseCliArgs(argv, env).ogmiosUrl).toBe(expected);
  });
});

describe("parseCliArgs() — missing required env vars", () => {
  // Each variable has its own check in parseCliArgs. ADVERT_CAPABILITY_ID and ADVERT_MODEL go through
  // advertEnv, where an empty value counts as absent, so one of them is empty here.
  it.each([
    ["NETWORK_ID", "absent"],
    ["SUPPLIER_PRIV_KEY_HEX", "absent"],
    ["ADVERT_CAPABILITY_ID", "absent"],
    ["ADVERT_MODEL", "empty"],
    ["ADVERT_PRICE_LOVELACE", "absent"],
    ["ADVERT_ENDPOINT_URL", "absent"],
  ])("throws when %s is %s", (name, state) => {
    const env: Env = { ...buildCliEnv() };
    if (state === "absent") delete env[name];
    else env[name] = "";
    expect(() => parseCliArgs([], env)).toThrow(`missing required env var: ${name}`);
  });
});

describe("parseCliArgs() — malformed env values", () => {
  it.each([
    ["ADVERT_PRICE_LOVELACE", "not-a-number"],
    ["NETWORK_ID", "2"],
  ])("throws when %s is %j", (name, value) => {
    expect(() => parseCliArgs([], { ...buildCliEnv(), [name]: value })).toThrow(name);
  });
});

describe("parseCliArgs() — ADVERT_DETAIL_HASH", () => {
  it.each([
    ["is absent", undefined, SHA256_EMPTY],
    ["is an empty string", "", SHA256_EMPTY],
    ["is 64 hex chars", "b".repeat(64), "b".repeat(64)],
  ])("detailHash when ADVERT_DETAIL_HASH %s", (_case, value, expected) => {
    const env: Env = { ...buildCliEnv(), ADVERT_DETAIL_HASH: value };
    expect(parseCliArgs([], env).detailHash).toBe(expected);
  });
});

describe("parseCliArgs() — bond defaults", () => {
  it.each([
    ["ADVERT_SUPPLIER_BOND_LOVELACE", "supplierBondLovelace"],
    ["ADVERT_BUYER_BOND_LOVELACE", "buyerBondLovelace"],
  ])("%s is absent: %s defaults to 1_000_000n", (name, field) => {
    const env: Env = { ...buildCliEnv() };
    delete env[name];
    expect(parseCliArgs([], env)).toMatchObject({ [field]: 1_000_000n });
  });
});
