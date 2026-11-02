import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

// Offline evaluation of the new escrow and advert scripts against the
// transactions of the shared builders (Part 2 §6.1, §6.2, §6.5). The tests need `aiken` v1.1.21 on
// PATH and no network, like tests/legacy-registry. Run from the repository
// root:
//   npx vitest run --config tests/identity-builders/vitest.config.ts
export default defineConfig({
  root,
  cacheDir: ".vitest-cache",
  resolve: {
    // Same lucid-evolution entry points as the root vitest.config.ts.
    alias: {
      "@lucid-evolution/lucid": resolve(root, "packages/shared/node_modules/@lucid-evolution/lucid/dist/index.js"),
      "@lucid-evolution/plutus": resolve(root, "packages/shared/node_modules/@lucid-evolution/plutus/dist/index.js"),
      "@lucid-evolution/uplc": resolve(
        root,
        "node_modules/.pnpm/@lucid-evolution+uplc@0.2.20/node_modules/@lucid-evolution/uplc/dist/node/uplc_tx.js",
      ),
    },
  },
  test: {
    include: ["tests/identity-builders/**/*.test.ts"],
    environment: "node",
    // Each evaluation starts one aiken process; the first live build loads the CML WASM.
    testTimeout: 120_000,
  },
});
