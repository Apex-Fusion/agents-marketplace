/**
 * The applied scripts of the deployment (Part 2 §2, §3.8). The parameters are
 * applied in the contract order:
 *
 * 1. `config_holder` (none);
 * 2. `config_seal(seed, config_holder)`;
 * 3. `identity(legacy_hash, legacy_root, config_policy, config_holder)`;
 * 4. `attestation`, `delegation` and `escrow` with `identity_hash`;
 * 5. `vault(identity_hash, delegation_hash, escrow_hash)`;
 * 6. `advert` (none).
 *
 * `apply_params_to_script` of `@lucid-evolution/uplc` (the `uplc` crate of
 * Aiken, compiled to WebAssembly) applies them, as the MCP server and both
 * SDKs do. Its bytes equal those of `aiken blueprint apply`
 * (tests/identity-deploy/plan.test.ts).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply_params_to_script } from "@lucid-evolution/uplc";
import { enterpriseAddress, plutusV3Hash, type NetworkId, type OutputReference } from "@marketplace/shared";
import { encodePlutusData, encodePlutusDataHex, type PlutusData } from "@marketplace/shared/cbor";
import { DeployError } from "./network.js";
import type { AppliedScriptRecord, ScriptName } from "./state.js";

export const BLUEPRINT_PATH = fileURLToPath(new URL("../plutus.json", import.meta.url));

/** The blueprint handler of each script. Handlers of one validator share its code. */
export const SCRIPT_TITLES: Readonly<Record<ScriptName, string>> = {
  config_holder: "config.config_holder.spend",
  config_seal: "config.config_seal.mint",
  identity: "identity.identity.mint",
  attestation: "attestation.attestation.mint",
  delegation: "delegation.delegation.mint",
  escrow: "escrow.escrow.spend",
  vault: "vault.vault.spend",
  advert: "advert.advert.spend",
};

interface BlueprintValidator {
  title: string;
  hash: string;
  compiledCode: string;
  parameters?: unknown[];
}

export interface Blueprint {
  validators: BlueprintValidator[];
  compiler: string;
  /** SHA-256 of the file bytes. */
  sha256: string;
}

export function readBlueprint(path = BLUEPRINT_PATH): Blueprint {
  const bytes = readFileSync(path);
  const parsed = JSON.parse(bytes.toString("utf8")) as { preamble?: { compiler?: { name?: string; version?: string } }; validators?: BlueprintValidator[] };
  if (!Array.isArray(parsed.validators)) throw new DeployError(`${path} has no validators`);
  const compiler = parsed.preamble?.compiler;
  return {
    validators: parsed.validators,
    compiler: `${compiler?.name ?? "?"} ${compiler?.version ?? "?"}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Applies Plutus Data parameters to a CIP-57 `compiledCode`, in order, as `aiken blueprint apply` does. */
export function applyParameters(compiledCode: string, parameters: readonly PlutusData[]): string {
  if (parameters.length === 0) return compiledCode;
  const list = encodePlutusData({ kind: "list", items: [...parameters] });
  return Buffer.from(apply_params_to_script(list, Buffer.from(compiledCode, "hex"))).toString("hex");
}

export interface PlanParameters {
  legacyHash: string;
  legacyRoot: string;
  configSeed: OutputReference;
  networkId: NetworkId;
}

const bytes = (hex: string): PlutusData => ({ kind: "bytes", hex });

/** The Plutus Data of an output reference: `Constr 0 [transaction_id, output_index]` (Aiken stdlib v3). */
export const outputReferenceData = (ref: OutputReference): PlutusData => ({
  kind: "constr",
  index: 0n,
  fields: [bytes(ref.txHash), { kind: "int", value: BigInt(ref.index) }],
});

/** Every identity-side script with its parameters applied, in the contract order. */
export function deriveScripts(blueprint: Blueprint, p: PlanParameters): Record<ScriptName, AppliedScriptRecord> {
  if (!/^[0-9a-f]{56}$/.test(p.legacyHash)) throw new DeployError("legacy_hash must be 56 lowercase hex characters");
  if (!/^[0-9a-f]{64}$/.test(p.legacyRoot)) throw new DeployError("legacy_root must be 64 lowercase hex characters");
  const scripts: Partial<Record<ScriptName, AppliedScriptRecord>> = {};
  const apply = (name: ScriptName, parameters: PlutusData[]): string => {
    const title = SCRIPT_TITLES[name];
    const validator = blueprint.validators.find((v) => v.title === title);
    if (validator === undefined) throw new DeployError(`the blueprint has no validator ${title}`);
    const expected = validator.parameters?.length ?? 0;
    if (expected !== parameters.length) throw new DeployError(`${title} takes ${expected} parameters, not ${parameters.length}`);
    if (plutusV3Hash(validator.compiledCode) !== validator.hash) throw new DeployError(`${title}: the code does not match the blueprint hash`);
    const compiledCode = applyParameters(validator.compiledCode, parameters);
    const hash = plutusV3Hash(compiledCode);
    scripts[name] = {
      title,
      parameters: parameters.map(encodePlutusDataHex),
      hash,
      address: enterpriseAddress({ type: "Script", hash }, p.networkId),
      size: compiledCode.length / 2,
      compiled_code: compiledCode,
    };
    return hash;
  };
  const holder = apply("config_holder", []);
  const policy = apply("config_seal", [outputReferenceData(p.configSeed), bytes(holder)]);
  const identity = apply("identity", [bytes(p.legacyHash), bytes(p.legacyRoot), bytes(policy), bytes(holder)]);
  apply("attestation", [bytes(identity)]);
  const delegation = apply("delegation", [bytes(identity)]);
  const escrow = apply("escrow", [bytes(identity)]);
  apply("vault", [bytes(identity), bytes(delegation), bytes(escrow)]);
  apply("advert", []);
  return scripts as Record<ScriptName, AppliedScriptRecord>;
}
