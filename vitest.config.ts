import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [react()],
  cacheDir: ".vitest-cache",
  resolve: {
    alias: {
      // The lucid-evolution packages are devDeps of @marketplace/shared and
      // therefore live under packages/shared/node_modules. Tests in tests/unit
      // import them as bare specifiers (e.g. `from "@lucid-evolution/lucid"`),
      // which Node's resolver cannot satisfy from the root cwd because there
      // is no @lucid-evolution entry in the root node_modules. Aliasing both
      // packages to their concrete entry-points lets vitest resolve them
      // regardless of the importing file's location.
      "@lucid-evolution/lucid": resolve(
        __dirname,
        "packages/shared/node_modules/@lucid-evolution/lucid/dist/index.js",
      ),
      "@lucid-evolution/plutus": resolve(
        __dirname,
        "packages/shared/node_modules/@lucid-evolution/plutus/dist/index.js",
      ),
      "@lucid-evolution/uplc": resolve(
        __dirname,
        "node_modules/.pnpm/@lucid-evolution+uplc@0.2.20/node_modules/@lucid-evolution/uplc/dist/node/uplc_tx.js",
      ),
    },
  },
  test: {
    include: [
      "tests/unit/**/*.{test,spec}.ts",
      "tests/unit/**/*.{test,spec}.tsx",
      "tests/ogmios/**/*.{test,spec}.ts",
      "tests/lifecycle/**/*.{test,spec}.ts",
      "packages/**/*.{test,spec}.ts",
      "buyer/**/*.{test,spec}.ts",
      "buyer/**/*.{test,spec}.tsx",
      "gateway/**/*.{test,spec}.ts",
      "supplier/**/*.{test,spec}.ts",
      "indexer/**/*.{test,spec}.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: true,
    // Per-file environment override via @vitest-environment docblock is still
    // supported; default remains "node" for all non-UI tests.
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
});
