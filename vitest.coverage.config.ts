import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".vitest-cache",
  test: {
    include: [
      "tests/unit/**/*.{test,spec}.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["packages/shared/src/**"],
      reporter: ["text"],
    },
  }
});
