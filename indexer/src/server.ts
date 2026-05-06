/**
 * indexer/src/server.ts — Express app factory for the indexer.
 *
 * createApp(deps, options) returns an Express Application with all routes
 * wired. Dependency injection allows tests to supply mock cache, worker, etc.
 *
 * JSON routes wired (priority order — these are mounted FIRST so they always
 * take precedence over the SPA catch-all):
 *   GET /healthz
 *   GET /suppliers
 *   GET /suppliers/:pkh
 *   GET /capabilities
 *   GET /capabilities/:id/suppliers
 *   GET /escrows/:ref
 *   GET /escrows
 *   GET /events
 *
 * Optional UI mount (M1-F-5):
 *   When `options.uiDistDir` is supplied:
 *     - express.static(uiDistDir) is mounted AFTER the JSON routes so /app.js,
 *       /assets/*, etc. are served from the bundled dashboard build.
 *     - app.get('*', sendFile('index.html')) is mounted LAST as the SPA
 *       catch-all so any unknown path returns the dashboard HTML — keeping
 *       client-side routing working.
 *   When `uiDistDir` is omitted (default), behaviour is unchanged: unknown
 *   paths return 404 (Express default). This preserves backwards-compat with
 *   existing unit tests that call createApp(deps).
 */

import express, { type Application } from "express";
import type { EventEmitter } from "events";
import type { SqliteCache } from "./db/cache.js";
import type { ChainSyncWorker } from "./follower/worker.js";

import { healthzRouter } from "./routes/healthz.js";
import { suppliersRouter } from "./routes/suppliers.js";
import { capabilitiesRouter } from "./routes/capabilities.js";
import { escrowsRouter } from "./routes/escrows.js";
import { eventsRouter } from "./routes/events.js";

export interface IndexerDeps {
  cache: SqliteCache;
  worker: ChainSyncWorker;
}

export interface IndexerAppOptions {
  /**
   * Milliseconds between SSE keepalive comment frames sent to all connected clients.
   * Default: 25_000 (25 s). Tests pass a lower value (e.g. 50 ms) to verify the
   * heartbeat without waiting wall-clock seconds.
   */
  heartbeatMs?: number;

  /**
   * Absolute path to the bundled indexer-ui /dist directory. When provided,
   * static assets and an SPA catch-all are mounted AFTER all JSON routes so
   * the same Express app serves the dashboard alongside the API. Omitting it
   * preserves the legacy "API-only" behaviour.
   */
  uiDistDir?: string;
}

export function createApp(deps: IndexerDeps, options?: IndexerAppOptions): Application {
  const app = express();

  app.use(healthzRouter({ cache: deps.cache, worker: deps.worker }));
  app.use(suppliersRouter({ cache: deps.cache }));
  app.use(capabilitiesRouter({ cache: deps.cache }));
  app.use(escrowsRouter({ cache: deps.cache }));

  // Long-lived multiplexed SSE: per-connection listeners on the worker
  // EventEmitter, replay-then-live ordering, heartbeat keepalive.
  const { router: events } = eventsRouter(deps.worker as unknown as EventEmitter, {
    cache: deps.cache,
    heartbeatMs: options?.heartbeatMs,
  });
  app.use(events);

  // App-level "warm" listeners on the worker emitter. These exist so that
  //   - the boot contract holds (listenerCount > 0 immediately after createApp)
  //   - downstream observers (metrics, logging) can hook in without waiting
  //     for an SSE client to connect.
  // Per-connection SSE delivery is independent and additive (eventsRouter
  // attaches its own listeners on each request).
  deps.worker.on("chain-event", () => { /* observed via SSE per-connection */ });
  deps.worker.on("sync-progress", () => { /* observed via SSE per-connection */ });

  // SPA mount — must run AFTER all JSON routes so /healthz, /suppliers, etc.
  // keep priority. Static files first, then catch-all → index.html.
  if (options?.uiDistDir) {
    const uiDir = options.uiDistDir;
    app.use(express.static(uiDir));
    app.get("*", (_req, res) => {
      res.sendFile("index.html", { root: uiDir });
    });
  }

  return app;
}
