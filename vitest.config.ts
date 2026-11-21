import { defineConfig } from "vitest/config";

// The global options of every run. The projects (unit, ui, aiken-eval) are in vitest.workspace.ts. Vitest 2 gives a project
// none of the options of this file, so it holds only what acts on the whole run.
export default defineConfig({
  cacheDir: ".vitest-cache",
  test: {
    // `vitest related` and a path filter that matches no file are not errors.
    passWithNoTests: true,
  },
});
