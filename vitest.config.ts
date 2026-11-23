import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

// The vitest projects of this repository (docs/TESTING.md, section 2). `pnpm test` runs all three:
//   unit        the tests of `.ts` files, in Node.
//   ui          the React tests (`.tsx`), in happy-dom, with the matchers of jest-dom (tests/setup.ts).
//   aiken-eval  the 4 folders that evaluate Aiken scripts with `aiken tx simulate`. They need `aiken` v1.1.21 on PATH and no network.
// Run one project with `pnpm exec vitest run --project <name>`.
//
// An inline project inherits the options of this file (`extends` is true by default in vitest 5): `cacheDir`, `resolve.alias`,
// `exclude` and `passWithNoTests`. Each project below says what it needs besides.
//
// The folders of `unit` and `ui` are the same as `UNIT_UI_TEST_ROOTS` in scripts/ci/changes.mjs, and the folders of `aiken-eval`
// are the same as `EVAL_DIRS` there and the cases of scripts/test-changed. Change them together.
const root = dirname(fileURLToPath(import.meta.url));

// The CI selects test files by path (scripts/ci/vitest-run.mjs). A path filter of vitest is a substring match, so
// "gateway/test/a.test.ts" also matches "identity-gateway/test/a.test.ts". The run lists the files that it adds by mistake
// in VITEST_EXCLUDE, one on each line. The option `--exclude` of the command line reaches no inline project (vitest 5.1.1).
const excluded = (process.env.VITEST_EXCLUDE ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

export default defineConfig({
  cacheDir: ".vitest-cache",
  resolve: {
    alias: {
      // The lucid-evolution packages are devDeps of @marketplace/shared and
      // therefore live under packages/shared/node_modules. Tests import them
      // as bare specifiers (e.g. `from "@lucid-evolution/lucid"`), which
      // Node's resolver cannot satisfy from the root cwd because there is no
      // @lucid-evolution entry in the root node_modules. Aliasing the
      // packages to their concrete entry-points lets vitest resolve them
      // regardless of the importing file's location.
      "@lucid-evolution/lucid": resolve(root, "packages/shared/node_modules/@lucid-evolution/lucid/dist/index.js"),
      "@lucid-evolution/plutus": resolve(root, "packages/shared/node_modules/@lucid-evolution/plutus/dist/index.js"),
      "@lucid-evolution/uplc": resolve(
        root,
        "node_modules/.pnpm/@lucid-evolution+uplc@0.2.20/node_modules/@lucid-evolution/uplc/dist/node/uplc_tx.js",
      ),
    },
  },
  test: {
    // `vitest related` and a path filter that matches no file are not errors.
    passWithNoTests: true,
    exclude: ["**/node_modules/**", "**/dist/**", ...excluded],
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "tests/unit/**/*.{test,spec}.ts",
            "packages/**/*.{test,spec}.ts",
            "gateway/**/*.{test,spec}.ts",
            "paper2agent/**/*.{test,spec}.ts",
            "identity-gateway/**/*.{test,spec}.ts",
          ],
          environment: "node",
          globals: true,
          // The first live tx build in a worker loads lucid's CML WASM (~2.5 s
          // idle; past the 5 s default when the whole suite runs in parallel on a
          // laptop). Whichever *-live*.test.ts file pays it first flakes, so the
          // ceiling is raised: it is warm-up, not a race.
          testTimeout: 20_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "ui",
          include: ["tests/unit/**/*.{test,spec}.tsx"],
          environment: "happy-dom",
          globals: true,
          // The matchers of jest-dom. The other projects do not load them.
          setupFiles: ["./tests/setup.ts"],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "aiken-eval",
          include: [
            "tests/legacy-registry/**/*.test.ts",
            "tests/identity-builders/**/*.test.ts",
            "tests/identity-vectors/**/*.test.ts",
            "tests/identity-deploy/**/*.test.ts",
          ],
          environment: "node",
          // Each evaluation starts one aiken process; the benchmarks and the plan test start many.
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
