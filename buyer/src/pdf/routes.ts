/**
 * buyer/src/pdf/routes.ts — HTTP surface for the PDF book summarizer.
 *
 * Mounted under /v1/pdf-* so it inherits the buyer app's session auth
 * (server.ts gates every /v1/* route except /v1/auth/*). The upload route
 * uses multer (multipart) so the global express.json({limit:"1mb"}) body
 * parser never sees the PDF.
 *
 * Endpoints:
 *   POST /v1/pdf-upload              multipart "file" → {job_id, chunk_count, ...}
 *   GET  /v1/pdf-jobs/:id/estimate   pre-spend cost + wallet floor check
 *   POST /v1/pdf-jobs/:id/start      {confirm:true} → 202 (posts escrows)
 *   GET  /v1/pdf-jobs/:id/events     text/event-stream live progress
 *   GET  /v1/pdf-jobs/:id            job view (status, coverage, summary)
 *   GET  /v1/pdf-jobs/:id/summary.md downloadable markdown
 */

import type { Express, Request, Response } from "express";
import multer from "multer";
import { extractPdfText } from "./extract.js";
import { chunkText } from "./chunk.js";
import { PdfExtractionError, type PdfCaps } from "./types.js";
import type { JobStore } from "./summarize-job.js";

function jsonError(res: Response, status: number, reason: string, message: string): Response {
  return res.status(status).json({ error: reason, message });
}

export function registerPdfRoutes(
  app: Express,
  jobStore: JobStore | undefined,
  caps: PdfCaps,
): void {
  // Without a JobStore (chain/marketplace deps missing, or archive off) the
  // feature is disabled — respond 503 on every pdf route so the SPA renders a
  // clear banner instead of 404s.
  if (!jobStore) {
    const disabled = (_req: Request, res: Response): Response =>
      jsonError(
        res,
        503,
        "service_unavailable",
        "PDF summarizer disabled (buyer booted without chain/marketplace/archive deps)",
      );
    app.post("/v1/pdf-upload", disabled);
    app.all(/^\/v1\/pdf-jobs(\/.*)?$/, disabled);
    return;
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: caps.maxPdfBytes },
  });

  // ── POST /v1/pdf-upload ─────────────────────────────────────────────
  app.post("/v1/pdf-upload", (req: Request, res: Response) => {
    upload.single("file")(req, res, async (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          return jsonError(res, 413, "pdf_too_large", `max upload is ${caps.maxPdfBytes} bytes`);
        }
        return jsonError(res, 400, "upload_failed", err instanceof Error ? err.message : String(err));
      }
      const file = (req as Request & { file?: { buffer: Buffer; originalname?: string } }).file;
      if (!file) {
        return jsonError(res, 400, "file_required", 'multipart form field "file" is required');
      }

      let extracted;
      try {
        extracted = await extractPdfText(file.buffer);
      } catch (e) {
        if (e instanceof PdfExtractionError) {
          return jsonError(res, 422, e.reason, e.message);
        }
        return jsonError(res, 500, "extract_failed", e instanceof Error ? e.message : String(e));
      }

      if (extracted.pageCount > caps.maxPages) {
        return jsonError(
          res,
          422,
          "too_many_pages",
          `${extracted.pageCount} pages exceeds the ${caps.maxPages}-page cap`,
        );
      }

      const chunks = chunkText(extracted.text, {
        targetTokens: caps.chunkTargetTokens,
        maxTokens: caps.chunkMaxTokens,
      });
      if (chunks.length === 0) {
        return jsonError(res, 422, "no_text", "no extractable text found in the PDF");
      }
      if (chunks.length > caps.maxChunks) {
        return jsonError(
          res,
          422,
          "too_many_chunks",
          `${chunks.length} chunks exceeds the ${caps.maxChunks}-chunk cap`,
        );
      }

      const job = jobStore.createJob(file.originalname || "book.pdf", extracted.pageCount, chunks);
      return res.status(200).json({
        job_id: job.jobId,
        filename: job.filename,
        page_count: extracted.pageCount,
        chunk_count: chunks.length,
        sample_chunk: chunks[0].text.slice(0, 500),
      });
    });
  });

  // ── GET /v1/pdf-jobs/:id/estimate ───────────────────────────────────
  app.get("/v1/pdf-jobs/:id/estimate", async (req: Request, res: Response) => {
    const job = jobStore.get(String(req.params.id));
    if (!job) return jsonError(res, 404, "job_not_found", `no job ${String(req.params.id)}`);
    try {
      const est = await jobStore.estimate(job);
      return res.status(200).json(est);
    } catch (err) {
      return jsonError(res, 502, "estimate_failed", err instanceof Error ? err.message : String(err));
    }
  });

  // ── POST /v1/pdf-jobs/:id/start ─────────────────────────────────────
  app.post("/v1/pdf-jobs/:id/start", async (req: Request, res: Response) => {
    const job = jobStore.get(String(req.params.id));
    if (!job) return jsonError(res, 404, "job_not_found", `no job ${String(req.params.id)}`);

    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
      confirm?: unknown;
    };
    if (body.confirm !== true) {
      return jsonError(res, 400, "not_confirmed", "body must include { confirm: true }");
    }
    if (job.status !== "estimated") {
      return jsonError(res, 409, "already_started", `job is already ${job.status}`);
    }

    let est;
    try {
      est = await jobStore.estimate(job);
    } catch (err) {
      return jsonError(res, 502, "estimate_failed", err instanceof Error ? err.message : String(err));
    }
    if (est.no_capable_suppliers) {
      return jsonError(res, 409, "no_capable_suppliers", "no capable suppliers available right now");
    }
    if (est.would_drop_below_floor) {
      return jsonError(
        res,
        402,
        "below_wallet_floor",
        `projected spend would drop the wallet below the ${est.wallet_floor_lovelace} lovelace floor`,
      );
    }

    jobStore.start(job);
    return res.status(202).json({ job_id: job.jobId, status: "running" });
  });

  // ── GET /v1/pdf-jobs/:id/events (SSE) ───────────────────────────────
  app.get("/v1/pdf-jobs/:id/events", (req: Request, res: Response) => {
    const job = jobStore.get(String(req.params.id));
    if (!job) {
      jsonError(res, 404, "job_not_found", `no job ${String(req.params.id)}`);
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Defeat proxy buffering (Traefik/nginx/Cloudflare) so frames flush live.
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as Response & { flushHeaders: () => void }).flushHeaders();
    }

    const unsubscribe = job.subscribe((frame) => res.write(frame));
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // ── GET /v1/pdf-jobs/:id/summary.md ─────────────────────────────────
  app.get("/v1/pdf-jobs/:id/summary.md", (req: Request, res: Response) => {
    const job = jobStore.get(String(req.params.id));
    if (!job) return jsonError(res, 404, "job_not_found", `no job ${String(req.params.id)}`);
    if (!job.finalSummary) {
      return jsonError(res, 404, "not_ready", "summary not available yet");
    }
    const safeName = job.filename.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_") || "summary";
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-summary.md"`);
    return res.send(job.finalSummary);
  });

  // ── GET /v1/pdf-jobs/:id ────────────────────────────────────────────
  app.get("/v1/pdf-jobs/:id", (req: Request, res: Response) => {
    const job = jobStore.get(String(req.params.id));
    if (!job) return jsonError(res, 404, "job_not_found", `no job ${String(req.params.id)}`);
    return res.status(200).json(job.view());
  });
}
