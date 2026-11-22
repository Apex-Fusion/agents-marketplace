import type { Blueprint, PlanParameters } from "../../contracts/identity-marketplace/deploy/scripts.js";
import type { AppliedScriptRecord, ScriptName } from "../../contracts/identity-marketplace/deploy/state.js";

type DeriveScripts = (blueprint: Blueprint, parameters: PlanParameters) => Record<ScriptName, AppliedScriptRecord>;

/**
 * `derive` that remembers its results. `deriveScripts` is a pure function of the blueprint and the parameters, and each call applies
 * 8 scripts in WebAssembly (about 0.4 s). The deployment commands call it again and again with the same plan. The first call of
 * each input runs the real function, so a test that compares a result with another source still tests the real application.
 */
export function memoizedDeriveScripts(derive: DeriveScripts): DeriveScripts {
  const results = new Map<string, Record<ScriptName, AppliedScriptRecord>>();
  return (blueprint, parameters) => {
    const key = JSON.stringify([blueprint.sha256, parameters]);
    let result = results.get(key);
    if (result === undefined) {
      result = derive(blueprint, parameters);
      results.set(key, result);
    }
    return structuredClone(result);
  };
}
