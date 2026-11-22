// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-sync-progress.test.tsx — SyncProgress: the sync gauge, the Ogmios warning and the polling of /healthz.
 * The render cases pin the state of usePolling. The polling cases run the real hook over a stubbed fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type * as PollingModule from "../../indexer-ui/src/hooks/usePolling.js";

// The mock wraps the real hook: a render case pins a state with mockReturnValue, a polling case runs the real hook.
vi.mock("../../indexer-ui/src/hooks/usePolling.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PollingModule>();
  return { usePolling: vi.fn(actual.usePolling) };
});

import SyncProgress from "../../indexer-ui/src/components/SyncProgress.js";
import { usePolling } from "../../indexer-ui/src/hooks/usePolling.js";

// The mocked module cannot give the real hook back after a case pinned a state, so a beforeEach restores it from the actual module.
const actualPolling = await vi.importActual<typeof PollingModule>("../../indexer-ui/src/hooks/usePolling.js");
const usePollingMock = vi.mocked(usePolling);

const HEALTHZ = { ok: true, sync_slot: 100, tip_slot: 200, ogmios_status: "connected", db_size_bytes: 4096 };
const fetchSpy = vi.fn(async (_url: string) => ({ ok: true, json: async () => HEALTHZ }));

beforeEach(() => {
  usePollingMock.mockImplementation(actualPolling.usePolling);
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Only the interval timers are fake: promises and Testing Library keep their real timers.
describe("SyncProgress — polling /healthz (real usePolling)", () => {
  it("requests /healthz at mount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(<SyncProgress />);
    await act(async () => {});
    expect(fetchSpy).toHaveBeenCalledWith("/healthz");
  });

  it("requests /healthz again at the next interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(<SyncProgress />);
    await act(async () => {});
    const atMount = fetchSpy.mock.calls.length;
    await act(async () => {
      vi.advanceTimersToNextTimer();
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(atMount);
  });

  it("requests /healthz no more after unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { unmount } = render(<SyncProgress />);
    await act(async () => {});
    const atMount = fetchSpy.mock.calls.length;
    await act(async () => {
      vi.advanceTimersToNextTimer();
    });
    const beforeUnmount = fetchSpy.mock.calls.length;
    // The polling was alive while the component was mounted.
    expect(beforeUnmount).toBeGreaterThan(atMount);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchSpy.mock.calls.length).toBe(beforeUnmount);
  });
});

describe("SyncProgress — render", () => {
  it("renders sync_slot and tip_slot numerically, and no Ogmios warning, when healthz data is available", () => {
    usePollingMock.mockReturnValue({
      data: { ok: true, sync_slot: 750, tip_slot: 1000, ogmios_status: "connected", db_size_bytes: 0 },
      error: null,
      loading: false,
    });
    render(<SyncProgress />);
    expect(screen.getByTestId("sync-progress")).toHaveTextContent(/750\D*1000/);
    expect(screen.queryByTestId("ogmios-warning")).toBeNull();
  });

  it("renders warning indicator when ogmios_status is 'disconnected'", () => {
    usePollingMock.mockReturnValue({
      data: { ok: false, sync_slot: 0, tip_slot: 0, ogmios_status: "disconnected", db_size_bytes: 0 },
      error: null,
      loading: false,
    });
    render(<SyncProgress />);
    expect(screen.getByTestId("ogmios-warning")).toBeInTheDocument();
  });
});
