/**
 * indexer/src/routes/escrows.ts
 *
 * GET /escrows/:ref  — ref is "<txHash>#<index>"; 404 if not found.
 * GET /escrows/:ref/lineage — exact spend-linked escrow history.
 * GET /escrows?buyer=PKH  — list escrows by buyer_pkh.
 * GET /escrows?supplier=PKH — list escrows by supplier_pkh.
 */

import { Router, type Request, type Response } from "express";
import {
  AmbiguousEscrowLineageError,
  type EscrowLineageRow,
  type EscrowRow,
  type SqliteCache,
} from "../db/cache.js";

export interface EscrowsDeps {
  cache: SqliteCache;
}

interface EscrowView {
  utxo_ref: string;
  buyer_pkh: string;
  supplier_pkh: string;
  advert_ref: string;            // canonical "<txHash>#<index>"
  capability_id: string;
  request_spec_hash: string;
  prompt_hash: string;
  payment_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
  deliver_by: number;
  posted_at: number;
  submitted_at: number | null;
  result_receipt_hash: string | null;
  state: string;
  created_slot: number;
}

interface LineageEscrowView extends EscrowView {
  spent_tx: string | null;
}

function shapeEscrow(row: EscrowRow): EscrowView {
  return {
    utxo_ref: row.utxo_ref,
    buyer_pkh: row.buyer_pkh,
    supplier_pkh: row.supplier_pkh,
    advert_ref: `${row.advert_ref_tx}#${row.advert_ref_index}`,
    capability_id: row.capability_id,
    request_spec_hash: row.request_spec_hash,
    prompt_hash: row.prompt_hash,
    payment_lovelace: row.payment_lovelace,
    buyer_bond_lovelace: row.buyer_bond_lovelace,
    supplier_bond_lovelace: row.supplier_bond_lovelace,
    deliver_by: row.deliver_by,
    posted_at: row.posted_at,
    submitted_at: row.submitted_at,
    result_receipt_hash: row.result_receipt_hash,
    state: row.state,
    created_slot: row.created_slot,
  };
}

function shapeLineageEscrow(row: EscrowLineageRow): LineageEscrowView {
  return { ...shapeEscrow(row), spent_tx: row.spent_tx };
}

export function escrowsRouter(deps: EscrowsDeps): Router {
  const router = Router();

  // The list-by-query route MUST be registered before /:ref so that GET /escrows
  // (no path segment) is matched here. Express's `/:ref` would not match "" anyway,
  // but the explicit ordering keeps the intent clear.
  router.get("/escrows", (req: Request, res: Response) => {
    const buyer = typeof req.query.buyer === "string" ? req.query.buyer : null;
    const supplier = typeof req.query.supplier === "string" ? req.query.supplier : null;
    if (!buyer && !supplier) {
      res.status(400).json({ error: "must provide ?buyer=<pkh> or ?supplier=<pkh>" });
      return;
    }
    const rows: EscrowRow[] = buyer
      ? deps.cache.listEscrowsByBuyer(buyer)
      : deps.cache.listEscrowsBySupplier(supplier!);
    res.status(200).json(rows.map(shapeEscrow));
  });

  router.get("/escrows/:ref/lineage", (req: Request, res: Response) => {
    const ref = String(req.params.ref);
    try {
      const lineage = deps.cache.getEscrowLineage(ref);
      if (!lineage) {
        res.status(404).json({ error: "escrow not found" });
        return;
      }
      res.status(200).json({
        original_ref: lineage.original_ref,
        rows: lineage.rows.map(shapeLineageEscrow),
        terminal: lineage.terminal,
      });
    } catch (err) {
      if (err instanceof AmbiguousEscrowLineageError) {
        res.status(409).json({ error: "ambiguous escrow lineage" });
        return;
      }
      throw err;
    }
  });

  router.get("/escrows/:ref", (req: Request, res: Response) => {
    const ref = String(req.params.ref);
    const row = deps.cache.getEscrowByRef(ref);
    if (!row) {
      res.status(404).json({ error: "escrow not found" });
      return;
    }
    res.status(200).json(shapeEscrow(row));
  });

  return router;
}
