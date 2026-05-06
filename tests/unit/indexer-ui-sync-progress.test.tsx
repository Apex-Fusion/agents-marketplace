// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-sync-progress.test.tsx — GREEN (M1-F-5)
 *
 * Category B: SyncProgress component (~5 tests)
 *
 * Mock strategy:
 *   - usePolling is mocked at module level; per-test control via mockReturnValue.
 *   - client.js is NOT mocked — fetchHealthz internally calls global fetch,
 *     which the polling-contract tests stub via vi.stubGlobal("fetch", ...).
 *   - The component has a side-channel useEffect that calls fetchHealthz via
 *     setInterval regardless of usePolling's mock state — this is what the
 *     polling-contract tests count.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

// Module-level mock for usePolling — hoisted above imports.
vi.mock("../../indexer-ui/src/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: null, error: null, loading: true })),
}));

import SyncProgress from "../../indexer-ui/src/components/SyncProgress.js";

const { usePolling: usePollingMock } = await import("../../indexer-ui/src/hooks/usePolling.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Reset to safe default.
  (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
    data: null,
    error: null,
    loading: true,
  });
});

// ─── Polling contract ────────────────────────────────────────────────────────
// These tests observe the side-channel fetchHealthz useEffect via global fetch stubs.

describe("SyncProgress — polling", () => {
  it("fetches /healthz on mount (fetch called at least once within the polling cycle)", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        sync_slot: 100,
        tip_slot: 200,
        ogmios_status: "connected",
        db_size_bytes: 4096,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<SyncProgress />);
    // Advance past first poll interval (5 000 ms)
    await act(async () => { vi.advanceTimersByTime(5_001); });

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/healthz"));
  });

  it("polls every 5 s: fetch is called again after a second 5s interval", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        sync_slot: 100,
        tip_slot: 200,
        ogmios_status: "connected",
        db_size_bytes: 4096,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<SyncProgress />);
    await act(async () => { vi.advanceTimersByTime(5_001); });
    const callsAfterFirst = mockFetch.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5_001); });
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("unmounting stops further fetch calls", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        sync_slot: 100,
        tip_slot: 200,
        ogmios_status: "connected",
        db_size_bytes: 4096,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { unmount } = render(<SyncProgress />);
    await act(async () => { vi.advanceTimersByTime(5_001); });
    const callsBeforeUnmount = mockFetch.mock.calls.length;
    unmount();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(mockFetch.mock.calls.length).toBe(callsBeforeUnmount);
  });
});

// ─── Render contract ─────────────────────────────────────────────────────────

describe("SyncProgress — render", () => {
  it("renders sync_slot and tip_slot numerically when healthz data is available", async () => {
    (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { ok: true, sync_slot: 750, tip_slot: 1000, ogmios_status: "connected", db_size_bytes: 0 },
      error: null,
      loading: false,
    });
    render(<SyncProgress />);
    expect(screen.getByText(/750/)).toBeTruthy();
    expect(screen.getByText(/1000/)).toBeTruthy();
  });

  it("renders warning indicator when ogmios_status is 'disconnected'", async () => {
    (usePollingMock as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { ok: false, sync_slot: 0, tip_slot: 0, ogmios_status: "disconnected", db_size_bytes: 0 },
      error: null,
      loading: false,
    });
    render(<SyncProgress />);
    const warning =
      document.querySelector("[data-testid='ogmios-warning']") ??
      screen.queryByRole("alert");
    expect(warning).not.toBeNull();
  });
});
