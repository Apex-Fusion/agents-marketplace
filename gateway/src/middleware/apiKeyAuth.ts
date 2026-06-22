/**
 * gateway/src/middleware/apiKeyAuth.ts — Bearer API-key authentication.
 *
 * Looks up sha256(rawKey) in api_keys (unique index). The raw key is never
 * stored. Attaches the matched row to req.gatewayKey for downstream handlers.
 */

import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import type { GatewayStore, ApiKeyRow } from "../db/store.js";
import { unauthorized } from "../openai/errors.js";
import { sendError } from "./http.js";

export interface GatewayRequest extends Request {
  gatewayKey?: ApiKeyRow;
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function makeApiKeyAuth(store: GatewayStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) {
      sendError(res, unauthorized("missing or malformed Authorization: Bearer header"));
      return;
    }
    const row = store.getKeyByHash(hashApiKey(m[1].trim()));
    if (!row || row.disabled) {
      sendError(res, unauthorized());
      return;
    }
    (req as GatewayRequest).gatewayKey = row;
    next();
  };
}

/** Read the authenticated key off the request (throws if middleware missing). */
export function requireKey(req: Request): ApiKeyRow {
  const row = (req as GatewayRequest).gatewayKey;
  if (!row) throw unauthorized();
  return row;
}
