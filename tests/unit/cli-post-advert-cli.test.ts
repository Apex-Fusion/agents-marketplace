/**
 * cli-post-advert-cli.test.ts — RED phase tests for M1-F-3
 *
 * Tests parseCliArgs(argv, env) — the pure argument-parsing function in
 * supplier/src/cli/post-advert.ts. No subprocess spawning; no real Ogmios.
 *
 * All tests are expected to FAIL (red) until Catherine implements
 * parseCliArgs in M1-F-3-green.
 *
 * Spec: supplier/src/cli/post-advert.ts + ARCHITECTURE.md §4.1.
 */

import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../../supplier/src/cli/post-advert.js";
import {
  buildCliEnv,
  SHA256_EMPTY,
  CLI_ADVERT_CAPABILITY_ID,
  CLI_ADVERT_MODEL,
  CLI_ADVERT_MAX_OUTPUT_TOKENS,
  CLI_ADVERT_MAX_PROCESSING_MS,
  CLI_ADVERT_PRICE_LOVELACE,
  CLI_ADVERT_SUPPLIER_BOND_LOVELACE,
  CLI_ADVERT_BUYER_BOND_LOVELACE,
  CLI_ADVERT_ENDPOINT_URL,
  CLI_ADVERT_DETAIL_URI,
  CLI_ADVERT_DETAIL_HASH,
} from "../fixtures/supplier-side/sample-advert-datum.js";
import { SUPPLIER_PRIVATE_KEY_HEX } from "../fixtures/supplier-side/wallet-keys.js";

// ─── Happy path: full env, no flags ──────────────────────────────────────────

describe("parseCliArgs() — happy path: full env no flags", () => {
  it("returns a valid CliConfig when all required env vars are populated", () => {
    const cfg = parseCliArgs([], buildCliEnv());
    expect(cfg.privKeyHex).toBe(SUPPLIER_PRIVATE_KEY_HEX);
    expect(cfg.networkId).toBe(0);
    expect(cfg.capabilityId).toBe(CLI_ADVERT_CAPABILITY_ID);
    expect(cfg.model).toBe(CLI_ADVERT_MODEL);
    expect(cfg.maxOutputTokens).toBe(CLI_ADVERT_MAX_OUTPUT_TOKENS);
    expect(cfg.maxProcessingMs).toBe(CLI_ADVERT_MAX_PROCESSING_MS);
    expect(cfg.priceLovelace).toBe(CLI_ADVERT_PRICE_LOVELACE);
    expect(cfg.supplierBondLovelace).toBe(CLI_ADVERT_SUPPLIER_BOND_LOVELACE);
    expect(cfg.buyerBondLovelace).toBe(CLI_ADVERT_BUYER_BOND_LOVELACE);
    expect(cfg.endpointUrl).toBe(CLI_ADVERT_ENDPOINT_URL);
    expect(cfg.detailUri).toBe(CLI_ADVERT_DETAIL_URI);
    expect(cfg.detailHash).toBe(CLI_ADVERT_DETAIL_HASH);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.useMock).toBe(false);
    expect(cfg.awaitTimeoutMs).toBe(120_000);
  });

  it("ogmiosUrl comes from env OGMIOS_URL when set", () => {
    const env = { ...buildCliEnv(), OGMIOS_URL: "https://custom.ogmios.example.com" };
    const cfg = parseCliArgs([], env);
    expect(cfg.ogmiosUrl).toBe("https://custom.ogmios.example.com");
  });
});

// ─── --dry-run flag ──────────────────────────────────────────────────────────

describe("parseCliArgs() — --dry-run flag", () => {
  it("sets dryRun: true", () => {
    const cfg = parseCliArgs(["--dry-run"], buildCliEnv());
    expect(cfg.dryRun).toBe(true);
  });

  it("dryRun defaults to false when flag is absent", () => {
    const cfg = parseCliArgs([], buildCliEnv());
    expect(cfg.dryRun).toBe(false);
  });
});

// ─── --mock flag ─────────────────────────────────────────────────────────────

describe("parseCliArgs() — --mock flag", () => {
  it("sets useMock: true", () => {
    const cfg = parseCliArgs(["--mock"], buildCliEnv());
    expect(cfg.useMock).toBe(true);
  });

  it("useMock defaults to false when flag is absent", () => {
    const cfg = parseCliArgs([], buildCliEnv());
    expect(cfg.useMock).toBe(false);
  });
});

// ─── --ogmios-url override ───────────────────────────────────────────────────

describe("parseCliArgs() — --ogmios-url flag overrides env", () => {
  it("sets ogmiosUrl to the flag value, ignoring env OGMIOS_URL", () => {
    const env = { ...buildCliEnv(), OGMIOS_URL: "https://env.ogmios.example.com" };
    const cfg = parseCliArgs(["--ogmios-url", "https://flag.ogmios.example.com"], env);
    expect(cfg.ogmiosUrl).toBe("https://flag.ogmios.example.com");
  });
});

// ─── --priv-key override ─────────────────────────────────────────────────────

describe("parseCliArgs() — --priv-key flag overrides env", () => {
  it("sets privKeyHex from the flag value", () => {
    // 64-char hex string different from the env value
    const flagPrivKey = "1".repeat(64);
    const cfg = parseCliArgs(["--priv-key", flagPrivKey], buildCliEnv());
    expect(cfg.privKeyHex).toBe(flagPrivKey);
  });

  it("throws when --priv-key value is not 64 hex chars", () => {
    expect(() =>
      parseCliArgs(["--priv-key", "short"], buildCliEnv()),
    ).toThrow();
  });
});

// ─── OGMIOS_URL default for testnet ──────────────────────────────────────────

describe("parseCliArgs() — OGMIOS_URL default", () => {
  it("defaults ogmiosUrl to 'https://ogmios.vector.testnet.apexfusion.org' when OGMIOS_URL is absent and NETWORK_ID='0'", () => {
    const env = { ...buildCliEnv() };
    delete env.OGMIOS_URL;
    const cfg = parseCliArgs([], env);
    expect(cfg.ogmiosUrl).toBe("https://ogmios.vector.testnet.apexfusion.org");
  });
});

// ─── Missing required env vars ───────────────────────────────────────────────

describe("parseCliArgs() — missing required env vars", () => {
  it("throws when SUPPLIER_PRIV_KEY_HEX is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.SUPPLIER_PRIV_KEY_HEX;
    expect(() => parseCliArgs([], env)).toThrow(/SUPPLIER_PRIV_KEY_HEX/i);
  });

  it("throws when NETWORK_ID is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.NETWORK_ID;
    expect(() => parseCliArgs([], env)).toThrow(/NETWORK_ID/i);
  });

  it("throws when ADVERT_CAPABILITY_ID is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.ADVERT_CAPABILITY_ID;
    expect(() => parseCliArgs([], env)).toThrow(/ADVERT_CAPABILITY_ID/i);
  });

  it("throws when ADVERT_MODEL is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.ADVERT_MODEL;
    expect(() => parseCliArgs([], env)).toThrow(/ADVERT_MODEL/i);
  });

  it("throws when ADVERT_PRICE_LOVELACE is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.ADVERT_PRICE_LOVELACE;
    expect(() => parseCliArgs([], env)).toThrow(/ADVERT_PRICE_LOVELACE/i);
  });

  it("throws when ADVERT_ENDPOINT_URL is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.ADVERT_ENDPOINT_URL;
    expect(() => parseCliArgs([], env)).toThrow(/ADVERT_ENDPOINT_URL/i);
  });
});

// ─── Malformed env values ─────────────────────────────────────────────────────

describe("parseCliArgs() — malformed env values", () => {
  it("throws when ADVERT_PRICE_LOVELACE is non-numeric", () => {
    expect(() =>
      parseCliArgs([], { ...buildCliEnv(), ADVERT_PRICE_LOVELACE: "not-a-number" }),
    ).toThrow();
  });

  it("throws when NETWORK_ID is '2'", () => {
    expect(() =>
      parseCliArgs([], { ...buildCliEnv(), NETWORK_ID: "2" }),
    ).toThrow();
  });

  it("throws when NETWORK_ID is 'mainnet' (not a numeric 0/1)", () => {
    expect(() =>
      parseCliArgs([], { ...buildCliEnv(), NETWORK_ID: "mainnet" }),
    ).toThrow();
  });
});

// ─── --await-timeout-ms ───────────────────────────────────────────────────────

describe("parseCliArgs() — --await-timeout-ms flag", () => {
  it("parses --await-timeout-ms as integer ms", () => {
    const cfg = parseCliArgs(["--await-timeout-ms", "60000"], buildCliEnv());
    expect(cfg.awaitTimeoutMs).toBe(60_000);
  });

  it("defaults awaitTimeoutMs to 120_000 when flag is absent", () => {
    const cfg = parseCliArgs([], buildCliEnv());
    expect(cfg.awaitTimeoutMs).toBe(120_000);
  });
});

// ─── Unknown flag ─────────────────────────────────────────────────────────────

describe("parseCliArgs() — unknown flags", () => {
  it("throws with 'unknown flag: --unknown-flag' when an unrecognised flag is passed", () => {
    expect(() =>
      parseCliArgs(["--unknown-flag"], buildCliEnv()),
    ).toThrow(/unknown flag: --unknown-flag/);
  });

  it("throws on any unrecognised --flag regardless of position", () => {
    expect(() =>
      parseCliArgs(["--dry-run", "--bogus"], buildCliEnv()),
    ).toThrow(/unknown flag: --bogus/);
  });
});

// ─── ADVERT_DETAIL_HASH default ───────────────────────────────────────────────

describe("parseCliArgs() — ADVERT_DETAIL_HASH default", () => {
  it("defaults detailHash to sha256('') when ADVERT_DETAIL_HASH is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.ADVERT_DETAIL_HASH;
    const cfg = parseCliArgs([], env);
    expect(cfg.detailHash).toBe(SHA256_EMPTY);
  });

  it("defaults detailHash to sha256('') when ADVERT_DETAIL_HASH is empty string", () => {
    const cfg = parseCliArgs([], { ...buildCliEnv(), ADVERT_DETAIL_HASH: "" });
    expect(cfg.detailHash).toBe(SHA256_EMPTY);
  });

  it("uses supplied detailHash when it is 64 hex chars", () => {
    const hash = "b".repeat(64);
    const cfg = parseCliArgs([], { ...buildCliEnv(), ADVERT_DETAIL_HASH: hash });
    expect(cfg.detailHash).toBe(hash);
  });
});

// ─── Bond defaults ────────────────────────────────────────────────────────────

describe("parseCliArgs() — bond defaults", () => {
  it("defaults supplierBondLovelace to 1_000_000n when ADVERT_SUPPLIER_BOND_LOVELACE is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.ADVERT_SUPPLIER_BOND_LOVELACE;
    const cfg = parseCliArgs([], env);
    expect(cfg.supplierBondLovelace).toBe(1_000_000n);
  });

  it("defaults buyerBondLovelace to 1_000_000n when ADVERT_BUYER_BOND_LOVELACE is absent", () => {
    const env = { ...buildCliEnv() };
    delete env.ADVERT_BUYER_BOND_LOVELACE;
    const cfg = parseCliArgs([], env);
    expect(cfg.buyerBondLovelace).toBe(1_000_000n);
  });
});
