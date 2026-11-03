/**
 * The state file `deployment.json` of one deployment. It is the record of
 * the run and the input of the next tools:
 *
 * - `allowlist` writes network, cutoff_slot, legacy_hash, legacy_root and allowlist.
 * - `seed` writes operator_address, seal_seed_address, config_seed and steps.seed.
 * - `plan` writes the script hashes, the addresses and the applied scripts.
 * - `publish-refs` writes refs and steps.publish-<name>.
 * - `seal` writes seal and steps.seal.
 *
 * The Module-1 deployment tool (vector-agent-modules) reads identity_hash,
 * config_policy, config_holder, refs.identity, reference_address,
 * operator_address, seal_seed_address and config_seed. Hex is lowercase;
 * output references are `<64 hex>#<index>`; times are ISO 8601 UTC.
 *
 * `pending` holds the transactions of the build mode: built and written to a
 * file, not yet submitted (`sign`, then `submit`).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { OutputReference } from "@marketplace/shared";
import { DeployError, type NetworkName } from "./network.js";

export const STATE_FORMAT = "vector-identity-deployment/1";

/** The scripts of the identity side, in the order of their parameters (Part 2 §2, §3.8). */
export const SCRIPT_NAMES = ["config_holder", "config_seal", "identity", "attestation", "delegation", "escrow", "vault", "advert"] as const;
export type ScriptName = (typeof SCRIPT_NAMES)[number];

/** The scripts that get a reference output. `config_holder` is never spent and the seal runs once, with the script inline. */
export const REFERENCE_NAMES = ["identity", "attestation", "delegation", "vault", "escrow", "advert"] as const;
export type ReferenceName = (typeof REFERENCE_NAMES)[number];

export interface AppliedScriptRecord {
  /** The blueprint handler, for example `identity.identity.mint`. */
  title: string;
  /** The parameters in apply order, each as Plutus Data CBOR hex. */
  parameters: string[];
  hash: string;
  /** Enterprise address of the script: the script as payment credential, no stake credential. */
  address: string;
  /** Bytes of the compiled code. */
  size: number;
  compiled_code: string;
}

export interface StepRecord {
  /** The transaction ID. */
  tx: string;
  time: string;
}

export interface PendingRecord {
  tx: string;
  /** The unsigned transaction file of the build mode. */
  file: string;
  built: string;
  /** Key hashes that must sign. */
  signers: string[];
  /** The seal only: M1 of its configuration datum, for the seal record after the submit. */
  module1_hash?: string;
}

export interface SealRecord {
  tx: string;
  /** M1: the hash of Module-1 `identity_party` in the configuration datum. */
  module1_hash: string;
  config_record: string;
}

export interface Deployment {
  format: string;
  network: NetworkName;
  network_id: number;
  cutoff_slot: number | null;
  legacy_hash: string | null;
  legacy_root: string | null;
  allowlist: { file: string; count: number; sha256: string } | null;
  operator_address: string | null;
  seal_seed_address: string | null;
  config_seed: string | null;
  config_holder: string | null;
  config_holder_address: string | null;
  config_policy: string | null;
  identity_hash: string | null;
  identity_address: string | null;
  attestation_hash: string | null;
  delegation_hash: string | null;
  escrow_hash: string | null;
  vault_hash: string | null;
  advert_hash: string | null;
  reference_address: string | null;
  blueprint: { sha256: string; compiler: string } | null;
  scripts: Partial<Record<ScriptName, AppliedScriptRecord>>;
  refs: Partial<Record<ReferenceName, string>>;
  seal: SealRecord | null;
  steps: Record<string, StepRecord>;
  pending: Record<string, PendingRecord>;
}

export function emptyDeployment(network: NetworkName, networkId: number): Deployment {
  return {
    format: STATE_FORMAT,
    network,
    network_id: networkId,
    cutoff_slot: null,
    legacy_hash: null,
    legacy_root: null,
    allowlist: null,
    operator_address: null,
    seal_seed_address: null,
    config_seed: null,
    config_holder: null,
    config_holder_address: null,
    config_policy: null,
    identity_hash: null,
    identity_address: null,
    attestation_hash: null,
    delegation_hash: null,
    escrow_hash: null,
    vault_hash: null,
    advert_hash: null,
    reference_address: null,
    blueprint: null,
    scripts: {},
    refs: {},
    seal: null,
    steps: {},
    pending: {},
  };
}

export const refText = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

export function parseRef(value: string, what: string): OutputReference {
  const match = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,5})$/.exec(value.trim().toLowerCase());
  if (match === null) throw new DeployError(`${what} must be <64 hex transaction ID>#<output index>, not ${JSON.stringify(value)}`);
  return { txHash: match[1]!, index: Number(match[2]) };
}

/** The state file of a state directory. Writes go to a temporary file first, then replace the file. */
export class StateFile {
  readonly path: string;

  constructor(readonly dir: string) {
    this.path = join(dir, "deployment.json");
  }

  load(): Deployment | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const state = JSON.parse(raw) as Deployment;
    if (state.format !== STATE_FORMAT) throw new DeployError(`${this.path}: format ${JSON.stringify(state.format)} is not ${STATE_FORMAT}`);
    return state;
  }

  /** The state, or a new one for `network`. Refuses a state of another network. */
  loadFor(network: NetworkName, networkId: number): Deployment {
    const state = this.load() ?? emptyDeployment(network, networkId);
    if (state.network !== network) throw new DeployError(`${this.path} is a ${state.network} deployment, not ${network}`);
    return state;
  }

  save(state: Deployment): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.path);
  }
}

/** Records a submitted step and clears its pending build. */
export function recordStep(state: Deployment, step: string, tx: string, time: string): void {
  state.steps[step] = { tx, time };
  delete state.pending[step];
}
