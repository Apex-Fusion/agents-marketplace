/**
 * buyer/src/ui/main.tsx — React entrypoint (Vite-driven).
 *
 * Boots the SPA. The buyer-app server injects:
 *   <script>window.__BUYER_BOOT__ = { walletKey: { pubKeyHash, address } }</script>
 * before </head> in index.html. We pass that public-only identity into the
 * SDK so pages can display it. The SPA never holds the private key — all
 * tx-construction is server-side via /v1/* endpoints.
 *
 * Chain/indexer URLs are NOT in the boot block on purpose: the SPA doesn't
 * talk to Ogmios directly (the old `ws://localhost:1337` triggered a "this
 * site wants to use local devices" prompt), and it talks to the indexer via
 * the same-origin buyer-app server proxy at /v1/pending-receipts. The chain
 * provider passed to the SDK is a stub that throws — if anything calls it
 * from the browser, that's a misroute we want to catch loudly.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";
import { MarketplaceProvider } from "./state/MarketplaceContext.js";
// MemoryTaskHistoryStore is a no-op placeholder for the browser-side SDK
// instance — submitPrompt now runs server-side, so the browser never
// records anything to a history store. The /tasks page reads directly
// from the indexer (chain is the source of truth). LocalStorageTaskHistoryStore
// was the previous browser-only persistence path; dropped because it
// always rendered empty post UX-2b.
import { Marketplace, MemoryTaskHistoryStore } from "../sdk/index.js";
import type { ChainProvider } from "@marketplace/shared/chain";

interface BuyerBoot {
  walletKey: {
    pubKeyHash: string;
    address: string;
  };
}

function readBoot(): BuyerBoot {
  const w = window as unknown as { __BUYER_BOOT__?: BuyerBoot };
  if (w.__BUYER_BOOT__) return w.__BUYER_BOOT__;
  return {
    walletKey: { pubKeyHash: "", address: "" },
  };
}

const boot = readBoot();

const chainStub: ChainProvider = {
  tip: () => { throw new Error("browser SPA must not call chain.tip — go through /v1/*"); },
  queryUtxo: () => { throw new Error("browser SPA must not call chain.queryUtxo — go through /v1/*"); },
  queryUtxosByAddress: () => { throw new Error("browser SPA must not call chain.queryUtxosByAddress — go through /v1/*"); },
  evaluateTx: () => { throw new Error("browser SPA must not call chain.evaluateTx — go through /v1/*"); },
  submitTx: () => { throw new Error("browser SPA must not call chain.submitTx — go through /v1/*"); },
  awaitTx: () => { throw new Error("browser SPA must not call chain.awaitTx — go through /v1/*"); },
};

const historyStore = new MemoryTaskHistoryStore();
const marketplace = new Marketplace({
  chain: chainStub,
  // Same-origin proxy: SDK calls land on /v1/indexer/<path> on the buyer
  // server, which forwards to the internal indexer. Avoids CORS and keeps
  // the real indexer URL out of the page bundle.
  indexerUrl: window.location.origin + "/v1/indexer",
  walletKey: {
    pubKeyHash: boot.walletKey.pubKeyHash,
    pubKeyHex: "",                    // not exposed to browser
    privateKeyHex: "0".repeat(64),    // sentinel: never sign in browser
    address: boot.walletKey.address,
  },
  networkParams: { networkId: 1 },    // Vector L2 = mainnet bytes
  historyStore,
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("[buyer] #root element not found");
createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <MarketplaceProvider marketplace={marketplace}>
        <App />
      </MarketplaceProvider>
    </BrowserRouter>
  </StrictMode>,
);
