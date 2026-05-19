/**
 * buyer/src/auth.ts — single-operator login primitives.
 *
 * The buyer-app sits on a public HTTP port and signs txs with a server-held
 * private key. Without a gate, anyone who reaches the port can drain the
 * operator's wallet via /v1/submit-prompt + /v1/accept. This module provides
 * the pieces an Express middleware needs to enforce a password-only gate:
 *
 *   - signSession / verifySession — HMAC-SHA256 signed cookies carrying
 *     { iat, exp }. No DB; revocation = wait for expiry or rotate SESSION_SECRET.
 *   - timingSafeCompareStrings — constant-time string equality for the
 *     password check and cookie signature compare.
 *   - createRateLimiter — in-memory per-IP brute-force limiter; resets on
 *     successful login or process restart.
 *   - SESSION_COOKIE_NAME / SESSION_MAX_AGE_MS / buildSessionCookieHeader —
 *     cookie header helpers shared by login, logout, and the rolling
 *     refresh in requireAuth.
 *
 * Pure (no Express imports). All time inputs are injectable for tests.
 */

import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "buyer_session";
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionPayload {
  /** issued-at, ms since epoch */
  iat: number;
  /** expires-at, ms since epoch */
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input: string): Buffer | null {
  // Reject non-base64url chars rather than silently decoding garbage.
  if (!/^[A-Za-z0-9_-]*$/.test(input)) return null;
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  try {
    return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
  } catch {
    return null;
  }
}

function hmac(secret: string, msg: string): Buffer {
  return createHmac("sha256", secret).update(msg).digest();
}

/** Sign a session payload as `<payloadB64>.<sigB64>`. */
export function signSession(secret: string, payload: SessionPayload): string {
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sigB64 = base64UrlEncode(hmac(secret, payloadB64));
  return `${payloadB64}.${sigB64}`;
}

export interface VerifyResult {
  valid: boolean;
  payload?: SessionPayload;
  reason?: "format" | "signature" | "expired";
}

/** Verify a `<payloadB64>.<sigB64>` string. */
export function verifySession(secret: string, raw: string, nowMs: number): VerifyResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { valid: false, reason: "format" };
  }
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) {
    return { valid: false, reason: "format" };
  }
  const payloadB64 = raw.slice(0, dot);
  const sigB64 = raw.slice(dot + 1);
  const expected = base64UrlEncode(hmac(secret, payloadB64));
  if (!timingSafeCompareStrings(sigB64, expected)) {
    return { valid: false, reason: "signature" };
  }
  const payloadJson = base64UrlDecode(payloadB64);
  if (payloadJson === null) return { valid: false, reason: "format" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson.toString("utf8"));
  } catch {
    return { valid: false, reason: "format" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { iat?: unknown }).iat !== "number" ||
    typeof (parsed as { exp?: unknown }).exp !== "number"
  ) {
    return { valid: false, reason: "format" };
  }
  const payload = parsed as SessionPayload;
  if (nowMs >= payload.exp) return { valid: false, reason: "expired" };
  return { valid: true, payload };
}

/**
 * Constant-time string compare. Pads both inputs to a common length so the
 * comparison time doesn't leak the secret's length. Always touches both
 * strings even when lengths differ.
 */
export function timingSafeCompareStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const eq = timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

// ─── Rate limiter ─────────────────────────────────────────────────────────

export interface RateLimitDecision {
  allowed: boolean;
  /** ms until the bucket resets. 0 when allowed. */
  retryAfterMs: number;
  /** Attempts consumed in the current window (including this one when allowed). */
  count: number;
}

export interface RateLimiter {
  attempt(key: string): RateLimitDecision;
  reset(key: string): void;
  /** For tests: clear all buckets. */
  clear(): void;
}

export interface RateLimiterOpts {
  max: number;
  windowMs: number;
  now?: () => number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Sliding-window rate limiter. Keyed by arbitrary string (typically req.ip).
 * Counts every call; on overflow returns `allowed=false` and the ms remaining
 * in the current window. `reset(key)` is called on successful login so a
 * legitimate operator who typo'd a few times isn't locked out.
 */
export function createRateLimiter(opts: RateLimiterOpts): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const now = opts.now ?? (() => Date.now());

  return {
    attempt(key: string): RateLimitDecision {
      const t = now();
      const existing = buckets.get(key);
      if (!existing || t - existing.windowStart >= opts.windowMs) {
        const fresh: Bucket = { count: 1, windowStart: t };
        buckets.set(key, fresh);
        return { allowed: true, retryAfterMs: 0, count: 1 };
      }
      if (existing.count >= opts.max) {
        const retryAfterMs = Math.max(0, opts.windowMs - (t - existing.windowStart));
        return { allowed: false, retryAfterMs, count: existing.count };
      }
      existing.count += 1;
      return { allowed: true, retryAfterMs: 0, count: existing.count };
    },
    reset(key: string): void {
      buckets.delete(key);
    },
    clear(): void {
      buckets.clear();
    },
  };
}

// ─── Cookie header helpers ────────────────────────────────────────────────

export interface CookieHeaderOpts {
  value: string;
  maxAgeMs: number;
  secure: boolean;
}

/** Build a Set-Cookie value for the session cookie. Path=/, HttpOnly, SameSite=Lax. */
export function buildSessionCookieHeader(opts: CookieHeaderOpts): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${opts.value}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeMs / 1000))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build a Set-Cookie value that clears the session cookie. */
export function buildClearCookieHeader(secure: boolean): string {
  return buildSessionCookieHeader({ value: "", maxAgeMs: 0, secure });
}

/**
 * Parse a single cookie value out of a `Cookie:` request header.
 * Returns null when the header is missing or the named cookie isn't present.
 * Tolerates leading whitespace and the standard `; `-separated format.
 */
export function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}
