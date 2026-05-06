/**
 * buyer/src/ui/pages/Dashboard.tsx — supplier list + new task form.
 *
 * Calls marketplace.discoverSuppliers() on mount; renders a SupplierCard
 * per result. PromptForm requires a selected supplier; until a supplier
 * is chosen it is not rendered.
 */

import { useEffect, useState } from "react";
import { useMarketplace } from "../state/MarketplaceContext.js";
import SupplierCard from "../components/SupplierCard.js";
import PromptForm from "../components/PromptForm.js";
import type { SupplierView } from "../../sdk/types.js";

function parseUtxoRef(ref: string): { txHash: string; index: number } | null {
  const sepIdx = ref.indexOf("#");
  if (sepIdx < 0) return null;
  const txHash = ref.slice(0, sepIdx);
  const index = Number(ref.slice(sepIdx + 1));
  if (!Number.isFinite(index) || index < 0) return null;
  return { txHash, index };
}

export default function Dashboard() {
  const marketplace = useMarketplace();
  const [suppliers, setSuppliers] = useState<SupplierView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SupplierView | null>(null);

  useEffect(() => {
    let cancelled = false;
    marketplace
      .discoverSuppliers()
      .then((list) => {
        if (!cancelled) setSuppliers(list);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [marketplace]);

  const advertRef =
    selected && parseUtxoRef(selected.utxo_ref);
  const payment_lovelace = selected ? BigInt(selected.price_lovelace) : 0n;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Suppliers</h1>
      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {suppliers.map((s) => (
          <SupplierCard
            key={s.utxo_ref}
            supplier={s}
            onUse={(sup) => setSelected(sup)}
          />
        ))}
      </div>

      {selected && advertRef && (
        <div className="mt-8">
          <h2 className="text-xl font-semibold mb-2">
            New prompt → {selected.model}
          </h2>
          <PromptForm advertRef={advertRef} payment_lovelace={payment_lovelace} />
        </div>
      )}
    </div>
  );
}
