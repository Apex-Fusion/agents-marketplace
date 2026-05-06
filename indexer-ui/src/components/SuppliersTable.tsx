/**
 * indexer-ui/src/components/SuppliersTable.tsx — Active advertisements list.
 *
 * Sources:
 *   - usePolling(fetchSuppliers, 30_000) — periodic refresh
 *   - useSSE("") — re-fetch on chain-event so the table reflects fresh state
 *     (PostAdvert / RetireAdvert / Post/Claim/Submit/Accept/Reclaim/ReleaseEscrow)
 *
 * Columns: capability_id | model | price (AP3X) | status | last_seen
 *
 * data-testid hooks (test contract):
 *   - suppliers-table   — the <table> element
 *   - supplier-row      — each <tr> data row
 *   - status-pill       — each status badge (className includes a colour token
 *                         matching {green|blue|gray} for {free|working|offline})
 */

import { useCallback, useEffect, useState } from "react";
import { usePolling } from "../hooks/usePolling.js";
import { useSSE } from "../hooks/useSSE.js";
import { fetchSuppliers, type SupplierRow } from "../api/client.js";

const POLL_INTERVAL_MS = 30_000;

function formatPrice(lovelaceStr: string): string {
  try {
    const v = BigInt(lovelaceStr);
    const ap3x = v / 1_000_000n;
    return `${ap3x.toString()} AP3X`;
  } catch {
    return `${lovelaceStr} lovelace`;
  }
}

function statusPillClass(status: SupplierRow["status"]): string {
  switch (status) {
    case "free":
      return "inline-block rounded px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-800";
    case "working":
      return "inline-block rounded px-2 py-0.5 text-xs font-semibold bg-blue-100 text-blue-800";
    case "offline":
      return "inline-block rounded px-2 py-0.5 text-xs font-semibold bg-gray-200 text-gray-700";
    default:
      return "inline-block rounded px-2 py-0.5 text-xs font-semibold bg-gray-100 text-gray-600";
  }
}

export default function SuppliersTable() {
  const fetchFn = useCallback(() => fetchSuppliers(""), []);
  const { data: pollData, error } = usePolling<SupplierRow[]>(fetchFn, POLL_INTERVAL_MS);
  const { events, lastSeenSlot } = useSSE("");

  // Local mirror so SSE-driven refetches can update without mutating the
  // polling result. Initial value follows polling; SSE listener re-fetches.
  const [rows, setRows] = useState<SupplierRow[] | null>(null);

  useEffect(() => {
    if (pollData) setRows(pollData);
  }, [pollData]);

  // SSE-driven refresh: any chain-event triggers a re-fetch.
  useEffect(() => {
    if (events.length === 0) return;
    let cancelled = false;
    fetchSuppliers("")
      .then((next) => { if (!cancelled) setRows(next); })
      .catch(() => { /* silent — polling will retry */ });
    return () => { cancelled = true; };
  }, [events.length, lastSeenSlot]);

  const display = rows ?? pollData ?? null;

  return (
    <div className="rounded-md bg-white p-4 shadow-sm">
      {error && !display && (
        <div className="mb-2 rounded bg-red-50 p-2 text-sm text-red-800">
          Failed to load suppliers: {error.message}
        </div>
      )}
      {display && display.length === 0 && (
        <p className="text-sm text-gray-500">No suppliers yet.</p>
      )}
      <table data-testid="suppliers-table" className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-gray-600">
            <th className="py-2 pr-3">Capability</th>
            <th className="py-2 pr-3">Model</th>
            <th className="py-2 pr-3">Price</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {(display ?? []).map((row) => (
            <tr
              key={row.utxo_ref}
              data-testid="supplier-row"
              className="border-b border-gray-100"
            >
              <td className="py-2 pr-3 font-mono text-xs">{row.capability_id}</td>
              <td className="py-2 pr-3">{row.model}</td>
              <td className="py-2 pr-3">{formatPrice(row.price_lovelace)}</td>
              <td className="py-2 pr-3">
                <span data-testid="status-pill" className={statusPillClass(row.status)}>
                  {row.status}
                </span>
              </td>
              <td className="py-2 pr-3 font-mono text-xs text-gray-500">
                {row.last_seen_iso ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
