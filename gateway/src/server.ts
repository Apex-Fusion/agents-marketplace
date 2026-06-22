/**
 * gateway/src/server.ts — Express app wiring.
 *
 * Public:   GET /healthz, GET /, POST /signup (IP rate-limited).
 * Bearer:   GET /account, POST /account/withdraw,
 *           POST /openai/v1/chat/completions, GET /openai/v1/models,
 *           POST /openai/v1/chat/sessions[/:id/messages|/close].
 */

import express, { type Express, type Request, type Response } from "express";
import type { GatewayDeps } from "./deps.js";
import { makeApiKeyAuth } from "./middleware/apiKeyAuth.js";
import { ipRateLimit, keyRateLimit } from "./middleware/rateLimit.js";
import { sendError } from "./middleware/http.js";
import { notFound } from "./openai/errors.js";
import { makeChatCompletionsHandler } from "./openai/chatCompletions.js";
import { makeModelsHandler } from "./openai/models.js";
import {
  makeOpenSessionHandler,
  makeSessionMessageHandler,
  makeCloseSessionHandler,
} from "./openai/sessions.js";
import { makeSignupHandler, makeAccountHandler, makeWithdrawHandler } from "./account/routes.js";
import { INDEX_HTML } from "./ui/page.js";

export function createApp(deps: GatewayDeps): Express {
  const app = express();
  // Behind traefik/Cloudflare — trust the proxy chain so req.ip is the client.
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).type("html").send(INDEX_HTML);
  });

  // Public signup, rate-limited per IP.
  app.post("/signup", ipRateLimit(deps.config.signupRate), makeSignupHandler(deps));

  // Bearer-gated routes: auth → per-key rate limit → handler.
  const auth = makeApiKeyAuth(deps.store);
  const krl = keyRateLimit(deps.config.keyRate);
  const gated = [auth, krl] as const;

  app.get("/account", auth, makeAccountHandler(deps));
  app.post("/account/withdraw", auth, makeWithdrawHandler(deps));

  app.post("/openai/v1/chat/completions", ...gated, makeChatCompletionsHandler(deps));
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
