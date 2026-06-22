/**
 * gateway/src/index.ts — entry point.
 *
 * Wires config → shared chain + store → SdkRegistry → Express app, and starts
 * the reclaim sweeper + wallet-health ticker. Boot is wrapped in runMain() so
 * importing this module (tests) does not start the server.
 */

import { loadConfig } from "./config.js";
import { buildChainProvider } from "./chain.js";
import { GatewayStore } from "./db/store.js";
import { SdkRegistry } from "./sdk/registry.js";
import { createApp } from "./server.js";
import { startSweeper } from "./sweeper.js";
import { startWalletHealthTicker } from "./walletHealth.js";
import type { GatewayDeps } from "./deps.js";

export function buildDeps(env: Record<string, string | undefined>): GatewayDeps {
  const config = loadConfig(env);
  const store = new GatewayStore(config.dbDir);
  const chain = buildChainProvider(config);
  const registry = new SdkRegistry({
    chain,
    indexerUrl: config.indexerUrl,
    networkId: config.networkId,
    masterKeyHex: config.masterKeyHex,
    max: config.sdkRegistryMax,
  });
  return { config, store, chain, registry, fetchFn: globalThis.fetch };
}

export function runMain(env: Record<string, string | undefined>): void {
  const deps = buildDeps(env);
  const app = createApp(deps);

  const stopSweeper = startSweeper(deps);
  const stopHealth = startWalletHealthTicker(deps);

  const server = app.listen(deps.config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[gateway] listening on :${deps.config.port} (network=${deps.config.networkId}, indexer=${deps.config.indexerUrl})`,
    );
  });

  const shutdown = (): void => {
    // eslint-disable-next-line no-console
    console.log("[gateway] shutting down...");
    stopSweeper();
    stopHealth();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv?.[1] !== undefined &&
  /gateway\/(src|dist)\/index\.(t|j)s$/.test(process.argv[1]);

if (invokedDirectly) {
  try {
    runMain(process.env);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[gateway] boot failed:", err);
    process.exit(1);
  }
}
