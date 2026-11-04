/**
 * indexer/src/routes/disputes.ts
 *
 * GET /disputes                  — { cases: DisputeCase[] }, newest first (disputes/module1.ts).
 * GET /disputes?agent_id=ID      — only the cases where ID is the claimer or the auditor.
 * GET /agents/:agent_id/jobs     — AgentJobs: the identity-layout escrows of the agent.
 *   One job is one escrow lineage (SqliteCache.getEscrowLineage); its outcome is
 *   the terminal event (accepted, reclaimed, released, refunded) or the state
 *   of its last proven output (open, claimed, submitted). `recent` holds the
 *   20 newest jobs.
 *
 * Without Module-1 addresses (config `module1` null), /disputes returns no cases.
 */

import { Router, type Request, type Response } from "express";
import type { NetworkId } from "@marketplace/shared";
import { isVectorId } from "@marketplace/shared/identity";
import { AmbiguousEscrowLineageError, type EscrowTerminalType, type SqliteCache } from "../db/cache.js";
import { buildDisputeCases, type Module1Addresses } from "../disputes/module1.js";

export interface DisputesDeps {
  cache: SqliteCache;
  module1: Module1Addresses | null;
  networkId: NetworkId;
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

export function disputesRouter(deps: DisputesDeps): Router {
  const router = Router();

  router.get("/disputes", (req: Request, res: Response) => {
    const raw = typeof req.query.agent_id === "string" ? req.query.agent_id.toLowerCase() : null;
    if (raw !== null && !isVectorId(raw)) {
      res.status(400).json({ error: "agent_id must be 64 hexadecimal characters" });
      return;
    }
    const m1 = deps.module1;
    const cases = m1
      ? buildDisputeCases(
          deps.cache.listModule1Outputs([m1.claimAddress, m1.challengeAddress, m1.partyAddress]),
          m1,
          deps.networkId,
        )
      : [];
    res.status(200).json({
      cases: raw === null ? cases : cases.filter((c) => c.claimer_agent_id === raw || c.challenge?.auditor_agent_id === raw),
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
