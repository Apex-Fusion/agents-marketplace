/**
 * indexer/src/index.ts — boot script for the marketplace indexer.
 *
 * Wires:
 *   - Config from process.env (validated)
 *   - SqliteCache (opens or creates DB, applies schema)
 *   - OgmiosSource (real WebSocket — exercised in M1-F lifecycle)
 *   - ChainSyncWorker (drives source → cache + emits chain-event/sync-progress)
 *   - StatusPoller (periodic supplier /status fetcher)
 *   - Express app via createApp(deps)
 *
 * Installs SIGTERM/SIGINT handlers for graceful shutdown.
 *
 * NOTE: the script computes the advertScript / escrowScript addresses from a
 * future config map — for M1-D the addresses are sourced from environment fall-
 * backs to keep the boot pure. M1-F lifecycle test will plumb real addresses
 * through `config/marketplace-deployments.json`.
 */

import { loadConfig } from "./config.js";
import { SqliteCache } from "./db/cache.js";
import { OgmiosSource } from "./follower/ogmiosSource.js";
import { ChainSyncWorker } from "./follower/worker.js";
import { StatusPoller } from "./poller/statusPoller.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const advertAddress = process.env.ADVERT_SCRIPT_ADDRESS ?? "";
  const escrowAddress = process.env.ESCROW_SCRIPT_ADDRESS ?? "";

  if (!advertAddress || !escrowAddress) {
    console.warn(
      "[indexer] ADVERT_SCRIPT_ADDRESS / ESCROW_SCRIPT_ADDRESS not set — " +
      "running in 'no scripts watched' mode. Set them via env or use M1-F config bridge."
    );
  }

  const cache = new SqliteCache(config.dbPath);
  const source = new OgmiosSource(config.ogmiosUrl, {
    responseTimeoutMs: config.ogmiosResponseTimeoutMs,
  });
  const worker = new ChainSyncWorker({
    source,
    cache,
    addresses: { advertAddress, escrowAddress },
    skipBeforeSlot: config.skipBeforeSlot,
  });
  const poller = new StatusPoller({ cache, pollIntervalMs: config.statusPollMs });

  const app = createApp(
    { cache, worker },
    config.uiDistDir ? { uiDistDir: config.uiDistDir } : undefined,
  );

  worker.on("error", (err: { message: string; stale: boolean }) => {
    console.error(`[indexer] worker error: ${err.message}${err.stale ? " (stale)" : ""}`);
  });

  const networkLabel = config.networkId === 0 ? "Vector testnet" : "Vector mainnet";
  const server = app.listen(config.indexerPort, () => {
    console.log(
      `[indexer] listening on :${config.indexerPort} ` +
      `(NETWORK_ID=${config.networkId} — ${networkLabel})`,
    );
  });

  await worker.start();
  poller.start();

  const shutdown = (signal: string): void => {
    console.log(`[indexer] received ${signal} — shutting down`);
    poller.stop();
    worker.stop();
    server.close(() => {
      cache.close();
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[indexer] shutdown timeout — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only auto-run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[indexer] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
