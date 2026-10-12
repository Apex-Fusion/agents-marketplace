/**
 * buyer/src/paper2agent/routes.ts — operator proxy to the Paper2Agent control
 * service.
 *
 * Each /v1/paper2agent route maps to one fixed control-service path. The
 * control URL and bearer token come only from buyer configuration, so the
 * browser can neither choose an upstream nor read the token. createApp mounts
 * these routes behind the operator-session gate; they stay closed (503) when
 * that gate is not configured. The app-wide JSON parser skips this prefix, so
 * bodies are parsed only after authentication and with per-route bounds.
 *
 * Every change requires `X-Paper2Agent-Request: 1`. A cross-site form cannot
 * send that header, and a cross-site script needs a CORS preflight that this
 * server never grants, so the session cookie alone cannot authorize a change.
 *
 *   GET  /status                       readiness and budget bounds
 *   GET  /jobs                         newest jobs
 *   POST /jobs                         JSON PaperSubmission or multipart upload
 *   GET  /jobs/:id
 *   POST /jobs/:id/build               explicit operator retry approval
 *   POST /jobs/:id/cancel
 *   GET  /jobs/:id/events?after=N
 *   GET  /jobs/:id/package             ZIP of the verified package files
 *   GET  /jobs/:id/files?path=…        reviewed artifact file preview
 *   POST /jobs/:id/review
 *   GET  /targets                      publisher wallet slots
 *   POST /jobs/:id/prepare-publication bundle hand-off, no chain transaction
 *   POST /jobs/:id/publish             live advert transaction; never retried
 *   GET  /jobs/:id/publication         read-only outcome refresh
 */

import { once } from "node:events";
import express, {
  type Express,
  type NextFunction,
  type Request as ExpressRequest,
  type RequestHandler,
  type Response as ExpressResponse,
} from "express";
import multer from "multer";
import { PAPER2AGENT_MAX_DOWNLOAD_BYTES } from "@marketplace/shared/paper2agent/workflow";

/** Requests under this prefix bypass the app-wide 1 MiB JSON parser. */
export const PAPER2AGENT_PATH_RE = /^\/v1\/paper2agent(?:\/|$)/i;

export interface Paper2AgentProxyOptions {
  /** True only when the operator password and session secret are configured. */
  authConfigured: boolean;
  /** Control-service base URL; empty disables the proxy. */
  controlUrl: string;
  /** Server-only bearer token for the control service; empty disables the proxy. */
  controlToken: string;
  fetchImpl: typeof globalThis.fetch;
}

const ROUTES_RE = /^\/v1\/paper2agent(?:\/.*)?$/i;
/** Control-service job IDs are lowercase UUIDv4 strings. */
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_SEQ_RE = /^\d{1,15}$/;
const MAX_LOVELACE_RE = /^[1-9]\d{0,19}$/;

const MAX_PDF_BYTES = 5 * 1024 * 1024;
/** A 5 MiB PDF is about 7 MiB as base64; the rest covers the text fields. */
const SUBMISSION_JSON_LIMIT = "8mb";
const CHANGE_JSON_LIMIT = "64kb";
/** Holds 100,000 characters of pasted paper text in UTF-8. */
const MAX_FORM_FIELD_BYTES = 512 * 1024;
const FORM_FIELDS: readonly string[] = ["title", "paper_url", "paper_text"];
const MAX_FILE_PATH_CHARS = 1024;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_CODE_CHARS = 100;
const MAX_ERROR_MESSAGE_CHARS = 4000;

// Each deadline is longer than the control service's own deadline for the
// same operation, so the operator normally sees the control service's answer.
const READ_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const REFRESH_TIMEOUT_MS = 2 * 60_000;
const PACKAGE_TIMEOUT_MS = 5 * 60_000;
/** Building the isolated runtime image alone can take five minutes. */
const PREPARE_TIMEOUT_MS = 7 * 60_000;
const PUBLISH_TIMEOUT_MS = 6 * 60_000;

const READ_TIMEOUT = "The Paper2Agent control service did not answer within 30 seconds. Try again.";
const UNREACHABLE =
  "The Paper2Agent control service is unreachable. Check PAPER2AGENT_CONTROL_URL and that the service is running.";

interface UpstreamCall {
  method: "GET" | "POST";
  /** Fixed control-service path; IDs and query values are already validated. */
  path: string;
  /** JSON body for POST calls. */
  body?: object;
  timeoutMs: number;
  timeoutMessage: string;
}

/** Cancels one upstream exchange at its deadline or, for reads, when the browser leaves. */
interface Exchange {
  signal: AbortSignal;
  timedOut(): boolean;
  close(): void;
}

class ResponseTooLarge extends Error {}

function jsonError(res: ExpressResponse, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

function openExchange(res: ExpressResponse, timeoutMs: number, abortOnClientClose: boolean): Exchange {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onClose = (): void => {
    if (!res.writableFinished) controller.abort();
  };
  if (abortOnClientClose) res.on("close", onClose);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    close: () => {
      clearTimeout(timer);
      res.off("close", onClose);
    },
  };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLarge();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

/** Relay a control-service JSON answer, keeping only {error, message} from failures. */
function relayJson(res: ExpressResponse, status: number, text: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (status >= 200 && status < 300 && payload !== undefined) {
    res.status(status).json(payload);
    return;
  }
  if (status === 401) {
    // Never relay a 401: the SPA treats any 401 as an expired operator session.
    jsonError(
      res,
      502,
      "paper2agent_control_auth_failed",
      "The Paper2Agent control service rejected PAPER2AGENT_CONTROL_TOKEN. Configure the same token on the buyer and the control service.",
    );
    return;
  }
  if (
    status >= 400 &&
    status <= 599 &&
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string" &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    jsonError(
      res,
      status,
      payload.error.slice(0, MAX_ERROR_CODE_CHARS),
      payload.message.slice(0, MAX_ERROR_MESSAGE_CHARS),
    );
    return;
  }
  jsonError(
    res,
    502,
    "paper2agent_invalid_response",
    `The Paper2Agent control service returned an unexpected HTTP ${status} response.`,
  );
}

function relayFailure(res: ExpressResponse, error: unknown, exchange: Exchange, timeoutMessage: string): void {
  if (res.headersSent) {
    // A partial download must fail visibly instead of ending as a short file.
    res.destroy();
    return;
  }
  if (exchange.timedOut()) {
    jsonError(res, 504, "paper2agent_timeout", timeoutMessage);
    return;
  }
  if (error instanceof ResponseTooLarge) {
    jsonError(
      res,
      502,
      "paper2agent_response_too_large",
      "The Paper2Agent control service response exceeded the buyer's size limit.",
    );
    return;
  }
  jsonError(res, 502, "paper2agent_unreachable", UNREACHABLE);
}

function jobIdParam(req: ExpressRequest, res: ExpressResponse): string | null {
  const id = String(req.params.id);
  if (JOB_ID_RE.test(id)) return id;
  jsonError(res, 404, "not_found", "Unknown Paper2Agent job.");
  return null;
}

/** Run a body parser after authentication and turn its failures into JSON errors. */
async function parsedJsonObject(
  parser: RequestHandler,
  req: ExpressRequest,
  res: ExpressResponse,
): Promise<object | null> {
  if (!req.is("application/json")) {
    jsonError(res, 415, "unsupported_media_type", "Send a JSON request body with Content-Type: application/json.");
    return null;
  }
  const failure = await new Promise<unknown>((resolve) => {
    void parser(req, res, (error?: unknown) => resolve(error));
  });
  if (failure !== undefined) {
    if (typeof failure === "object" && failure !== null && "type" in failure && failure.type === "entity.too.large") {
      jsonError(res, 413, "request_too_large", "The request body is too large.");
    } else {
      jsonError(res, 400, "invalid_json", "The request body must be valid JSON.");
    }
    return null;
  }
  const body: unknown = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    jsonError(res, 400, "invalid_body", "The request body must be a JSON object.");
    return null;
  }
  return body;
}

export function registerPaper2AgentRoutes(app: Express, options: Paper2AgentProxyOptions): void {
  if (!options.authConfigured) {
    // Fail closed: without the operator login these routes would be public.
    app.all(ROUTES_RE, (_req: ExpressRequest, res: ExpressResponse) => {
      res.setHeader("Cache-Control", "no-store");
      jsonError(
        res,
        503,
        "auth_unconfigured",
        "Operator login is not configured, so the Paper2Agent routes are closed.",
      );
    });
    return;
  }
  const controlUrl = options.controlUrl.replace(/\/+$/, "");
  const { controlToken, fetchImpl } = options;
  if (controlUrl === "" || controlToken === "") {
    app.all(ROUTES_RE, (_req: ExpressRequest, res: ExpressResponse) => {
      res.setHeader("Cache-Control", "no-store");
      jsonError(
        res,
        503,
        "paper2agent_unconfigured",
        "Paper2Agent is not configured on this buyer. Set PAPER2AGENT_CONTROL_URL and PAPER2AGENT_CONTROL_TOKEN, then restart the buyer.",
      );
    });
    return;
  }

  const submissionJson = express.json({ limit: SUBMISSION_JSON_LIMIT });
  const changeJson = express.json({ limit: CHANGE_JSON_LIMIT });
  const paperUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_PDF_BYTES,
      files: 1,
      fields: FORM_FIELDS.length,
      fieldSize: MAX_FORM_FIELD_BYTES,
      parts: FORM_FIELDS.length + 1,
    },
  }).single("paper_pdf");

  function upstream(call: UpstreamCall, accept: string, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      authorization: `Bearer ${controlToken}`,
    };
    if (call.body !== undefined) headers["content-type"] = "application/json";
    return fetchImpl(`${controlUrl}${call.path}`, {
      method: call.method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      redirect: "error",
      signal,
    });
  }

  /** Send one request; a change is never repeated after a failure. */
  async function forwardJson(res: ExpressResponse, call: UpstreamCall): Promise<void> {
    // Reads stop when the browser leaves. Changes run to completion upstream.
    const exchange = openExchange(res, call.timeoutMs, call.method === "GET");
    try {
      const response = await upstream(call, "application/json", exchange.signal);
      relayJson(res, response.status, await readBoundedText(response, MAX_JSON_RESPONSE_BYTES));
    } catch (error) {
      relayFailure(res, error, exchange, call.timeoutMessage);
    } finally {
      exchange.close();
    }
  }

  function forwardRead(res: ExpressResponse, path: string): Promise<void> {
    return forwardJson(res, { method: "GET", path, timeoutMs: READ_TIMEOUT_MS, timeoutMessage: READ_TIMEOUT });
  }

  /** Translate the multipart paper upload into the JSON PaperSubmission body. */
  async function formSubmission(req: ExpressRequest, res: ExpressResponse): Promise<Record<string, string> | null> {
    const failure = await new Promise<unknown>((resolve) => {
      paperUpload(req, res, (error?: unknown) => resolve(error));
    });
    if (failure !== undefined) {
      const code = failure instanceof multer.MulterError ? failure.code : undefined;
      if (code === "LIMIT_FILE_SIZE") {
        jsonError(res, 413, "paper_pdf_too_large", "The paper PDF is larger than 5 MiB.");
      } else if (code === "LIMIT_FIELD_VALUE") {
        jsonError(res, 413, "field_too_large", "A form field is larger than 512 KiB.");
      } else {
        jsonError(
          res,
          400,
          "invalid_upload",
          `The submission form is invalid: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
      return null;
    }
    const submission: Record<string, string> = {};
    // multer collects text fields into a plain object; a repeated field becomes an array.
    const fields: unknown = req.body;
    for (const [name, value] of Object.entries(typeof fields === "object" && fields !== null ? fields : {})) {
      if (!FORM_FIELDS.includes(name)) {
        jsonError(res, 400, "unsupported_field", `Unsupported form field: ${name.slice(0, 100)}`);
        return null;
      }
      if (typeof value !== "string") {
        jsonError(res, 400, "invalid_field", `Send the form field ${name} once.`);
        return null;
      }
      submission[name] = value;
    }
    const file = req.file;
    if (file !== undefined) {
      if (file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
        jsonError(res, 400, "paper_pdf_invalid", "The uploaded paper must be a PDF file.");
        return null;
      }
      submission.paper_pdf_base64 = file.buffer.toString("base64");
      if (!submission.title?.trim()) {
        submission.title = file.originalname.split(/[\\/]/).at(-1)?.replace(/\.pdf$/i, "")
          .replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200) || "Research paper";
      }
    }
    return submission;
  }

  // Shared guard for the whole prefix, after the session gate in createApp.
  app.use("/v1/paper2agent", (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD" && req.get("x-paper2agent-request") !== "1") {
      jsonError(
        res,
        403,
        "paper2agent_header_required",
        "Paper2Agent changes require the X-Paper2Agent-Request: 1 header.",
      );
      return;
    }
    next();
  });

  app.get("/v1/paper2agent/status", (_req: ExpressRequest, res: ExpressResponse) => {
    void forwardRead(res, "/status");
  });

  app.get("/v1/paper2agent/targets", (_req: ExpressRequest, res: ExpressResponse) => {
    void forwardRead(res, "/targets");
  });

  app.get("/v1/paper2agent/jobs", (_req: ExpressRequest, res: ExpressResponse) => {
    void forwardRead(res, "/jobs");
  });

  // Submission queues the first build with marketplace default limits.
  app.post("/v1/paper2agent/jobs", async (req: ExpressRequest, res: ExpressResponse) => {
    const submission = req.is("multipart/form-data")
      ? await formSubmission(req, res)
      : await parsedJsonObject(submissionJson, req, res);
    if (submission === null) return;
    const extra = Object.keys(submission).find((name) => !FORM_FIELDS.includes(name) && name !== "paper_pdf_base64");
    if (extra !== undefined) {
      jsonError(res, 400, "unsupported_field", `Unsupported submission field: ${extra.slice(0, 100)}`);
      return;
    }
    await forwardJson(res, {
      method: "POST",
      path: "/jobs",
      body: submission,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      timeoutMessage:
        "The Paper2Agent control service did not confirm the submission within 60 seconds. Refresh the job list before you submit again.",
    });
  });

  app.get("/v1/paper2agent/jobs/:id", (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id !== null) void forwardRead(res, `/jobs/${id}`);
  });

  // A retry requires explicit model-spend approval for this job.
  app.post("/v1/paper2agent/jobs/:id/build", async (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    const body = await parsedJsonObject(changeJson, req, res);
    if (body === null) return;
    if (!("confirm" in body) || body.confirm !== true) {
      jsonError(
        res,
        400,
        "confirmation_required",
        "Starting a build approves model spending. Send confirm: true with the budget.",
      );
      return;
    }
    await forwardJson(res, {
      method: "POST",
      path: `/jobs/${id}/build`,
      body,
      timeoutMs: READ_TIMEOUT_MS,
      timeoutMessage: "The build request did not finish within 30 seconds. Refresh the job before you try again.",
    });
  });

  app.post("/v1/paper2agent/jobs/:id/cancel", (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    void forwardJson(res, {
      method: "POST",
      path: `/jobs/${id}/cancel`,
      body: {},
      timeoutMs: READ_TIMEOUT_MS,
      timeoutMessage: "The cancel request did not finish within 30 seconds. Refresh the job to see its state.",
    });
  });

  app.get("/v1/paper2agent/jobs/:id/events", (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    const after = req.query.after ?? "0";
    if (typeof after !== "string" || !EVENT_SEQ_RE.test(after)) {
      jsonError(res, 400, "invalid_after", "after must be a non-negative event sequence number.");
      return;
    }
    void forwardRead(res, `/jobs/${id}/events?after=${after}`);
  });

  app.get("/v1/paper2agent/jobs/:id/files", (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    const path = req.query.path;
    if (typeof path !== "string" || path === "" || path.length > MAX_FILE_PATH_CHARS) {
      jsonError(res, 400, "invalid_path", "Choose one file path from the artifact file list.");
      return;
    }
    void forwardRead(res, `/jobs/${id}/files?path=${encodeURIComponent(path)}`);
  });

  app.get("/v1/paper2agent/jobs/:id/package", async (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    const call: UpstreamCall = {
      method: "GET",
      path: `/jobs/${id}/package`,
      timeoutMs: PACKAGE_TIMEOUT_MS,
      timeoutMessage: "The package download did not finish within 5 minutes.",
    };
    const exchange = openExchange(res, call.timeoutMs, true);
    try {
      const response = await upstream(call, "application/zip", exchange.signal);
      if (!response.ok) {
        relayJson(res, response.status, await readBoundedText(response, MAX_JSON_RESPONSE_BYTES));
        return;
      }
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const length = response.headers.get("content-length");
      const lengthOk = length === null || (/^\d+$/.test(length) && Number(length) <= PAPER2AGENT_MAX_DOWNLOAD_BYTES);
      if (type !== "application/zip" || response.body === null || !lengthOk) {
        await response.body?.cancel().catch(() => undefined);
        jsonError(
          res,
          502,
          "paper2agent_invalid_package",
          "The Paper2Agent control service did not return a bounded ZIP package.",
        );
        return;
      }
      res.status(200);
      res.setHeader("Content-Type", "application/zip");
      // Named from the validated server job ID; no upstream file name or path.
      res.setHeader("Content-Disposition", `attachment; filename="paper2agent-${id}.zip"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (length !== null) res.setHeader("Content-Length", length);
      res.flushHeaders();
      const reader = response.body.getReader();
      let sent = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        sent += chunk.value.byteLength;
        if (sent > PAPER2AGENT_MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ResponseTooLarge();
        }
        if (!res.write(chunk.value)) await once(res, "drain", { signal: exchange.signal });
      }
      res.end();
    } catch (error) {
      relayFailure(res, error, exchange, call.timeoutMessage);
    } finally {
      exchange.close();
    }
  });

  // Review records a decision only; it never publishes or spends.
  app.post("/v1/paper2agent/jobs/:id/review", async (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    const body = await parsedJsonObject(changeJson, req, res);
    if (body === null) return;
    await forwardJson(res, {
      method: "POST",
      path: `/jobs/${id}/review`,
      body,
      timeoutMs: READ_TIMEOUT_MS,
      timeoutMessage: "The review request did not finish within 30 seconds. Refresh the job before you try again.",
    });
  });

  // Hands the reviewed bundle to the publisher. No chain transaction.
  app.post("/v1/paper2agent/jobs/:id/prepare-publication", async (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    const body = await parsedJsonObject(changeJson, req, res);
    if (body === null) return;
    await forwardJson(res, {
      method: "POST",
      path: `/jobs/${id}/prepare-publication`,
      body,
      timeoutMs: PREPARE_TIMEOUT_MS,
      timeoutMessage:
        "Publication preparation did not finish within 7 minutes. It can still be running. Refresh the job before you try again.",
    });
  });

  // Live chain spend. Sent once and never retried here; an unclear outcome is
  // resolved with GET /jobs/:id/publication, not with another publish request.
  app.post("/v1/paper2agent/jobs/:id/publish", async (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    const body = await parsedJsonObject(changeJson, req, res);
    if (body === null) return;
    const approved =
      "confirm" in body &&
      body.confirm === true &&
      "max_debit_lovelace" in body &&
      typeof body.max_debit_lovelace === "string" &&
      MAX_LOVELACE_RE.test(body.max_debit_lovelace);
    if (!approved) {
      jsonError(
        res,
        400,
        "confirmation_required",
        "Publishing spends real funds. Send confirm: true and a positive max_debit_lovelace.",
      );
      return;
    }
    await forwardJson(res, {
      method: "POST",
      path: `/jobs/${id}/publish`,
      body,
      timeoutMs: PUBLISH_TIMEOUT_MS,
      timeoutMessage:
        "The publish request did not finish within 6 minutes. A transaction can already be signed or submitted. Do not publish again. Refresh the publication status.",
    });
  });

  app.get("/v1/paper2agent/jobs/:id/publication", (req: ExpressRequest, res: ExpressResponse) => {
    const id = jobIdParam(req, res);
    if (id === null) return;
    void forwardJson(res, {
      method: "GET",
      path: `/jobs/${id}/publication`,
      timeoutMs: REFRESH_TIMEOUT_MS,
      timeoutMessage: "The publication status refresh did not finish within 2 minutes. Try the refresh again.",
    });
  });

  // No other path reaches the control service.
  app.all(ROUTES_RE, (_req: ExpressRequest, res: ExpressResponse) => {
    jsonError(res, 404, "not_found", "Unknown Paper2Agent route.");
  });
}
