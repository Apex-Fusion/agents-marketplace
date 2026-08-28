import { useCallback, useEffect, useState } from "react";

interface VectorProof {
  status: "pending" | "confirmed" | "failed";
  saleHash: string | null;
  batchRoot: string | null;
  txHash: string | null;
  leafIndex: number | null;
  siblings: string[];
}

const PENDING_PROOF: VectorProof = {
  status: "pending",
  saleHash: null,
  batchRoot: null,
  txHash: null,
  leafIndex: null,
  siblings: [],
};

interface DashboardSnapshot {
  generatedAt: string;
  controller: {
    ok: boolean;
    phase: string;
    lastError: string | null;
  };
  identity: {
    sellerWallet: string;
    payoutAddress: string;
  };
  provider: {
    hardLimitUsd: string;
    remainingUsd: string;
    usedUsd: string;
    reserveUsd: string;
    estimatedDailyExposureUsd: string;
  };
  surplus: {
    offer: {
      id: string | null;
      model: string | null;
      providerModel: string | null;
      status: string;
      dailyCapUsd: string | null;
      costMultiplier: number | null;
      inputUsdPer1m: string | null;
      outputUsdPer1m: string | null;
      rank: number | null;
      available: boolean;
      healthy: boolean;
      trusted: boolean;
      trades24h: number;
      volume24hUsd: string;
      capRemainingUsd: string | null;
    };
    earnings: {
      totalUsd: string;
      pendingUsd: string;
      paidUsd: string;
      requests: number;
      tokens: number;
      today: {
        earnedUsd: number;
        requests: number;
        totalTokens: number;
      } | null;
      topModel: string | null;
      payoutHoldReason: string | null;
      payoutHoldReleasesAt: string | null;
    };
    recentSales: Array<{
      id: string;
      model: string;
      createdAt: string | null;
      settlementStatus: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      revenueUsd: string;
      vectorProof: VectorProof;
    }>;
  };

}

function usd(value: string | number | null): string {
  if (value === null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `$${number.toFixed(number < 0.01 ? 6 : 4)}`;
}

function count(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function timestamp(value: string | null): string {
  if (value === null) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function compact(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 12)}…${value.slice(-9)}`;
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        active ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"
      }`}
    >
      {label}
    </span>
  );
}

function VectorProofState({ proof }: { proof: VectorProof }) {
  const pillClass = proof.status === "confirmed"
    ? "bg-green-100 text-green-700"
    : proof.status === "pending"
      ? "bg-amber-100 text-amber-700"
      : "bg-red-100 text-red-700";
  const pill = (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${pillClass}`}>
      {proof.status}
    </span>
  );

  if (proof.status !== "confirmed" || proof.txHash === null) return pill;

  return (
    <a
      className="inline-flex items-center gap-2 rounded text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2"
      href={`https://vector.apexscan.org/en/transaction/${proof.txHash}/summary/`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Confirmed Vector proof transaction ${proof.txHash}`}
    >
      {pill}
      <span className="font-mono text-xs">{compact(proof.txHash)}</span>
    </a>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight text-gray-900">{value}</p>
      <p className="mt-0.5 text-xs text-gray-500">{detail}</p>
    </div>
  );
}

function FlowNode({ label, title, detail, mono }: {
  label: string;
  title: string;
  detail: string;
  mono?: string | null;
}) {
  return (
    <div className="min-w-0 flex-1 rounded border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 font-semibold text-gray-900">{title}</p>
      <p className="mt-1 text-sm text-gray-600">{detail}</p>
      {mono && <p className="mt-2 truncate font-mono text-xs text-gray-400">{mono}</p>}
    </div>
  );
}

export default function ResaleDashboard() {
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/v1/resale-dashboard", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as DashboardSnapshot | {
        message?: string;
      } | null;
      if (!response.ok) {
        throw new Error(
          body && "message" in body && typeof body.message === "string"
            ? body.message
            : `dashboard request failed (${response.status})`,
        );
      }
      setData(body as DashboardSnapshot);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "dashboard data is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (loading && data === null) {
    return <p className="text-sm text-gray-500">Loading capacity markets…</p>;
  }

  if (data === null) {
    return (
      <div className="max-w-3xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error ?? "Dashboard data is unavailable."}
      </div>
    );
  }

  const offer = data.surplus.offer;
  const earnings = data.surplus.earnings;
  const offerLive = offer.status === "active" && offer.available && offer.healthy;
  const proofCounts = { confirmed: 0, pending: 0, failed: 0 };
  for (const sale of data.surplus.recentSales) {
    proofCounts[(sale.vectorProof ?? PENDING_PROOF).status] += 1;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6" data-testid="resale-dashboard">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Capacity Markets</h1>
          <p className="max-w-3xl text-sm text-gray-600">
            Surplus turns available OpenRouter capacity into Base USDC sales. Vector anchors
            Merkle-batched proofs so every sale has a verifiable transaction record.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill label={data.controller.phase} active={data.controller.ok} />
          <button
            type="button"
            onClick={() => { void refresh(); }}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Last refresh failed: {error}. Showing the last good snapshot.
        </div>
      )}
      {data.controller.lastError && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Controller: {data.controller.lastError}
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Capacity and proof route</h2>
            <p className="text-sm text-gray-500">
              Capacity sells through Surplus, and each sale joins a shared Vector anchor.
            </p>
          </div>
          <span className="text-xs text-gray-400">Updated {timestamp(data.generatedAt)}</span>
        </div>
        <div className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center">
          <FlowNode
            label="Upstream"
            title="OpenRouter"
            detail={`${usd(data.provider.remainingUsd)} of ${usd(data.provider.hardLimitUsd)} remaining`}
            mono={offer.providerModel}
          />
          <span className="self-center text-lg text-gray-400">→</span>
          <FlowNode
            label="Manager"
            title="Seller agent"
            detail="Discovers, prices, caps, and reconciles offers"
            mono={data.identity.sellerWallet}
          />
          <span className="self-center text-lg text-gray-400">→</span>
          <FlowNode
            label="Live market"
            title="Surplus / Base USDC"
            detail={`${offerLive ? "Available" : "Unavailable"} · ${offer.trusted ? "trusted" : "untrusted"}`}
            mono={offer.id}
          />
          <span className="self-center text-lg text-gray-400">→</span>
          <FlowNode
            label="Proof layer"
            title="Vector anchors"
            detail="Commits each sale through a shared Merkle-batch transaction"
          />
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Current market</p>
            <h2 className="mt-1 text-lg font-semibold">Surplus Intelligence</h2>
            <p className="mt-1 text-sm text-gray-600">Discounted inference with USDC settlement on Base.</p>
          </div>
          <StatusPill label={offer.status} active={offerLive} />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Lifetime revenue" value={usd(earnings.totalUsd)} detail={`${usd(earnings.pendingUsd)} pending`} />
          <Metric label="Requests sold" value={count(earnings.requests)} detail={`${count(earnings.tokens)} tokens`} />
          <Metric label="Market rank" value={offer.rank === null ? "—" : `#${offer.rank}`} detail={`${offer.trades24h} trades / 24h`} />
          <Metric label="Daily seller cap" value={usd(offer.dailyCapUsd)} detail={`${usd(offer.capRemainingUsd)} remaining`} />
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-2 border-t border-gray-100 pt-4 text-sm sm:grid-cols-2">
          <div><dt className="text-gray-500">Marketplace model</dt><dd className="font-mono text-xs text-gray-900">{offer.model ?? "—"}</dd></div>
          <div><dt className="text-gray-500">Provider model</dt><dd className="font-mono text-xs text-gray-900">{offer.providerModel ?? "—"}</dd></div>
          <div><dt className="text-gray-500">Input / 1M</dt><dd>{usd(offer.inputUsdPer1m)}</dd></div>
          <div><dt className="text-gray-500">Output / 1M</dt><dd>{usd(offer.outputUsdPer1m)}</dd></div>
        </dl>
        {earnings.payoutHoldReason && (
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Payout hold: {earnings.payoutHoldReason}
            {earnings.payoutHoldReleasesAt && ` · releases ${timestamp(earnings.payoutHoldReleasesAt)}`}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Economics</p>
          <h2 className="mt-1 text-lg font-semibold">Capacity and price controls</h2>
          <p className="mt-1 text-sm text-gray-600">
            The seller cap is discounted revenue. The agent converts it to estimated upstream exposure before opening the route.
          </p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="OpenRouter remaining" value={usd(data.provider.remainingUsd)} detail={`${usd(data.provider.usedUsd)} used`} />
          <Metric label="Protected reserve" value={usd(data.provider.reserveUsd)} detail="fail-closed threshold" />
          <Metric label="Daily upstream estimate" value={usd(data.provider.estimatedDailyExposureUsd)} detail="from recovery floor" />
          <Metric label="Current multiplier" value={offer.costMultiplier === null ? "—" : `${(offer.costMultiplier * 100).toFixed(3)}%`} detail={`${usd(offer.inputUsdPer1m)} in · ${usd(offer.outputUsdPer1m)} out`} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Surplus activity</p>
            <h2 className="mt-1 text-lg font-semibold">Recent sales</h2>
          </div>
          <p className="text-sm text-gray-500">{count(earnings.requests)} lifetime requests · {count(earnings.tokens)} tokens</p>
        </div>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Vector proof summary"
        >
          <span className="rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
            Confirmed {count(proofCounts.confirmed)}
          </span>
          <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700">
            Pending {count(proofCounts.pending)}
          </span>
          <span className="rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700">
            Failed {count(proofCounts.failed)}
          </span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <caption className="sr-only">Recent Surplus sales with Vector proof status</caption>
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3 text-right">Input</th>
                <th className="px-4 py-3 text-right">Output</th>
                <th className="px-4 py-3 text-right">Cache read</th>
                <th className="px-4 py-3 text-right">Revenue</th>
                <th className="px-4 py-3">Vector proof</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.surplus.recentSales.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">No sales returned.</td></tr>
              ) : data.surplus.recentSales.map((sale) => (
                <tr key={sale.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-gray-600">{timestamp(sale.createdAt)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                      sale.settlementStatus === "confirmed"
                        ? "bg-green-100 text-green-700"
                        : "bg-amber-100 text-amber-700"
                    }`}>
                      {sale.settlementStatus}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{sale.model}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{count(sale.inputTokens)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{count(sale.outputTokens)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{count(sale.cacheReadTokens)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{usd(sale.revenueUsd)}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <VectorProofState proof={sale.vectorProof ?? PENDING_PROOF} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-gray-400">
        Surplus seller {compact(data.identity.sellerWallet)} · payout {compact(data.identity.payoutAddress)}
      </p>
    </div>
  );
}
