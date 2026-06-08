/**
 * buyer/src/ui/pages/Dashboard.tsx — supplier list + capability-routed task form.
 *
 * Calls marketplace.discoverSuppliers() on mount; renders a SupplierCard
 * per result. Once a supplier is selected, the form rendered below is
 * picked from `CAPABILITY_FORMS` based on the supplier's `capability_id`.
 *
 * Capabilities (current registry):
 *
 *   `llm.text.generate.v1`         → PromptForm        (chat-completion, full escrow lifecycle)
 *   `audio.synthesize.piper.v1`    → PiperTTSForm      (PiperTTS proxy via /v1/synth-speech)
 *
 * The Piper supplier is currently injected as a SYNTHETIC, client-side
 * entry — the real openedai-speech-min host on apex-simulation is not yet
 * a marketplace-registered supplier (no on-chain advert, no bond, no signed
 * receipts). Once the supplier-side adapter ships and posts a proper advert,
 * delete the `PIPER_DEMO_SUPPLIER` constant; the real entry will appear in
 * `discoverSuppliers()` automatically and the dispatch table below resolves it.
 */

import { useEffect, useState } from "react";
import { useMarketplace } from "../state/MarketplaceContext.js";
import SupplierCard from "../components/SupplierCard.js";
import PromptForm from "../components/PromptForm.js";
import PiperTTSForm from "../components/PiperTTSForm.js";
import ChatForm from "../components/ChatForm.js";
import type { SupplierView } from "../../sdk/types.js";

function parseUtxoRef(ref: string): { txHash: string; index: number } | null {
  const sepIdx = ref.indexOf("#");
  if (sepIdx < 0) return null;
  const txHash = ref.slice(0, sepIdx);
  const index = Number(ref.slice(sepIdx + 1));
  if (!Number.isFinite(index) || index < 0) return null;
  return { txHash, index };
}

// Synthetic supplier entry — see file-header. Marker `utxo_ref` starts with
// "demo:" so anything that tries to parse it as `<txhash>#<index>` cleanly
// rejects it (parseUtxoRef returns null), keeping the SDK paths honest.
const PIPER_DEMO_SUPPLIER: SupplierView = {
  utxo_ref: "demo:piper-tts",
  supplier_pkh: "",
  capability_id: "audio.synthesize.piper.v1",
  model: "PiperTTS (apex-simulation)",
  max_output_tokens: 0,
  max_processing_ms: 0,
  // price=0 reflects "no escrow yet" — the demo proxy bypasses payment.
  // Once a real on-chain advert arrives, that entry's price_lovelace
  // overrides this and the synthetic stub goes away.
  price_lovelace: "0",
  supplier_bond_lovelace: "0",
  buyer_bond_lovelace: "0",
  endpoint_url: "https://tts-piper.vector.testnet.apexfusion.org",
  detail_uri: "",
  detail_hash: "",
  advertised_at: 0,
  status: "demo",
  advert_status: "demo",
  current_escrow_ref: null,
  last_seen_iso: null,
  created_slot: 0,
};

// Synthetic free chat demo — same pattern as PIPER_DEMO_SUPPLIER. The
// "demo:kimi-chat" ref fails parseUtxoRef → advertRef null → ChatForm runs in
// demo mode (streams from OpenRouter via /v1/chat-demo/message, no escrow).
// Delete this constant once a real `llm.chat.v1` supplier with price=0 posts
// an on-chain advert; the discovered entry then wins selection.
const KIMI_DEMO_SUPPLIER: SupplierView = {
  utxo_ref: "demo:kimi-chat",
  supplier_pkh: "",
  capability_id: "llm.chat.v1",
  model: "Kimi K2.6 (demo)",
  max_output_tokens: 0,
  max_processing_ms: 0,
  price_lovelace: "0",
  supplier_bond_lovelace: "0",
  buyer_bond_lovelace: "0",
  endpoint_url: "https://openrouter.ai/api",
  detail_uri: "",
  detail_hash: "",
  advertised_at: 0,
  status: "demo",
  advert_status: "demo",
  current_escrow_ref: null,
  last_seen_iso: null,
  created_slot: 0,
};

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
        if (!cancelled) {
          // Append demo supplier so it's visually grouped with real ones.
          // If a real audio.synthesize.piper.v1 supplier appears in `list`,
          // the synthetic entry still shows but the real one wins selection
          // (cards are deduped by utxo_ref, and "demo:..." can't collide).
          setSuppliers([...list, PIPER_DEMO_SUPPLIER, KIMI_DEMO_SUPPLIER]);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          // Even when the indexer is unreachable, expose the demos so the
          // capability path is testable in isolation.
          setSuppliers([PIPER_DEMO_SUPPLIER, KIMI_DEMO_SUPPLIER]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [marketplace]);

  const advertRef = selected && parseUtxoRef(selected.utxo_ref);
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

      {selected && (
        <div className="mt-8">
          <h2 className="text-xl font-semibold mb-2">
            New task → {selected.model}
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({selected.capability_id})
            </span>
          </h2>
          {renderCapabilityForm(selected, advertRef, payment_lovelace)}
        </div>
      )}
    </div>
  );
}

/** Picks the form component that matches the selected supplier's capability.
 * Each capability owns its own props shape (PromptForm needs advertRef +
 * payment_lovelace; PiperTTSForm takes none — it bypasses escrow), so the
 * match-block is the simplest expression. As more capabilities land, add a
 * new case rather than building an abstract dispatcher; the explicit list
 * stays readable until there's a real reason to generalise. */
function renderCapabilityForm(
  supplier: SupplierView,
  advertRef: { txHash: string; index: number } | null,
  payment_lovelace: bigint,
): JSX.Element {
  switch (supplier.capability_id) {
    case "llm.text.generate.v1":
      if (!advertRef) {
        return (
          <UnsupportedCapability
            capabilityId={supplier.capability_id}
            reason="supplier has no parseable advert UTxO ref"
          />
        );
      }
      return <PromptForm advertRef={advertRef} payment_lovelace={payment_lovelace} />;

    case "audio.synthesize.piper.v1":
      // Real on-chain TTS supplier → marketplace mode (full escrow). The
      // synthetic demo supplier has utxo_ref="demo:piper-tts" which fails
      // parseUtxoRef → advertRef is null → form falls back to demo mode.
      if (advertRef) {
        return <PiperTTSForm advertRef={advertRef} payment_lovelace={payment_lovelace} />;
      }
      return <PiperTTSForm />;

    case "llm.chat.v1":
      // Real on-chain chat supplier → paid mode (escrow bookends). The
      // synthetic demo supplier has utxo_ref="demo:kimi-chat" which fails
      // parseUtxoRef → advertRef is null → ChatForm runs in free demo mode.
      if (advertRef) {
        return <ChatForm advertRef={advertRef} payment_lovelace={payment_lovelace} />;
      }
      return <ChatForm />;

    default:
      return <UnsupportedCapability capabilityId={supplier.capability_id} />;
  }
}

function UnsupportedCapability({
  capabilityId,
  reason,
}: { capabilityId: string; reason?: string }): JSX.Element {
  return (
    <div className="rounded border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900"
         data-testid="unsupported-capability">
      <strong>No form registered for capability:</strong> <code>{capabilityId}</code>
      {reason && <div className="mt-1 text-xs text-yellow-800">({reason})</div>}
    </div>
  );
}
