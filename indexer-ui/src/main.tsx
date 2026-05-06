/**
 * indexer-ui/src/main.tsx — React entrypoint (Vite-driven).
 *
 * Mounts <App /> at #root. Uses relative URLs (same-origin) so the dashboard
 * automatically targets the indexer that serves it (when bundled via
 * INDEXER_UI_DIST). For dev (`pnpm dev`), Vite proxies are not currently
 * configured — set up a vite proxy to the indexer if running standalone.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("[indexer-ui] #root element not found");
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
