// Runs the benchmarks of Part 2 §12.4 and writes bench/results.json. Needs `aiken` v1.1.21 on PATH.
//   npx tsx contracts/identity-marketplace/bench/run.ts
// tests/identity-vectors/bench.test.ts runs every case again and compares with the file.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { aikenVersion, scriptHash, toHex } from "../../../tests/legacy-registry/harness/index.js";
import { CASES } from "./cases.js";
import { FLAG_SHARE, LIMITS, measure, type Measurement } from "./measure.js";
import { MODULE1_STAND_IN, SCRIPTS } from "./scripts.js";

export const RESULTS_PATH = fileURLToPath(new URL("./results.json", import.meta.url));

export interface Results {
  readonly name: string;
  readonly specification: string;
  readonly evaluator: string;
  readonly limits: typeof LIMITS;
  readonly flagShare: number;
  readonly notes: readonly string[];
  readonly scripts: ReadonlyArray<{ readonly name: string; readonly hash: string; readonly bytes: number }>;
  readonly cases: readonly Measurement[];
}

const NOTES = [
  "Every case is a complete, signed transaction with the applied scripts of plutus.json (test parameters, see bench/scripts.ts), evaluated offline with `aiken tx simulate`. Scripts run from reference inputs; script transactions have a collateral input.",
  "aiken tx simulate has no option for protocol parameters: it uses its built-in Plutus V3 cost model and a budget of 14,000,000 memory and 10,000,000,000 CPU units for the whole transaction (Vector allows 16,000,000 memory units).",
  "mem and cpu are the sums over all redeemers of a transaction. txBytes adds the script data hash, the collateral return and the total collateral, which the harness does not write, and uses the measured execution units in the redeemers.",
  "Module-1 (identity_party) is in another repository. A stand-in that accepts every purpose takes its withdraw handler's place, so the Module-1 cost is not in the cases that use ok(Script { M1 }) (Register, Adopt, the Module-1 Suspend and Revoke, the subagent Register).",
  "The verdict applications, the Consent Update and the challenge resolution of §12.4 need the Module-1 scripts and are not in these cases.",
];

export function benchResults(): Results {
  const scripts = [
    ["identity", SCRIPTS.identity],
    ["config_holder", SCRIPTS.configHolder],
    ["config_seal", SCRIPTS.configSeal],
    ["attestation", SCRIPTS.attestation],
    ["delegation", SCRIPTS.delegation],
    ["vault", SCRIPTS.vault],
    ["escrow", SCRIPTS.escrow],
    ["advert", SCRIPTS.advert],
    ["Module-1 stand-in", MODULE1_STAND_IN],
  ] as const;
  return {
    name: "identity-marketplace benchmarks",
    specification: "docs/IDENTITY_REGISTRY.md §12.4",
    evaluator: `aiken ${aikenVersion().replace(/^aiken /, "")} tx simulate (built-in Plutus V3 cost model)`,
    limits: LIMITS,
    flagShare: FLAG_SHARE,
    notes: NOTES,
    scripts: scripts.map(([name, script]) => ({ name, hash: toHex(scriptHash(script)), bytes: script.compiledCode.length })),
    cases: CASES.map(measure),
  };
}

export const resultsText = (results: Results): string => `${JSON.stringify(results, null, 2)}\n`;

const pad = (text: string, width: number): string => text.padEnd(width);
const num = (value: number): string => value.toLocaleString("en-US");

/** A text table of the results, one line per case; `!` marks a share above 70 %. */
export function resultsTable(results: Results): string {
  const lines = [`${pad("case", 30)} ${"memory".padStart(12)} ${"%".padStart(6)} ${"CPU".padStart(15)} ${"%".padStart(6)} ${"bytes".padStart(7)} ${"%".padStart(6)}`];
  for (const c of results.cases) {
    const mark = (limit: "mem" | "cpu" | "txBytes", share: number): string => `${share.toFixed(1)}${c.over70.includes(limit) ? "!" : " "}`.padStart(6);
    lines.push(
      `${pad(c.name, 30)} ${num(c.mem).padStart(12)} ${mark("mem", c.memPercent)} ${num(c.cpu).padStart(15)} ${mark("cpu", c.cpuPercent)} ${num(c.txBytes).padStart(7)} ${mark("txBytes", c.txBytesPercent)}`,
    );
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = benchResults();
  writeFileSync(RESULTS_PATH, resultsText(results));
  console.log(resultsTable(results));
  console.log("wrote contracts/identity-marketplace/bench/results.json");
}
