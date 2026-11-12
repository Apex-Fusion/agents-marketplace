/**
 * indexer/src/routes/disputes.ts
 *
 * GET /disputes                  — { cases: DisputeCase[], total: number }, newest first (disputes/module1.ts).
 * GET /disputes?agent_id=ID      — only the cases where ID is the claimer or the auditor.
 * GET /disputes?limit=N&offset=M — one page: the N cases (1 to 200) after the first M (default 0).
 *   Without `limit`, the page runs to the end of the list (all cases when `offset` is 0).
 *   `total` is the number of cases after the agent_id filter, before the paging.
 *   A `limit` or `offset` that is not an integer in range gives HTTP 400.
 * GET /agents/:agent_id/jobs     — AgentJobs: the identity-layout escrows of the agent.
 *   One job is one escrow lineage (SqliteCache.getEscrowLineage); its outcome is
 *   the terminal event (accepted, reclaimed, released, refunded) or the state
 *   of its last proven output (open, claimed, submitted). `recent` holds the
 *   20 newest jobs.
 *
 * Without Module-1 addresses (config `module1` null), /disputes returns no cases.
 * Each case links its canonical jury case (`jury`, from the followed jury
 * deployments) and the documents on chain (`resolution_document`, and
 * `claim.document` / `challenge.document` for `vector-tx:` URIs).
 *
 * The build of the list of all cases decodes every Module-1 output. The router
 * builds the list at most once every 5 seconds and keeps it in memory. The
 * agent_id filter and the paging read this copy, so a change on chain shows in
 * /disputes up to 5 seconds late.
 */

import { Router, type Request, type Response } from "express";
import type { NetworkId } from "@marketplace/shared";
import { isVectorId } from "@marketplace/shared/identity";
import type { JuryDeployment } from "../config.js";
import { AmbiguousEscrowLineageError, type EscrowTerminalType, type SqliteCache } from "../db/cache.js";
import { buildDisputeCases, type DisputeCase, type DisputeLinks, type Module1Addresses } from "../disputes/module1.js";
import { loadJuryView, type JuryCaseView } from "../jury/view.js";

export interface DisputesDeps {
  cache: SqliteCache;
  module1: Module1Addresses | null;
  networkId: NetworkId;
  /** Followed jury deployments; empty: no jury cases. */
  jury: readonly JuryDeployment[];
  /** Clock in milliseconds for the case list copy (default Date.now); tests inject their own. */
  now?: () => number;
}

type JobOutcome = "open" | "claimed" | "submitted" | "accepted" | "reclaimed" | "released" | "refunded";

const TERMINAL_OUTCOME: Record<EscrowTerminalType, JobOutcome> = {
  AcceptEscrow: "accepted",
  ReclaimEscrow: "reclaimed",
  ReleaseEscrow: "released",
  RefundRevokedEscrow: "refunded",
};

const STATE_OUTCOME: Record<string, JobOutcome> = {
  Open: "open",
  Claimed: "claimed",
  Submitted: "submitted",
};

const RECENT_JOBS = 20;

/** The most cases that one page of GET /disputes holds. */
const MAX_PAGE = 200;

/** How long a built list of all cases stays valid. */
const CASES_CACHE_MS = 5_000;

/** A query value that is a whole number in decimal digits; null for any other value (also a repeated parameter). */
function queryInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function disputesRouter(deps: DisputesDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  let built: { at: number; cases: DisputeCase[] } | null = null;

  /** All cases, newest first. The build is the costly step, so it runs at most once every 5 seconds. */
  const allCases = (): DisputeCase[] => {
    const m1 = deps.module1;
    if (!m1) return [];
    const at = now();
    // A clock that moved back (at < built.at) makes the copy stale.
    if (built !== null && at >= built.at && at - built.at < CASES_CACHE_MS) return built.cases;
    const canonical = new Map<string, JuryCaseView>();
    for (const c of loadJuryView(deps.cache, deps.jury, deps.networkId).cases) {
      if (c.canonical && !canonical.has(c.claim)) canonical.set(c.claim, c);
    }
    const links: DisputeLinks = {
      juryCase: (claimToken) => canonical.get(claimToken) ?? null,
      documentSummary: (txHash) => deps.cache.getDocumentSummaries([txHash]).get(txHash) ?? null,
      document: (txHash) => deps.cache.getDocument(txHash),
    };
    const cases = buildDisputeCases(
      deps.cache.listModule1Outputs([m1.claimAddress, m1.challengeAddress, m1.partyAddress]),
      m1,
      deps.networkId,
      links,
    );
    built = { at, cases };
    return cases;
  };

  router.get("/disputes", (req: Request, res: Response) => {
    const raw = typeof req.query.agent_id === "string" ? req.query.agent_id.toLowerCase() : null;
    if (raw !== null && !isVectorId(raw)) {
      res.status(400).json({ error: "agent_id must be 64 hexadecimal characters" });
      return;
    }
    let limit: number | null = null;
    if (req.query.limit !== undefined) {
      limit = queryInteger(req.query.limit);
      if (limit === null || limit < 1 || limit > MAX_PAGE) {
        res.status(400).json({ error: `limit must be an integer from 1 to ${MAX_PAGE}` });
        return;
      }
    }
    let offset = 0;
    if (req.query.offset !== undefined) {
      const parsed = queryInteger(req.query.offset);
      if (parsed === null) {
        res.status(400).json({ error: "offset must be an integer of 0 or more" });
        return;
      }
      offset = parsed;
    }
    const all = allCases();
    const cases = raw === null ? all : all.filter((c) => c.claimer_agent_id === raw || c.challenge?.auditor_agent_id === raw);
    res.status(200).json({
      cases: cases.slice(offset, limit === null ? undefined : offset + limit),
      total: cases.length,
    });
  });

  router.get("/agents/:agent_id/jobs", (req: Request, res: Response) => {
    const agentId = String(req.params.agent_id).toLowerCase();
    if (!isVectorId(agentId)) {
      res.status(400).json({ error: "agent_id must be 64 hexadecimal characters" });
      return;
    }
    const counts: Record<JobOutcome, number> = {
      open: 0, claimed: 0, submitted: 0, accepted: 0, reclaimed: 0, released: 0, refunded: 0,
    };
    const recent: Array<{
      job_ref: string;
      capability_id: string;
      payment_lovelace: string;
      outcome: JobOutcome;
      last_tx: string | null;
      created_slot: number;
    }> = [];

    for (const origin of deps.cache.listIdentityEscrowOrigins(agentId)) {
      let outcome: JobOutcome = "open";
      let lastTx: string | null = origin.utxo_ref.split("#")[0] ?? null;
      try {
        const lineage = deps.cache.getEscrowLineage(origin.utxo_ref);
        const last = lineage?.rows[lineage.rows.length - 1];
        if (lineage?.terminal) {
          outcome = TERMINAL_OUTCOME[lineage.terminal.type];
          lastTx = lineage.terminal.tx_hash;
        } else if (last) {
          outcome = STATE_OUTCOME[last.state] ?? "open";
          lastTx = last.utxo_ref.split("#")[0] ?? null;
        }
      } catch (err) {
        if (!(err instanceof AmbiguousEscrowLineageError)) throw err;
      }
      counts[outcome] += 1;
      if (recent.length < RECENT_JOBS) {
        recent.push({
          job_ref: origin.utxo_ref,
          capability_id: origin.capability_id,
          payment_lovelace: origin.payment_lovelace,
          outcome,
          last_tx: lastTx,
          created_slot: origin.created_slot,
        });
      }
    }

    res.status(200).json({ agent_id: agentId, counts, recent });
  });

  return router;
}
