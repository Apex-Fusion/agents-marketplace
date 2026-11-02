/**
 * Loads a validator from an Aiken blueprint (CIP-57 `plutus.json`).
 *
 * A parameterised validator, such as the identity validator of Part 2 §2,
 * gets its parameters from `aiken blueprint apply`, one parameter at a time
 * and in the order of the blueprint.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeData, type Data } from "./data.js";
import { fromHex, scriptHash, toHex, type PlutusV3Script } from "./ledger.js";
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
