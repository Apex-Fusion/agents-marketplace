/**
 * buyer/src/pdf/supplier-pool.ts — discover + filter + round-robin the
 * capable suppliers a summarization job pays.
 *
 * "Capable" = a llm.text.generate.v1 supplier whose model passes the
 * allow/deny filter (e.g. exclude the weak local qwen2.5:0.5b). The pool
 * round-robins across them so traffic is spread over multiple agents and a
 * retry always lands on a *different* supplier than the one that just failed.
 */

import type { Marketplace } from "../sdk/Marketplace.js";
import type { SupplierView } from "../sdk/types.js";
import type { PdfCaps, PoolSupplier } from "./types.js";

export const SUMMARIZE_CAPABILITY_ID = "llm.text.generate.v1";

const REF_RE = /^([0-9a-f]{64})#(\d+)$/;

function parseRef(ref: string): { txHash: string; index: number } | null {
  const m = REF_RE.exec(ref);
  return m ? { txHash: m[1], index: Number(m[2]) } : null;
}

/** Is `model` capable given the allow/deny substring lists? Deny wins. */
export function isCapableModel(
  model: string,
  allow: string[],
  deny: string[],
): boolean {
  const m = model.toLowerCase();
  if (deny.some((d) => d.length > 0 && m.includes(d.toLowerCase()))) return false;
  if (allow.length === 0) return true;
  return allow.some((a) => a.length > 0 && m.includes(a.toLowerCase()));
}

/** Filter raw indexer views down to capable, payable suppliers. */
export function filterSuppliers(
  views: SupplierView[],
  caps: PdfCaps,
): PoolSupplier[] {
  const out: PoolSupplier[] = [];
  const seen = new Set<string>();
  for (const v of views) {
    if (v.capability_id !== SUMMARIZE_CAPABILITY_ID) continue;
    if (!isCapableModel(v.model, caps.modelAllowlist, caps.modelDenylist)) continue;
    if (seen.has(v.utxo_ref)) continue;
    const ref = parseRef(v.utxo_ref);
    if (!ref) continue; // demo/synthetic entries have non-parseable refs
    let price: bigint;
    try {
      price = BigInt(v.price_lovelace);
    } catch {
      continue;
    }
    seen.add(v.utxo_ref);
    out.push({
      advertRef: ref,
      utxoRef: v.utxo_ref,
      supplierPkh: v.supplier_pkh,
      model: v.model,
      priceLovelace: price,
      maxOutputTokens: v.max_output_tokens,
      endpointUrl: v.endpoint_url,
    });
  }
  return out;
}

export class SupplierPool {
  private readonly suppliers: PoolSupplier[];
  private cursor = 0;

  constructor(suppliers: PoolSupplier[]) {
    this.suppliers = suppliers;
  }

  get size(): number {
    return this.suppliers.length;
  }

  all(): PoolSupplier[] {
    return this.suppliers.slice();
  }

  /** Upper bound for cost estimates: the priciest supplier in the pool. */
  maxPrice(): bigint {
    return this.suppliers.reduce(
      (max, s) => (s.priceLovelace > max ? s.priceLovelace : max),
      0n,
    );
  }

  /**
   * Round-robin the next supplier, skipping any whose utxoRef is in `exclude`.
   * Returns null only when every supplier is excluded (caller treats as
   * "out of suppliers" → gap).
   */
  next(exclude?: Set<string>): PoolSupplier | null {
    const n = this.suppliers.length;
    if (n === 0) return null;
    for (let i = 0; i < n; i++) {
      const s = this.suppliers[(this.cursor + i) % n];
      if (!exclude || !exclude.has(s.utxoRef)) {
        this.cursor = (this.cursor + i + 1) % n;
        return s;
      }
    }
    return null;
  }
}

export async function buildSupplierPool(
  marketplace: Marketplace,
  caps: PdfCaps,
): Promise<SupplierPool> {
  const views = await marketplace.discoverSuppliers({
    capability_id: SUMMARIZE_CAPABILITY_ID,
  });
  return new SupplierPool(filterSuppliers(views, caps));
}
