/**
 * gateway/src/index.ts — entry point.
 *
 * Wires config → shared chain + store → SdkRegistry → Express app, and starts
 * the reclaim sweeper + wallet-health ticker. Boot is wrapped in runMain() so
 * importing this module (tests) does not start the server.
 */

import { loadIdentityBlueprint } from "@marketplace/shared/tx";
import { startDecoderHealth } from "@marketplace/shared/tx/server";
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
  // Fail at boot, not at the first new escrow: the image must hold the
  // identity blueprint, and its code must hash to the blueprint hashes.
  if (config.identityPolicyId !== null) loadIdentityBlueprint({ identityHash: config.identityPolicyId });
  const store = new GatewayStore(config.dbDir);
  const chain = buildChainProvider(config);
  const registry = new SdkRegistry({
    chain,
    store,
    fetchFn: globalThis.fetch,
    indexerUrl: config.indexerUrl,
    networkId: config.networkId,
    masterKeyHex: config.masterKeyHex,
    max: config.sdkRegistryMax,
    switchSlot: config.switchSlot,
  });
  return { config, store, chain, registry, fetchFn: globalThis.fetch };
}

/**
 * The time that a shutdown which the decoder check starts may take. Docker gives a stop of the gateway the same time: its compose file,
 * `deploy/mainnet/docker-compose.gateway.yml`, has no `stop_grace_period`, so the Docker default of 10 s applies. Keep the two equal
 * (tests/unit/decoder-stop-limits.test.ts reads the compose file).
 */
export const DECODER_STOP_LIMIT_MS = 10_000;
/**
 * `startHealth` starts the check of the decoder library. The gateway loads the library, so it always runs it. A test passes a stand-in.
 */
export function runMain(
  env: Record<string, string | undefined>,
  startHealth: typeof startDecoderHealth = startDecoderHealth,
): void {
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

  let stopping = false;
  let exitCode = 0;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    // eslint-disable-next-line no-console
    console.log("[gateway] shutting down...");
    stopSweeper();
    stopHealth();
    server.close(() => process.exit(exitCode));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // When the decoder library cannot decode, the process takes the path of a SIGTERM and ends with code 1, so that Docker starts it
  // again. A SIGTERM that came first keeps its own exit code.
  startHealth({
    server,
    stopLimitMs: DECODER_STOP_LIMIT_MS,
    stop: (code) => {
      if (stopping) return false;
      exitCode = code;
      shutdown();
      return true;
    },
  });
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv?.[1] !== undefined &&
  // Accept both path separators: on Windows process.argv[1] arrives with
  // backslashes, so a forward-slash-only pattern silently never matches and
  // the process exits 0 without ever starting the server.
  /gateway[\\/](src|dist)[\\/]index\.(t|j)s$/.test(process.argv[1]);

if (invokedDirectly) {
  try {
    runMain(process.env);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[gateway] boot failed:", err);
    process.exit(1);
  }
}
