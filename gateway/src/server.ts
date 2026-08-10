/**
 * gateway/src/server.ts — Express app wiring.
 *
 * Public:   GET /healthz, GET /, POST /signup (IP rate-limited).
 * Bearer:   GET /account, POST /account/withdraw,
 *           POST /openai/v1/chat/completions, GET /openai/v1/models,
 *           POST /openai/v1/chat/sessions[/:id/messages|/close].
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { GatewayDeps } from "./deps.js";
import { makeApiKeyAuth } from "./middleware/apiKeyAuth.js";
import { ipRateLimit, keyRateLimit, demoIpRateLimit } from "./middleware/rateLimit.js";
import { sendError } from "./middleware/http.js";
import { notFound } from "./openai/errors.js";
import { makeChatCompletionsHandler } from "./openai/chatCompletions.js";
import { makeOcrExtractHandler } from "./ocr/extract.js";
import { makeModelsHandler } from "./openai/models.js";
import {
  makeOpenSessionHandler,
  makeSessionMessageHandler,
  makeCloseSessionHandler,
} from "./openai/sessions.js";
import { makeSignupHandler, makeAccountHandler, makeWithdrawHandler } from "./account/routes.js";
import { INDEX_HTML } from "./ui/page.js";

/**
 * CORS for browser clients on an allowlisted Origin (e.g. the marketplace
 * frontend's "Generate API key" page, served from a different host than the
 * gateway). Only echoes Access-Control-* headers when the request's Origin is
 * in the configured allowlist; an empty allowlist disables CORS entirely.
 * No credentials are allowed — the signup call is a plain bearer-less POST, so
 * cookies never ride along cross-origin. Preflight OPTIONS is answered 204.
 */
function corsMiddleware(allowOrigins: string[]) {
  const allow = new Set(allowOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && allow.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function createApp(deps: GatewayDeps): Express {
  const app = express();
  // Behind traefik/Cloudflare — trust the proxy chain so req.ip is the client.
  app.set("trust proxy", true);
  // CORS before body-parsing so preflight OPTIONS short-circuits cheaply.
  app.use(corsMiddleware(deps.config.corsOrigins));
  // /v1/ocr carries a base64 page image and mounts its own larger parser on
  // the route; every other path keeps the 1mb ceiling.
  const jsonBody = express.json({ limit: "1mb" });
  app.use((req, res, next) =>
    req.path.startsWith("/v1/ocr") ? next() : jsonBody(req, res, next));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).type("html").send(INDEX_HTML);
  });

  // Public signup, rate-limited per IP.
  app.post("/signup", ipRateLimit(deps.config.signupRate), makeSignupHandler(deps));

  // Bearer-gated routes: auth → per-key rate limit (skips demo keys) →
  // per-IP demo limit (demo keys only) → handler.
  const auth = makeApiKeyAuth(deps.store);
  const krl = keyRateLimit(deps.config.keyRate);
  const dirl = demoIpRateLimit(deps.config.demoIpRate);
  const gated = [auth, krl, dirl] as const;

  app.get("/account", auth, makeAccountHandler(deps));
  app.post("/account/withdraw", auth, makeWithdrawHandler(deps));

  app.post("/openai/v1/chat/completions", ...gated, makeChatCompletionsHandler(deps));
  // Model-scoped OCR: 16mb parser covers MAX_OCR_IMAGE_B64_CHARS
  // (~12M chars ≈ 9 MB binary) plus JSON envelope.
  app.post("/v1/ocr/extract", express.json({ limit: "16mb" }), ...gated, makeOcrExtractHandler(deps));
  app.get("/openai/v1/models", auth, makeModelsHandler(deps));
  app.post("/openai/v1/chat/sessions", ...gated, makeOpenSessionHandler(deps));
  app.post("/openai/v1/chat/sessions/:id/messages", ...gated, makeSessionMessageHandler(deps));
  app.post("/openai/v1/chat/sessions/:id/close", ...gated, makeCloseSessionHandler(deps));

  // OpenAI-shaped 404 for anything else.
  app.use((_req: Request, res: Response) => {
    sendError(res, notFound("not_found", "unknown route"));
  });

  return app;
}
