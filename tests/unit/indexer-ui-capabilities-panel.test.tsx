// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-capabilities-panel.test.tsx — GREEN (M1-F-5)
 *
 * Category D: CapabilitiesPanel component (~5 tests)
 *
 * Mock strategy: vi.mock at module level; per-test control via usePollingMock.mockReturnValue().
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

// Module-level mock — must be hoisted above imports.
vi.mock("../../indexer-ui/src/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: null, error: null, loading: true })),
}));

import CapabilitiesPanel from "../../indexer-ui/src/components/CapabilitiesPanel.js";

const { usePolling: usePollingMock } = await import("../../indexer-ui/src/hooks/usePolling.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
    data: null,
    error: null,
    loading: true,
  });
});

const SAMPLE_CAPABILITIES = [
  { capability_id: "llm.text.generate.v1", supplier_count: 3 },
  { capability_id: "speech.transcribe.v1", supplier_count: 1 },
];

// ─── Render contract ─────────────────────────────────────────────────────────

describe("CapabilitiesPanel — render", () => {
  it("renders one capability-card per capability entry", async () => {
    (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
      data: SAMPLE_CAPABILITIES,
      error: null,
      loading: false,
    });
    render(<CapabilitiesPanel />);
    await waitFor(() => {
      const cards = document.querySelectorAll("[data-testid='capability-card']");
      expect(cards.length).toBe(SAMPLE_CAPABILITIES.length);
    });
  });

  it("renders zero cards when capabilities list is empty", async () => {
    (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [],
      error: null,
      loading: false,
    });
    render(<CapabilitiesPanel />);
    await waitFor(() => {
      const cards = document.querySelectorAll("[data-testid='capability-card']");
      expect(cards.length).toBe(0);
    });
  });

  it("each card shows capability_id text", async () => {
    (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
      data: SAMPLE_CAPABILITIES,
      error: null,
      loading: false,
    });
    render(<CapabilitiesPanel />);
    await waitFor(() => {
      expect(screen.getByText(/llm\.text\.generate\.v1/)).toBeTruthy();
      expect(screen.getByText(/speech\.transcribe\.v1/)).toBeTruthy();
    });
  });

  it("each card shows supplier_count", async () => {
    (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
      data: SAMPLE_CAPABILITIES,
      error: null,
      loading: false,
    });
    render(<CapabilitiesPanel />);
    await waitFor(() => {
      // supplier_count: 3 for llm, 1 for speech
      expect(screen.getByText("3")).toBeTruthy();
      expect(screen.getByText("1")).toBeTruthy();
    });
  });
});

// ─── Polling interval ────────────────────────────────────────────────────────

describe("CapabilitiesPanel — polling", () => {
  it("passes intervalMs=30000 to usePolling", async () => {
    (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [],
      error: null,
      loading: false,
    });
    render(<CapabilitiesPanel />);
    await waitFor(() => {
      expect(usePollingMock).toHaveBeenCalled();
      const callArgs = (usePollingMock as ReturnType<typeof vi.fn>).mock.calls[0];
      // second argument must be 30000
      expect(callArgs[1]).toBe(30_000);
    });
  });
});
