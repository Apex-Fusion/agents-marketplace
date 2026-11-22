/**
 * Loads a validator from an Aiken blueprint (CIP-57 `plutus.json`).
 *
 * A parameterised validator, such as the identity validator of Part 2 §2,
 * gets its parameters from `aiken blueprint apply`, one parameter at a time
 * and in the order of the blueprint (`blueprintScript`), or from
 * `apply_params_to_script` in process (`appliedScript`).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeData, type Data } from "./data.js";
import { fromHex, scriptHash, toHex, type PlutusV3Script } from "./ledger.js";
import { apply_params_to_script } from "@lucid-evolution/uplc";
import { HarnessError } from "./simulate.js";

export interface BlueprintValidator {
  /** `<module>.<validator>.<handler>`, for example `registry.registry.mint`. */
  readonly title: string;
  readonly compiledCode: string;
  readonly hash: string;
  readonly parameters?: readonly unknown[];
}

export interface Blueprint {
  readonly preamble: { readonly plutusVersion: string; readonly compiler: { readonly name: string; readonly version: string } };
  readonly validators: readonly BlueprintValidator[];
}

export const readBlueprint = (path: string): Blueprint => JSON.parse(readFileSync(path, "utf8")) as Blueprint;

/**
 * The script of validator `title` in the blueprint at `path`, with
 * `parameters` applied. The script hash must equal the blueprint's hash.
 */
export function blueprintScript(path: string, title: string, parameters: readonly Data[] = []): PlutusV3Script {
  const parts = title.split(".");
  if (parts.length < 3) throw new HarnessError(`Not a validator title: ${title}`);
  const validator = parts.at(-2)!;
  const module = parts.slice(0, -2).join(".");
  const dir = mkdtempSync(join(tmpdir(), "legacy-registry-blueprint-"));
  try {
    let current = path;
    parameters.forEach((parameter, i) => {
      const out = join(dir, `applied-${i}.json`);
      const args = ["blueprint", "apply", "-i", current, "-o", out, "-m", module, "-v", validator, toHex(encodeData(parameter))];
      const result = spawnSync("aiken", args, { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      if (result.error !== undefined || result.status !== 0) {
        throw new HarnessError(`aiken blueprint apply failed for parameter ${i}: ${result.error?.message ?? result.stderr}`);
      }
      current = out;
    });
    const entry = readBlueprint(current).validators.find((v) => v.title === title);
    if (entry === undefined) throw new HarnessError(`No validator ${title} in ${path}`);
    if ((entry.parameters ?? []).length > 0) {
      throw new HarnessError(`${title} still needs ${entry.parameters!.length} parameter(s)`);
    }
    const script = { compiledCode: fromHex(entry.compiledCode) };
    if (toHex(scriptHash(script)) !== entry.hash) throw new HarnessError(`${title}: the code does not match the blueprint hash`);
    return script;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Like `blueprintScript`, without a process. `apply_params_to_script` of @lucid-evolution/uplc (the `uplc` crate of Aiken, in
 * WebAssembly) applies all parameters in one call, as the deployment tool does
 * (contracts/identity-marketplace/deploy/scripts.ts). Its bytes equal those of `aiken blueprint apply`
 * (tests/identity-deploy/plan.test.ts). The blueprint holds a hash only for a script without parameters: that one is checked.
 */
export function appliedScript(path: string, title: string, parameters: readonly Data[] = []): PlutusV3Script {
  const entry = readBlueprint(path).validators.find((v) => v.title === title);
  if (entry === undefined) throw new HarnessError(`No validator ${title} in ${path}`);
  const expected = (entry.parameters ?? []).length;
  if (expected !== parameters.length) throw new HarnessError(`${title} takes ${expected} parameter(s), not ${parameters.length}`);
  const blueprintCode = fromHex(entry.compiledCode);
  if (parameters.length === 0) {
    if (toHex(scriptHash({ compiledCode: blueprintCode })) !== entry.hash) throw new HarnessError(`${title}: the code does not match the blueprint hash`);
    return { compiledCode: blueprintCode };
  }
  return { compiledCode: apply_params_to_script(encodeData(parameters), blueprintCode) };
}
