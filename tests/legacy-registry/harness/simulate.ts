/**
 * Runs `aiken tx simulate` (the uplc evaluator of the Aiken compiler that
 * built the deployed script) on a transaction and its resolved inputs.
 * Nothing goes to a network.
 *
 * aiken evaluates the redeemers in the order of the redeemer map and stops
 * at the first failure. When a transaction fails, simulate() evaluates it
 * again with each redeemer first, so that each redeemer gets its own
 * verdict. The order of the redeemer map does not change the transaction ID.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cbor from "./cbor.js";
import { encodeOutput, purposeOf, toHex, VECTOR_MAINNET_TIME, type BuiltTx } from "./ledger.js";

/** The evaluator could not run the scripts (decoding, a missing script or redeemer, no aiken). */
export class HarnessError extends Error {}

export interface RedeemerVerdict {
  readonly label: string;
  /** For example `Spend[0]` or `Mint[1]`. */
  readonly purpose: string;
  readonly passed: boolean;
  /** Execution units, when the whole transaction passes. */
  readonly mem?: number;
  readonly cpu?: number;
  /** The evaluator's error for a failing redeemer, for example "the validator crashed / exited prematurely". */
  readonly reason?: string;
}

export interface Simulation {
  readonly txId: string;
  readonly passed: boolean;
  readonly verdicts: readonly RedeemerVerdict[];
  /** The first failing purpose in ledger order. */
  readonly failedAt?: string;
  /** aiken's report of the first failure. */
  readonly error?: string;
}

interface Run {
  readonly ok: boolean;
  readonly budgets: ReadonlyArray<{ readonly mem: number; readonly cpu: number }>;
  readonly failedAt?: string;
  readonly reason?: string;
  readonly report: string;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Set LEGACY_REGISTRY_ARTIFACTS=<dir> to keep the files and the command of each run. */
const ARTIFACTS = process.env.LEGACY_REGISTRY_ARTIFACTS;

export function aikenVersion(): string {
  const result = spawnSync("aiken", ["--version"], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new HarnessError(`Cannot run aiken: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
}

function run(built: BuiltTx, order: readonly number[]): Run {
  const name = `${toHex(built.id).slice(0, 16)}-${order.join("_") || "none"}`;
  const dir = ARTIFACTS === undefined ? mkdtempSync(join(tmpdir(), "legacy-registry-")) : join(ARTIFACTS, name);
  mkdirSync(dir, { recursive: true });
  try {
    const files = { tx: join(dir, "tx.hex"), inputs: join(dir, "inputs.hex"), outputs: join(dir, "outputs.hex") };
    writeFileSync(files.tx, toHex(built.encode(order)));
    writeFileSync(files.inputs, toHex(cbor.array(built.resolved.map((u) => cbor.array([cbor.bytes(u.ref.txId), cbor.uint(u.ref.index)])))));
    writeFileSync(files.outputs, toHex(cbor.array(built.resolved.map((u) => encodeOutput(u.output)))));
    const args = [
      "tx", "simulate", files.tx, files.inputs, files.outputs,
      "--zero-time", String(VECTOR_MAINNET_TIME.zeroTimeMs),
      "--zero-slot", String(VECTOR_MAINNET_TIME.zeroSlot),
      "--slot-length", String(VECTOR_MAINNET_TIME.slotLengthMs),
    ];
    if (ARTIFACTS !== undefined) writeFileSync(join(dir, "command.txt"), `aiken ${args.join(" ")}\n`);
    const result = spawnSync("aiken", args, { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    if (result.error !== undefined) throw new HarnessError(`Cannot run aiken: ${result.error.message}`);
    const report = result.stderr.replace(ANSI, "");
    if (result.status === 0) {
      const budgets = JSON.parse(result.stdout) as Array<{ mem: number; cpu: number }>;
      if (budgets.length !== built.redeemers.length) throw new HarnessError(`aiken evaluated ${budgets.length} redeemers:\n${report}`);
      return { ok: true, budgets, report };
    }
    const failure = /failed script execution\s+(\w+\[\d+\]) ([^\n]*)/.exec(report);
    if (failure === null) throw new HarnessError(`aiken could not evaluate the transaction:\n${report}`);
    return { ok: false, budgets: [], failedAt: failure[1], reason: failure[2]!.trim(), report };
  } finally {
    if (ARTIFACTS === undefined) rmSync(dir, { recursive: true, force: true });
  }
}

export function simulate(built: BuiltTx): Simulation {
  const txId = toHex(built.id);
  const ledgerOrder = built.redeemers.map((_, i) => i);
  const first = run(built, ledgerOrder);
  if (first.ok) {
    const verdicts = built.redeemers.map((r, i) => ({
      label: r.label,
      purpose: purposeOf(r),
      passed: true,
      mem: first.budgets[i]!.mem,
      cpu: first.budgets[i]!.cpu,
    }));
    return { txId, passed: true, verdicts };
  }
  const verdicts = built.redeemers.map((r, i) => {
    const alone = i === 0 ? first : run(built, [i, ...ledgerOrder.filter((j) => j !== i)]);
    const passed = alone.ok || alone.failedAt !== purposeOf(r);
    return { label: r.label, purpose: purposeOf(r), passed, ...(passed ? {} : { reason: alone.reason }) };
  });
  return { txId, passed: false, verdicts, failedAt: first.failedAt, error: first.report };
}

/** One line per redeemer, for test output and the README table. */
export const describeSimulation = (s: Simulation): string =>
  s.verdicts
    .map((v) => `${v.purpose} ${v.label}: ${v.passed ? "pass" : "FAIL"}${v.mem === undefined ? "" : ` (mem ${v.mem}, cpu ${v.cpu})`}`)
    .join("; ");
