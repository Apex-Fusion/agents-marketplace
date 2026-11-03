// The plan of the identity deployment tool (Part 2 §2, §3.8): the parameters that
// @lucid-evolution/uplc applies, in the contract order, give the bytes and hashes of
// `aiken blueprint apply`; the plan command checks the seed and writes the state file
// that the Module-1 deployment tool reads.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { enterpriseAddress } from "@marketplace/shared";
import { loadIdentityBlueprint } from "@marketplace/shared/tx";
import { blake2b256, blueprintScript, fromHex, LEGACY_HASH, outRefData, scriptHash, toHex, utf8 } from "../legacy-registry/harness/index.js";
import { IDENTITY_BLUEPRINT_PATH } from "../legacy-registry/harness/identity.js";
import { allowlistFromMints, writeAllowlistFiles } from "../../contracts/identity-marketplace/deploy/allowlist.js";
import { main } from "../../contracts/identity-marketplace/deploy/cli.js";
import { generatePaymentKey, keyAddress } from "../../contracts/identity-marketplace/deploy/keys.js";
import { MAINNET_LEGACY_POLICY } from "../../contracts/identity-marketplace/deploy/network.js";
import { deriveScripts, readBlueprint, SCRIPT_TITLES } from "../../contracts/identity-marketplace/deploy/scripts.js";
import { SCRIPT_NAMES, StateFile } from "../../contracts/identity-marketplace/deploy/state.js";
import { FakeLedger, testIo } from "./ledger.js";

const SEED = { txHash: "5e".repeat(32), index: 3 };
const ALLOWLIST = allowlistFromMints(MAINNET_LEGACY_POLICY, 100, Array.from({ length: 13 }, (_, i) => ({
  id: toHex(blake2b256(utf8(`plan test: legacy record ${i}`))),
  slot: i,
  supply: 1n,
})));

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

describe("parameters", () => {
  const scripts = deriveScripts(readBlueprint(), { legacyHash: MAINNET_LEGACY_POLICY, legacyRoot: ALLOWLIST.root, configSeed: SEED, networkId: 1 });

  test("uplc gives the bytes and hashes of aiken blueprint apply for every script, in the contract order", () => {
    const path = IDENTITY_BLUEPRINT_PATH;
    const holder = blueprintScript(path, SCRIPT_TITLES.config_holder);
    const seal = blueprintScript(path, SCRIPT_TITLES.config_seal, [outRefData({ txId: fromHex(SEED.txHash), index: SEED.index }), scriptHash(holder)]);
    const identity = blueprintScript(path, SCRIPT_TITLES.identity, [LEGACY_HASH, fromHex(ALLOWLIST.root), scriptHash(seal), scriptHash(holder)]);
    const attestation = blueprintScript(path, SCRIPT_TITLES.attestation, [scriptHash(identity)]);
    const delegation = blueprintScript(path, SCRIPT_TITLES.delegation, [scriptHash(identity)]);
    const escrow = blueprintScript(path, SCRIPT_TITLES.escrow, [scriptHash(identity)]);
    const vault = blueprintScript(path, SCRIPT_TITLES.vault, [scriptHash(identity), scriptHash(delegation), scriptHash(escrow)]);
    const advert = blueprintScript(path, SCRIPT_TITLES.advert);
    const aiken = { config_holder: holder, config_seal: seal, identity, attestation, delegation, escrow, vault, advert };
    for (const name of SCRIPT_NAMES) {
      const hash = toHex(scriptHash(aiken[name]));
      expect(scripts[name].compiled_code, name).toBe(toHex(aiken[name].compiledCode));
      expect(scripts[name].hash, name).toBe(hash);
      expect(scripts[name].address, name).toBe(enterpriseAddress({ type: "Script", hash }, 1));
      expect(scripts[name].size, name).toBe(aiken[name].compiledCode.length);
    }
  });

  test("the escrow equals the escrow of the shared blueprint loader (WASM-free application)", () => {
    expect(loadIdentityBlueprint({ identityHash: scripts.identity.hash }).escrowCompiledCode).toBe(scripts.escrow.compiled_code);
  });

  test("a parameter changes the hashes that depend on it, and only those", () => {
    const other = deriveScripts(readBlueprint(), { legacyHash: MAINNET_LEGACY_POLICY, legacyRoot: ALLOWLIST.root, configSeed: { ...SEED, index: 4 }, networkId: 1 });
    expect(other.config_holder.hash).toBe(scripts.config_holder.hash);
    expect(other.advert.hash).toBe(scripts.advert.hash);
    for (const name of ["config_seal", "identity", "attestation", "delegation", "escrow", "vault"] as const) expect(other[name].hash).not.toBe(scripts[name].hash);
  });
});

describe("plan command", () => {
  const sealSeed = generatePaymentKey();
  const sealSeedAddress = keyAddress(sealSeed.keyHash, 1);

  function setup(): { dir: string; ledger: FakeLedger } {
    const dir = mkdtempSync(join(tmpdir(), "identity-deploy-plan-"));
    directories.push(dir);
    writeAllowlistFiles(dir, ALLOWLIST);
    const ledger = new FakeLedger();
    ledger.add({ ref: SEED, address: sealSeedAddress, lovelace: 5_000_000n, assets: {}, datumHex: null, scriptRef: null });
    return { dir, ledger };
  }

  test("checks the seed and writes every value that the Module-1 tool reads", async () => {
    const { dir, ledger } = setup();
    const io = testIo(ledger);
    const status = await main(["plan", "--network", "mainnet", "--dir", dir, "--seed", `${SEED.txHash}#${SEED.index}`, "--seed-address", sealSeedAddress], io, {});
    expect(status, io.lines.join("\n")).toBe(0);
    const state = JSON.parse(readFileSync(join(dir, "deployment.json"), "utf8")) as Record<string, unknown>;
    for (const key of [
      "network", "cutoff_slot", "legacy_hash", "legacy_root", "config_seed", "config_holder", "config_policy", "identity_hash",
      "identity_address", "attestation_hash", "delegation_hash", "escrow_hash", "vault_hash", "advert_hash", "refs", "seal", "steps",
    ]) expect(state, key).toHaveProperty(key);
    const scripts = deriveScripts(readBlueprint(), { legacyHash: MAINNET_LEGACY_POLICY, legacyRoot: ALLOWLIST.root, configSeed: SEED, networkId: 1 });
    expect(state).toMatchObject({
      network: "mainnet",
      cutoff_slot: 100,
      legacy_hash: MAINNET_LEGACY_POLICY,
      legacy_root: ALLOWLIST.root,
      config_seed: `${SEED.txHash}#${SEED.index}`,
      seal_seed_address: sealSeedAddress,
      config_holder: scripts.config_holder.hash,
      config_policy: scripts.config_seal.hash,
      identity_hash: scripts.identity.hash,
      identity_address: scripts.identity.address,
      vault_hash: scripts.vault.hash,
      refs: {},
      seal: null,
      steps: {},
    });
    expect(new StateFile(dir).load()!.scripts.identity!.compiled_code).toBe(scripts.identity.compiled_code);
    expect(io.lines.join("\n")).toMatch(/seed: (5e){32}#3 is unspent at the seal-seed address/);
    expect(io.lines.join("\n")).toMatch(/publish-identity .* reference output of identity/);
    expect(io.lines.join("\n")).toMatch(/seal .* configuration record/);
  });

  test("refuses a seed that is spent or not at the seal-seed address; --no-seed-check plans a made-up seed", async () => {
    const { dir, ledger } = setup();
    const madeUp = `${"ab".repeat(32)}#0`;
    await expect(main(["plan", "--network", "mainnet", "--dir", dir, "--seed", madeUp, "--seed-address", sealSeedAddress], testIo(ledger), {}))
      .rejects.toThrow(/not an unspent output/);
    const elsewhere = keyAddress(generatePaymentKey().keyHash, 1);
    await expect(main(["plan", "--network", "mainnet", "--dir", dir, "--seed", `${SEED.txHash}#${SEED.index}`, "--seed-address", elsewhere], testIo(ledger), {}))
      .rejects.toThrow(/not at the seal-seed address/);
    expect(new StateFile(dir).load()).toBeNull();
    const io = testIo(ledger);
    expect(await main(["plan", "--network", "mainnet", "--dir", dir, "--seed", madeUp, "--no-seed-check"], io, {})).toBe(0);
    expect(io.lines.join("\n")).toMatch(/was not checked/);
    expect(new StateFile(dir).load()!.config_seed).toBe(madeUp);
  });
});
