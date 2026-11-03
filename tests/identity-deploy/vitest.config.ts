import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

// The identity deployment tool (contracts/identity-marketplace/deploy): plan
// hashes against `aiken blueprint apply`, the seal and publish transactions
// under `aiken tx simulate`, the allowlist root against the published vectors,
// and the resume rules over an in-memory ledger. The tests need `aiken`
// v1.1.21 on PATH and no network. Run from the repository root:
//   npx vitest run --config tests/identity-deploy/vitest.config.ts
export default defineConfig({
  root,
  cacheDir: ".vitest-cache",
  resolve: {
    // Same lucid-evolution entry points as the root vitest.config.ts (@marketplace/shared/tx/server loads lucid).
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
    include: ["tests/identity-deploy/**/*.test.ts"],
    environment: "node",
    // Each evaluation starts one aiken process; the plan test applies parameters with aiken.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
