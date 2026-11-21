/**
 * The switch of the deep test variants of this package. It does what `tests/depth.ts` does (docs/TESTING.md, "Test depth"):
 * `TEST_DEPTH=nightly` is set by .github/workflows/nightly.yml only. A test with a deep variant (bigger data, more property
 * runs) reads `nightly` and keeps the small variant for the pull request and for the agent loop.
 *
 * This package cannot import `tests/depth.ts`: its `tsconfig.json` sets `rootDir` to the package, and `pnpm -r typecheck` reads
 * the test files.
 */
export const nightly: boolean = process.env.TEST_DEPTH === "nightly";
