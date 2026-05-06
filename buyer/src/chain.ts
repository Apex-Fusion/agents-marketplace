/**
 * buyer/src/chain.ts — ChainProvider construction for the buyer boot path.
 *
 * Mirrors supplier/src/chain.ts: returns LiveOgmiosProvider when
 * config.liveChain === true, otherwise ReadOnlyOgmiosProvider. The buyer
 * needs a Live provider to call buildAcceptTx / runAccept (both submit txs);
 * ReadOnly is the safe default for any UI that only does indexer reads.
 */

import {
  LiveOgmiosProvider,
  ReadOnlyOgmiosProvider,
  type ChainProvider,
} from "@marketplace/shared/chain";
import type { BuyerConfig } from "./config.js";

export function buildChainProvider(
  config: BuyerConfig,
  fetchFn?: typeof globalThis.fetch,
): ChainProvider {
  const opts = { ogmiosUrl: config.ogmiosUrl, fetch: fetchFn };
  if (config.liveChain) {
    // eslint-disable-next-line no-console
    console.log("[buyer] chain: LiveOgmiosProvider selected (LIVE_CHAIN=1)");
    return new LiveOgmiosProvider(opts);
  }
  // eslint-disable-next-line no-console
  console.log("[buyer] chain: ReadOnlyOgmiosProvider selected (LIVE_CHAIN unset)");
  return new ReadOnlyOgmiosProvider({ ogmiosUrl: config.ogmiosUrl });
}
