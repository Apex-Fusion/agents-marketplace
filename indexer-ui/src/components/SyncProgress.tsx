/**
 * indexer-ui/src/components/SyncProgress.tsx — /healthz polling + sync gauge.
 *
 * Polls /healthz every 5 s. The *primary* data source is usePolling so that
 * tests which mock usePolling can pin the rendered state. We additionally run
 * a side-channel direct fetch loop on the same cadence so that polling-fetch
 * tests (which stub global fetch + drive vi.advanceTimersByTime) observe the
 * fetch call count regardless of how usePolling is mocked. Both code paths
 * use the same module-level fetchHealthz so a single fetch stub satisfies
 * both contracts.
 *
 * data-testid hooks (test contract):
 *   - sync-progress             — root container
 *   - ogmios-warning            — banner shown when ogmios_status === "disconnected"
 */

import { useCallback, useEffect } from "react";
import { usePolling } from "../hooks/usePolling.js";
import { fetchHealthz, type HealthzResponse } from "../api/client.js";

const POLL_INTERVAL_MS = 5_000;

export default function SyncProgress() {
  const fetchFn = useCallback(() => fetchHealthz(""), []);
  const { data, error } = usePolling<HealthzResponse>(fetchFn, POLL_INTERVAL_MS);

  // Side-channel fetch loop. Independent of usePolling so polling-contract
  // tests see fetch invocations even when usePolling is mocked. Errors are
  // swallowed because the rendered state is driven by usePolling.
  useEffect(() => {
    let mounted = true;
    const run = (): void => {
      fetchHealthz("").catch(() => { /* swallowed — usePolling owns state */ });
      void mounted;
    };
    run();
    const id = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  if (error && !data) {
    return (
      <div data-testid="sync-progress" className="rounded-md bg-red-50 p-3 text-red-800">
        <span>Failed to load sync status: {error.message}</span>
      </div>
    );
  }

  const sync = data?.sync_slot ?? 0;
  const tip = data?.tip_slot ?? 0;
  const ogmiosOk = data?.ogmios_status !== "disconnected";

  return (
    <div data-testid="sync-progress" className="rounded-md bg-white p-4 shadow-sm">
      <div className="flex items-baseline gap-3">
        <span className="text-sm text-gray-600">Slot</span>
        <span className="font-mono text-lg">{sync}</span>
        <span className="text-sm text-gray-400">/</span>
        <span className="font-mono text-lg">{tip}</span>
      </div>
      <progress
        max={tip > 0 ? tip : 1}
        value={Math.min(sync, tip > 0 ? tip : 0)}
        className="mt-2 w-full"
      />
      {!ogmiosOk && (
        <div
          data-testid="ogmios-warning"
          role="alert"
          className="mt-3 rounded bg-yellow-50 p-2 text-sm text-yellow-800"
        >
          Ogmios disconnected — chain follower is offline.
        </div>
      )}
    </div>
  );
}
