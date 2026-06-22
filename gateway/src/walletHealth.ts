/**
 * gateway/src/walletHealth.ts — keep each custodial wallet usable.
 *
 * After every settled request (and on a periodic tick) we re-shape the wallet to
 * {≥5 ADA collateral UTxO, working UTxO} via the shared consolidate builder, so
 * the NEXT request's Accept/Reclaim script-spend always finds a pure-ADA
 * collateral candidate. No-op when the wallet is already healthy.
 */

import type { LiveOgmiosProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import { runConsolidateWallet, DEFAULT_COLLATERAL_LOVELACE } from "@marketplace/shared/tx/server";
import type { GatewayDeps } from "./deps.js";

export async function ensureWalletHealthy(
  chain: LiveOgmiosProvider,
  walletKey: WalletKey,
): Promise<void> {
  await runConsolidateWallet({
    chain,
    walletKey,
    collateralLovelace: DEFAULT_COLLATERAL_LOVELACE,
    log: () => {
      /* quiet; callers log failures */
    },
  });
}

/** Periodically re-shape every wallet so a collateral UTxO is always available.
 * Serialized per key via the registry mutex; no-op for already-healthy wallets. */
export function startWalletHealthTicker(deps: GatewayDeps): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const keyRow of deps.store.listKeys()) {
        const ctx = deps.registry.getContext(keyRow);
        await ctx.mutex.run(() => ensureWalletHealthy(deps.chain, ctx.walletKey)).catch(() => {
          /* skip wallets that can't consolidate (e.g. drained) */
        });
      }
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), deps.config.walletHealthIntervalMs);
  return () => clearInterval(handle);
}
