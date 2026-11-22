// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-events-log.test.tsx — EventsLog: the rows (newest first), the type badges and the filter chips.
 * useSSE is mocked; each case pins the events that the hook returns.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";

// Module-level mock — hoisted above all imports by Vitest.
vi.mock("../../indexer-ui/src/hooks/useSSE.js", () => ({
  useSSE: vi.fn(() => ({ events: [], lastSeenSlot: null, connected: true })),
}));

// Import AFTER mock declaration so the component gets the mocked module.
import type { ChainEvent } from "../../indexer-ui/src/api/sse.js";
import EventsLog from "../../indexer-ui/src/components/EventsLog.js";

// Grab the mocked function reference for per-test control.
const { useSSE: useSSEMock } = await import("../../indexer-ui/src/hooks/useSSE.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset to safe default so a failed test doesn't poison the next.
  (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
    events: [],
    lastSeenSlot: null,
    connected: true,
  });
});

function makeEvents(count: number, type = "PostAdvert"): ChainEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type,
    ref: "a".repeat(64) + `#${i}`,
    slot: 1000 + i,
  }));
}

// ─── Basic render ─────────────────────────────────────────────────────────────

describe("EventsLog — render", () => {
  it("renders one event-row per event received", async () => {
    const events = makeEvents(3);
    (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
      events,
      lastSeenSlot: events[events.length - 1].slot,
      connected: true,
    });
    render(<EventsLog />);
    await waitFor(() => {
      const rows = document.querySelectorAll("[data-testid='event-row']");
      expect(rows.length).toBe(3);
    });
  });

  it("renders events in reverse-chronological order (newest slot first)", async () => {
    const events: ChainEvent[] = [
      { type: "PostAdvert", ref: "a".repeat(64) + "#0", slot: 100 },
      { type: "PostAdvert", ref: "b".repeat(64) + "#1", slot: 200 },
      { type: "PostAdvert", ref: "c".repeat(64) + "#2", slot: 300 },
    ];
    (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
      events,
      lastSeenSlot: 300,
      connected: true,
    });
    render(<EventsLog />);
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll("[data-testid='event-row']"));
      expect(rows.length).toBe(3);
      // The newest slot (300) comes first.
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("300"),
        expect.stringContaining("200"),
        expect.stringContaining("100"),
      ]);
    });
  });

  it("renders a type badge for each event", async () => {
    const events = makeEvents(2, "PostAdvert");
    (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
      events,
      lastSeenSlot: events[events.length - 1].slot,
      connected: true,
    });
    render(<EventsLog />);
    await waitFor(() => {
      const badges = document.querySelectorAll("[data-testid='event-type-badge']");
      expect(badges.length).toBe(2);
    });
  });

  it("renders zero rows when no events", async () => {
    (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
      events: [],
      lastSeenSlot: null,
      connected: true,
    });
    render(<EventsLog />);
    await waitFor(() => {
      const rows = document.querySelectorAll("[data-testid='event-row']");
      expect(rows.length).toBe(0);
    });
  });
});

// ─── Event type distinction ───────────────────────────────────────────────────

describe("EventsLog — event type visual distinction", () => {
  it("different event types render different badge text", async () => {
    const events: ChainEvent[] = [
      { type: "PostAdvert", ref: "a".repeat(64) + "#0", slot: 100 },
      { type: "PostEscrow", ref: "b".repeat(64) + "#1", slot: 101 },
    ];
    (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
      events,
      lastSeenSlot: 101,
      connected: true,
    });
    render(<EventsLog />);
    // Badges use full event type text (not split like chips)
    await waitFor(() => {
      const badges = document.querySelectorAll("[data-testid='event-type-badge']");
      const texts = Array.from(badges).map((b) => b.textContent ?? "");
      expect(texts.some((t) => t.includes("PostAdvert"))).toBe(true);
      expect(texts.some((t) => t.includes("PostEscrow"))).toBe(true);
    });
  });
});

// ─── Filter chips ─────────────────────────────────────────────────────────────

describe("EventsLog — filter chips", () => {
  it("renders a filter chip for each distinct event type present", async () => {
    const events: ChainEvent[] = [
      { type: "PostAdvert", ref: "a".repeat(64) + "#0", slot: 100 },
      { type: "PostEscrow", ref: "b".repeat(64) + "#1", slot: 101 },
      { type: "PostAdvert", ref: "c".repeat(64) + "#2", slot: 102 },
    ];
    (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
      events,
      lastSeenSlot: 102,
      connected: true,
    });
    render(<EventsLog />);
    await waitFor(() => {
      const advertChip = document.querySelector("[data-testid='event-filter-chip-PostAdvert']");
      const escrowChip = document.querySelector("[data-testid='event-filter-chip-PostEscrow']");
      expect(advertChip).not.toBeNull();
      expect(escrowChip).not.toBeNull();
    });
  });

  it("clicking a filter chip shows only events of that type", async () => {
    const events: ChainEvent[] = [
      { type: "PostAdvert", ref: "a".repeat(64) + "#0", slot: 100 },
      { type: "PostEscrow", ref: "b".repeat(64) + "#1", slot: 101 },
      { type: "PostAdvert", ref: "c".repeat(64) + "#2", slot: 102 },
    ];
    (useSSEMock as ReturnType<typeof vi.fn>).mockReturnValue({
      events,
      lastSeenSlot: 102,
      connected: true,
    });
    render(<EventsLog />);
    await waitFor(() => {
      const chip = document.querySelector("[data-testid='event-filter-chip-PostAdvert']");
      expect(chip).not.toBeNull();
    });
    const chip = document.querySelector("[data-testid='event-filter-chip-PostAdvert']")!;
    fireEvent.click(chip);
    await waitFor(() => {
      const rows = document.querySelectorAll("[data-testid='event-row']");
      // Only PostAdvert rows (2 of them)
      expect(rows.length).toBe(2);
    });
  });
});
