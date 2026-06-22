/**
 * gateway/src/middleware/rateLimit.ts — per-IP and per-key limiters.
 *
 * Small sliding-window limiter (same shape as buyer/src/auth.ts createRateLimiter,
 * inlined to avoid coupling the operator-auth module into the gateway). Used to
 * bound public /signup abuse (per IP) and per-key request volume (429 + Retry-After).
 */

import type { Request, Response, NextFunction } from "express";
import { rateLimited } from "../openai/errors.js";
import { sendError } from "./http.js";
import { requireKey } from "./apiKeyAuth.js";

interface Bucket {
  count: number;
  windowStart: number;
}

interface Limiter {
  attempt(key: string): { allowed: boolean; retryAfterMs: number };
}

function createLimiter(opts: { max: number; windowMs: number }): Limiter {
  const buckets = new Map<string, Bucket>();
  return {
    attempt(key: string) {
      const t = Date.now();
      const existing = buckets.get(key);
      if (!existing || t - existing.windowStart >= opts.windowMs) {
        buckets.set(key, { count: 1, windowStart: t });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (existing.count >= opts.max) {
        return { allowed: false, retryAfterMs: Math.max(0, opts.windowMs - (t - existing.windowStart)) };
      }
      existing.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

type Keyer = (req: Request) => string;

function makeLimiter(opts: { max: number; windowMs: number }, keyOf: Keyer) {
  const limiter = createLimiter(opts);
  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = limiter.attempt(keyOf(req));
    if (!decision.allowed) {
      const retrySec = Math.ceil(decision.retryAfterMs / 1000);
      res.setHeader("Retry-After", retrySec.toString());
      sendError(res, rateLimited(`rate limit exceeded; retry in ${retrySec}s`));
      return;
    }
    next();
  };
}

/** Per-IP limiter (for the public /signup endpoint). */
export function ipRateLimit(opts: { max: number; windowMs: number }) {
  return makeLimiter(opts, (req) => req.ip ?? "unknown");
}

/** Per-API-key limiter (apply AFTER apiKeyAuth). */
export function keyRateLimit(opts: { max: number; windowMs: number }) {
  return makeLimiter(opts, (req) => requireKey(req).id);
}
