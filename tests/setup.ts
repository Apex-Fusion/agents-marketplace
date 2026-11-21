/**
 * tests/setup.ts — setup file of the vitest project `ui` (vitest.workspace.ts).
 *
 * Imports @testing-library/jest-dom so its matchers (toBeInTheDocument, etc.)
 * are available in the React tests. This runs before each test file of the
 * project `ui`. The projects `unit` and `aiken-eval` do not load it.
 */
import "@testing-library/jest-dom";
