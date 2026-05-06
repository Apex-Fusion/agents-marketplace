/**
 * indexer/src/routes/capabilities.ts
 *
 * GET /capabilities — distinct capability_id list with active supplier counts.
 * GET /capabilities/:id/suppliers — filtered list, sortable by ?sort=price or ?sort=last_seen.
 */

import { Router, type Request, type Response } from "express";
import type { SqliteCache } from "../db/cache.js";
import { shapeSupplier } from "./suppliers.js";

export interface CapabilitiesDeps {
  cache: SqliteCache;
}

export function capabilitiesRouter(deps: CapabilitiesDeps): Router {
  const router = Router();

  router.get("/capabilities", (_req: Request, res: Response) => {
    const adverts = deps.cache.listActiveAdvertisements();
    const counts = new Map<string, number>();
    for (const a of adverts) {
      counts.set(a.capability_id, (counts.get(a.capability_id) ?? 0) + 1);
    }
    const out = Array.from(counts.entries()).map(([capability_id, supplier_count]) => ({
      capability_id,
      supplier_count,
    }));
    res.status(200).json(out);
  });

  router.get("/capabilities/:id/suppliers", (req: Request, res: Response) => {
    const capId = String(req.params.id);
    const sort = typeof req.query.sort === "string" ? req.query.sort : null;
    const adverts = deps.cache.listActiveAdvertisements({ capability_id: capId });

    let views = adverts.map((a) => {
      const status = deps.cache.getSupplierStatus(a.supplier_pkh);
      return shapeSupplier(a, status);
    });

    if (sort === "price") {
      views = views.slice().sort((a, b) => {
        const ap = BigInt(a.price_lovelace);
        const bp = BigInt(b.price_lovelace);
        return ap < bp ? -1 : ap > bp ? 1 : 0;
      });
    } else if (sort === "last_seen") {
      views = views.slice().sort((a, b) => {
        // Most recent first
        const at = a.last_seen_iso ?? "";
        const bt = b.last_seen_iso ?? "";
        return at < bt ? 1 : at > bt ? -1 : 0;
      });
    }

    res.status(200).json(views);
  });

  return router;
}
