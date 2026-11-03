/**
 * The commands of the identity deployment tool (Part 2 §11 step 2), except
 * `check` (check.ts). Each command takes its options, the I/O seam and the
 * environment, and returns the exit status.
 *
 * Common rules of the transaction commands (`seed`, `publish-refs`, `seal`):
 * - Dry run by default: build, evaluate with Ogmios `evaluateTransaction`,
 *   print the fee and min-UTxO totals, send nothing.
 * - `--skey <file>` (`--seed-skey` for the seal) signs; with `--submit` the
 *   transactions go to the submit API, after the totals are printed.
 * - `--build` writes unsigned transactions to `<state dir>/tx/` instead; the
 *   `sign` command signs them offline and the `submit` command sends them.
 * - Resume: each submitted step records its transaction ID in the state
 *   file. A step whose result the chain already shows is skipped. A recorded
 *   step whose result is not on chain stops the run until the transaction is
 *   on chain, or until `--rebuild`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_TOKEN_NAME, minUtxo, paymentCredential, readConfigRecord, signTransaction, type Utxo,
} from "@marketplace/shared";
import { referenceScriptAddress } from "@marketplace/shared/tx/server";
import { ALLOWLIST_FILE, ALLOWLIST_IDS_FILE, allowlistFromMints, legacyMints, readAllowlistFile, writeAllowlistFiles } from "./allowlist.js";
import type { Chain } from "./chain.js";
import {
  ap3x, holdsScript, openState, parseAp3x, printTable, requirePlan, seedStatus, verifyPlan, type CommonOptions, type Io,
  type PlannedDeployment,
} from "./context.js";
import { generatePaymentKey, keyAddress, readSigningKey, writeKeyFiles, type PaymentKey } from "./keys.js";
import { readModule1Manifest, manifestDifferences, type Module1Manifest } from "./manifest.js";
import { DeployError, type Network } from "./network.js";
import { deriveScripts, readBlueprint } from "./scripts.js";
import {
  parseRef, recordStep, REFERENCE_NAMES, refText, type Deployment, type PendingRecord, type ReferenceName, type StateFile,
} from "./state.js";
import {
  buildEnv, keyHashOf, publishTxs, sealTx, seedTx, walletAfter, type BuildEnv, type ReferenceToPublish, type StepTx,
} from "./steps.js";
import { feeAndFirstOutput, readTxFile, SIGNED_TYPE, UNSIGNED_TYPE, witnessedKeyHashes, writeTxFile } from "./txfiles.js";

type Env = Record<string, string | undefined>;

export interface TxModeOptions {
  submit?: boolean;
  build?: boolean;
  rebuild?: boolean;
  /** Seconds to wait for the submitted transactions (default 180; 0: do not wait). */
  wait?: number;
}

const DEFAULT_WAIT_SECONDS = 180;
const POLL_MS = 5_000;

// ─── keygen ──────────────────────────────────────────────────────────

export async function keygen(o: CommonOptions & { out?: string; name?: string }, io: Io, env: Env): Promise<number> {
  const { network } = openState(o, env);
  if (o.out === undefined) throw new DeployError("--out <dir> is required");
  const key = generatePaymentKey();
  writeKeyFiles(o.out, o.name ?? "operator", key);
  io.out(`address: ${keyAddress(key.keyHash, network.networkId)}`);
  io.out(`key hash: ${key.keyHash}`);
  return 0;
}

// ─── allowlist ───────────────────────────────────────────────────────

export async function allowlist(o: CommonOptions & { cutoffSlot?: string; cutoff?: string }, io: Io, env: Env): Promise<number> {
  const { network, dir, file } = openState(o, env);
  if ((o.cutoffSlot === undefined) === (o.cutoff === undefined)) throw new DeployError("give --cutoff-slot <slot> or --cutoff now");
  if (o.cutoff !== undefined && o.cutoff !== "now") throw new DeployError("--cutoff takes only the value now");
  const cutoffSlot = o.cutoffSlot === undefined ? "now" : Number(o.cutoffSlot);
  if (cutoffSlot !== "now" && (!Number.isSafeInteger(cutoffSlot) || cutoffSlot <= 0)) throw new DeployError("--cutoff-slot must be a slot number");
  const policy = network.legacyPolicy;
  if (policy === null) throw new DeployError(`${network.name} has no default legacy registry policy: give --legacy-policy <56 hex>`);
  const state = file.loadFor(network.name, network.networkId);
  const index = io.index(network);
  const { mints, cutoff, tip } = await legacyMints(index, policy, network.systemStart, cutoffSlot);
  const list = allowlistFromMints(policy, cutoff, mints);
  if (state.identity_hash !== null && (state.legacy_root !== list.root || state.cutoff_slot !== cutoff || state.legacy_hash !== policy)) {
    throw new DeployError(`${file.path} has a plan for cutoff slot ${state.cutoff_slot} and root ${state.legacy_root}; a new allowlist needs a new state directory (--dir)`);
  }
  mkdirSync(dir, { recursive: true });
  const written = writeAllowlistFiles(dir, list);
  state.cutoff_slot = cutoff;
  state.legacy_hash = policy;
  state.legacy_root = list.root;
  state.allowlist = { file: ALLOWLIST_FILE, count: list.count, sha256: written.sha256 };
  file.save(state);
  const included = mints.filter((m) => m.slot < cutoff);
  io.out(`index: ${index.label} at slot ${tip}`);
  io.out(`cutoff slot: ${cutoff}${cutoffSlot === "now" ? " (the tip of the index)" : ""}`);
  io.out(`legacy policy: ${policy}`);
  io.out(`identifiers: ${list.count} minted before the cutoff (${included.filter((m) => m.supply === 0n).length} of them burned since); ${mints.length - list.count} minted at or after the cutoff are not in the list`);
  io.out(`root: ${list.root}`);
  io.out(`files: ${written.path}, ${join(dir, ALLOWLIST_IDS_FILE)}`);
  return 0;
}

// ─── shared parts of the transaction commands ────────────────────────

function checkModes(o: TxModeOptions & { key: PaymentKey | null; keyFlag: string }): void {
  if (o.build === true && o.submit === true) throw new DeployError("--build writes unsigned transactions; it does not go with --submit");
  if (o.build === true && o.key !== null) throw new DeployError(`--build writes unsigned transactions; sign them with the sign command, not ${o.keyFlag}`);
  if (o.submit === true && o.key === null) throw new DeployError(`--submit needs ${o.keyFlag} <file>`);
}

/**
 * The operator address: from the key, the flag or the state; they must agree.
 * Its key must not be the seal-seed key: the operator wallet pays every
 * transaction but the seal. Records it in the state.
 */
function operatorOf(state: Deployment, network: Network, key: PaymentKey | null, flag: string | undefined): string {
  const candidates = [key === null ? null : keyAddress(key.keyHash, network.networkId), flag ?? null, state.operator_address].filter((a): a is string => a !== null);
  if (candidates.length === 0) throw new DeployError("the operator address is unknown: give --skey <operator key> or --operator <address>");
  if (new Set(candidates).size > 1) throw new DeployError(`the operator addresses differ: ${[...new Set(candidates)].join(", ")}`);
  const operator = candidates[0]!;
  if (state.seal_seed_address !== null && keyHashOf(operator, "the operator address") === keyHashOf(state.seal_seed_address, "the seal-seed address")) {
    throw new DeployError("the operator address must not be the seal-seed address: only the seal spends from the seal-seed key");
  }
  state.operator_address = operator;
  return operator;
}

/** The fee and min-UTxO table of a run; printed before every submit. */
function printTotals(io: Io, env: BuildEnv, steps: readonly StepTx[], title: string): void {
  io.out(`${title} (AP3X; protocol parameters at slot ${env.tipSlot}: ${env.protocol.minFeeA} per byte + ${env.protocol.minFeeB}, ${env.protocol.coinsPerUtxoByte} per UTxO byte)`);
  const rows = steps.map((s) => [s.step, s.tx.txHash, String(s.tx.signedSize), ap3x(s.tx.fee), ap3x(s.locked), s.target]);
  const fees = steps.reduce((t, s) => t + s.tx.fee, 0n);
  const locked = steps.reduce((t, s) => t + s.locked, 0n);
  rows.push(["total", "", "", ap3x(fees), ap3x(locked), `fees + min-UTxO = ${ap3x(fees + locked)} AP3X, spent for good`]);
  printTable(io, ["step", "transaction ID", "bytes", "fee", "min-UTxO", "output"], rows, new Set([2, 3, 4]));
}

/** Records the result of a submitted step in the state. */
function recordResult(state: Deployment, step: string, txId: string, time: string, pending?: PendingRecord): void {
  if (step === "seed") {
    if (state.identity_hash === null) state.config_seed = `${txId}#0`;
  } else if (step === "seal") {
    if (pending?.module1_hash === undefined) throw new DeployError("the seal has no recorded M1");
    state.seal = { tx: txId, module1_hash: pending.module1_hash, config_record: `${txId}#0` };
  } else if (step.startsWith("publish-")) {
    state.refs[step.slice("publish-".length) as ReferenceName] = `${txId}#0`;
  }
  recordStep(state, step, txId, time);
}

/** Waits until output 0 of each transaction is on chain. */
async function awaitResults(io: Io, chain: Chain, txIds: readonly string[], waitSeconds: number): Promise<void> {
  if (waitSeconds <= 0 || txIds.length === 0) return;
  const deadline = Date.now() + waitSeconds * 1000;
  let open = [...txIds];
  for (;;) {
    const found = await Promise.all(open.map((id) => chain.utxo({ txHash: id, index: 0 })));
    open = open.filter((_, i) => found[i] === null);
    if (open.length === 0) {
      io.out(`on chain: ${txIds.length === 1 ? txIds[0] : `all ${txIds.length} transactions`}`);
      return;
    }
    if (Date.now() >= deadline) {
      io.out(`not on chain after ${waitSeconds} s: ${open.join(", ")}. Run the command or check again later.`);
      return;
    }
    await io.sleep(POLL_MS);
  }
}

/**
 * The end of every transaction command: build mode, dry run or submit.
 * `extra` adds fields to the pending record of a build (the seal's M1).
 */
async function finish(args: {
  io: Io;
  chain: Chain;
  network: Network;
  file: StateFile;
  state: Deployment;
  steps: readonly StepTx[];
  key: PaymentKey | null;
  keyFlag: string;
  o: TxModeOptions;
  extra?: Partial<PendingRecord>;
}): Promise<number> {
  const { io, chain, network, file, state, steps, key, o } = args;
  for (const s of steps) {
    if (key !== null && s.tx.requiredSigners.some((h) => h !== key.keyHash)) {
      throw new DeployError(`${s.step} needs the signatures of ${s.tx.requiredSigners.join(", ")}; ${args.keyFlag} is the key ${key.keyHash}`);
    }
  }
  if (o.build === true) {
    const built = io.now().toISOString();
    for (const s of steps) {
      const path = join(file.dir, "tx", `${s.step}.unsigned.json`);
      writeTxFile(path, {
        type: UNSIGNED_TYPE, description: `identity deployment, ${network.name}: ${s.step}`, cborHex: s.tx.txCborHex,
        network: network.name, step: s.step, txId: s.tx.txHash, signers: s.tx.requiredSigners,
      });
      state.pending[s.step] = { tx: s.tx.txHash, file: path, built, signers: s.tx.requiredSigners, ...args.extra };
      io.out(`built ${s.step}: ${path}`);
    }
    file.save(state);
    io.out("next, in this order: sign --tx <file> --skey <key>, then submit --tx <signed file> --submit");
    io.out(`the transactions are valid until ${new Date(steps[0]!.tx.window.hi).toISOString()}; build them again after that`);
    return 0;
  }
  const signed: string[] = [];
  if (key !== null) for (const s of steps) signed.push(await signTransaction(s.tx.txCborHex, key.privateKeyHex));
  if (o.submit !== true) {
    io.out(key === null
      ? "dry run: nothing was sent. Add --skey <file> --submit to send, or --build to write unsigned transactions."
      : `dry run: signed with ${key.keyHash}; nothing was sent. Add --submit to send.`);
    return 0;
  }
  const submitted: string[] = [];
  for (const [i, s] of steps.entries()) {
    const txId = await chain.submit(signed[i]!);
    if (txId !== s.tx.txHash) throw new DeployError(`${s.step}: the submit API returned ${txId}, not ${s.tx.txHash}`);
    recordResult(state, s.step, txId, io.now().toISOString(), { tx: txId, file: "", built: "", signers: [], ...args.extra });
    file.save(state);
    submitted.push(txId);
    io.out(`submitted ${s.step}: ${txId}`);
  }
  await awaitResults(io, chain, submitted, o.wait ?? DEFAULT_WAIT_SECONDS);
  return 0;
}

// ─── seed ────────────────────────────────────────────────────────────

export async function seed(o: CommonOptions & TxModeOptions & { skey?: string; operator?: string; to?: string; amount?: string }, io: Io, env: Env): Promise<number> {
  const { network, file } = openState(o, env);
  const key = o.skey === undefined ? null : readSigningKey(o.skey);
  checkModes({ ...o, key, keyFlag: "--skey" });
  const state = file.loadFor(network.name, network.networkId);
  const operator = operatorOf(state, network, key, o.operator);
  const to = o.to ?? state.seal_seed_address;
  if (to === null) throw new DeployError("--to <seal-seed address> is required");
  if (state.seal_seed_address !== null && state.seal_seed_address !== to) throw new DeployError(`${file.path} records the seal-seed address ${state.seal_seed_address}, not ${to}`);
  if (keyHashOf(to, "the seal-seed address") === keyHashOf(operator, "the operator address")) throw new DeployError("the seal-seed address must not be the operator address");
  const chain = io.chain(network);

  const recorded = state.steps.seed;
  if (recorded !== undefined) {
    const ref = { txHash: recorded.tx, index: 0 };
    const output = await chain.utxo(ref);
    if (output !== null) {
      io.out(`seed: done; ${refText(ref)} holds ${ap3x(output.lovelace)} AP3X at ${output.address}`);
      return 0;
    }
    if (state.seal !== null) {
      io.out(`seed: done; the seal ${state.seal.tx} spent it`);
      return 0;
    }
    if (o.rebuild !== true) {
      throw new DeployError(`seed: ${refText(ref)} (submitted ${recorded.time}) is not on chain. Wait until it is and run again, or add --rebuild.`);
    }
    if (state.identity_hash !== null) throw new DeployError(`seed: the plan in ${file.path} depends on the seed ${state.config_seed}; use a new state directory for a new seed`);
    delete state.steps.seed;
  } else {
    const present = await chain.utxosAt(to);
    if (present.length > 0) {
      throw new DeployError(`the seal-seed address already holds ${present.map((u) => refText(u.ref)).join(", ")}: use one of them with plan --seed <ref>, or send the seed to a new seal-seed address`);
    }
  }
  if (o.amount === undefined) throw new DeployError("--amount <AP3X> is required");
  const amount = parseAp3x(o.amount, "--amount");
  if (amount < MIN_SEED_LOVELACE) {
    throw new DeployError(`--amount must be at least ${ap3x(MIN_SEED_LOVELACE)} AP3X: the seed alone pays the configuration record (about 1.2 AP3X), the seal fee, the collateral and a change output`);
  }
  state.seal_seed_address = to;

  const env2 = await buildEnv(network, chain);
  const step = await seedTx(env2, { wallet: await chain.utxosAt(operator), operator, sealSeedAddress: to, amount });
  printTotals(io, env2, [step], "seed transaction");
  return finish({ io, chain, network, file, state, steps: [step], key, keyFlag: "--skey", o });
}

/** The least seed: the seal spends only the seed (record, fee, collateral, change). The runbook uses 5 AP3X. */
const MIN_SEED_LOVELACE = 3_000_000n;

// ─── plan ────────────────────────────────────────────────────────────

/** Key hashes of the stand-in addresses of a cost estimate before the operator or the seal-seed address is known. */
const ESTIMATE_OPERATOR_KEY_HASH = "11".repeat(28);
const ESTIMATE_SEAL_SEED_KEY_HASH = "22".repeat(28);
/** The stand-in wallet output of a cost estimate when the operator wallet has too little. */
const ESTIMATE_WALLET_LOVELACE = 1_000_000_000n;

export async function plan(o: CommonOptions & {
  seed?: string;
  seedAddress?: string;
  allowlist?: string;
  seedCheck?: boolean;
  operator?: string;
  skey?: string;
  seedAmount?: string;
}, io: Io, env: Env): Promise<number> {
  const { network, dir, file } = openState(o, env);
  const state = file.loadFor(network.name, network.networkId);
  const listPath = o.allowlist ?? join(dir, ALLOWLIST_FILE);
  const list = readAllowlistFile(listPath);
  if (network.legacyPolicy !== null && list.policy !== network.legacyPolicy) throw new DeployError(`${listPath} lists policy ${list.policy}, not the legacy registry ${network.legacyPolicy}`);
  if (state.legacy_root !== null && (state.legacy_root !== list.root || state.cutoff_slot !== list.cutoff_slot || state.legacy_hash !== list.policy)) {
    throw new DeployError(`${listPath} is not the allowlist of ${file.path} (cutoff slot ${state.cutoff_slot}, root ${state.legacy_root})`);
  }
  const seedFromStep = state.steps.seed === undefined ? null : `${state.steps.seed.tx}#0`;
  const seedText = o.seed ?? seedFromStep ?? state.config_seed;
  if (seedText === null) throw new DeployError("--seed <txid#index> is required (or run the seed command first)");
  const seedRef = parseRef(seedText, "--seed");
  if (seedFromStep !== null && refText(seedRef) !== seedFromStep) throw new DeployError(`${file.path} records the seed ${seedFromStep} of the seed command, not ${refText(seedRef)}`);
  if (o.seedAddress !== undefined && state.seal_seed_address !== null && o.seedAddress !== state.seal_seed_address) {
    throw new DeployError(`${file.path} records the seal-seed address ${state.seal_seed_address}, not ${o.seedAddress}`);
  }
  const sealSeedAddress = o.seedAddress ?? state.seal_seed_address;
  if (sealSeedAddress !== null) keyHashOf(sealSeedAddress, "the seal-seed address");
  const key = o.skey === undefined ? null : readSigningKey(o.skey);
  if (key !== null || o.operator !== undefined) operatorOf(state, network, key, o.operator);
  const chain = io.chain(network);

  if (o.seedCheck !== false) {
    if (sealSeedAddress === null) throw new DeployError("the seed check needs the seal-seed address: --seed-address <address>, or run the seed command first");
    const output = await chain.utxo(seedRef);
    if (output === null) throw new DeployError(`the seed ${refText(seedRef)} is not an unspent output on ${network.name}`);
    if (paymentCredential(output.address)?.hash !== keyHashOf(sealSeedAddress, "the seal-seed address")) {
      throw new DeployError(`the seed ${refText(seedRef)} is at ${output.address}, not at the seal-seed address ${sealSeedAddress}`);
    }
    io.out(`seed: ${refText(seedRef)} is unspent at the seal-seed address (${ap3x(output.lovelace)} AP3X)`);
  } else {
    io.out(`seed: ${refText(seedRef)} was not checked (--no-seed-check); use this plan only for estimates`);
  }

  const blueprint = readBlueprint();
  const scripts = deriveScripts(blueprint, { legacyHash: list.policy, legacyRoot: list.root, configSeed: seedRef, networkId: network.networkId });
  if (state.identity_hash !== null && state.identity_hash !== scripts.identity.hash) {
    if (Object.keys(state.refs).length > 0 || state.seal !== null || Object.keys(state.pending).some((s) => s !== "seed")) {
      throw new DeployError(`${file.path} has transactions of the plan with identity hash ${state.identity_hash}; a new plan needs a new state directory`);
    }
    io.out(`the plan replaces the plan with identity hash ${state.identity_hash}; nothing of it is published`);
  }
  Object.assign(state, {
    cutoff_slot: list.cutoff_slot,
    legacy_hash: list.policy,
    legacy_root: list.root,
    seal_seed_address: sealSeedAddress,
    config_seed: refText(seedRef),
    config_holder: scripts.config_holder.hash,
    config_holder_address: scripts.config_holder.address,
    config_policy: scripts.config_seal.hash,
    identity_hash: scripts.identity.hash,
    identity_address: scripts.identity.address,
    attestation_hash: scripts.attestation.hash,
    delegation_hash: scripts.delegation.hash,
    escrow_hash: scripts.escrow.hash,
    vault_hash: scripts.vault.hash,
    advert_hash: scripts.advert.hash,
    reference_address: state.reference_address ?? referenceScriptAddress(network.networkId),
    blueprint: { sha256: blueprint.sha256, compiler: blueprint.compiler },
    scripts,
  } satisfies Partial<Deployment>);
  file.save(state);

  io.out(`plan: ${file.path}`);
  printTable(io, ["script", "hash", "address", "bytes"], Object.entries(scripts).map(([name, s]) => [name, s.hash, s.address, String(s.size)]), new Set([3]));
  await printCosts(io, network, chain, requirePlan(state, file.path), o.seedAmount === undefined ? 5_000_000n : parseAp3x(o.seedAmount, "--seed-amount"));
  return 0;
}

/**
 * The cost table: every transaction that is not done yet, built with the
 * chain's protocol parameters and evaluated with Ogmios. Stand-ins replace
 * what is not known yet: the operator wallet (one output of 1,000 AP3X when
 * the wallet holds less), the seal-seed address, the seed (when it is not on
 * chain) and M1 (the fee does not depend on its value).
 */
async function printCosts(io: Io, network: Network, chain: Chain, state: PlannedDeployment, seedAmount: bigint): Promise<void> {
  const env = await buildEnv(network, chain);
  const operator = state.operator_address ?? keyAddress(ESTIMATE_OPERATOR_KEY_HASH, network.networkId);
  const sealSeedAddress = state.seal_seed_address ?? keyAddress(ESTIMATE_SEAL_SEED_KEY_HASH, network.networkId);
  const notes: string[] = [];
  let wallet: Utxo[] = state.operator_address === null ? [] : await chain.utxosAt(operator);
  if (wallet.reduce((t, u) => t + u.lovelace, 0n) < ESTIMATE_WALLET_LOVELACE / 2n) {
    wallet = [{ ref: { txHash: "ee".repeat(32), index: 0 }, address: operator, lovelace: ESTIMATE_WALLET_LOVELACE, assets: {}, datumHex: null, scriptRef: null }];
    notes.push(`the operator wallet is a stand-in: one output of ${ap3x(ESTIMATE_WALLET_LOVELACE)} AP3X`);
  }
  const steps: StepTx[] = [];
  if (state.steps.seed === undefined) {
    const seedStep = await seedTx(env, { wallet, operator, sealSeedAddress, amount: seedAmount });
    steps.push(seedStep);
    wallet = walletAfter(wallet, seedStep.tx, operator);
  }
  const todo: ReferenceToPublish[] = REFERENCE_NAMES.filter((name) => state.refs[name] === undefined).map((name) => ({ name, script: state.scripts[name] }));
  const publish = await publishTxs(env, {
    wallet, operator, sealSeedKeyHash: keyHashOf(sealSeedAddress, "the seal-seed address"), to: state.reference_address ?? referenceScriptAddress(network.networkId), scripts: todo,
  });
  steps.push(...publish.txs);
  if (state.seal === null) {
    const onChain = (await seedStatus(chain, state)).utxo;
    const seedUtxo: Utxo = onChain ?? { ref: parseRef(state.config_seed, "config_seed"), address: sealSeedAddress, lovelace: seedAmount, assets: {}, datumHex: null, scriptRef: null };
    if (onChain === null) notes.push(`the seed is a stand-in output of ${ap3x(seedAmount)} AP3X at the seal-seed address`);
    notes.push("M1 is a stand-in: the seal fee does not depend on its value");
    const seal = await sealTx(env, {
      seed: seedUtxo, operator, sealSeedAddress, configSeal: state.scripts.config_seal, configHolder: state.scripts.config_holder,
      module1: state.config_holder, additional: onChain === null ? [seedUtxo] : [],
    });
    steps.push(seal);
    const change = minUtxo({ address: operator, coin: 1_000_000n, assets: [], datum: null, scriptRef: null }, env.protocol.coinsPerUtxoByte);
    notes.push(`the seed must hold at least ${ap3x(seal.locked + seal.tx.fee + change)} AP3X: the configuration record, the seal fee and a change output`);
  }
  if (state.operator_address === null) notes.push("the operator address is a stand-in");
  if (state.seal_seed_address === null) notes.push("the seal-seed address is a stand-in");
  printTotals(io, env, steps, "costs of the steps that are not done");
  for (const note of notes) io.out(`  note: ${note}`);
}

// ─── publish-refs ────────────────────────────────────────────────────

function referenceNames(text: string): ReferenceName[] {
  const names = text.split(",").map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) throw new DeployError("--scripts lists no script");
  for (const name of names) {
    if (name === "config_seal" || name === "config_holder") throw new DeployError(`${name} needs no reference output: config_holder is never spent, and the seal carries config_seal once`);
    if (!(REFERENCE_NAMES as readonly string[]).includes(name)) throw new DeployError(`--scripts: unknown script ${name}; the scripts are ${REFERENCE_NAMES.join(", ")}`);
  }
  if (new Set(names).size !== names.length) throw new DeployError("--scripts lists a script twice");
  return names as ReferenceName[];
}

export async function publishRefs(o: CommonOptions & TxModeOptions & { scripts?: string; to?: string; skey?: string; operator?: string }, io: Io, env: Env): Promise<number> {
  const { network, file } = openState(o, env);
  const names = referenceNames(o.scripts ?? REFERENCE_NAMES.join(","));
  const key = o.skey === undefined ? null : readSigningKey(o.skey);
  checkModes({ ...o, key, keyFlag: "--skey" });
  const state = requirePlan(file.loadFor(network.name, network.networkId), file.path);
  verifyPlan(state);
  const operator = operatorOf(state, network, key, o.operator);
  const to = o.to ?? state.reference_address ?? referenceScriptAddress(network.networkId);
  if (Object.keys(state.refs).length > 0 && state.reference_address !== null && to !== state.reference_address) {
    throw new DeployError(`${file.path} records reference scripts at ${state.reference_address}, not at ${to}`);
  }
  const chain = io.chain(network);

  const seedState = await seedStatus(chain, state);
  if (!seedState.atSealSeed && state.seal === null) {
    const problem = `the config seed ${state.config_seed} is not an unspent output at the seal-seed address: the seal could never mint with this plan`;
    if (o.submit === true || o.build === true) throw new DeployError(problem);
    io.out(`warning: ${problem}`);
  }

  let synced = false;
  const atTarget = await chain.utxosAt(to);
  const todo: ReferenceToPublish[] = [];
  for (const name of names) {
    const script = state.scripts[name];
    const step = `publish-${name}`;
    const recorded = state.refs[name];
    if (recorded !== undefined) {
      const output = await chain.utxo(parseRef(recorded, `refs.${name}`));
      if (output !== null && holdsScript(output, script, to)) {
        io.out(`${step}: done; ${recorded}`);
        continue;
      }
      if (output !== null) throw new DeployError(`${step}: ${recorded} does not hold the ${name} script ${script.hash}`);
      if (o.rebuild !== true) {
        throw new DeployError(`${step}: ${recorded} (submitted ${state.steps[step]?.time ?? "?"}) is not on chain. Wait until it is and run again, or add --rebuild.`);
      }
      delete state.refs[name];
      delete state.steps[step];
    }
    const found = atTarget.find((u) => holdsScript(u, script, to));
    if (found !== undefined) {
      state.refs[name] = refText(found.ref);
      recordStep(state, step, found.ref.txHash, io.now().toISOString());
      synced = true;
      io.out(`${step}: done; found on chain at ${refText(found.ref)}`);
      continue;
    }
    todo.push({ name, script });
  }
  state.reference_address = to;
  if (synced) file.save(state);
  if (todo.length === 0) {
    io.out("every listed reference script is on chain");
    return 0;
  }
  const env2 = await buildEnv(network, chain);
  const sealSeedKeyHash = state.seal_seed_address === null ? null : keyHashOf(state.seal_seed_address, "the seal-seed address");
  const { txs } = await publishTxs(env2, { wallet: await chain.utxosAt(operator), operator, sealSeedKeyHash, to, scripts: todo });
  printTotals(io, env2, txs, `reference-script transactions to ${to}`);
  return finish({ io, chain, network, file, state, steps: txs, key, keyFlag: "--skey", o });
}

// ─── seal ────────────────────────────────────────────────────────────

export async function seal(o: CommonOptions & TxModeOptions & { manifest?: string; seedSkey?: string }, io: Io, env: Env): Promise<number> {
  const { network, file } = openState(o, env);
  const key = o.seedSkey === undefined ? null : readSigningKey(o.seedSkey);
  checkModes({ ...o, key, keyFlag: "--seed-skey" });
  const state = requirePlan(file.loadFor(network.name, network.networkId), file.path);
  verifyPlan(state);
  if (o.manifest === undefined) throw new DeployError("--module1-manifest <file> is required");
  const manifest: Module1Manifest = readModule1Manifest(o.manifest);
  const differences = manifestDifferences(state, manifest);
  if (differences.length > 0) throw new DeployError(`the Module-1 manifest ${o.manifest} differs from the plan: ${differences.join("; ")}`);
  if (state.operator_address === null) throw new DeployError(`${file.path} has no operator address; run seed or plan with --operator <address>`);
  if (state.seal_seed_address === null) throw new DeployError(`${file.path} has no seal-seed address`);
  if (key !== null && key.keyHash !== keyHashOf(state.seal_seed_address, "the seal-seed address")) {
    throw new DeployError(`--seed-skey is the key ${key.keyHash}, not the key of the seal-seed address ${state.seal_seed_address}`);
  }
  const chain = io.chain(network);

  const records = (await chain.utxosAt(state.config_holder_address))
    .filter((u) => Object.keys(u.assets).some((unit) => unit.replace(".", "") === `${state.config_policy}${CONFIG_TOKEN_NAME}`));
  if (records.length > 1) throw new DeployError(`the config_holder address holds ${records.length} configuration tokens`);
  if (records.length === 1) {
    const record = records[0]!;
    const m1 = readConfigRecord(record, state.config_policy, state.config_holder);
    if (m1 !== manifest.m1) throw new DeployError(`the configuration record ${refText(record.ref)} names M1 ${m1}; the manifest names ${manifest.m1}`);
    if (state.seal === null) {
      state.seal = { tx: record.ref.txHash, module1_hash: m1, config_record: refText(record.ref) };
      recordStep(state, "seal", record.ref.txHash, io.now().toISOString());
      file.save(state);
    }
    io.out(`seal: done; ${refText(record.ref)} names M1 ${m1}`);
    return 0;
  }
  const recorded = state.steps.seal;
  if (recorded !== undefined && o.rebuild !== true) {
    throw new DeployError(`seal: ${recorded.tx} (submitted ${recorded.time}) is not on chain. Wait until it is and run again, or add --rebuild.`);
  }
  const seedOutput = (await seedStatus(chain, state));
  if (seedOutput.utxo === null || !seedOutput.atSealSeed) {
    throw new DeployError(`the config seed ${state.config_seed} is not an unspent output at the seal-seed address: config_seal cannot mint`);
  }
  const env2 = await buildEnv(network, chain);
  const step = await sealTx(env2, {
    seed: seedOutput.utxo, operator: state.operator_address, sealSeedAddress: state.seal_seed_address,
    configSeal: state.scripts.config_seal, configHolder: state.scripts.config_holder, module1: manifest.m1, additional: [],
  });
  printTotals(io, env2, [step], `seal (M1 ${manifest.m1})`);
  io.out(`  change to the operator: ${ap3x(seedOutput.utxo.lovelace - step.locked - step.tx.fee)} AP3X`);
  return finish({ io, chain, network, file, state, steps: [step], key, keyFlag: "--seed-skey", o, extra: { module1_hash: manifest.m1 } });
}

// ─── sign ────────────────────────────────────────────────────────────

export async function sign(o: { tx?: string; skey?: string; out?: string }, io: Io): Promise<number> {
  if (o.tx === undefined || o.skey === undefined) throw new DeployError("sign needs --tx <file> and --skey <file>");
  const txFile = readTxFile(o.tx);
  const key = readSigningKey(o.skey);
  if (!txFile.signers.includes(key.keyHash)) {
    throw new DeployError(`${o.tx} needs the signatures of ${txFile.signers.join(", ")}; ${o.skey} is the key ${key.keyHash}`);
  }
  const signed = await signTransaction(txFile.cborHex, key.privateKeyHex);
  const out = o.out ?? (o.tx.endsWith(".unsigned.json") ? o.tx.replace(/\.unsigned\.json$/, ".signed.json") : `${o.tx}.signed.json`);
  writeTxFile(out, { ...txFile, type: SIGNED_TYPE, cborHex: signed });
  const missing = txFile.signers.filter((h) => !witnessedKeyHashes(signed).includes(h));
  io.out(`signed ${txFile.step} with ${key.keyHash}: ${out}`);
  if (missing.length > 0) io.out(`still needed: ${missing.join(", ")}`);
  return 0;
}

// ─── submit ──────────────────────────────────────────────────────────

export async function submit(o: CommonOptions & { tx?: string; submit?: boolean; wait?: number }, io: Io, env: Env): Promise<number> {
  const { network, file } = openState(o, env);
  if (o.tx === undefined) throw new DeployError("--tx <signed file> is required");
  const txFile = readTxFile(o.tx);
  if (txFile.network !== network.name) throw new DeployError(`${o.tx} is a ${txFile.network} transaction`);
  const state = file.loadFor(network.name, network.networkId);
  const pending = state.pending[txFile.step];
  if (pending === undefined || pending.tx !== txFile.txId) {
    throw new DeployError(`${file.path} has no pending build of ${txFile.step} with the transaction ${txFile.txId}: build it again`);
  }
  const missing = pending.signers.filter((h) => !witnessedKeyHashes(txFile.cborHex).includes(h));
  if (missing.length > 0) throw new DeployError(`${o.tx} lacks the signatures of ${missing.join(", ")}`);
  const chain = io.chain(network);
  if (txFile.step.startsWith("publish-")) {
    const planned = requirePlan(state, file.path);
    const seedState = await seedStatus(chain, planned);
    if (!seedState.atSealSeed && state.seal === null) throw new DeployError(`the config seed ${planned.config_seed} is not an unspent output at the seal-seed address`);
  }
  await chain.evaluate(txFile.cborHex, []);
  const { fee, firstOutput } = feeAndFirstOutput(txFile.cborHex);
  const output = txFile.step === "seed" ? "seed output" : txFile.step === "seal" ? "configuration record (min-UTxO)" : "reference output (min-UTxO)";
  io.out(`${txFile.step}: ${txFile.txId}, ${txFile.cborHex.length / 2} bytes, signed by ${pending.signers.join(", ")}`);
  io.out(`  fee ${ap3x(fee)} AP3X; output 0, the ${output}: ${ap3x(firstOutput)} AP3X`);
  if (o.submit !== true) {
    io.out("dry run: nothing was sent. Add --submit to send.");
    return 0;
  }
  const txId = await chain.submit(txFile.cborHex);
  if (txId !== txFile.txId) throw new DeployError(`the submit API returned ${txId}, not ${txFile.txId}`);
  recordResult(state, txFile.step, txId, io.now().toISOString(), pending);
  file.save(state);
  io.out(`submitted ${txFile.step}: ${txId}`);
  await awaitResults(io, chain, [txId], o.wait ?? DEFAULT_WAIT_SECONDS);
  return 0;
}
