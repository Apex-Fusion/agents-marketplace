/**
 * Measures the benchmark transactions against Vector's per-transaction
 * limits (Part 2 §12.4): 16,000,000 memory units, 10,000,000,000 CPU units
 * and 16,384 bytes.
 *
 * Execution units: `aiken tx simulate` (v1.1.21) evaluates every redeemer.
 * The CLI has no option for protocol parameters: it uses its built-in Plutus
 * V3 cost model and a budget of 14,000,000 memory and 10,000,000,000 CPU units
 * for the whole transaction (uplc `ExBudget::default`). The units below are
 * the sums over all redeemers of a transaction.
 *
 * Size: the encoded transaction, plus the fields that the harness does not
 * write: the script data hash (key 11), the collateral return (key 16) and the
 * total collateral (key 17) of a script transaction, and the difference
 * between the measured execution units and the units that the harness writes
 * into the redeemers.
 */
import {
  cbor,
  encodeOutput,
  EVALUATOR_BUDGET,
  simulate,
  type BuiltTx,
} from "../../../tests/legacy-registry/harness/index.js";
import { COLLATERAL, PAYER, TOTAL_COLLATERAL, type BenchCase } from "./cases.js";

export const LIMITS = { mem: 16_000_000, cpu: 10_000_000_000, txBytes: 16_384 } as const;
/** Cases above this share of a limit are flagged. */
export const FLAG_SHARE = 0.7;

export interface RedeemerUnits {
  readonly purpose: string;
  readonly label: string;
  readonly mem: number;
  readonly cpu: number;
}

export interface Measurement {
  readonly name: string;
  readonly group: string;
  readonly description: string;
  readonly mem: number;
  readonly cpu: number;
  readonly txBytes: number;
  /** Share of each limit, in percent with one decimal. */
  readonly memPercent: number;
  readonly cpuPercent: number;
  readonly txBytesPercent: number;
  /** The limits above 70 %. */
  readonly over70: ReadonlyArray<"mem" | "cpu" | "txBytes">;
  readonly redeemers: readonly RedeemerUnits[];
}

const uintBytes = (value: bigint | number): number => cbor.uint(value).length;

/** The size of the transaction with the fields of a submitted transaction (see the module comment). */
export function transactionBytes(built: BuiltTx, redeemers: readonly RedeemerUnits[]): number {
  const encoded = built.encode().length;
  if (built.redeemers.length === 0) return encoded;
  const share = BigInt(built.redeemers.length);
  const written = uintBytes(EVALUATOR_BUDGET.mem / share) + uintBytes(EVALUATOR_BUDGET.steps / share);
  const exUnits = redeemers.reduce((sum, r) => sum + uintBytes(r.mem) + uintBytes(r.cpu) - written, 0);
  const scriptDataHash = uintBytes(11) + cbor.bytes(new Uint8Array(32)).length;
  const collateralReturn =
    uintBytes(16) + encodeOutput({ address: PAYER.address, value: { coin: COLLATERAL.output.value.coin - TOTAL_COLLATERAL } }).length;
  const totalCollateral = uintBytes(17) + uintBytes(TOTAL_COLLATERAL);
  return encoded + exUnits + scriptDataHash + collateralReturn + totalCollateral;
}

const percent = (value: number, limit: number): number => Math.round((value / limit) * 1000) / 10;

/** Builds and evaluates a case. Throws when a redeemer fails. */
export function measure(c: BenchCase): Measurement {
  const built = c.build();
  const result = simulate(built);
  if (!result.passed) {
    const failed = result.verdicts.filter((v) => !v.passed).map((v) => `${v.purpose} ${v.label}: ${v.reason ?? "failed"}`);
    throw new Error(`${c.name}: the transaction fails (${failed.join("; ")})\n${result.error ?? ""}`);
  }
  const redeemers = result.verdicts.map((v) => ({ purpose: v.purpose, label: v.label, mem: v.mem!, cpu: v.cpu! }));
  const mem = redeemers.reduce((sum, r) => sum + r.mem, 0);
  const cpu = redeemers.reduce((sum, r) => sum + r.cpu, 0);
  const txBytes = transactionBytes(built, redeemers);
  const over70 = (["mem", "cpu", "txBytes"] as const).filter((limit) => ({ mem, cpu, txBytes })[limit] > LIMITS[limit] * FLAG_SHARE);
  return {
    name: c.name,
    group: c.group,
    description: c.description,
    mem,
    cpu,
    txBytes,
    memPercent: percent(mem, LIMITS.mem),
    cpuPercent: percent(cpu, LIMITS.cpu),
    txBytesPercent: percent(txBytes, LIMITS.txBytes),
    over70,
    redeemers,
  };
}
