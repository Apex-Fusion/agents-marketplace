/**
 * buyer/src/ui/components/JobEstimate.tsx — step 2: show the pre-spend cost
 * estimate and require an explicit "Proceed" before any escrow is posted.
 *
 * GET /v1/pdf-jobs/:id/estimate returns the map+reduce call count, an
 * upper-bound AP3X cost, the wallet balance, and whether the spend would drop
 * the wallet below its floor (in which case Proceed is disabled).
 */

import { useEffect, useState } from "react";
import type { UploadInfo } from "./PdfUploadForm.js";

interface EstimateData {
  mapCalls: number;
  reduceCalls: number;
  totalCalls: number;
  perCallMaxLovelace: string;
  totalLovelace: string;
  totalAp3x: string;
  suppliers: { model: string; price_lovelace: string }[];
  wallet_balance_lovelace: string;
  wallet_floor_lovelace: string;
  would_drop_below_floor: boolean;
  no_capable_suppliers: boolean;
}

function ap3x(lovelace: string): string {
  return (Number(lovelace) / 1e6).toFixed(2);
}

export default function JobEstimate({
  info,
  onStarted,
}: {
  info: UploadInfo;
  onStarted: () => void;
}) {
  const [est, setEst] = useState<EstimateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/v1/pdf-jobs/${info.job_id}/estimate`, { credentials: "same-origin" })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(`${body.error}: ${body.message ?? ""}`);
        if (!cancelled) setEst(body as EstimateData);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [info.job_id]);

  const proceed = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      const r = await fetch(`/v1/pdf-jobs/${info.job_id}/start`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(`${body.error}: ${body.message ?? ""}`);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  if (error) {
    return (
      <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (!est) return <div className="text-sm text-gray-500">Estimating cost…</div>;

  const blocked = est.would_drop_below_floor || est.no_capable_suppliers || est.totalCalls === 0;

  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-200 bg-white p-4 text-sm">
        <h3 className="mb-2 font-medium">{info.filename}</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-gray-700">
          <dt>Pages</dt>
          <dd className="text-right">{info.page_count}</dd>
          <dt>Chunks (map calls)</dt>
          <dd className="text-right">{est.mapCalls}</dd>
          <dt>Reduce calls</dt>
          <dd className="text-right">{est.reduceCalls}</dd>
          <dt className="font-medium">Total paid calls</dt>
          <dd className="text-right font-medium">{est.totalCalls}</dd>
          <dt className="font-medium">Est. max cost</dt>
          <dd className="text-right font-medium">{est.totalAp3x} AP3X</dd>
          <dt>Wallet balance</dt>
          <dd className="text-right">{ap3x(est.wallet_balance_lovelace)} AP3X</dd>
          <dt>Wallet floor</dt>
          <dd className="text-right">{ap3x(est.wallet_floor_lovelace)} AP3X</dd>
        </dl>
        <p className="mt-3 text-xs text-gray-500">
          Suppliers: {est.suppliers.map((s) => `${s.model} (${ap3x(s.price_lovelace)})`).join(", ") || "none"}
        </p>
      </div>

      {est.no_capable_suppliers && (
        <div className="rounded border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
          No capable suppliers are available right now — try again shortly.
        </div>
      )}
      {est.would_drop_below_floor && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          This job would drop the wallet below its floor. Fund the wallet or
          reduce the book size before proceeding.
        </div>
      )}

      <button
        type="button"
        onClick={() => void proceed()}
        disabled={blocked || starting}
        className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-gray-400"
      >
        {starting ? "Starting…" : `Proceed & pay (~${est.totalAp3x} AP3X)`}
      </button>
    </div>
  );
}
