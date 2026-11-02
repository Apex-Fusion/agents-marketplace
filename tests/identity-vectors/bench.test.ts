// Benchmarks of Part 2 §12.4 (contracts/identity-marketplace/bench): every case is a complete
// transaction that the applied scripts accept, within Vector's per-transaction limits, and
// bench/results.json is the output of this run. Changed cases (controls) must fail, so the
// measurements come from the real rules. Needs `aiken` v1.1.21 on PATH.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { simulate } from "../legacy-registry/harness/index.js";
import { CASES, CONTROLS, VAULT_ESCROWS_OVER_SIZE, vaultPay } from "../../contracts/identity-marketplace/bench/cases.js";
import { LIMITS, measure } from "../../contracts/identity-marketplace/bench/measure.js";
import { RESULTS_PATH, benchResults, resultsText, type Results } from "../../contracts/identity-marketplace/bench/run.js";

let results: Results;

beforeAll(() => {
  results = benchResults();
});

const measured = (name: string) => {
  const found = results.cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no measurement of ${name}`);
  return found;
};

describe("benchmarks (Part 2 §12.4)", () => {
  test("bench/results.json is the output of this run (regenerate: npx tsx contracts/identity-marketplace/bench/run.ts)", () => {
    expect(readFileSync(RESULTS_PATH, "utf8")).toBe(resultsText(results));
  });

  test("the cases cover every identity action, Claim, Submit, the subagent, the vault and each publication", () => {
    expect(CASES.map((c) => c.name)).toEqual([
      "Register",
      "Adopt",
      "Update",
      "ChangeController",
      "Suspend (key party)",
      "Suspend (Module-1)",
      "Unsuspend",
      "Revoke (controller)",
      "Revoke (Module-1)",
      "Retire",
      "Reclaim",
      "SetSuccessor",
      "BumpEpoch",
      "RecoverInit",
      "RecoverCancel",
      "RecoverFinalize",
      "Register depth-4 subagent",
      "Claim",
      "Submit",
      "Vault Pay, 1 escrow",
      "Vault Pay, 5 escrows",
      "Vault Pay, 10 escrows",
      "Vault Pay, 25 escrows",
      "Vault Pay, 38 escrows",
      "Publish identity",
      "Publish config_holder",
      "Publish config_seal",
      "Publish attestation",
      "Publish delegation",
      "Publish vault",
      "Publish escrow",
      "Publish advert",
    ]);
  });

  test.each(CASES.map((c) => [c.name] as const))("%s: within 16,000,000 memory, 10,000,000,000 CPU units and 16,384 bytes", (name) => {
    const m = measured(name);
    expect(m.mem).toBeLessThanOrEqual(LIMITS.mem);
    expect(m.cpu).toBeLessThanOrEqual(LIMITS.cpu);
    expect(m.txBytes).toBeLessThanOrEqual(LIMITS.txBytes);
    expect(m.over70).toEqual(
      (["mem", "cpu", "txBytes"] as const).filter((limit) => ({ mem: m.mem, cpu: m.cpu, txBytes: m.txBytes })[limit] > LIMITS[limit] * 0.7),
    );
  });

  test("the script transactions run the expected scripts", () => {
    const labels = (name: string) => measured(name).redeemers.map((r) => r.label).sort();
    expect(labels("Register")).toEqual(["Module-1 withdraw (stand-in)", "identity mint Register"]);
    expect(labels("Adopt")).toEqual(["Module-1 withdraw (stand-in)", "identity mint Adopt", "legacy mint Burn", "legacy spend Deregister"]);
    expect(labels("Update")).toEqual(["identity spend Update"]);
    expect(labels("Claim")).toEqual(["escrow spend Claim"]);
    expect(labels("Vault Pay, 5 escrows")).toEqual(["vault spend Pay"]);
    expect(measured("Publish identity").redeemers).toEqual([]);
  });

  test.each(CONTROLS.map((c) => [c.name, c] as const))("control: %s fails in the script", (_name, control) => {
    const result = simulate(control.build());
    expect(result.passed).toBe(false);
    const failed = result.verdicts.filter((v) => !v.passed);
    expect(failed.map((v) => v.label)).toEqual([control.fails]);
    expect(failed[0]!.reason).toBe("the validator crashed / exited prematurely");
  });

  test(`a vault Pay with ${VAULT_ESCROWS_OVER_SIZE} escrow outputs is larger than 16,384 bytes`, () => {
    const m = measure({ name: "over", group: "vault", description: "", build: () => vaultPay(VAULT_ESCROWS_OVER_SIZE) });
    expect(m.txBytes).toBeGreaterThan(LIMITS.txBytes);
  });
});
