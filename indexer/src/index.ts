/**
 * indexer/src/index.ts — boot script for the marketplace indexer.
 *
 * Wires:
 *   - Config from process.env (validated)
 *   - SqliteCache (opens or creates DB, applies schema migrations, listing policy)
 *   - Resync: one-time resync point (identity backfill, Part 2 §6.4, or the
 *     recovery after a lost intersection) and/or the start-up load of the
 *     outputs at the identity address
 *   - OgmiosSource (Ogmios WebSocket; intersection with the saved block points)
 *   - ChainSyncWorker (drives source → cache + emits chain-event/sync-progress/identity-change)
 *   - StatusPoller (periodic supplier /status fetcher)
 *   - IdentityRefresher (identity gateway answers for the new adverts)
 *   - Express app via createApp(deps)
 *
 * Installs SIGTERM/SIGINT handlers for graceful shutdown.
 */

import { ReadOnlyOgmiosProvider } from "@marketplace/shared/chain";
import { plutusAddressFromBech32 } from "@marketplace/shared/cbor";
import { loadConfig } from "./config.js";
import { SqliteCache } from "./db/cache.js";
import { OgmiosSource } from "./follower/ogmiosSource.js";
import { ChainSyncWorker } from "./follower/worker.js";
import type { RollbackPoint } from "./follower/types.js";
import { loadIdentityOutputs } from "./identity/backfill.js";
import { createGatewayClient } from "./identity/gateway.js";
import { IdentityRefresher } from "./identity/refresher.js";
import { StatusPoller } from "./poller/statusPoller.js";
import { createApp } from "./server.js";

/** Ogmios v6 serves JSON-RPC over HTTP on the WebSocket port: ws(s)://host → http(s)://host. */
function ogmiosHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//i, "http$1://");
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const identity = config.identity;

  if (!config.advertAddress || !config.escrowAddress) {
    console.warn(
      "[indexer] ADVERT_SCRIPT_ADDRESS / ESCROW_SCRIPT_ADDRESS not set — " +
      "the legacy advert and escrow contracts are not watched.",
    );
  }

  const cache = new SqliteCache(config.dbPath, {
    listing: { switchSlot: config.switchSlot, identityAddress: identity?.address ?? null },
  });

  if (config.resyncFrom) {
    const { slot, blockHash } = config.resyncFrom;
    console.log(
      cache.applyResync(config.resyncFrom)
        ? `[indexer] resync: the state after block ${slot}:${blockHash} is removed; reading the later blocks again`
        : `[indexer] resync point ${slot}:${blockHash} already applied or not behind the cursor`,
    );
  }

  if (identity?.loadAtStart) {
    const loaded = await loadIdentityOutputs({
      cache,
      chain: new ReadOnlyOgmiosProvider({ ogmiosUrl: ogmiosHttpUrl(config.ogmiosUrl) }),
      identityAddress: identity.address,
      policyId: identity.policyId,
    });
    console.log(
      `[indexer] identity address: ${loaded.outputs} current record outputs, ${loaded.inserted} new to this database`,
    );
  }

  const source = new OgmiosSource(config.ogmiosUrl, {
    responseTimeoutMs: config.ogmiosResponseTimeoutMs,
  });
  const worker = new ChainSyncWorker({
    source,
    cache,
    addresses: {
      advertAddress: config.advertAddress,
      escrowAddress: config.escrowAddress,
      identityAdvertAddress: identity?.advertAddress,
      identityEscrowAddress: identity?.escrowAddress,
      identityAddress: identity?.address,
      identityPolicyId: identity?.policyId,
      module1Addresses: config.module1
        ? [config.module1.claimAddress, config.module1.challengeAddress, config.module1.partyAddress]
        : [],
      module1Challenge: config.module1
        ? {
            address: config.module1.challengeAddress,
            policyId: plutusAddressFromBech32(config.module1.challengeAddress).paymentCredential.hash.toLowerCase(),
          }
        : undefined,
      jury: config.jury.map((d) => ({ address: d.address, scriptHash: d.scriptHash })),
    },
    networkId: config.networkId,
    skipBeforeSlot: config.skipBeforeSlot,
  });
  const poller = new StatusPoller({ cache, pollIntervalMs: config.statusPollMs });
  const refresher = identity
    ? new IdentityRefresher({
        cache,
        resolve: createGatewayClient({ baseUrl: identity.gatewayUrl }),
        refreshMs: identity.refreshMs,
      })
    : null;

  const app = createApp(
    { cache, worker },
    {
      uiDistDir: config.uiDistDir,
      maxSyncLagSlots: config.maxSyncLagSlots,
      module1: config.module1,
      jury: config.jury,
      networkId: config.networkId,
    },
  );

  worker.on("error", (err: { message: string; stale: boolean }) => {
    console.error(`[indexer] worker error: ${err.message}${err.stale ? " (stale)" : ""}`);
  });
  source.on("intersection", ({ point }: { point: RollbackPoint }) => {
    console.log(
      point === "origin"
        ? "[indexer] chain-sync: starting at the origin"
        : `[indexer] chain-sync: intersection at slot ${point.slot} (block ${point.id})`,
    );
  });
  worker.on("identity-change", (agentIds: string[]) => refresher?.invalidate(agentIds));

  const networkLabel = config.networkId === 0 ? "Vector testnet" : "Vector mainnet";
  const server = app.listen(config.indexerPort, () => {
    console.log(
      `[indexer] listening on :${config.indexerPort} ` +
      `(NETWORK_ID=${config.networkId} — ${networkLabel}; ` +
      `identity ${identity ? `on, switch slot ${config.switchSlot ?? "none"}` : "off"}; ` +
      `Module-1 disputes ${config.module1 ? "on" : "off"}; ` +
      `jury ${config.jury.length > 0 ? config.jury.map((d) => d.label).join(", ") : "off"})`,
    );
  });

  await worker.start();
  poller.start();
  refresher?.start();

  const shutdown = (signal: string): void => {
    console.log(`[indexer] received ${signal} — shutting down`);
    poller.stop();
    refresher?.stop();
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
