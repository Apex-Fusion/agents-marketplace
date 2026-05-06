/**
 * indexer-ui/src/components/CapabilitiesPanel.tsx — capability counts.
 *
 * Polls /capabilities every 30 s via usePolling. Renders one card per entry.
 *
 * data-testid hooks (test contract):
 *   - capability-card   — one card per CapabilityCount entry
 */

import { useCallback } from "react";
import { usePolling } from "../hooks/usePolling.js";
import { fetchCapabilities, type CapabilityCount } from "../api/client.js";

const POLL_INTERVAL_MS = 30_000;

export default function CapabilitiesPanel() {
  const fetchFn = useCallback(() => fetchCapabilities(""), []);
  const { data, error } = usePolling<CapabilityCount[]>(fetchFn, POLL_INTERVAL_MS);

  const caps = data ?? [];

  return (
    <div className="rounded-md bg-white p-4 shadow-sm">
      {error && !data && (
        <div className="mb-2 rounded bg-red-50 p-2 text-sm text-red-800">
          Failed to load capabilities: {error.message}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {caps.map((cap) => (
          <div
            key={cap.capability_id}
            data-testid="capability-card"
            className="rounded border border-gray-200 p-3"
          >
            <div className="font-mono text-xs text-gray-700">{cap.capability_id}</div>
            <div className="mt-1 text-sm text-gray-600">
              <span className="font-semibold text-gray-900">{cap.supplier_count}</span>
              <span className="ml-1">supplier{cap.supplier_count === 1 ? "" : "s"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
