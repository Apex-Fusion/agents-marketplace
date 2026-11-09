/**
 * indexer/src/routes/jury.ts — the followed jury deployments (Module-1/jury/SPEC.md).
 *
 * GET /jury                   — { deployments: [{ label, script_hash, address, params }], chain_time }
 * GET /jury/jurors            — { chain_time, jurors: JurorView[] }, newest registration first
 * GET /jury/jurors?agent_id=ID — only the jurors of the DID ID (64 hex)
 * GET /jury/cases             — { chain_time, cases: JuryCaseView[] }, newest opening first
 * GET /jury/cases?challenge=T — only the cases of the Module-1 challenge token T (64 hex)
 *
 * The views are in jury/view.ts. `chain_time` is the time of the last block that
 * the indexer applied: windows, eligibility and results use it. Without jury
 * deployments (JURY_DEPLOYMENTS unset), the lists are empty.
 */

import { Router, type Request, type Response } from "express";
import type { NetworkId } from "@marketplace/shared";
import type { JuryDeployment } from "../config.js";
import type { SqliteCache } from "../db/cache.js";
import { chainTimeMs, loadJuryView } from "../jury/view.js";

export interface JuryDeps {
  cache: SqliteCache;
  deployments: readonly JuryDeployment[];
  networkId: NetworkId;
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/** A query value as lowercase 64 hex; undefined when absent; null when malformed. */
function hex64Query(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  return HEX64_RE.test(lower) ? lower : null;
}

export function juryRouter(deps: JuryDeps): Router {
  const router = Router();

  router.get("/jury", (_req: Request, res: Response) => {
    res.status(200).json({
      deployments: deps.deployments.map((d) => ({ label: d.label, script_hash: d.scriptHash, address: d.address, params: d.params })),
      chain_time: new Date(chainTimeMs(deps.cache, deps.networkId)).toISOString(),
    });
  });

  router.get("/jury/jurors", (req: Request, res: Response) => {
    const agentId = hex64Query(req.query.agent_id);
    if (agentId === null) {
      res.status(400).json({ error: "agent_id must be 64 hexadecimal characters" });
      return;
    }
    const view = loadJuryView(deps.cache, deps.deployments, deps.networkId);
    res.status(200).json({
      chain_time: view.chain_time,
      jurors: agentId === undefined ? view.jurors : view.jurors.filter((j) => j.agent_id === agentId),
    });
  });

  router.get("/jury/cases", (req: Request, res: Response) => {
    const challenge = hex64Query(req.query.challenge);
    if (challenge === null) {
      res.status(400).json({ error: "challenge must be 64 hexadecimal characters" });
      return;
    }
    const view = loadJuryView(deps.cache, deps.deployments, deps.networkId);
    res.status(200).json({
      chain_time: view.chain_time,
      cases: challenge === undefined ? view.cases : view.cases.filter((c) => c.challenge === challenge),
    });
  });

  return router;
}
