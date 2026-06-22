/**
 * gateway/src/chain.ts — the single shared LiveOgmiosProvider.
 *
 * The gateway always submits real transactions, so it always uses a Live
 * provider (config enforces LIVE_CHAIN=1). One provider is shared across all
 * per-key Marketplace instances; ChainProvider reads are concurrency-safe.
 */

import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import type { GatewayConfig } from "./config.js";

export function buildChainProvider(config: GatewayConfig): LiveOgmiosProvider {
  // eslint-disable-next-line no-console
  console.log("[gateway] chain: LiveOgmiosProvider");
  return new LiveOgmiosProvider({ ogmiosUrl: config.ogmiosUrl });
}
