/**
 * Shared parts of the legacy script tests: throwaway wallets, funds that
 * exist before a test transaction, a record profile, the legacy Register
 * that follows the rules, and evaluate().
 */
import { appendFileSync } from "node:fs";
import { expect } from "vitest";
import {
  address,
  buildTx,
  chainUtxo,
  fromHex,
  identifierOf,
  LEGACY_HASH,
  LEGACY_MIN_DEPOSIT,
  LEGACY_SCRIPT,
  recordOutput,
  registerRedeemer,
  simulate,
  testKeyPair,
  toHex,
  withChange,
  type AgentDatum,
  type BuiltTx,
  type KeyPair,
  type PlutusV3Script,
  type Simulation,
  type TxSpec,
  type Utxo,
} from "./harness/index.js";

export const AP3X = 1_000_000n;
export const FEE = 400_000n;

export interface Wallet {
  readonly key: KeyPair;
  /** Enterprise address of the key. */
  readonly address: Uint8Array;
}

export function newWallet(label: string): Wallet {
  const key = testKeyPair(label);
  return { key, address: address({ key: key.keyHash }) };
}

/** A collateral UTxO of `owner`. */
export const collateralOf = (owner: Wallet): Utxo => funds(`collateral of ${toHex(owner.key.keyHash)}`, owner, 5n * AP3X);

/** Verdict of each redeemer by label. */
export const verdicts = (result: Simulation): Record<string, boolean> =>
  Object.fromEntries(result.verdicts.map((v) => [v.label, v.passed]));

/** aiken's error when a validator rejects (an `error` term: `fail`, a failed `expect` or False). */
export const VALIDATOR_REJECTION = "the validator crashed / exited prematurely";

/**
 * simulate(), with one guard: each failing redeemer must fail because the
 * validator rejects, not for another machine error such as an exhausted
 * budget. With LEGACY_REGISTRY_REPORT=<file>, it also appends one JSON line
 * per evaluation: the test name, the transaction ID and the verdicts (the
 * README results table comes from this file).
 */
export function evaluate(built: BuiltTx): Simulation {
  const result = simulate(built);
  for (const v of result.verdicts) {
    if (!v.passed && v.reason !== VALIDATOR_REJECTION) throw new Error(`${v.label} failed for another reason: ${v.reason}`);
  }
  const report = process.env.LEGACY_REGISTRY_REPORT;
  if (report !== undefined) {
    const { txId, passed, verdicts: each, failedAt } = result;
    appendFileSync(report, `${JSON.stringify({ test: expect.getState().currentTestName, txId, passed, failedAt, verdicts: each })}\n`);
  }
  return result;
}

/** AP3X at a wallet, created by an earlier transaction named `label`. */
export const funds = (label: string, owner: Wallet, coin: bigint, index = 0): Utxo =>
  chainUtxo(label, { address: owner.address, value: { coin } }, index);

export const profile = (owner: Wallet, changes: Partial<AgentDatum> = {}): AgentDatum => ({
  owner: { key: owner.key.keyHash },
  name: "Legacy Test Agent",
  description: "Offline test record",
  capabilities: ["ocr.page.extract.v1"],
  framework: "vector-agent",
  endpoint: "https://agent.example/a2a",
  registeredAt: 1_760_000_000_000n,
  ...changes,
});

/** The parts of a legacy Register that follows the rules, without the change output. */
export function registerParts(owner: Wallet, seed: Utxo, datum: AgentDatum, deposit: bigint): TxSpec {
  const id = identifierOf(seed.ref);
  return {
    inputs: [{ utxo: seed }],
    collateral: [collateralOf(owner)],
    outputs: [recordOutput({ ids: [id], datum, coin: deposit })],
    fee: FEE,
    mint: [{ policy: LEGACY_HASH, assets: [{ name: id, quantity: 1n }], redeemer: registerRedeemer(seed.ref), label: "legacy Register" }],
    requiredSigners: [owner.key.keyHash],
    scripts: [LEGACY_SCRIPT],
    signers: [owner.key],
  };
}

/** A legacy Register that follows the rules. The seed is the owner's wallet UTxO. */
export const registerTx = (owner: Wallet, seed: Utxo, datum = profile(owner), deposit = LEGACY_MIN_DEPOSIT): BuiltTx =>
  buildTx(withChange(registerParts(owner, seed, datum, deposit), owner.address));

/**
 * A legacy record that a rule-following Register created (output 0 of
 * `registerTx`). The deployed script must accept that Register.
 */
export function registeredRecord(owner: Wallet, label: string, deposit = LEGACY_MIN_DEPOSIT) {
  const seed = funds(label, owner, deposit + 20n * AP3X);
  const register = registerTx(owner, seed, profile(owner), deposit);
  if (!simulate(register).passed) throw new Error(`The Register of ${label} fails`);
  return { record: register.utxo(0), id: identifierOf(seed.ref), datum: profile(owner) };
}

/**
 * A Plutus V3 script that accepts every purpose: `(program 1.1.0 (lam ctx (con unit ())))`
 * (`aiken uplc encode --cbor --hex`). It takes the place of the identity
 * validator until wave 2 adds the real blueprint.
 */
export const STAND_IN_IDENTITY: PlutusV3Script = { compiledCode: fromHex("450101002499") };
