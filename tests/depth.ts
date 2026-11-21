/**
 * tests/depth.ts: the switch of the deep test variants (docs/TESTING.md, "Test depth").
 *
 * `TEST_DEPTH=nightly` is set by .github/workflows/nightly.yml only. A test that has a deep variant (bigger data, more property
 * runs) reads `nightly` and keeps the small variant for the pull request and for the agent loop.
 */
export const nightly: boolean = process.env.TEST_DEPTH === "nightly";
