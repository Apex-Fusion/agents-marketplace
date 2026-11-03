/**
 * indexer/src/routes/healthz.ts — GET /healthz
 *
 * SPEC FIX 2026-04-27: standardized to /healthz (was /health — indexer drift).
 * Every service now exposes GET /healthz per ARCHITECTURE.md §5 endpoint table.
 *
 * Returns HTTP 200 with:
 *   ok                 — true only when the follower follows the chain, Ogmios
 *                        reported the tip in the last MAX_TIP_AGE_MS, and
 *                        lag_slots is at most max_sync_lag_slots
 *   sync_slot          — slot of the last applied block
 *   tip_slot           — slot of the chain tip that Ogmios reported last
 *                        (chain-sync answers, queryNetwork/tip); 0 before the first report
 *   ogmios_status      — "connected" | "disconnected": the chain-sync connection
 *   db_size_bytes      — size of the database file
 *   lag_slots          — tip_slot − sync_slot (at least 0); null before the first tip
 *   max_sync_lag_slots — the lag limit (MAX_SYNC_LAG_SLOTS)
 *   tip_age_ms         — time since Ogmios reported the tip; null before the first tip
 *   follower           — "starting" | "following" | "no_intersection"
 *   error              — why the follower failed; null when it did not
 *
 * The status stays 200 when ok is false. The container health check and the
 * proxy route need only a live process, and the API stays readable while the
 * indexer catches up. Monitors read `ok`.
 */

import { Router, type Request, type Response } from "express";
import type { SqliteCache } from "../db/cache.js";
import type { ChainSyncWorker } from "../follower/worker.js";

/** Default of MAX_SYNC_LAG_SLOTS. */
export const DEFAULT_MAX_SYNC_LAG_SLOTS = 600;

/** ok is false when Ogmios has not reported the tip for this long (four tip polls). */
export const MAX_TIP_AGE_MS = 120_000;

export interface HealthzDeps {
  cache: SqliteCache;
  worker: ChainSyncWorker;
  /** ok is false when the indexer is more slots than this behind the tip. */
  maxSyncLagSlots: number;
}

export function healthzRouter(deps: HealthzDeps): Router {
  const router = Router();
  router.get("/healthz", (_req: Request, res: Response) => {
    const health = deps.worker.getHealth();
    const lagSlots = health.tip === null ? null : Math.max(0, health.tip.slot - health.syncSlot);
    const ok =
      health.state === "following" &&
      lagSlots !== null &&
      lagSlots <= deps.maxSyncLagSlots &&
      health.tipAgeMs !== null &&
      health.tipAgeMs <= MAX_TIP_AGE_MS;
    res.status(200).json({
      ok,
      sync_slot: health.syncSlot,
      tip_slot: health.tip?.slot ?? 0,
      ogmios_status: health.connected ? "connected" : "disconnected",
      db_size_bytes: deps.cache.dbSizeBytes(),
      lag_slots: lagSlots,
      max_sync_lag_slots: deps.maxSyncLagSlots,
      tip_age_ms: health.tipAgeMs,
      follower: health.state,
      error: health.error,
    });
  });
  return router;
}
