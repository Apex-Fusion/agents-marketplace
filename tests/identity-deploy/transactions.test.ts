// The transactions of the identity deployment tool, signed as the tool signs them and evaluated
// with `aiken tx simulate` through evaluateBuiltTx (tests/legacy-registry/harness/identity.ts):
// the seed payment, one reference-script transaction per script (the shared publisher), and the
// configuration seal (shared buildConfigSeal). Also the seal-seed guard: no transaction except
// the seal takes inputs from the seal-seed address.

import { describe, expect, test } from "vitest";
import { CONFIG_TOKEN_NAME, minUtxo, signTransaction, type Utxo } from "@marketplace/shared";
import { encodePlutusDataHex } from "@marketplace/shared/cbor";
import { referenceScriptAddress } from "@marketplace/shared/tx/server";
import { describeSimulation } from "../legacy-registry/harness/index.js";
import { evaluateBuiltTx } from "../legacy-registry/harness/identity.js";
import { completeTx } from "../../packages/shared/src/identity/tx/complete.js";
import { generatePaymentKey, keyAddress } from "../../contracts/identity-marketplace/deploy/keys.js";
import { MAINNET_LEGACY_POLICY, resolveNetwork } from "../../contracts/identity-marketplace/deploy/network.js";
import { deriveScripts, readBlueprint } from "../../contracts/identity-marketplace/deploy/scripts.js";
import { REFERENCE_NAMES } from "../../contracts/identity-marketplace/deploy/state.js";
import { assertNoSealSeedInput, buildEnv, publishTxs, sealTx, seedTx, type BuildEnv } from "../../contracts/identity-marketplace/deploy/steps.js";
import { decodeTx, FakeLedger } from "./ledger.js";

const AP3X = 1_000_000n;
const network = resolveNetwork("mainnet", {}, {});
const operatorKey = generatePaymentKey();
const sealSeedKey = generatePaymentKey();
const operator = keyAddress(operatorKey.keyHash, 1);
const sealSeedAddress = keyAddress(sealSeedKey.keyHash, 1);
const M1 = "a1".repeat(28);

const utxo = (txHash: string, address: string, lovelace: bigint, index = 0): Utxo => ({
  ref: { txHash, index }, address, lovelace, assets: {}, datumHex: null, scriptRef: null,
});
const funds = utxo("f0".repeat(32), operator, 1_000n * AP3X);
const seedOutput = utxo("5e".repeat(32), sealSeedAddress, 5n * AP3X, 2);
const scripts = deriveScripts(readBlueprint(), { legacyHash: MAINNET_LEGACY_POLICY, legacyRoot: "e4".repeat(32), configSeed: seedOutput.ref, networkId: 1 });

async function environment(...utxos: Utxo[]): Promise<{ ledger: FakeLedger; env: BuildEnv }> {
  const ledger = new FakeLedger();
  ledger.add(...utxos);
  return { ledger, env: await buildEnv(network, ledger) };
}

describe("transactions under aiken tx simulate", () => {
  test("seed: exactly one output, at the seal-seed address, paid by the operator", async () => {
    const { ledger, env } = await environment(funds);
    const step = await seedTx(env, { wallet: [funds], operator, sealSeedAddress, amount: 5n * AP3X });
    const signed = await signTransaction(step.tx.txCborHex, operatorKey.privateKeyHex);
    const simulation = evaluateBuiltTx(signed, [funds], "seed");
    expect(simulation.passed, describeSimulation(simulation)).toBe(true);
    expect(simulation.verdicts).toEqual([]);
    const tx = decodeTx(signed);
    expect(tx.inputs).toEqual([funds.ref]);
    expect(tx.outputs.filter((o) => o.address === sealSeedAddress)).toEqual([expect.objectContaining({ ref: { txHash: tx.id, index: 0 }, lovelace: 5n * AP3X })]);
    expect(tx.outputs.slice(1).every((o) => o.address === operator)).toBe(true);
    expect(step.tx.requiredSigners).toEqual([operatorKey.keyHash]);
    await ledger.submit(signed);
  });

  test("publish: one transaction per script, chained, each with one reference output of the ledger minimum", async () => {
    const { ledger, env } = await environment(funds);
    const to = referenceScriptAddress(1);
    const { txs } = await publishTxs(env, {
      wallet: [funds], operator, sealSeedKeyHash: sealSeedKey.keyHash, to, scripts: REFERENCE_NAMES.map((name) => ({ name, script: scripts[name] })),
    });
    expect(txs.map((s) => s.step)).toEqual(REFERENCE_NAMES.map((name) => `publish-${name}`));
    const known: Utxo[] = [funds];
    for (const [i, step] of txs.entries()) {
      const signed = await signTransaction(step.tx.txCborHex, operatorKey.privateKeyHex);
      const simulation = evaluateBuiltTx(signed, known, step.step);
      expect(simulation.passed, `${step.step}: ${describeSimulation(simulation)} ${simulation.error ?? ""}`).toBe(true);
      const tx = decodeTx(signed);
      const script = scripts[REFERENCE_NAMES[i]!];
      const reference = tx.outputs[0]!;
      expect(reference).toMatchObject({ address: to, scriptRef: script.compiled_code, datumHex: null, assets: {} });
      expect(reference.lovelace).toBe(minUtxo({ address: to, coin: reference.lovelace, assets: [], datum: null, scriptRef: script.compiled_code }, env.protocol.coinsPerUtxoByte));
      expect(step.locked).toBe(reference.lovelace);
      expect(tx.outputs.slice(1).every((o) => o.address === operator)).toBe(true);
      // The next transaction spends this change, so each one is valid before the earlier ones are on chain.
      await ledger.submit(signed);
      known.push(...tx.outputs);
    }
  });

  test("seal: spends only the seed, which also gives the collateral; the record holds the token and M1", async () => {
    const { ledger, env } = await environment(seedOutput);
    const step = await sealTx(env, {
      seed: seedOutput, operator, sealSeedAddress, configSeal: scripts.config_seal, configHolder: scripts.config_holder, module1: M1, additional: [],
    });
    expect(step.tx.requiredSigners).toEqual([sealSeedKey.keyHash]);
    expect(step.tx.redeemers.map((r) => r.exUnits.mem < 1_000_000n)).toEqual([true]);
    const signed = await signTransaction(step.tx.txCborHex, sealSeedKey.privateKeyHex);
    const simulation = evaluateBuiltTx(signed, [seedOutput], "config_seal mint");
    expect(simulation.passed, describeSimulation(simulation)).toBe(true);
    expect(simulation.verdicts.map((v) => v.purpose)).toEqual(["Mint[0]"]);
    const tx = decodeTx(signed);
    expect(tx.inputs).toEqual([seedOutput.ref]);
    expect(tx.collateral).toEqual([seedOutput.ref]);
    expect(tx.outputs[0]).toMatchObject({
      address: scripts.config_holder.address,
      assets: { [`${scripts.config_seal.hash}${CONFIG_TOKEN_NAME}`]: 1n },
      datumHex: encodePlutusDataHex({ kind: "bytes", hex: M1 }),
    });
    expect(tx.outputs.slice(1).map((o) => o.address)).toEqual([operator]);
    await ledger.submit(signed);
    expect(await ledger.utxo(seedOutput.ref)).toBeNull();
  });
});

describe("seal-seed guard", () => {
  const atSealSeed = utxo("5f".repeat(32), sealSeedAddress, 1_000n * AP3X);

  test("seed and publish never take inputs from the seal-seed address", async () => {
    const { env } = await environment(atSealSeed, funds);
    await expect(seedTx(env, { wallet: [atSealSeed], operator, sealSeedAddress, amount: 5n * AP3X })).rejects.toThrow(/short/);
    const to = referenceScriptAddress(1);
    const only = [{ name: "advert" as const, script: scripts.advert }];
    await expect(publishTxs(env, { wallet: [atSealSeed], operator, sealSeedKeyHash: sealSeedKey.keyHash, to, scripts: only })).rejects.toThrow(/short/);
    const { txs } = await publishTxs(env, { wallet: [atSealSeed, funds], operator, sealSeedKeyHash: sealSeedKey.keyHash, to, scripts: only });
    expect(txs[0]!.tx.inputs).toEqual([funds.ref]);
    const seed = await seedTx(env, { wallet: [atSealSeed, funds], operator, sealSeedAddress, amount: 5n * AP3X });
    expect(seed.tx.inputs).toEqual([funds.ref]);
  });

  test("a transaction other than the seal that needs the seal-seed key stops the run", async () => {
    const { env } = await environment(atSealSeed);
    const tx = completeTx({ networkId: 1, slotConfig: env.slotConfig, protocol: env.protocol, wallet: [atSealSeed], changeAddress: operator }, {
      inputs: [], referenceInputs: [], outputs: [{ address: operator, coin: 2n * AP3X, assets: [], datum: null, scriptRef: null }],
      mints: [], withdrawals: [], extraSignatories: [], window: env.window,
    });
    expect(() => assertNoSealSeedInput("publish-identity", tx, sealSeedKey.keyHash)).toThrow(/only the seal may spend from it/);
    expect(() => assertNoSealSeedInput("publish-identity", tx, operatorKey.keyHash)).not.toThrow();
  });

  test("the seal refuses a seed that is not at the seal-seed address, and the seed must not go to the operator", async () => {
    const { env } = await environment(funds);
    await expect(sealTx(env, {
      seed: funds, operator, sealSeedAddress, configSeal: scripts.config_seal, configHolder: scripts.config_holder, module1: M1, additional: [],
    })).rejects.toThrow(/not at the seal-seed address/);
    await expect(seedTx(env, { wallet: [funds], operator, sealSeedAddress: operator, amount: 5n * AP3X })).rejects.toThrow(/must not be the operator address/);
  });
});
