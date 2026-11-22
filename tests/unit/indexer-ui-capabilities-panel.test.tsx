// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-capabilities-panel.test.tsx — CapabilitiesPanel: one card for each entry of GET /capabilities.
 * usePolling is mocked; each case pins the state that the hook returns.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Module-level mock — hoisted above the imports, so the import below is the mock.
vi.mock("../../indexer-ui/src/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: null, error: null, loading: true })),
}));

import CapabilitiesPanel from "../../indexer-ui/src/components/CapabilitiesPanel.js";
import { usePolling } from "../../indexer-ui/src/hooks/usePolling.js";

const usePollingMock = vi.mocked(usePolling);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  usePollingMock.mockReturnValue({ data: null, error: null, loading: true });
});

// The counts do not repeat a digit of an id, so a card holds its own count only.
const SAMPLE_CAPABILITIES = [
  { capability_id: "llm.text.generate.v1", supplier_count: 3 },
  { capability_id: "speech.transcribe.v1", supplier_count: 5 },
];

describe("CapabilitiesPanel — render", () => {
  it("renders one capability-card per capability entry, with its capability_id and supplier_count", () => {
    usePollingMock.mockReturnValue({ data: SAMPLE_CAPABILITIES, error: null, loading: false });
    render(<CapabilitiesPanel />);
    const cards = screen.getAllByTestId("capability-card");
    expect(cards).toHaveLength(SAMPLE_CAPABILITIES.length);
    SAMPLE_CAPABILITIES.forEach((capability, i) => {
      expect(cards[i]).toHaveTextContent(capability.capability_id);
      expect(cards[i]).toHaveTextContent(String(capability.supplier_count));
    });
  });

  it("renders zero cards when capabilities list is empty", () => {
    usePollingMock.mockReturnValue({ data: [], error: null, loading: false });
    render(<CapabilitiesPanel />);
    expect(screen.queryAllByTestId("capability-card")).toHaveLength(0);
  });
});
