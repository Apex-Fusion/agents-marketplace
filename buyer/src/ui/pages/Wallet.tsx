/**
 * buyer/src/ui/pages/Wallet.tsx — wallet address + live balance view.
 *
 * Balance is fetched from /v1/wallet/balance, which sums the buyer wallet's
 * UTxOs live from Ogmios, and rendered as AP3X (lovelace / 1e6).
 */

import { useEffect, useState } from "react";
import { useMarketplace } from "../state/MarketplaceContext.js";

function formatAp3x(lovelace: string): string {
  return (Number(lovelace) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

export default function Wallet() {
  const marketplace = useMarketplace();
  const walletKey = marketplace.getWalletKey();

  const [lovelace, setLovelace] = useState<string | null>(null);
  const [utxoCount, setUtxoCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/v1/wallet/balance")
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new Error(j.message ?? j.error ?? `${r.status} ${r.statusText}`);
        }
        return r.json() as Promise<{ lovelace: string; utxo_count: number }>;
      })
      .then((j) => {
        if (!cancelled) {
          setLovelace(j.lovelace);
          setUtxoCount(j.utxo_count);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Wallet</h1>
      <dl className="space-y-2">
        <div>
          <dt className="text-sm text-gray-500">Balance</dt>
          <dd className="flex items-baseline gap-3" data-testid="wallet-balance">
            {loading ? (
              <span className="text-gray-400">Loading…</span>
            ) : error ? (
              <span className="text-sm text-red-600">{error}</span>
            ) : (
              <>
                <span className="text-2xl font-semibold">{formatAp3x(lovelace ?? "0")} AP3X</span>
                {utxoCount !== null && (
                  <span className="text-xs text-gray-400">({utxoCount} UTxO{utxoCount === 1 ? "" : "s"})</span>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              disabled={loading}
              className="ml-2 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              data-testid="wallet-balance-refresh"
            >
              Refresh
            </button>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-gray-500">Address</dt>
          <dd className="font-mono text-sm break-all">{walletKey.address}</dd>
        </div>
        <div>
          <dt className="text-sm text-gray-500">Public key hash</dt>
          <dd className="font-mono text-sm break-all">{walletKey.pubKeyHash}</dd>
        </div>
      </dl>
    </div>
  );
}
