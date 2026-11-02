import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Legacy script tests (Part 2 §12.2). They need `aiken` v1.1.21 on PATH and
// no network. Run from the repository root:
//   npx vitest run --config tests/legacy-registry/vitest.config.ts
export default defineConfig({
  root: resolve(here, "../.."),
  cacheDir: ".vitest-cache",
  test: {
    include: ["tests/legacy-registry/**/*.test.ts"],
    environment: "node",
    // Each evaluation starts one aiken process.
    testTimeout: 120_000,
  },
});
