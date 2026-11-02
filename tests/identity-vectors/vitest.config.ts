import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Published vectors, benchmarks and resolver properties (Part 2 §12.3, §12.4).
// The benchmarks need `aiken` v1.1.21 on PATH and no network. Run from the
// repository root:
//   npx vitest run --config tests/identity-vectors/vitest.config.ts
export default defineConfig({
  root: resolve(here, "../.."),
  cacheDir: ".vitest-cache",
  test: {
    include: ["tests/identity-vectors/**/*.test.ts"],
    environment: "node",
    // Each benchmark transaction starts one aiken process.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
