/**
 * Ledger encoding of the identity builders: Conway structure, script data
 * hash and minimum fee checked against cardano-multiplatform-lib (CML, the
 * library inside lucid-evolution); fee arithmetic; key witnesses; the
 * validity window; execution units from an evaluation; the configuration
 * seal; P-256 point helpers.
 */
import { CML, PROTOCOL_PARAMETERS_DEFAULT } from "@lucid-evolution/lucid";
import { createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { cborArray, cborInt, cborMap, cborUint, concatBytes } from "../../packages/shared/src/identity/tx/cbor.js";
import { toRational } from "../../packages/shared/src/identity/tx/ledger.js";
import {
  addVKeyWitnesses, buildConfigSeal, buildRegister, buildUpdate, compressP256, decompressP256, ed25519Key, executionFee,
  plutusV3Hash, readConfigRecord, referenceScriptFee, signTransaction, transactionId, TxConstructionError,
  validityWindow, VECTOR_MAINNET_SLOT_CONFIG, type CreatedRecordTx, type ProtocolParameters, type RegisterArgs,
  type UnsignedTx,
} from "../../packages/shared/src/identity/tx/index.js";
import { describeSimulation } from "../legacy-registry/harness/simulate.js";
import { blake2b256, fromHex, toHex } from "../legacy-registry/harness/ledger.js";
import {
  AP3X, controllerAccountable, identityWorld, reportEvaluation, simulateUnsigned, TEST_NOW, TEST_PROTOCOL, testContext,
  testWallet, testWindow, walletFunds, type TestWallet,
} from "../legacy-registry/harness/identity.js";

const world = identityWorld();
const window = testWindow();

/** The test protocol with the lucid default Plutus V3 cost model, so CML hashes a real cost model. */
const costModel = Object.values(PROTOCOL_PARAMETERS_DEFAULT.costModels.PlutusV3) as number[];
const protocol: ProtocolParameters = { ...TEST_PROTOCOL, costModels: { PlutusV3: costModel } };
const cmlCostModels = () =>
  CML.CostModels.from_cbor_hex(toHex(cborMap([[cborUint(2), cborArray(costModel.map((c) => cborInt(BigInt(c))))]])));

/** CML's script data hash of a transaction that runs Plutus V3 scripts by reference and has no witness datums. */
function cmlScriptDataHash(txCborHex: string): string | undefined {
  const witnesses = CML.Transaction.from_cbor_hex(txCborHex).witness_set();
  const languages = CML.LanguageList.new();
  languages.add(CML.Language.PlutusV3);
  return CML.calc_script_data_hash(witnesses.redeemers()!, CML.PlutusDataList.new(), cmlCostModels(), languages)?.to_hex();
}

/** The raw Ed25519 private key of `testKeyPair(label)` (the harness derives it from the label). */
const privateKeyOf = (label: string): string => toHex(blake2b256(new TextEncoder().encode(`legacy-registry test key: ${label}`)));

function register(label: string, extra: Partial<RegisterArgs> = {}, proto = protocol): { tx: CreatedRecordTx; funds: Utxo; wallet: TestWallet } {
  const wallet = testWallet(label);
  const funds = walletFunds(`${label} funds`, wallet, 100n * AP3X);
  const tx = buildRegister({ ...testContext(wallet, [funds]), protocol: proto }, world.identityScripts, {
    seed: funds,
    window,
    controller: wallet.publicKey,
    parties: [controllerAccountable(window)],
    profile: { name: label },
    ...extra,
  });
  return { tx, funds, wallet };
}

/** Adds real signatures of the test keys `labels`. */
function signed(tx: UnsignedTx, labels: string[]): string {
  const id = fromHex(tx.txHash);
  const witnesses = labels.map((label) => {
    const wallet = testWallet(label);
    return { vkey: wallet.publicKey, signature: toHex(Uint8Array.from(sign(null, id, wallet.key.privateKey))) };
  });
  return addVKeyWitnesses(tx.txCborHex, witnesses);
}

describe("Conway encoding (checked with CML)", () => {
  it("parses as a Conway transaction with the planned parts and the same script data hash", () => {
    const { tx } = register("ledger: cml register", { keys: [ed25519Key(testWallet("ledger: cml key").publicKey, 9)] });
    const parsed = CML.Transaction.from_cbor_hex(tx.txCborHex);
    const body = parsed.body();
    expect(body.fee()).toBe(tx.fee);
    expect(body.inputs().len()).toBe(tx.inputs.length);
    expect(body.reference_inputs()?.len()).toBe(tx.referenceInputs.length);
    expect(body.required_signers()?.len()).toBe(tx.extraSignatories.length);
    expect(Number(body.ttl())).toBe((window.hi - VECTOR_MAINNET_SLOT_CONFIG.zeroTimeMs) / 1000);
    expect(Number(body.validity_interval_start())).toBe((window.lo - VECTOR_MAINNET_SLOT_CONFIG.zeroTimeMs) / 1000);
    expect(body.collateral_inputs()?.len()).toBe(1);
    expect(body.total_collateral()).toBe((tx.fee * 150n + 99n) / 100n);
    const hash = cmlScriptDataHash(tx.txCborHex);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.script_data_hash()?.to_hex()).toBe(hash);
    expect(transactionId(tx.txCborHex)).toBe(tx.txHash);
    expect(CML.hash_transaction(body).to_hex()).toBe(tx.txHash);
  });

  it("withdraws Module-1's whole reward balance in a consent; CML reads the withdrawal and hashes the two redeemers the same way", () => {
    const { tx: created, funds, wallet } = register("ledger: cml consent");
    const simulation = simulateUnsigned(created, [...world.utxos, funds], [wallet.key]);
    expect(simulation.passed).toBe(true);
    const more = walletFunds("ledger: cml consent more", wallet, 100n * AP3X);
    const balance = 3_250_000n;
    const args = {
      record: created.outputs[0]!,
      window,
      parties: [controllerAccountable(window), { ...controllerAccountable(window), role: "Responsible" as const, signer: { type: "Script" as const, hash: world.module1.hash }, rights: 1 }],
    };
    expect(() => buildUpdate({ ...testContext(wallet, [more]), protocol, rewardBalances: {} }, world.identityScripts, args)).toThrow(/reward balance/);
    const ctx = { ...testContext(wallet, [more]), protocol, rewardBalances: { [world.module1.hash]: balance } };
    const tx = buildUpdate(ctx, world.identityScripts, args);
    const parsed = CML.Transaction.from_cbor_hex(tx.txCborHex);
    const withdrawals = parsed.body().withdrawals()!;
    expect(withdrawals.len()).toBe(1);
    expect(withdrawals.get(withdrawals.keys().get(0))).toBe(balance);
    const spent = [created.outputs[0]!, more].filter((u) => tx.inputs.some((r) => r.txHash === u.ref.txHash && r.index === u.ref.index));
    const inputs = spent.reduce((t, u) => t + u.lovelace, 0n);
    const outputs = tx.outputs.reduce((t, o) => t + o.lovelace, 0n);
    expect(inputs + balance).toBe(outputs + tx.fee);
    expect(parsed.witness_set().redeemers()?.to_flat_format().len()).toBe(2);
    expect(parsed.body().script_data_hash()?.to_hex()).toBe(cmlScriptDataHash(tx.txCborHex));
    const result = simulateUnsigned(tx, [...world.utxos, created.outputs[0]!, more], [wallet.key]);
    reportEvaluation(expect.getState().currentTestName ?? "", tx, result);
    expect(result.passed, describeSimulation(result)).toBe(true);
  });

  it("pays at least CML's minimum fee of the signed transaction, and not much more", () => {
    const { tx } = register("ledger: cml fee");
    const signedHex = signed(tx, ["ledger: cml fee"]);
    expect(signedHex.length / 2).toBe(tx.signedSize);
    const refScriptSize = BigInt(world.identity.reference.scriptRef!.length / 2);
    const minimum = CML.min_fee(
      CML.Transaction.from_cbor_hex(signedHex),
      CML.LinearFee.new(44n, 155_381n, 15n),
      CML.ExUnitPrices.new(CML.Rational.new(577n, 10_000n), CML.Rational.new(721n, 10_000_000n)),
      refScriptSize,
    );
    expect(tx.fee).toBeGreaterThanOrEqual(minimum);
    expect(tx.fee - minimum).toBeLessThan(1_000n);
  });
});

describe("fee arithmetic", () => {
  it("reads prices as exact decimals", () => {
    expect(toRational(0.0577)).toEqual({ num: 577n, den: 10_000n });
    expect(toRational(0.0000721)).toEqual({ num: 721n, den: 10_000_000n });
    expect(toRational(1e-7)).toEqual({ num: 1n, den: 10_000_000n });
    expect(toRational(15)).toEqual({ num: 15n, den: 1n });
  });

  it("rounds the execution fee up over the sum of the units", () => {
    expect(executionFee(0.0577, 0.0000721, { mem: 1n, steps: 1n })).toBe(1n);
    expect(executionFee(0.0577, 0.0000721, { mem: 16_000_000n, steps: 10_000_000_000n })).toBe(923_200n + 721_000n);
  });

  it("prices reference scripts in 25,600-byte tiers that cost 1.2 times more each", () => {
    expect(referenceScriptFee(15, 0)).toBe(0n);
    expect(referenceScriptFee(15, 13_557)).toBe(203_355n);
    expect(referenceScriptFee(15, 25_600)).toBe(384_000n);
    expect(referenceScriptFee(15, 25_601)).toBe(384_018n);
    expect(referenceScriptFee(15, 51_200)).toBe(384_000n + 460_800n);
    expect(referenceScriptFee(15, 51_201)).toBe(384_000n + 460_800n + 21n);
  });
});

describe("validity window", () => {
  it("aligns the window to slot starts and keeps it within one hour", () => {
    const w = validityWindow(TEST_NOW + 999, VECTOR_MAINNET_SLOT_CONFIG);
    expect(w).toEqual({ lo: TEST_NOW - 60_000, hi: TEST_NOW + 600_000 });
    expect(() => validityWindow(TEST_NOW, VECTOR_MAINNET_SLOT_CONFIG, { futureMs: 3_600_000 })).toThrow(TxConstructionError);
    expect(validityWindow(TEST_NOW, VECTOR_MAINNET_SLOT_CONFIG, { pastMs: 0, futureMs: 3_600_000 }).hi - TEST_NOW).toBe(3_600_000);
  });
});

describe("key witnesses", () => {
  it("adds witnesses in turn without changing the body; signTransaction signs the transaction ID", async () => {
    const { tx } = register("ledger: witnesses");
    const first = await signTransaction(tx.txCborHex, privateKeyOf("ledger: witnesses"));
    expect(transactionId(first)).toBe(tx.txHash);
    const second = signed({ ...tx, txCborHex: first }, ["ledger: other signer"]);
    expect(transactionId(second)).toBe(tx.txHash);
    const vkeys = CML.Transaction.from_cbor_hex(second).witness_set().vkeywitnesses()!;
    expect(vkeys.len()).toBe(2);
    const wallet = testWallet("ledger: witnesses");
    const witness = vkeys.get(0).vkey().to_raw_bytes();
    const which = toHex(witness) === wallet.publicKey ? 0 : 1;
    const w = vkeys.get(which);
    expect(toHex(w.vkey().to_raw_bytes())).toBe(wallet.publicKey);
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(wallet.publicKey, "hex")]), format: "der", type: "spki" });
    expect(verify(null, fromHex(tx.txHash), publicKey, w.ed25519_signature().to_raw_bytes())).toBe(true);
    // A key that signed already is not added twice.
    expect(await signTransaction(first, privateKeyOf("ledger: witnesses"))).toBe(first);
  });
});

describe("execution units from an evaluation", () => {
  it("rebuilds with measured units for a lower fee, and the transaction still passes", () => {
    const { tx, funds, wallet } = register("ledger: ex units");
    const first = simulateUnsigned(tx, [...world.utxos, funds], [wallet.key]);
    expect(first.passed).toBe(true);
    const units = Object.fromEntries(first.verdicts.map((v, i) => {
      const r = tx.redeemers[i]!;
      return [`${r.tag}:${r.index}`, { mem: (BigInt(v.mem!) * 11n) / 10n, steps: (BigInt(v.cpu!) * 11n) / 10n }];
    }));
    const tuned = buildRegister({ ...testContext(wallet, [funds]), exUnits: units }, world.identityScripts, {
      seed: funds,
      window,
      controller: wallet.publicKey,
      parties: [controllerAccountable(window)],
      profile: { name: "ledger: ex units" },
    });
    expect(tuned.fee).toBeLessThan(tx.fee / 3n);
    expect(tuned.redeemers[0]!.exUnits).toEqual(Object.values(units)[0]);
    const second = simulateUnsigned(tuned, [...world.utxos, funds], [wallet.key]);
    reportEvaluation(expect.getState().currentTestName ?? "", tuned, second);
    expect(second.passed, describeSimulation(second)).toBe(true);
  });
});

describe("configuration seal (§3.8)", () => {
  it("mints identity-config once to the holder with the Module-1 hash as inline datum", () => {
    const result = simulateUnsigned(world.sealTx, [...world.utxos, world.seal.seed], [world.deployer.key]);
    reportEvaluation(expect.getState().currentTestName ?? "", world.sealTx, result);
    expect(result.passed, describeSimulation(result)).toBe(true);
    expect(result.verdicts.map((v) => v.label)).toEqual(["config_seal mint"]);
    expect(readConfigRecord(world.configRecord, world.seal.hash, world.holder.hash)).toBe(world.module1.hash);
    expect(world.sealTx.inputs.some((r) => r.txHash === world.seal.seed.ref.txHash)).toBe(true);
  });

  it("refuses an M1 that is not a 28-byte hash, and a seal script that does not match its hash", () => {
    const ctx = testContext(world.deployer, [world.seal.seed]);
    const args = {
      seed: world.seal.seed,
      seal: { hash: world.seal.hash, compiledCode: toHex(world.seal.script.compiledCode) },
      configHolder: world.holder.hash,
      module1: world.module1.hash,
      window,
    };
    expect(() => buildConfigSeal(ctx, { ...args, module1: "00" })).toThrow(/28-byte/);
    expect(() => buildConfigSeal(ctx, { ...args, seal: { ...args.seal, hash: world.holder.hash } })).toThrow(TxConstructionError);
    expect(plutusV3Hash(args.seal.compiledCode)).toBe(world.seal.hash);
  });
});

describe("P-256 points", () => {
  it("compresses and decompresses a point", async () => {
    const pair = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey));
    expect(toHex(decompressP256(compressP256(raw)))).toBe(toHex(raw));
    expect(() => decompressP256(concatBytes([Uint8Array.of(2), new Uint8Array(32).fill(0xff)]))).toThrow();
  });
});
