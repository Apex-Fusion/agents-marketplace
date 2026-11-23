/**
 * tests/setup.ts — setup file of the vitest project `ui` (vitest.config.ts).
 *
 * Imports @testing-library/jest-dom for vitest, so its matchers (toBeInTheDocument, etc.)
 * are available in the React tests, with their types. This runs before each test file of the
 * project `ui`. The projects `unit` and `aiken-eval` do not load it.
 */
import "@testing-library/jest-dom/vitest";
