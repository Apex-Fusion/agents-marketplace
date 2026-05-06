/**
 * buyer/src/ui/pages/TaskHistory.tsx — full lifecycle history for this buyer.
 *
 * Source of truth: the indexer. We fetch every escrow row for the buyer's
 * pkh (proxied through the buyer-app's /v1/indexer/* passthrough), group by
 * `posted_at` (which is preserved across state transitions by the
 * `expect_unchanged_modulo_state` validator invariant), and render one card
 * per lifecycle.
 *
 * Why server-side / indexer-driven: the SPA previously read from a
 * LocalStorageTaskHistoryStore that was written by `marketplace.submitPrompt`.
 * After UX-2b moved submitPrompt server-side, the browser SDK no longer
 * writes anything, so localStorage was always empty. The chain itself is the
 * canonical history; rendering directly from indexer rows means a fresh
 * browser session immediately sees every prior lifecycle this buyer has
 * participated in, on any device.
 */

import { useEffect, useState, useMemo } from "react";
import { useMarketplace } from "../state/MarketplaceContext.js";

interface IndexerEscrowRow {
  utxo_ref: string;
  buyer_pkh: string;
  supplier_pkh: string;
  advert_ref: string;
  capability_id: string;
  prompt_hash: string;
  payment_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
  posted_at: number;
  submitted_at: number | null;
  result_receipt_hash: string | null;
  state: string;
  created_slot: number;
}

/** A lifecycle = all escrow rows that share posted_at (one buyer/supplier pair). */
interface Lifecycle {
  posted_at: number;
  supplier_pkh: string;
  capability_id: string;
  payment_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
  advert_ref: string;
  prompt_hash: string;
  rows: IndexerEscrowRow[]; // sorted ascending by created_slot
  currentState: string;     // = rows[rows.length-1].state
}

const STATE_PRIORITY: Record<string, number> = {
  Open: 0,
  Claimed: 1,
  Submitted: 2,
  Accepted: 3,
  Reclaimed: 3,
  Released: 3,
};

function txHashFromRef(ref: string): string {
  const hash = ref.split("#")[0] ?? "";
  return hash.length >= 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

function fmtAda(lovelace: string): string {
  try {
    const n = BigInt(lovelace);
    const ada = Number(n) / 1_000_000;
    return `${ada.toFixed(2)} AP3X`;
  } catch {
    return lovelace;
  }
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return String(ms);
  }
}

function statePill(state: string): string {
  switch (state) {
    case "Accepted":  return "bg-green-100 text-green-800";
    case "Submitted": return "bg-indigo-100 text-indigo-800";
    case "Claimed":   return "bg-blue-100 text-blue-800";
    case "Open":      return "bg-yellow-100 text-yellow-800";
    case "Reclaimed": return "bg-orange-100 text-orange-800";
    case "Released":  return "bg-red-100 text-red-800";
    default:          return "bg-gray-200 text-gray-700";
  }
}

function groupByLifecycle(rows: IndexerEscrowRow[]): Lifecycle[] {
  const buckets = new Map<string, IndexerEscrowRow[]>();
  for (const r of rows) {
    // posted_at + supplier_pkh disambiguates if a buyer happens to post two
    // escrows in the exact same ms (extremely unlikely on testnet but
    // cheap defensive grouping).
    const key = `${r.posted_at}:${r.supplier_pkh}`;
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }
  const out: Lifecycle[] = [];
  for (const [, lcRows] of buckets) {
    lcRows.sort((a, b) => a.created_slot - b.created_slot);
    const last = lcRows[lcRows.length - 1];
    // currentState is whichever row has the highest STATE_PRIORITY (handles
    // out-of-order arrivals from the indexer; we don't rely on slot order
    // alone).
    const top = lcRows.reduce((acc, r) =>
      (STATE_PRIORITY[r.state] ?? 0) > (STATE_PRIORITY[acc.state] ?? 0) ? r : acc,
    last);
    out.push({
      posted_at: last.posted_at,
      supplier_pkh: last.supplier_pkh,
      capability_id: last.capability_id,
      payment_lovelace: last.payment_lovelace,
      buyer_bond_lovelace: last.buyer_bond_lovelace,
      supplier_bond_lovelace: last.supplier_bond_lovelace,
      advert_ref: last.advert_ref,
      prompt_hash: last.prompt_hash,
      rows: lcRows,
      currentState: top.state,
    });
  }
  // Newest first.
  out.sort((a, b) => b.posted_at - a.posted_at);
  return out;
}

export default function TaskHistory() {
  const marketplace = useMarketplace();
  const buyerPkh = marketplace.getWalletKey().pubKeyHash;
  const [rows, setRows] = useState<IndexerEscrowRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    if (!buyerPkh) {
      setError("buyer pkh missing — boot script not injected");
      setRows([]);
      return;
    }
    setError(null);
    try {
      const resp = await fetch(`/v1/indexer/escrows?buyer=${buyerPkh}`);
      if (!resp.ok) {
        throw new Error(`indexer responded ${resp.status} ${resp.statusText}`);
      }
      const body = (await resp.json()) as IndexerEscrowRow[];
      setRows(Array.isArray(body) ? body : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [buyerPkh]);

  const lifecycles = useMemo<Lifecycle[]>(
    () => (rows === null ? [] : groupByLifecycle(rows)),
    [rows],
  );

  return (
    <div className="space-y-4" data-testid="task-history-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-gray-300 bg-white px-3 py-1 text-sm hover:bg-gray-50"
          data-testid="task-history-refresh"
        >
          refresh
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
          Failed to load history: {error}
        </div>
      )}

      {rows === null ? (
        <p className="text-sm text-gray-500">loading…</p>
      ) : lifecycles.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="task-history-empty">
          No on-chain lifecycles yet for this buyer. Submit a prompt from the
          Dashboard to start one.
        </p>
      ) : (
        <ul className="space-y-3">
          {lifecycles.map((lc) => (
            <li
              key={`${lc.posted_at}:${lc.supplier_pkh}`}
              data-testid="task-row"
              className="rounded-md bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                <div className="text-xs font-mono text-gray-500">
                  {fmtTime(lc.posted_at)}
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${statePill(lc.currentState)}`}
                >
                  {lc.currentState}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700 mb-2">
                <span className="font-medium">{lc.capability_id}</span>
                <span className="text-gray-500">·</span>
                <span>{fmtAda(lc.payment_lovelace)} payment</span>
                <span className="text-gray-500">·</span>
                <span>{fmtAda(lc.buyer_bond_lovelace)} bond</span>
                <span className="text-gray-500">·</span>
                <span className="font-mono text-xs text-gray-500">
                  supplier {lc.supplier_pkh.slice(0, 12)}…
                </span>
              </div>
              <div className="space-y-1 border-t border-gray-100 pt-2">
                {lc.rows.map((r) => (
                  <div
                    key={r.utxo_ref}
                    className="flex flex-wrap items-center gap-x-3 text-xs"
                  >
                    <span
                      className={`rounded px-1.5 py-0.5 font-medium ${statePill(r.state)}`}
                    >
                      {r.state}
                    </span>
                    <span className="font-mono text-gray-600">{txHashFromRef(r.utxo_ref)}</span>
                    <span className="font-mono text-gray-400">slot {r.created_slot}</span>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
