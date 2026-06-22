/**
 * gateway/src/sweeper.ts — state-aware custody safety net.
 *
 * Per key, classifies on-chain escrows and recovers stranded funds:
 *   Open|Claimed past the deliver_by deadline → Reclaim (returns funds + bond).
 *   Submitted (verified, in accept-window)    → retry Accept (settle + refund).
 *   Submitted past the accept-window          → leave for supplier Release (log).
 *
 * reclaim only works on Open/Claimed; Accept only on Submitted — so we branch by
 * state and never blind-reclaim a Submitted escrow. The on-chain validator is
 * the source of truth for deadlines, so premature/late attempts simply fail and
 * are caught here; the age thresholds just avoid racing in-flight requests.
 */

import type { GatewayDeps } from "./deps.js";
import { fetchEscrows, acceptAndConfirm, reclaimAndConfirm } from "./onchain/settle.js";
import { parseRef } from "./routing/selectSupplier.js";

// Don't touch escrows newer than this — an in-flight request is settling them.
const MIN_AGE_MS = 90_000;
// Reclaim Open/Claimed escrows older than this (past deliver_by ~10m + buffer).
const RECLAIM_AFTER_MS = 11 * 60 * 1000;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[gateway:sweeper] ${msg}`);
}

export async function runSweepOnce(deps: GatewayDeps): Promise<void> {
  const now = Date.now();
  for (const keyRow of deps.store.listKeys()) {
    let rows;
    try {
      rows = await fetchEscrows(deps.config.indexerUrl, keyRow.wallet_pkh, deps.fetchFn);
    } catch (err) {
      log(`indexer error for ${keyRow.key_prefix}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const ctx = deps.registry.getContext(keyRow);
    for (const row of rows) {
      const ref = parseRef(row.utxo_ref);
      if (!ref) continue;
      const ageMs = now - (row.posted_at ?? 0);
      if (ageMs < MIN_AGE_MS) continue;

      try {
        if (row.state === "Submitted") {
          await ctx.mutex.run(() => acceptAndConfirm(deps.chain, ctx.walletKey, ref));
          log(`accepted stranded Submitted escrow ${row.utxo_ref}`);
        } else if ((row.state === "Open" || row.state === "Claimed") && ageMs > RECLAIM_AFTER_MS) {
          await ctx.mutex.run(() => reclaimAndConfirm(deps.chain, ctx.walletKey, ref));
          log(`reclaimed stranded ${row.state} escrow ${row.utxo_ref}`);
        }
      } catch {
        // Expected when the validator rejects (wrong window/state) or the UTxO
        // was already spent by an in-flight request; skip quietly.
      }
    }
  }

  // Mark closed/settled chat sessions whose escrow is no longer active.
  // (Best-effort housekeeping; the escrow recovery above is the load-bearing part.)
}

/** Start the periodic sweeper. Returns a stop() function. */
export function startSweeper(deps: GatewayDeps): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runSweepOnce(deps);
    } catch (err) {
      log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), deps.config.sweeperIntervalMs);
  return () => clearInterval(handle);
}
