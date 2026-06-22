/**
 * gateway/src/routing/selectSupplier.ts — capability + model routing.
 *
 * Queries the indexer for suppliers advertising the requested model under the
 * required capability. Per the design: match by capability + model, pick an
 * AVAILABLE supplier (status free|unknown), NOT the cheapest. We return all
 * eligible candidates so the caller can fall back to the next one when the
 * chosen supplier turns out to be busy/offline at escrow-post time.
 *
 * `status==="unknown"` is treated as eligible: the indexer poller (~20s) leaves
 * freshly-advertised suppliers as "unknown" until first polled, and excluding
 * them would create artificial availability gaps.
 */

import type { OutputReference } from "@marketplace/shared/chain";

/** Subset of the indexer's SupplierView we depend on. */
interface SupplierView {
  utxo_ref: string;
  supplier_pkh: string;
  capability_id: string;
  model: string;
  max_output_tokens: number;
  price_lovelace: string;
  supplier_bond_lovelace: string;
  buyer_bond_lovelace: string;
  endpoint_url: string;
  advert_status: string;
  status: string;
}

export interface SupplierCandidate {
  advertRef: OutputReference;
  utxoRef: string;
  supplierPkh: string;
  model: string;
  capabilityId: string;
  endpointUrl: string;
  priceLovelace: bigint;
  buyerBondLovelace: bigint;
  supplierBondLovelace: bigint;
  maxOutputTokens: number;
  status: string;
}

const ESCROW_REF_RE = /^([0-9a-fA-F]{64})#(\d+)$/;

export function parseRef(ref: string): OutputReference | null {
  const m = ESCROW_REF_RE.exec(ref);
  if (!m) return null;
  return { txHash: m[1], index: Number(m[2]) };
}

export interface SelectSupplierOpts {
  indexerUrl: string;
  model: string;
  capabilityId: string;
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Return eligible candidates for (model, capability), ordered for fallback.
 * Eligible = advert Active, model matches, live status ∈ {free, unknown}.
 */
export async function selectCandidates(opts: SelectSupplierOpts): Promise<SupplierCandidate[]> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const url = `${opts.indexerUrl}/suppliers?capability_id=${encodeURIComponent(opts.capabilityId)}`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`indexer /suppliers returned ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error("indexer /suppliers did not return an array");
  }

  const candidates: SupplierCandidate[] = [];
  for (const raw of body as SupplierView[]) {
    if (raw.capability_id !== opts.capabilityId) continue;
    if (raw.model !== opts.model) continue;
    if (raw.advert_status !== "Active") continue;
    if (raw.status !== "free" && raw.status !== "unknown") continue;
    const advertRef = parseRef(raw.utxo_ref);
    if (!advertRef) continue;
    candidates.push({
      advertRef,
      utxoRef: raw.utxo_ref,
      supplierPkh: raw.supplier_pkh,
      model: raw.model,
      capabilityId: raw.capability_id,
      endpointUrl: raw.endpoint_url,
      priceLovelace: BigInt(raw.price_lovelace),
      buyerBondLovelace: BigInt(raw.buyer_bond_lovelace),
      supplierBondLovelace: BigInt(raw.supplier_bond_lovelace),
      maxOutputTokens: raw.max_output_tokens,
      status: raw.status,
    });
  }
  // Prefer known-free over unknown so we route to confirmed-available first.
  candidates.sort((a, b) => (a.status === "free" ? 0 : 1) - (b.status === "free" ? 0 : 1));
  return candidates;
}

/** Distinct models across Active suppliers (for GET /openai/v1/models). */
export async function listModels(opts: {
  indexerUrl: string;
  fetchFn?: typeof globalThis.fetch;
}): Promise<string[]> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const res = await fetchFn(`${opts.indexerUrl}/suppliers`);
  if (!res.ok) throw new Error(`indexer /suppliers returned ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("indexer /suppliers did not return an array");
  const models = new Set<string>();
  for (const raw of body as SupplierView[]) {
    if (raw.advert_status === "Active" && typeof raw.model === "string") models.add(raw.model);
  }
  return [...models].sort();
}
