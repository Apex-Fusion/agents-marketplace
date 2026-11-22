// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-suppliers-table.test.tsx — SuppliersTable: the rows of GET /suppliers, the price in AP3X and the refresh on a
 * chain event. client.js and useSSE.js are mocked.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, waitFor, within } from "@testing-library/react";
import {
  ALL_SAMPLE_SUPPLIERS,
  SAMPLE_FREE_SUPPLIER,
  buildUiSupplierRow,
} from "../fixtures/indexer-ui-side/sample-supplier-rows.js";

// Module-level mocks — hoisted above the imports, so the imports below are the mocks.
vi.mock("../../indexer-ui/src/api/client.js", () => ({
  fetchSuppliers: vi.fn(),
}));

vi.mock("../../indexer-ui/src/hooks/useSSE.js", () => ({
  useSSE: vi.fn(() => ({ events: [], lastSeenSlot: null, connected: true })),
}));

import SuppliersTable from "../../indexer-ui/src/components/SuppliersTable.js";
import { fetchSuppliers } from "../../indexer-ui/src/api/client.js";
import { useSSE } from "../../indexer-ui/src/hooks/useSSE.js";

const fetchSuppliersMock = vi.mocked(fetchSuppliers);
const useSSEMock = vi.mocked(useSSE);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset to safe defaults.
  useSSEMock.mockReturnValue({ events: [], lastSeenSlot: null, connected: true });
});

describe("SuppliersTable — rows", () => {
  it.each([
    ["three suppliers", ALL_SAMPLE_SUPPLIERS],
    ["no supplier", []],
  ])("fetches /suppliers on mount and renders one row per supplier: %s", async (_name, suppliers) => {
    fetchSuppliersMock.mockResolvedValue(suppliers);
    render(<SuppliersTable />);
    // The fetch has no result to wait for when the list is empty, so the case flushes the promise instead.
    await act(async () => {});
    expect(screen.queryAllByTestId("supplier-row")).toHaveLength(suppliers.length);
    expect(fetchSuppliersMock).toHaveBeenCalledTimes(1);
  });
});

describe("SuppliersTable — price formatting", () => {
  it.each([
    ["0", "0 AP3X"],
    ["1000000", "1 AP3X"],
    ["2000000", "2 AP3X"],
  ])("formats price_lovelace=%s as '%s'", async (lovelace, shown) => {
    fetchSuppliersMock.mockResolvedValue([buildUiSupplierRow({ price_lovelace: lovelace })]);
    render(<SuppliersTable />);
    const row = await screen.findByTestId("supplier-row");
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toContain(shown);
  });
});

describe("SuppliersTable — SSE refresh", () => {
  it("re-fetches /suppliers when a chain-event is emitted via useSSE", async () => {
    // The mock useSSE emits a PostAdvert event at once.
    useSSEMock.mockReturnValue({
      events: [{ type: "PostAdvert", ref: "f".repeat(64) + "#0", slot: 3000 }],
      lastSeenSlot: 3000,
      connected: true,
    });
    fetchSuppliersMock.mockResolvedValue([SAMPLE_FREE_SUPPLIER]);
    render(<SuppliersTable />);
    // At least 2 calls: the first fetch (usePolling) and the fetch on the chain event.
    await waitFor(() => {
      expect(fetchSuppliersMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
