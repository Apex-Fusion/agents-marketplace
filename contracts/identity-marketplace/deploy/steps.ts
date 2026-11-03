/**
 * The transactions of the deployment, built with the shared builders and
 * evaluated with Ogmios:
 *
 * - `seed`: a plain payment from the operator with exactly one output at the
 *   seal-seed address. That output is the `config_seal` seed.
 * - `publish-<name>`: one reference output per script (shared
 *   `buildPublishReferenceScripts`), paid by the operator.
 * - `seal`: the configuration seal (shared `buildConfigSeal`). It spends only
 *   the seed; the seed pays the configuration record, the fee and the
 *   collateral, and the change goes to the operator.
 *
 * Guard: only the seal spends from the seal-seed key. Every other
 * transaction takes its inputs from the operator wallet without the
 * outputs of that key, and a built transaction that needs its signature
 * stops the run.
 */

import {
  buildConfigSeal, paymentCredential, validityWindow, type ExUnits, type ProtocolParameters,
  type SlotConfig, type TxContext, type UnsignedTx, type Utxo, type ValidityWindow,
} from "@marketplace/shared";
import { buildPublishReferenceScripts } from "@marketplace/shared/tx/server";
import { completeTx } from "../../../packages/shared/src/identity/tx/complete.js";
import type { Chain } from "./chain.js";
import { ap3x } from "./context.js";
import { DeployError, SLOT_LENGTH_MS, type Network } from "./network.js";
import { refText, type AppliedScriptRecord, type ReferenceName } from "./state.js";

/** Headroom on the evaluated execution units: the final transaction differs from the draft in its fee and units. */
export const EX_UNITS_MARGIN_PERCENT = 110n;

/** The validity interval of every transaction: from one minute before the tip to 59 minutes after it (the contracts allow one hour). */
const WINDOW = { pastMs: 60_000, futureMs: 3_540_000 };

export interface BuildEnv {
  chain: Chain;
  network: Network;
  protocol: ProtocolParameters;
  slotConfig: SlotConfig;
  window: ValidityWindow;
  tipSlot: number;
}

/** The chain values of one run. Refuses an Ogmios endpoint of another network (system start). */
export async function buildEnv(network: Network, chain: Chain): Promise<BuildEnv> {
  const [startMs, tipSlot, protocol] = await Promise.all([chain.systemStartMs(), chain.tipSlot(), chain.protocolParameters()]);
  if (network.systemStart !== null && startMs !== network.systemStart * 1000) {
    throw new DeployError(`${chain.label} reports the system start ${new Date(startMs).toISOString()}, which is not ${network.name}: wrong network`);
  }
  const slotConfig: SlotConfig = { zeroTimeMs: startMs, zeroSlot: 0, slotLengthMs: SLOT_LENGTH_MS };
  return { chain, network, protocol, slotConfig, window: validityWindow(startMs + tipSlot * SLOT_LENGTH_MS, slotConfig, WINDOW), tipSlot };
}

/** A built transaction of one step. */
export interface StepTx {
  step: string;
  tx: UnsignedTx;
  /**
   * AP3X base units that the step locks for good: the min-UTxO of a
   * reference output (nobody can spend it) or of the configuration record
   * (config_holder rejects every spend). 0 for the seed: the seal spends it.
   */
  locked: bigint;
  /** The output of the step. */
  target: string;
}

/**
 * Builds with an equal share of the execution units, evaluates with Ogmios,
 * builds again with the measured units plus the margin and evaluates the
 * result. A transaction without scripts is evaluated once. `additional`
 * holds the outputs that the transaction reads and that are not on chain
 * yet (the seed of a cost estimate).
 */
export async function evaluatedBuild(
  env: BuildEnv,
  build: (exUnits: Record<string, ExUnits> | undefined) => UnsignedTx,
  additional: readonly Utxo[],
): Promise<UnsignedTx> {
  const draft = build(undefined);
  const measured = await env.chain.evaluate(draft.txCborHex, additional);
  if (draft.redeemers.length === 0) return draft;
  const units: Record<string, ExUnits> = {};
  for (const r of draft.redeemers) {
    const key = `${r.tag}:${r.index}`;
    const u = measured[key];
    if (u === undefined) throw new DeployError(`Ogmios returned no execution units for ${key} (${r.label})`);
    units[key] = { mem: (u.mem * EX_UNITS_MARGIN_PERCENT + 99n) / 100n, steps: (u.steps * EX_UNITS_MARGIN_PERCENT + 99n) / 100n };
  }
  const final = build(units);
  await env.chain.evaluate(final.txCborHex, additional);
  return final;
}

/** The payment key hash of an address, or a refusal that names `what`. */
export function keyHashOf(address: string, what: string): string {
  const credential = paymentCredential(address);
  if (credential === null || credential.type !== "VerificationKey") throw new DeployError(`${what} ${address} is not an address of a payment key`);
  return credential.hash;
}

/** The wallet without the outputs of the seal-seed key: no command but the seal may spend them. */
export function withoutSealSeed(wallet: readonly Utxo[], sealSeedKeyHash: string | null): Utxo[] {
  return wallet.filter((u) => sealSeedKeyHash === null || paymentCredential(u.address)?.hash !== sealSeedKeyHash);
}

/** Stops a transaction other than the seal that needs the seal-seed key: it would spend from the seal-seed address. */
export function assertNoSealSeedInput(step: string, tx: UnsignedTx, sealSeedKeyHash: string | null): void {
  if (sealSeedKeyHash !== null && tx.requiredSigners.includes(sealSeedKeyHash)) {
    throw new DeployError(`${step}: the transaction spends from the seal-seed address; only the seal may spend from it`);
  }
}

/** The operator wallet after `tx`: without its inputs, with its outputs at the operator address. */
export function walletAfter(wallet: readonly Utxo[], tx: UnsignedTx, operator: string): Utxo[] {
  const spent = new Set(tx.inputs.map(refText));
  return [...wallet.filter((u) => !spent.has(refText(u.ref))), ...tx.outputs.filter((u) => u.address === operator)];
}

function operatorContext(env: BuildEnv, wallet: readonly Utxo[], operator: string, exUnits?: Record<string, ExUnits>): TxContext {
  return {
    networkId: env.network.networkId,
    slotConfig: env.slotConfig,
    protocol: env.protocol,
    wallet,
    changeAddress: operator,
    ...(exUnits === undefined ? {} : { exUnits }),
  };
}

/** The seed payment: exactly one output of `amount` at the seal-seed address, paid by the operator. */
export async function seedTx(env: BuildEnv, args: {
  wallet: readonly Utxo[];
  operator: string;
  sealSeedAddress: string;
  amount: bigint;
}): Promise<StepTx> {
  const sealSeedKeyHash = keyHashOf(args.sealSeedAddress, "the seal-seed address");
  if (keyHashOf(args.operator, "the operator address") === sealSeedKeyHash) throw new DeployError("the seal-seed address must not be the operator address");
  const wallet = withoutSealSeed(args.wallet, sealSeedKeyHash);
  const output = { address: args.sealSeedAddress, coin: args.amount, assets: [], datum: null, scriptRef: null };
  const tx = await evaluatedBuild(env, () => completeTx(operatorContext(env, wallet, args.operator), {
    inputs: [], referenceInputs: [], outputs: [output], mints: [], withdrawals: [], extraSignatories: [], window: env.window,
  }), []);
  assertNoSealSeedInput("seed", tx, sealSeedKeyHash);
  const atSeed = tx.outputs.filter((u) => paymentCredential(u.address)?.hash === sealSeedKeyHash);
  if (atSeed.length !== 1 || atSeed[0]!.ref.index !== 0) throw new DeployError("seed: the transaction must have exactly one output at the seal-seed address, output 0");
  return { step: "seed", tx, locked: 0n, target: `seed output of ${ap3x(args.amount)} AP3X at the seal-seed address; the seal spends it` };
}

export interface ReferenceToPublish {
  name: ReferenceName;
  script: AppliedScriptRecord;
}

/**
 * One publish transaction per script, chained: each spends the change of the
 * one before, so the whole list is valid before any of them is on chain.
 * Returns the transactions and the wallet after them.
 */
export async function publishTxs(env: BuildEnv, args: {
  wallet: readonly Utxo[];
  operator: string;
  sealSeedKeyHash: string | null;
  to: string;
  scripts: readonly ReferenceToPublish[];
}): Promise<{ txs: StepTx[]; wallet: Utxo[] }> {
  let wallet = withoutSealSeed(args.wallet, args.sealSeedKeyHash);
  const txs: StepTx[] = [];
  for (const { name, script } of args.scripts) {
    const step = `publish-${name}`;
    const before = wallet;
    const built = await evaluatedBuild(env, () => buildPublishReferenceScripts(operatorContext(env, before, args.operator), {
      scripts: [{ compiledCode: script.compiled_code }],
      to: args.to,
      window: env.window,
    }), []);
    const reference = built.outputs[0]!;
    if (reference.scriptRef !== script.compiled_code || reference.address !== args.to) throw new DeployError(`${step}: output 0 is not the reference output`);
    assertNoSealSeedInput(step, built, args.sealSeedKeyHash);
    txs.push({ step, tx: built, locked: reference.lovelace, target: `reference output of ${name} (min-UTxO)` });
    wallet = walletAfter(before, built, args.operator);
  }
  return { txs, wallet };
}

/**
 * The seal: spends only the seed, which also gives the collateral. The
 * configuration record goes to the exact `config_holder` address with M1 as
 * inline datum; the change goes to the operator.
 */
export async function sealTx(env: BuildEnv, args: {
  seed: Utxo;
  operator: string;
  sealSeedAddress: string;
  configSeal: AppliedScriptRecord;
  configHolder: AppliedScriptRecord;
  module1: string;
  /** Outputs that are not on chain yet (a seed of the cost estimate). */
  additional: readonly Utxo[];
}): Promise<StepTx> {
  const sealSeedKeyHash = keyHashOf(args.sealSeedAddress, "the seal-seed address");
  if (paymentCredential(args.seed.address)?.hash !== sealSeedKeyHash) throw new DeployError(`seal: the seed ${refText(args.seed.ref)} is not at the seal-seed address`);
  const tx = await evaluatedBuild(env, (exUnits) => buildConfigSeal(
    { ...operatorContext(env, [], args.operator, exUnits), collateral: [args.seed] },
    {
      seed: args.seed,
      seal: { hash: args.configSeal.hash, compiledCode: args.configSeal.compiled_code },
      configHolder: args.configHolder.hash,
      module1: args.module1,
      window: env.window,
    },
  ), args.additional);
  if (tx.inputs.length !== 1 || refText(tx.inputs[0]!) !== refText(args.seed.ref)) throw new DeployError("seal: the transaction must spend the seed and nothing else");
  if (tx.requiredSigners.length !== 1 || tx.requiredSigners[0] !== sealSeedKeyHash) throw new DeployError("seal: only the seal-seed key may sign the seal");
  const record = tx.outputs[0]!;
  if (record.address !== args.configHolder.address) throw new DeployError("seal: output 0 is not at the config_holder address");
  return { step: "seal", tx, locked: record.lovelace, target: "configuration record (min-UTxO; never spendable)" };
}

