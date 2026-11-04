/**
 * buyer/src/ui/components/SupplierCard.tsx — displays a single supplier advert.
 *
 * "Use" button is disabled when supplier.status === "offline".
 * A new advert (agent_id set) shows the agent's DID badge; the Dashboard
 * passes its identity summary (one /v1/identity/summaries call for all cards).
 */

import type { SupplierView } from "../../sdk/types.js";
import { AgentLink, EffectivePill, HEX64_RE, shortDid, type IdentitySummary } from "./IdentityBits.js";

export interface SupplierCardProps {
  supplier: SupplierView;
  onUse?: (supplier: SupplierView) => void;
  identity?: IdentitySummary;
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

export default function SupplierCard({ supplier, onUse, identity }: SupplierCardProps) {
  const isOffline = supplier.status === "offline";
  const agentId = typeof supplier.agent_id === "string" && HEX64_RE.test(supplier.agent_id) ? supplier.agent_id : null;
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
      {agentId && (
        <AgentLink
          id={agentId}
          className="mt-2 flex flex-wrap items-center gap-1 text-xs hover:underline"
        >
          <span className="font-mono text-blue-700" title={`did:vector:${agentId}`}>{shortDid(agentId)}</span>
          {identity && <EffectivePill effective={identity.effective} />}
          {identity?.accountable && (
            <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700" title="An accountable party is on record">
              ✓ Accountable
            </span>
          )}
          {identity?.module1 && (
            <span className="rounded bg-purple-100 px-1.5 py-0.5 font-medium text-purple-700" title="Module-1 dispute resolution is a party">
              Module-1
            </span>
          )}
        </AgentLink>
      )}
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
