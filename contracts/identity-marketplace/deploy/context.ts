/**
 * What the commands share: the I/O seam (output lines, chain clients, clock),
 * the state directory, AP3X amounts, tables and the checks of a plan against
 * the chain and the blueprint.
 */

import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { paymentCredential, plutusV3Hash } from "@marketplace/shared";
import { KoiosIndex, OgmiosChain, type Chain, type ChainUtxo, type LegacyIndex } from "./chain.js";
import { DeployError, resolveNetwork, type Network, type NetworkOverrides } from "./network.js";
import { deriveScripts, readBlueprint } from "./scripts.js";
import { parseRef, SCRIPT_NAMES, StateFile, type AppliedScriptRecord, type Deployment, type ScriptName } from "./state.js";

export interface Io {
  out(line: string): void;
  chain(network: Network): Chain;
  index(network: Network): LegacyIndex;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  chain: (network) => new OgmiosChain(network.ogmiosUrl, network.submitUrl),
  index: (network) => {
    if (network.koiosUrl === null) throw new DeployError(`${network.name} has no default Koios URL: give --koios <url> or VECTOR_KOIOS_URL`);
    return new KoiosIndex(network.koiosUrl, network.koiosToken);
  },
  now: () => new Date(),
  sleep: (ms) => delay(ms),
};

/** The default state directories: `contracts/identity-marketplace/deploy/state/<network>` (git ignores them). */
export const STATE_ROOT = fileURLToPath(new URL("./state/", import.meta.url));

export interface CommonOptions extends NetworkOverrides {
  network?: string;
  /** The state directory. Default: STATE_ROOT/<network>. */
  dir?: string;
}

export function openState(o: CommonOptions, env: Record<string, string | undefined>): { network: Network; dir: string; file: StateFile } {
  const network = resolveNetwork(o.network, o, env);
  const dir = o.dir ?? join(STATE_ROOT, network.name);
  return { network, dir, file: new StateFile(dir) };
}

const AP3X = 1_000_000n;

/** AP3X with six decimals, from base units. */
export function ap3x(base: bigint): string {
  const sign = base < 0n ? "-" : "";
  const abs = base < 0n ? -base : base;
  return `${sign}${abs / AP3X}.${(abs % AP3X).toString().padStart(6, "0")}`;
}

/** Base units from an AP3X amount with at most six decimals. */
export function parseAp3x(text: string, what: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (match === null) throw new DeployError(`${what} must be an AP3X amount such as 5 or 2.5, not ${JSON.stringify(text)}`);
  return BigInt(match[1]!) * AP3X + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** Prints rows as aligned columns; numbers (columns in `right`) align to the right. */
export function printTable(io: Io, header: readonly string[], rows: ReadonlyArray<readonly string[]>, right: ReadonlySet<number>): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (right.has(i) ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd();
  io.out(`  ${line(header)}`);
  for (const row of rows) io.out(`  ${line(row)}`);
}

/** A state with a plan: every value that `plan` writes is set. */
export type PlannedDeployment = Deployment & {
  cutoff_slot: number;
  legacy_hash: string;
  legacy_root: string;
  config_seed: string;
  config_holder: string;
  config_holder_address: string;
  config_policy: string;
  identity_hash: string;
  identity_address: string;
  scripts: Record<ScriptName, AppliedScriptRecord>;
};

export function requirePlan(state: Deployment, path: string): PlannedDeployment {
  if (state.identity_hash === null || state.config_seed === null || SCRIPT_NAMES.some((name) => state.scripts[name] === undefined)) {
    throw new DeployError(`${path} has no plan: run the plan command first`);
  }
  return state as PlannedDeployment;
}

/**
 * Applies the recorded parameters to the current blueprint again and compares
 * the scripts with the plan. A difference means that plutus.json changed after
 * the plan, and the recorded hashes are not those of the blueprint.
 */
export function verifyPlan(state: PlannedDeployment): void {
  const scripts = deriveScripts(readBlueprint(), {
    legacyHash: state.legacy_hash,
    legacyRoot: state.legacy_root,
    configSeed: parseRef(state.config_seed, "config_seed"),
    networkId: state.network_id as 1,
  });
  const changed = SCRIPT_NAMES.filter((name) => scripts[name].compiled_code !== state.scripts[name].compiled_code);
  if (changed.length > 0) {
    throw new DeployError(`the applied scripts of ${changed.join(", ")} differ from the plan: plutus.json changed after the plan. Run plan again (only possible before anything is published).`);
  }
}

/** True when `u` is at `to` and holds `script` as a Plutus V3 reference script. */
export function holdsScript(u: ChainUtxo, script: AppliedScriptRecord, to: string): boolean {
  return u.address === to && u.scriptRef !== null && (u.scriptLanguage ?? "plutus:v3") === "plutus:v3" && plutusV3Hash(u.scriptRef) === script.hash;
}

export interface SeedStatus {
  /** The seed output, when it is unspent. */
  utxo: ChainUtxo | null;
  /** True when the unspent seed is at the seal-seed address. */
  atSealSeed: boolean;
}

/** The state of the config seed on chain. */
export async function seedStatus(chain: Chain, state: PlannedDeployment): Promise<SeedStatus> {
  const utxo = await chain.utxo(parseRef(state.config_seed, "config_seed"));
  const sealSeedKeyHash = state.seal_seed_address === null ? null : paymentCredential(state.seal_seed_address)?.hash ?? null;
  return { utxo, atSealSeed: utxo !== null && sealSeedKeyHash !== null && paymentCredential(utxo.address)?.hash === sealSeedKeyHash };
}
