// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-app-smoke.test.tsx — RED phase (M1-F-5)
 *
 * Category A: App-level smoke tests with React Testing Library + happy-dom.
 * (~10 tests)
 *
 * All tests FAIL until M1-F-5-green because App.tsx stubs render
 * "NOT IMPLEMENTED" placeholders and components don't yet implement
 * the contracted panel headings / document title.
 *
 * Design contract for Catherine:
 *   - <App /> renders exactly five panel headings (h2 or section[aria-label]):
 *       "Sync Progress", "Suppliers", "Capabilities", "Live Events", "Escrow Lookup"
 *   - document.title is "Marketplace Indexer"
 *   - Each component mounts without throwing (isolation smoke)
 *   - <App /> has a root heading or title containing "Marketplace Indexer"
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import App from "../../indexer-ui/src/App.js";
import SyncProgress from "../../indexer-ui/src/components/SyncProgress.js";
import SuppliersTable from "../../indexer-ui/src/components/SuppliersTable.js";
import CapabilitiesPanel from "../../indexer-ui/src/components/CapabilitiesPanel.js";
import EventsLog from "../../indexer-ui/src/components/EventsLog.js";
import EscrowLookup from "../../indexer-ui/src/components/EscrowLookup.js";

// Mock all hooks that make network calls so component isolation tests don't throw
// from the stub-hook level — the component-level "NOT IMPLEMENTED" is the first
// barrier Catherine must replace.
vi.mock("../../indexer-ui/src/hooks/usePolling.js", () => ({
  usePolling: () => ({ data: null, error: null, loading: true }),
}));
vi.mock("../../indexer-ui/src/hooks/useSSE.js", () => ({
  useSSE: () => ({ events: [], lastSeenSlot: null, connected: false }),
  MAX_EVENTS: 500,
}));

afterEach(() => {
  cleanup();
});

// ─── <App /> level ──────────────────────────────────────────────────────────

describe("<App /> smoke", () => {
  it("renders all five panel headings", () => {
    render(<App />);
    expect(screen.getByText(/sync progress/i)).toBeTruthy();
    expect(screen.getByText(/suppliers/i)).toBeTruthy();
    expect(screen.getByText(/capabilities/i)).toBeTruthy();
    expect(screen.getByText(/live events/i)).toBeTruthy();
    expect(screen.getByText(/escrow lookup/i)).toBeTruthy();
  });

  it("document title is 'Marketplace Indexer'", () => {
    render(<App />);
    expect(document.title).toBe("Marketplace Indexer");
  });

  it("renders a top-level heading or h1 containing 'Marketplace Indexer'", () => {
    render(<App />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toMatch(/marketplace indexer/i);
  });

  it("does not throw on mount with no network access", () => {
    expect(() => render(<App />)).not.toThrow();
  });
});

// ─── Component isolation smoke ──────────────────────────────────────────────

describe("<SyncProgress /> isolation smoke", () => {
  it("mounts without throwing", () => {
    expect(() => render(<SyncProgress />)).not.toThrow();
  });

  it("renders a container element with data-testid='sync-progress'", () => {
    render(<SyncProgress />);
    const el = document.querySelector("[data-testid='sync-progress']");
    expect(el).not.toBeNull();
  });
});

describe("<SuppliersTable /> isolation smoke", () => {
  it("mounts without throwing", () => {
    expect(() => render(<SuppliersTable />)).not.toThrow();
  });
});

describe("<CapabilitiesPanel /> isolation smoke", () => {
  it("mounts without throwing", () => {
    expect(() => render(<CapabilitiesPanel />)).not.toThrow();
  });
});

describe("<EventsLog /> isolation smoke", () => {
  it("mounts without throwing", () => {
    expect(() => render(<EventsLog />)).not.toThrow();
  });
});

describe("<EscrowLookup /> isolation smoke", () => {
  it("mounts without throwing", () => {
    expect(() => render(<EscrowLookup />)).not.toThrow();
  });
});
