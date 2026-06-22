/**
 * gateway/src/deps.ts — shared dependency bundle passed to route factories.
 */

import type { LiveOgmiosProvider } from "@marketplace/shared/chain";
import type { GatewayConfig } from "./config.js";
import type { GatewayStore } from "./db/store.js";
import type { SdkRegistry } from "./sdk/registry.js";

export interface GatewayDeps {
  config: GatewayConfig;
  store: GatewayStore;
  chain: LiveOgmiosProvider;
  registry: SdkRegistry;
  fetchFn: typeof globalThis.fetch;
}
