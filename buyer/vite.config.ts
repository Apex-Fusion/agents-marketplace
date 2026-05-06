/**
 * buyer/vite.config.ts — Vite config for the React UI bundle.
 *
 * The UI source lives at buyer/src/ui (with index.html alongside). The build
 * output goes to buyer/dist; the Express server in production mounts that
 * directory via createApp({ distPath }).
 *
 * SPEC FIX 2026-04-27 (M1-F-1): alias array uses regex `find` for the bare
 * `@marketplace/shared` so it does NOT prefix-match sub-paths like
 * `@marketplace/shared/chain`. The previous object-form aliases were matched
 * in insertion order; the broad `@marketplace/shared` would rewrite
 * `@marketplace/shared/chain` to `…/index.ts/chain` (a path under a file)
 * which broke the production Vite build. Sub-path aliases come BEFORE the
 * bare-name regex regardless, so the order here is robust either way.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src/ui"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  resolve: {
    alias: [
      // Sub-path aliases first (longest prefixes win on string matching).
      { find: "@marketplace/shared/chain", replacement: resolve(__dirname, "../packages/shared/src/chain/index.ts") },
      { find: "@marketplace/shared/cbor", replacement: resolve(__dirname, "../packages/shared/src/cbor/index.ts") },
      { find: "@marketplace/shared/receipt", replacement: resolve(__dirname, "../packages/shared/src/receipt/index.ts") },
      { find: "@marketplace/shared/tx", replacement: resolve(__dirname, "../packages/shared/src/tx/index.ts") },
      { find: "@marketplace/shared/network", replacement: resolve(__dirname, "../packages/shared/src/network.ts") },
      // Bare alias as a regex anchored to end — only matches exact
      // `@marketplace/shared`, never a sub-path.
      { find: /^@marketplace\/shared$/, replacement: resolve(__dirname, "../packages/shared/src/index.ts") },
      // Browser stub for tx/blueprint.ts. The real module reads plutus.json
      // via fs/path/url; the SPA transitively imports `loadBlueprint` but
      // never calls it (tx construction is server-side via /v1/*). Aliasing
      // to a stub keeps Node builtins out of the Rollup browser bundle.
      { find: /\/packages\/shared\/src\/tx\/blueprint\.ts$/, replacement: resolve(__dirname, "src/ui/stubs/blueprintStub.ts") },
    ],
  },
});
