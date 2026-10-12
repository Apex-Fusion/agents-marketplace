import { Router, json, type Request, type Response, type NextFunction } from "express";
import { MAX_TOOL_INPUT_BYTES } from "@marketplace/shared/paper2agent";
import { Paper2AgentRuntime, ToolAdmissionError } from "./runtime.js";
import type { ToolJob } from "./journal.js";

function publicJob(job: ToolJob) {
  return {
    job_id: job.job_id, status: job.status, escrow_ref: job.escrow_ref,
    manifest_hash: job.manifest_hash,
    ...(job.claimed_ref ? { claimed_ref: job.claimed_ref } : {}),
    ...(job.submitted_ref ? { submitted_ref: job.submitted_ref } : {}),
    ...(job.result ? { result: job.result, receipt: job.receipt,
      receipt_signature: job.receipt_signature, pub_key_hex: job.pub_key_hex } : {}),
    ...(job.reason ? { reason: job.reason, message: job.reason, financial_status: "unknown" } : {}),
  };
}

export function paper2AgentRoutes(runtime: Paper2AgentRuntime): Router {
  const router = Router();
  const toolRequest = json({ limit: MAX_TOOL_INPUT_BYTES + 256, strict: true, inflate: false });
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.post("/v1/paper2agent/run", toolRequest,
    async (req, res) => {
      try {
        const job = await runtime.admit(req.header("X-Escrow-Ref"), req.body);
        res.status(202).json({ job_id: job.job_id, status: "accepted", escrow_ref: job.escrow_ref });
      } catch (error) {
        if (error instanceof ToolAdmissionError) {
          res.status(error.status).json(error.job ? publicJob(error.job) : {
            reason: error.reason, message: error.reason,
          });
        } else res.status(503).json({ reason: "tool_admission_unavailable" });
      }
    });
  // Recovery of a lost admission reply: read-only, never a second paid admission.
  router.post("/v1/paper2agent/lookup", toolRequest, (req, res) => {
    let job: ToolJob | undefined;
    try { job = runtime.lookup(req.header("X-Escrow-Ref"), req.body); }
    catch (error) {
      if (error instanceof ToolAdmissionError) res.status(error.status).json({ reason: error.reason, message: error.reason });
      else res.status(503).json({ reason: "tool_journal_unavailable" });
      return;
    }
    // The same answer for an absent job and a wrong preimage. No tool data.
    if (!job) res.status(404).json({ reason: "job_not_found" });
    else res.json({ job_id: job.job_id, escrow_ref: job.escrow_ref, manifest_hash: job.manifest_hash, status: job.status });
  });
  router.get("/v1/paper2agent/run/:jobId", (req, res) => {
    // This journal has only tool jobs. Never consult the legacy shared JobStore.
    let job: ToolJob | undefined;
    try { job = runtime.journal.get(req.params.jobId); }
    catch { res.status(503).json({ reason: "tool_journal_unavailable" }); return; }
    if (!job) {
      res.status(404).json({ reason: "job_not_found" });
    } else if (job.status === "accepted" || job.status === "running") {
      res.status(202).json({ status: job.status, escrow_ref: job.escrow_ref });
    } else res.status(job.status === "done" ? 200 : 502).json(publicJob(job));
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!error) { next(); return; }
    const status = typeof error === "object" && "status" in error ? error.status : undefined;
    res.status(status === 413 ? 413 : 400).json({ reason: "invalid_tool_request" });
  });
  return router;
}
