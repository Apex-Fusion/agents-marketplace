/**
 * indexer/src/routes/suppliers.ts — GET /suppliers, GET /suppliers/:pkh
 *
 * GET /suppliers — list the listed advertisements (SqliteCache.listActiveAdvertisements:
 *   listing rule, switch slot, value cap) joined with latest supplier_status.
 * GET /suppliers/:pkh — single supplier detail; 404 if no listed advert for pkh.
 *
 * `agent_id` (Part 2 §6.4): 64 lowercase hex for a new advert, null for a legacy advert.
 */

import { Router, type Request, type Response } from "express";
import type { SqliteCache, AdvertRow, SupplierStatusRow } from "../db/cache.js";

export interface SuppliersDeps {
  cache: SqliteCache;
}

interface SupplierView {
  utxo_ref: string;
  supplier_pkh: string;
  capability_id: string;
  model: string;
  max_output_tokens: number;
  max_processing_ms: number;
  price_lovelace: string;
  supplier_bond_lovelace: string;
  buyer_bond_lovelace: string;
  endpoint_url: string;
  detail_uri: string;
  detail_hash: string;
  advertised_at: number;
  status: string;                     // status from supplier_status (free|working|offline) or "unknown"
  advert_status: string;              // Active|Retired
  current_escrow_ref: string | null;
  last_seen_iso: string | null;
  created_slot: number;
  agent_id: string | null;
}

export function shapeSupplier(advert: AdvertRow, status: SupplierStatusRow | null): SupplierView {
  return {
    utxo_ref: advert.utxo_ref,
    supplier_pkh: advert.supplier_pkh,
    capability_id: advert.capability_id,
    model: advert.model,
    max_output_tokens: advert.max_output_tokens,
    max_processing_ms: advert.max_processing_ms,
    price_lovelace: advert.price_lovelace,
    supplier_bond_lovelace: advert.supplier_bond_lovelace,
    buyer_bond_lovelace: advert.buyer_bond_lovelace,
    endpoint_url: advert.endpoint_url,
    detail_uri: advert.detail_uri,
    detail_hash: advert.detail_hash,
    advertised_at: advert.advertised_at,
    status: status?.status ?? "unknown",
    advert_status: advert.status,
    current_escrow_ref: status?.current_escrow_ref ?? null,
    last_seen_iso: status?.last_seen_iso ?? null,
    created_slot: advert.created_slot,
    agent_id: advert.layout === "identity" && advert.agent_id ? advert.agent_id.toLowerCase() : null,
  };
}

export function suppliersRouter(deps: SuppliersDeps): Router {
  const router = Router();

  router.get("/suppliers", (_req: Request, res: Response) => {
    const adverts = deps.cache.listActiveAdvertisements();
    const out = adverts.map((a) => {
      const status = deps.cache.getSupplierStatus(a.supplier_pkh);
      return shapeSupplier(a, status);
    });
    res.status(200).json(out);
  });

  router.get("/suppliers/:pkh", (req: Request, res: Response) => {
    const pkh = String(req.params.pkh);
    const adverts = deps.cache.listActiveAdvertisements({ supplier_pkh: pkh });
    if (adverts.length === 0) {
      res.status(404).json({ error: "supplier not found" });
      return;
    }
    const advert = adverts[0];
    const status = deps.cache.getSupplierStatus(pkh);
    res.status(200).json(shapeSupplier(advert, status));
  });

  return router;
}
