/**
 * indexer/src/routes/healthz.ts — GET /healthz
 *
 * SPEC FIX 2026-04-27: standardized to /healthz (was /health — indexer drift).
 * Every service now exposes GET /healthz per ARCHITECTURE.md §5 endpoint table.
 *
 * Returns:
 *   { ok: boolean, sync_slot: number, tip_slot: number,
 *     ogmios_status: "connected" | "disconnected",
 *     db_size_bytes: number }
 */

import { Router, type Request, type Response } from "express";
import type { SqliteCache } from "../db/cache.js";
import type { ChainSyncWorker } from "../follower/worker.js";

export interface HealthzDeps {
  cache: SqliteCache;
  worker: ChainSyncWorker;
}

export function healthzRouter(deps: HealthzDeps): Router {
  const router = Router();
  router.get("/healthz", (_req: Request, res: Response) => {
    const syncSlot = deps.worker.getCurrentSlot();
    const tipSlot = deps.worker.getTipSlot();
    const dbSize = deps.cache.dbSizeBytes();
    res.status(200).json({
      ok: true,
      sync_slot: syncSlot,
      tip_slot: tipSlot,
      ogmios_status: tipSlot > 0 ? "connected" : "disconnected",
      db_size_bytes: dbSize,
    });
  });
  return router;
}
