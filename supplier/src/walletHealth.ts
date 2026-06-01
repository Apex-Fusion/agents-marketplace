/**
 * walletHealth.ts — Periodic + on-failure wallet auto-consolidation.
 *
 * The supplier wallet drifts into a fragmented shape over time as Claim/
 * Submit/Accept change outputs accumulate. Once a dust UTxO becomes the
 * coin-selected working input, buildClaimTx fails with `chain_submit_failed`
 * and the lane stalls until an operator runs `tx:consolidate-wallet`.
 *
 * Two layers of self-healing:
 *   startWalletHealthTicker — periodic background tick (every N ms). When
 *     the supplier is idle, runs runConsolidateWallet. planConsolidate
 *     returns `already-healthy` cheaply for clean 2-UTxO wallets, so this
 *     is a no-op in steady state — no tx, no fee.
 *   triggerOnFailureConsolidate — fire-and-forget consolidate from the
 *     Claim-failure path. Debounced so back-to-back failures don't queue
 *     multiple consolidates. Returns 503 to the buyer for THIS request; the
 *     next buyer retry (~30-60s later) finds the wallet healthy.
 *
 * State-lock discipline: both layers use state.tryAcquire with a synthetic
 * escrowRef so they share the existing single-slot lock with real Claims.
 * If a Claim is in flight, the consolidation skips this tick.
 */

import type { ChainProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import {
  runConsolidateWallet,
  type ConsolidateWalletFlowParams,
  type ConsolidateWalletFlowResult,
} from "@marketplace/shared/tx/server";

import type { SupplierState } from "./state.js";

const WALLET_HEALTH_LOCK_REF = "__wallet_consolidate__";
const DEFAULT_COLLATERAL_LOVELACE = 5_000_000n;
const DEFAULT_AWAIT_TIMEOUT_MS = 90_000;
const DEFAULT_ON_FAILURE_DEBOUNCE_MS = 5 * 60_000;

export type ConsolidateFn = (
  params: ConsolidateWalletFlowParams,
) => Promise<ConsolidateWalletFlowResult>;

export interface WalletHealthDeps {
  chain: ChainProvider;
  state: SupplierState;
  supplierKey: WalletKey;
  /** Test-injectable. Defaults to runConsolidateWallet from @marketplace/shared. */
  consolidate?: ConsolidateFn;
}

export interface WalletHealthOptions {
  intervalMs: number;
  collateralLovelace?: bigint;
  awaitTimeoutMs?: number;
  /** Override for tests; defaults to console.log. */
  log?: (line: string) => void;
}

export interface WalletHealthTicker {
  stop(): void;
}

const inFlight = new WeakSet<SupplierState>();
const lastOnFailureAt = new WeakMap<SupplierState, number>();

function defaultLog(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`[wallet-health] ${line}`);
}

async function consolidateOnce(
  deps: WalletHealthDeps,
  opts: { collateralLovelace: bigint; awaitTimeoutMs: number; log: (line: string) => void },
): Promise<void> {
  const { state } = deps;
  if (inFlight.has(state)) {
    opts.log("skip: another consolidate already in flight");
    return;
  }
  if (!state.tryAcquire(WALLET_HEALTH_LOCK_REF)) {
    opts.log("skip: supplier busy");
    return;
  }
  inFlight.add(state);
  const consolidate: ConsolidateFn = deps.consolidate ?? runConsolidateWallet;
  try {
    const result = await consolidate({
      chain: deps.chain,
      walletKey: deps.supplierKey,
      collateralLovelace: opts.collateralLovelace,
      awaitTimeoutMs: opts.awaitTimeoutMs,
      log: opts.log,
    });
    if (result.reason === "already-healthy") {
      opts.log("already-healthy");
    } else {
      opts.log(`consolidated: ${result.reason} txHash=${result.txHash}`);
    }
  } catch (err) {
    opts.log(`consolidate failed: ${(err as Error).message}`);
  } finally {
    inFlight.delete(state);
    state.release();
  }
}

export function startWalletHealthTicker(
  deps: WalletHealthDeps,
  opts: WalletHealthOptions,
): WalletHealthTicker {
  const collateralLovelace = opts.collateralLovelace ?? DEFAULT_COLLATERAL_LOVELACE;
  const awaitTimeoutMs = opts.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const log = opts.log ?? defaultLog;

  const handle = setInterval(() => {
    void consolidateOnce(deps, { collateralLovelace, awaitTimeoutMs, log });
  }, opts.intervalMs);
  handle.unref();

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}

export function triggerOnFailureConsolidate(
  deps: WalletHealthDeps,
  opts: Partial<WalletHealthOptions> & { debounceMs?: number } = {},
): void {
  const { state } = deps;
  const debounceMs = opts.debounceMs ?? DEFAULT_ON_FAILURE_DEBOUNCE_MS;
  const now = Date.now();
  const last = lastOnFailureAt.get(state) ?? 0;
  if (now - last < debounceMs) return;
  lastOnFailureAt.set(state, now);

  const log = opts.log ?? defaultLog;
  log("on-failure trigger: scheduling consolidate");
  void consolidateOnce(deps, {
    collateralLovelace: opts.collateralLovelace ?? DEFAULT_COLLATERAL_LOVELACE,
    awaitTimeoutMs: opts.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS,
    log,
  });
}

/** Test-only: reset the in-flight + debounce maps between tests. */
export function _resetWalletHealthForTests(state: SupplierState): void {
  inFlight.delete(state);
  lastOnFailureAt.delete(state);
}
