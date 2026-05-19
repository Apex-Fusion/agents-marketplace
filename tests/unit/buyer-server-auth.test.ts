/**
 * buyer-server-auth.test.ts — coverage for the operator login gate.
 *
 * Two flavors:
 *   1. Pure-function tests for buyer/src/auth.ts (sign/verify, rate limit,
 *      cookie header helpers).
 *   2. Supertest-driven integration over createApp({password, sessionSecret})
 *      covering /v1/auth/{login,logout,whoami}, the /v1/* gate, and rolling
 *      cookie renewal.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../buyer/src/server.js";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  buildClearCookieHeader,
  buildSessionCookieHeader,
  createRateLimiter,
  getCookie,
  signSession,
  timingSafeCompareStrings,
  verifySession,
} from "../../buyer/src/auth.js";

// ─── Pure helpers ─────────────────────────────────────────────────────────

describe("auth: signSession / verifySession", () => {
  const SECRET = "0".repeat(64);

  it("round-trips a signed session", () => {
    const now = 1_700_000_000_000;
    const payload = { iat: now, exp: now + 1000 };
    const token = signSession(SECRET, payload);
    const r = verifySession(SECRET, token, now);
    expect(r.valid).toBe(true);
    expect(r.payload).toEqual(payload);
  });

  it("rejects an expired session", () => {
    const iat = 1_700_000_000_000;
    const exp = iat + 1000;
    const token = signSession(SECRET, { iat, exp });
    const r = verifySession(SECRET, token, exp); // now === exp ⇒ expired
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("expired");
  });

  it("rejects a tampered signature", () => {
    const iat = 1_700_000_000_000;
    const token = signSession(SECRET, { iat, exp: iat + 1000 });
    // Flip the last char of the signature segment.
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const r = verifySession(SECRET, tampered, iat);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature");
  });

  it("rejects a payload that doesn't parse", () => {
    const r = verifySession(SECRET, "not-a-session", 0);
    expect(r.valid).toBe(false);
  });

  it("rejects an empty string", () => {
    const r = verifySession(SECRET, "", 0);
    expect(r.valid).toBe(false);
  });
});

describe("auth: timingSafeCompareStrings", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeCompareStrings("hunter2", "hunter2")).toBe(true);
  });
  it("returns false for different strings of equal length", () => {
    expect(timingSafeCompareStrings("hunter2", "hunter3")).toBe(false);
  });
  it("returns false for strings of different lengths", () => {
    expect(timingSafeCompareStrings("a", "ab")).toBe(false);
    expect(timingSafeCompareStrings("ab", "a")).toBe(false);
  });
});

describe("auth: createRateLimiter", () => {
  it("allows up to max attempts then denies until window elapses", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
    expect(limiter.attempt("ip").allowed).toBe(true);
    expect(limiter.attempt("ip").allowed).toBe(true);
    expect(limiter.attempt("ip").allowed).toBe(true);
    const denied = limiter.attempt("ip");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // After the window slides past, the bucket resets.
    t += 1001;
    expect(limiter.attempt("ip").allowed).toBe(true);
  });

  it("reset() clears the bucket for a key", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    limiter.attempt("a");
    limiter.attempt("a");
    expect(limiter.attempt("a").allowed).toBe(false);
    limiter.reset("a");
    expect(limiter.attempt("a").allowed).toBe(true);
  });

  it("buckets are per-key", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.attempt("a").allowed).toBe(true);
    expect(limiter.attempt("b").allowed).toBe(true); // different key, fresh
    expect(limiter.attempt("a").allowed).toBe(false);
  });
});

describe("auth: cookie header helpers", () => {
  it("buildSessionCookieHeader sets HttpOnly/SameSite=Lax/Path=/", () => {
    const h = buildSessionCookieHeader({ value: "abc", maxAgeMs: 1000, secure: false });
    expect(h).toContain(`${SESSION_COOKIE_NAME}=abc`);
    expect(h).toContain("HttpOnly");
    expect(h).toContain("SameSite=Lax");
    expect(h).toContain("Path=/");
    expect(h).toContain("Max-Age=1");
    expect(h).not.toContain("Secure");
  });

  it("buildSessionCookieHeader appends Secure when requested", () => {
    const h = buildSessionCookieHeader({ value: "abc", maxAgeMs: 1000, secure: true });
    expect(h).toContain("Secure");
  });

  it("buildClearCookieHeader produces Max-Age=0", () => {
    const h = buildClearCookieHeader(false);
    expect(h).toContain("Max-Age=0");
    expect(h).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it("getCookie parses the named cookie out of a header", () => {
    expect(getCookie("a=1; buyer_session=xyz; b=2", "buyer_session")).toBe("xyz");
    expect(getCookie("buyer_session=xyz", "buyer_session")).toBe("xyz");
    expect(getCookie("a=1; b=2", "buyer_session")).toBeNull();
    expect(getCookie(undefined, "buyer_session")).toBeNull();
  });
});

// ─── Integration via supertest ────────────────────────────────────────────

const PASSWORD = "hunter2";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeAuthApp(overrides: { nowMs?: () => number } = {}) {
  return createApp({
    password: PASSWORD,
    sessionSecret: SECRET,
    cookieSecure: false, // tests run over plain HTTP
    nowMs: overrides.nowMs,
  });
}

/** Pull the buyer_session value out of a Set-Cookie response header. */
function extractSessionCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const m = /buyer_session=([^;]*)/.exec(h);
    if (m && m[1].length > 0) return m[1];
  }
  return null;
}

describe("createApp({password, sessionSecret}): /v1/auth/login", () => {
  it("rejects a missing body field with 400", async () => {
    const app = makeAuthApp();
    const res = await request(app).post("/v1/auth/login").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("password_required");
  });

  it("rejects a wrong password with 401", async () => {
    const app = makeAuthApp();
    const res = await request(app).post("/v1/auth/login").send({ password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_password");
  });

  it("accepts the right password with 204 + HttpOnly Set-Cookie", async () => {
    const app = makeAuthApp();
    const res = await request(app).post("/v1/auth/login").send({ password: PASSWORD });
    expect(res.status).toBe(204);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join(";") : setCookie;
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Lax");
    expect(extractSessionCookie(setCookie)).toBeTruthy();
  });

  it("rate-limits after 5 wrong attempts with 429 + Retry-After", async () => {
    const app = makeAuthApp();
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post("/v1/auth/login").send({ password: "wrong" });
      expect(r.status).toBe(401);
    }
    const sixth = await request(app).post("/v1/auth/login").send({ password: "wrong" });
    expect(sixth.status).toBe(429);
    expect(sixth.headers["retry-after"]).toBeDefined();
    // Even the correct password is rejected while the bucket is full.
    const seventh = await request(app).post("/v1/auth/login").send({ password: PASSWORD });
    expect(seventh.status).toBe(429);
  });

  it("a successful login resets the rate-limit bucket", async () => {
    const app = makeAuthApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post("/v1/auth/login").send({ password: "wrong" });
    }
    const ok = await request(app).post("/v1/auth/login").send({ password: PASSWORD });
    expect(ok.status).toBe(204);
    // After reset, four more wrong attempts shouldn't trip the limit.
    for (let i = 0; i < 4; i++) {
      const r = await request(app).post("/v1/auth/login").send({ password: "wrong" });
      expect(r.status).toBe(401);
    }
  });
});

describe("createApp: /v1/auth/whoami + protected /v1/* gate", () => {
  it("whoami without cookie returns 401", async () => {
    const app = makeAuthApp();
    const res = await request(app).get("/v1/auth/whoami");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
  });

  it("whoami with a valid session returns 200 and refreshes the cookie", async () => {
    const app = makeAuthApp();
    const login = await request(app).post("/v1/auth/login").send({ password: PASSWORD });
    const token = extractSessionCookie(login.headers["set-cookie"]);
    expect(token).not.toBeNull();
    const res = await request(app)
      .get("/v1/auth/whoami")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    // Rolling renewal: a fresh Set-Cookie should accompany the response.
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("whoami with a tampered cookie returns 401", async () => {
    const app = makeAuthApp();
    const login = await request(app).post("/v1/auth/login").send({ password: PASSWORD });
    const token = extractSessionCookie(login.headers["set-cookie"])!;
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const res = await request(app)
      .get("/v1/auth/whoami")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${tampered}`);
    expect(res.status).toBe(401);
  });

  it("whoami with an expired cookie returns 401", async () => {
    // Issue a cookie at t=0, then probe at t=SESSION_MAX_AGE_MS+1 to exceed exp.
    const start = 1_700_000_000_000;
    let now = start;
    const app = makeAuthApp({ nowMs: () => now });
    const login = await request(app).post("/v1/auth/login").send({ password: PASSWORD });
    const token = extractSessionCookie(login.headers["set-cookie"])!;
    now = start + SESSION_MAX_AGE_MS + 1;
    const res = await request(app)
      .get("/v1/auth/whoami")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(401);
  });

  it("a protected /v1/* route returns 401 without a cookie", async () => {
    const app = makeAuthApp();
    const res = await request(app).get("/v1/pending-receipts");
    expect(res.status).toBe(401);
  });

  it("a protected /v1/* route is reachable with a valid cookie", async () => {
    // The route still 503s on missing chain deps, but it gets past the gate.
    const app = makeAuthApp();
    const login = await request(app).post("/v1/auth/login").send({ password: PASSWORD });
    const token = extractSessionCookie(login.headers["set-cookie"])!;
    const res = await request(app)
      .get("/v1/pending-receipts")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
    expect(res.status).not.toBe(401);
  });

  it("GET /healthz is open even without a cookie", async () => {
    const app = makeAuthApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });
});

describe("createApp: /v1/auth/logout", () => {
  it("logout clears the cookie (Max-Age=0) and is idempotent", async () => {
    const app = makeAuthApp();
    const login = await request(app).post("/v1/auth/login").send({ password: PASSWORD });
    const token = extractSessionCookie(login.headers["set-cookie"])!;
    const out = await request(app)
      .post("/v1/auth/logout")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
    expect(out.status).toBe(204);
    const setCookie = out.headers["set-cookie"];
    const flat = Array.isArray(setCookie) ? setCookie.join(";") : setCookie;
    expect(flat).toContain("Max-Age=0");
    // Idempotent: same call without a session still 204s.
    const again = await request(app).post("/v1/auth/logout");
    expect(again.status).toBe(204);
  });
});

describe("createApp without auth deps (test/library shape)", () => {
  it("does not gate /v1/* and does not mount /v1/auth/* routes", async () => {
    const app = createApp({});
    // No /v1/auth/login route → 404.
    const login = await request(app).post("/v1/auth/login").send({ password: "any" });
    expect(login.status).toBe(404);
    // /healthz still works.
    const health = await request(app).get("/healthz");
    expect(health.status).toBe(200);
  });
});
