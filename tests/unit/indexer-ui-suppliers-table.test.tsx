// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-suppliers-table.test.tsx — GREEN (M1-F-5)
 *
 * Category C: SuppliersTable component (~8 tests)
 *
 * Mock strategy: vi.mock at module level for both client.js and useSSE.js;
 * per-test control via mockReturnValue / mockResolvedValue.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import {
  ALL_SAMPLE_SUPPLIERS,
  SAMPLE_FREE_SUPPLIER,
  SAMPLE_WORKING_SUPPLIER,
  SAMPLE_OFFLINE_SUPPLIER,
} from "../fixtures/indexer-ui-side/sample-supplier-rows.js";

// Module-level mocks — hoisted above imports.
vi.mock("../../indexer-ui/src/api/client.js", () => ({
  fetchSuppliers: vi.fn(),
  fetchHealthz: vi.fn(),
  fetchCapabilities: vi.fn(),
  fetchEscrow: vi.fn(),
}));

vi.mock("../../indexer-ui/src/hooks/useSSE.js", () => ({
  useSSE: vi.fn(() => ({ events: [], lastSeenSlot: null, connected: true })),
  MAX_EVENTS: 500,
}));

import SuppliersTable from "../../indexer-ui/src/components/SuppliersTable.js";

const { fetchSuppliers: fetchSuppliersMock } = await import("../../indexer-ui/src/api/client.js");
const { useSSE: useSSEMock } = await import("../../indexer-ui/src/hooks/useSSE.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset to safe defaults.
  (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
    events: [],
    lastSeenSlot: null,
    connected: true,
  });
});

// ─── Columns and initial fetch ───────────────────────────────────────────────

describe("SuppliersTable — columns", () => {
  it("renders column headers: capability_id, model, price, status, last_seen", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue(ALL_SAMPLE_SUPPLIERS);
    render(<SuppliersTable />);
    await waitFor(() => {
      expect(screen.getByText(/capability/i)).toBeTruthy();
      expect(screen.getByText(/model/i)).toBeTruthy();
      expect(screen.getByText(/price/i)).toBeTruthy();
      expect(screen.getByText(/status/i)).toBeTruthy();
      expect(screen.getByText(/last.?seen/i)).toBeTruthy();
    });
  });

  it("fetches /suppliers on mount and renders one row per supplier", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue(ALL_SAMPLE_SUPPLIERS);
    render(<SuppliersTable />);
    await waitFor(() => {
      const rows = document.querySelectorAll("[data-testid='supplier-row']");
      expect(rows.length).toBe(ALL_SAMPLE_SUPPLIERS.length);
    });
  });
});

// ─── Empty state ─────────────────────────────────────────────────────────────

describe("SuppliersTable — empty state", () => {
  it("renders 'no suppliers yet' when supplier list is empty", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    render(<SuppliersTable />);
    await waitFor(() => {
      expect(screen.getByText(/no suppliers yet/i)).toBeTruthy();
    });
  });
});

// ─── Price formatting ────────────────────────────────────────────────────────

describe("SuppliersTable — price formatting", () => {
  it("formats price_lovelace=2000000 as '2 AP3X'", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE_FREE_SUPPLIER]);
    render(<SuppliersTable />);
    await waitFor(() => {
      expect(screen.getByText(/2\s*AP3X/i)).toBeTruthy();
    });
  });

  it("formats price_lovelace=1000000 as '1 AP3X'", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE_WORKING_SUPPLIER]);
    render(<SuppliersTable />);
    await waitFor(() => {
      expect(screen.getByText(/1\s*AP3X/i)).toBeTruthy();
    });
  });
});

// ─── Status pill colours ─────────────────────────────────────────────────────

describe("SuppliersTable — status pill colours", () => {
  it("free status pill has green-related class", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE_FREE_SUPPLIER]);
    render(<SuppliersTable />);
    await waitFor(() => {
      const pills = document.querySelectorAll("[data-testid='status-pill']");
      expect(pills.length).toBeGreaterThan(0);
      const pill = pills[0] as HTMLElement;
      expect(pill.className).toMatch(/green/i);
    });
  });

  it("working status pill has blue-related class", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE_WORKING_SUPPLIER]);
    render(<SuppliersTable />);
    await waitFor(() => {
      const pill = document.querySelector("[data-testid='status-pill']") as HTMLElement;
      expect(pill).not.toBeNull();
      expect(pill.className).toMatch(/blue/i);
    });
  });

  it("offline status pill has gray-related class", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE_OFFLINE_SUPPLIER]);
    render(<SuppliersTable />);
    await waitFor(() => {
      const pill = document.querySelector("[data-testid='status-pill']") as HTMLElement;
      expect(pill).not.toBeNull();
      expect(pill.className).toMatch(/gray/i);
    });
  });
});

// ─── Refresh on chain-event ──────────────────────────────────────────────────

describe("SuppliersTable — SSE refresh", () => {
  it("re-fetches /suppliers when a chain-event is emitted via useSSE", async () => {
    // Provide a mock useSSE that emits a PostAdvert event immediately.
    (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
      events: [{ type: "PostAdvert", ref: "f".repeat(64) + "#0", slot: 3000 }],
      lastSeenSlot: 3000,
      connected: true,
    });
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE_FREE_SUPPLIER]);
    render(<SuppliersTable />);
    // Expect at least 2 calls: initial mount (via usePolling) + on chain-event
    await waitFor(() => {
      expect((fetchSuppliersMock as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
