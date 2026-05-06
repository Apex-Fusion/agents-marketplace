/**
 * indexer-ui/vite.config.ts — Vite config for the indexer dashboard UI.
 *
 * Mirrors buyer/vite.config.ts structure.
 * Output goes to indexer-ui/dist; the indexer's Express server mounts that
 * directory via INDEXER_UI_DIST env.
 *
 * Alias ordering: sub-path aliases before bare-name regex (M1-F-1 fix pattern).
 * The bare alias is anchored with `/^@marketplace\/shared$/` so it does NOT
 * prefix-match sub-paths like `@marketplace/shared/chain` (which would rewrite
 * to `…/index.ts/chain` and break the build).
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
  },
  resolve: {
    alias: [
      // Sub-path aliases first.
      { find: "@marketplace/shared/chain", replacement: resolve(__dirname, "../packages/shared/src/chain/index.ts") },
      { find: "@marketplace/shared/cbor", replacement: resolve(__dirname, "../packages/shared/src/cbor/index.ts") },
      { find: "@marketplace/shared/receipt", replacement: resolve(__dirname, "../packages/shared/src/receipt/index.ts") },
      { find: "@marketplace/shared/tx", replacement: resolve(__dirname, "../packages/shared/src/tx/index.ts") },
      { find: "@marketplace/shared/network", replacement: resolve(__dirname, "../packages/shared/src/network.ts") },
      // Bare alias as a regex anchored to end — only matches exact
      // `@marketplace/shared`, never a sub-path.
      { find: /^@marketplace\/shared$/, replacement: resolve(__dirname, "../packages/shared/src/index.ts") },
    ],
  },
});
