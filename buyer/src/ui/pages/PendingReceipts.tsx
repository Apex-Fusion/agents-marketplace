/**
 * buyer/src/ui/pages/PendingReceipts.tsx — list of currently-Submitted escrows
 * for this buyer, with an "Accept & Pay" action per row.
 *
 * Data flow:
 *   GET /v1/pending-receipts → buyer-app server proxies indexer /escrows?buyer=<pkh>
 *                              and filters to state="Submitted".
 *   POST /v1/accept           → buyer-app server resolves the current Submitted
 *                              UTxO (in case the user hands us an older lifecycle
 *                              ref), calls runAccept against LiveOgmiosProvider,
 *                              returns the Accept tx hash.
 *
 * The browser never sees the buyer's private key — all signing happens
 * server-side. The accept-window timer comes from datum.submitted_at +
 * 600_000 ms (the validator's ACCEPT_WINDOW_MS); we surface a countdown so
 * operators know when a receipt is about to expire.
 */

import { useCallback, useEffect, useState } from "react";

interface IndexerEscrowRow {
  utxo_ref: string;
  buyer_pkh: string;
  supplier_pkh: string;
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

interface AcceptResult {
  tx_hash: string;
  accepted_ref: string;
}

interface ApiError {
  error: string;
  message?: string;
}

const ACCEPT_WINDOW_MS = 600_000;

function fmtLovelace(s: string): string {
  try {
    const n = BigInt(s);
    const ada = Number(n) / 1_000_000;
    return `${ada.toFixed(2)} AP3X`;
  } catch {
    return s;
  }
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "expired";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export default function PendingReceipts() {
  const [rows, setRows] = useState<IndexerEscrowRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [acceptingRef, setAcceptingRef] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AcceptResult | string>>({});

  const loadPending = useCallback(async (): Promise<void> => {
    setLoadErr(null);
    try {
      const resp = await fetch("/v1/pending-receipts");
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as ApiError;
        throw new Error(`${body.error ?? resp.statusText}: ${body.message ?? ""}`);
      }
      const body = (await resp.json()) as { escrows: IndexerEscrowRow[] };
      setRows(body.escrows ?? []);
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : String(err));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  // Tick every second so the countdown updates live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const onAccept = async (ref: string): Promise<void> => {
    setAcceptingRef(ref);
    setResults((prev) => ({ ...prev, [ref]: "submitting" }));
    try {
      const resp = await fetch("/v1/accept", {
        method: "POST",
        // `Accept: application/json` discourages CF from substituting an
        // HTML 5xx page for browser requests. We still tolerate non-JSON
        // bodies below (CF can ignore the hint).
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ escrow_ref: ref }),
      });
      // Read body once as text so we can show *something* even when the
      // response is HTML (CF edge errors) — JSON.parse on HTML throws
      // "Unexpected token '<'", which is the bug we're papering over.
      const text = await resp.text();
      let body: AcceptResult | ApiError | null = null;
      try {
        body = JSON.parse(text) as AcceptResult | ApiError;
      } catch {
        body = null;
      }
      if (!resp.ok) {
        const apiErr = (body && typeof body === "object" ? body : {}) as ApiError;
        const reason = apiErr.error
          ?? `http_${resp.status}`;
        const detail = apiErr.message
          ?? text.slice(0, 120).replace(/<[^>]+>/g, " ").trim()
          ?? `${resp.status} ${resp.statusText}`;
        setResults((prev) => ({
          ...prev,
          [ref]: `error: ${reason}${detail ? " — " + detail : ""}`,
        }));
        // For "already_accepted" specifically, the row is stale — refresh
        // the list so the user sees it disappear.
        if (apiErr.error === "already_accepted") {
          await loadPending();
        }
        return;
      }
      if (!body) {
        setResults((prev) => ({
          ...prev,
          [ref]: `error: malformed_response — server returned non-JSON`,
        }));
        return;
      }
      setResults((prev) => ({ ...prev, [ref]: body as AcceptResult }));
      await loadPending();
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [ref]: `error: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setAcceptingRef(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="pending-receipts-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Pending Receipts</h1>
        <button
          type="button"
          onClick={loadPending}
          className="rounded border border-gray-300 bg-white px-3 py-1 text-sm hover:bg-gray-50"
          data-testid="pending-refresh"
        >
          refresh
        </button>
      </div>

      {loadErr ? (
        <p className="text-sm text-red-700" role="alert">
          Failed to load pending receipts: {loadErr}
        </p>
      ) : null}

      {rows === null ? (
        <p className="text-sm text-gray-500">loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="pending-empty">
          No pending receipts. When the supplier submits a result on chain,
          it'll appear here with an Accept button.
        </p>
      ) : (
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="px-2 py-2">Submitted</th>
              <th className="px-2 py-2">Supplier</th>
              <th className="px-2 py-2">Capability</th>
              <th className="px-2 py-2">Payment</th>
              <th className="px-2 py-2">Window left</th>
              <th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const submittedAt = r.submitted_at ?? 0;
              const windowMsLeft = submittedAt + ACCEPT_WINDOW_MS - now;
              const expired = windowMsLeft <= 0;
              const result = results[r.utxo_ref];
              const isAccepting = acceptingRef === r.utxo_ref;
              return (
                <tr
                  key={r.utxo_ref}
                  data-testid="pending-row"
                  className="border-b border-gray-100 align-top"
                >
                  <td className="px-2 py-2 font-mono text-xs">
                    {submittedAt > 0 ? new Date(submittedAt).toISOString() : "—"}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs break-all">
                    {r.supplier_pkh.slice(0, 16)}…
                  </td>
                  <td className="px-2 py-2 text-xs">{r.capability_id}</td>
                  <td className="px-2 py-2 text-xs">
                    {fmtLovelace(r.payment_lovelace)}
                  </td>
                  <td className="px-2 py-2">
                    <span
                      className={
                        "rounded px-2 py-0.5 font-mono text-xs " +
                        (expired
                          ? "bg-red-100 text-red-700"
                          : windowMsLeft < 120_000
                            ? "bg-yellow-100 text-yellow-800"
                            : "bg-green-100 text-green-700")
                      }
                    >
                      {fmtCountdown(windowMsLeft)}
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    {typeof result === "object" ? (
                      <span className="font-mono text-xs text-green-700" data-testid="pending-accepted">
                        accepted ✓ {result.tx_hash.slice(0, 12)}…
                      </span>
                    ) : typeof result === "string" && result.startsWith("error") ? (
                      <span className="text-xs text-red-700">{result}</span>
                    ) : (
                      <button
                        type="button"
                        disabled={expired || isAccepting}
                        onClick={() => void onAccept(r.utxo_ref)}
                        data-testid="accept-button"
                        className={
                          "rounded px-3 py-1 text-sm font-medium " +
                          (expired
                            ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                            : isAccepting
                              ? "bg-indigo-300 text-white cursor-wait"
                              : "bg-indigo-600 text-white hover:bg-indigo-700")
                        }
                      >
                        {isAccepting ? "accepting…" : expired ? "expired" : "Accept & Pay"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
