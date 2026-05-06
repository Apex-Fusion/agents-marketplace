/**
 * buyer/src/ui/components/SupplierCard.tsx — displays a single supplier advert.
 *
 * "Use" button is disabled when supplier.status === "offline".
 */

import type { SupplierView } from "../../sdk/types.js";

export interface SupplierCardProps {
  supplier: SupplierView;
  onUse?: (supplier: SupplierView) => void;
}

function formatLovelace(lovelace: string): string {
  // Tiny helper — no Intl precision required at this stage.
  try {
    const n = BigInt(lovelace);
    const integer = Number(n / 1_000_000n);
    const fraction = Number(n % 1_000_000n);
    return `${integer}.${String(fraction).padStart(6, "0")} AP3X`;
  } catch {
    return `${lovelace} lovelace`;
  }
}

function statusColour(status: string): string {
  if (status === "free") return "bg-green-100 text-green-700";
  if (status === "working") return "bg-amber-100 text-amber-700";
  return "bg-gray-200 text-gray-600";
}

export default function SupplierCard({ supplier, onUse }: SupplierCardProps) {
  const isOffline = supplier.status === "offline";
  return (
    <div
      data-testid="supplier-card"
      className="rounded border border-gray-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="font-mono text-sm font-medium">{supplier.model}</h3>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${statusColour(supplier.status)}`}
        >
          {supplier.status}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-600">{supplier.capability_id}</p>
      <p className="mt-2 text-sm">
        <span className="text-gray-500">price:</span>{" "}
        <span className="font-mono">{formatLovelace(supplier.price_lovelace)}</span>
      </p>
      <p className="text-xs text-gray-400 mt-1 break-all">{supplier.endpoint_url}</p>
      <button
        type="button"
        className="mt-3 w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:bg-gray-300 disabled:text-gray-500"
        disabled={isOffline}
        onClick={() => {
          if (onUse) onUse(supplier);
        }}
      >
        Use
      </button>
    </div>
  );
}
