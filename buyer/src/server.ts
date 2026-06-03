/**
 * buyer/src/server.ts — createApp(deps) for the buyer web server.
 *
 * Routes:
 *   GET  /healthz                  → { ok: true } (no chain or indexer touch)
 *   GET  /v1/pending-receipts      → list the buyer's currently-Submitted escrows
 *                                    from the indexer (pre-filtered by buyer_pkh)
 *   POST /v1/accept                → resolve original escrow_ref → current Submitted
 *                                    UTxO via the indexer, run runAccept against
 *                                    the LiveOgmiosProvider, return the Accept tx hash
 *   *                              → static SPA bundle from `distPath`, with
 *                                    SPA fallback to index.html
 *
 * The Accept endpoint exists because the browser holds no private key and
 * can't talk to Ogmios directly (no submit, CORS) — the server is the only
 * place that can sign + submit. The /v1/pending-receipts endpoint is a thin
 * convenience proxy; the browser could hit the indexer directly, but routing
 * through the buyer-app keeps the buyer_pkh out of the page bundle.
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync, statSync } from "fs";
import { bech32 } from "bech32";
import type { ChainProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import type { Marketplace } from "./sdk/Marketplace.js";
import type { ChatMessage } from "@marketplace/shared/tx";
import { canonicalize } from "@marketplace/shared/cbor";
import { runAccept } from "./cli/acceptFlow.js";
import type { ResponseArchive } from "./db/archive.js";
import { registerPdfRoutes } from "./pdf/routes.js";
import { defaultPdfCaps } from "./pdf/caps.js";
import type { PdfCaps } from "./pdf/types.js";
import type { JobStore } from "./pdf/summarize-job.js";
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
  type RateLimiter,
} from "./auth.js";

const ESCROW_REF_RE = /^([0-9a-f]{64})#(\d+)$/;

export interface IndexerEscrowRow {
  utxo_ref: string;
  buyer_pkh: string;
  supplier_pkh: string;
  state: string;
  posted_at: number;
  submitted_at: number | null;
  result_receipt_hash: string | null;
  capability_id: string;
  prompt_hash: string;
  payment_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
  deliver_by: number;
  created_slot: number;
}

export interface AppDeps {
  /** Absolute path to the Vite-built static directory (buyer/dist). */
  distPath?: string;
  /** ChainProvider; must be Live for /v1/accept to work. */
  chain?: ChainProvider;
  /** Buyer wallet key — used by runAccept to sign the Accept tx. */
  walletKey?: WalletKey;
  /** Indexer base URL (no trailing slash). */
  indexerUrl?: string;
  /** Marketplace SDK instance — used by /v1/submit-prompt to drive the
   * full PostEscrow → supplier → receipt-verify lifecycle server-side.
   * The browser SPA calls fetch('/v1/submit-prompt') instead of touching
   * the SDK directly, so the chain stub in the SPA never has to fire. */
  marketplace?: Marketplace;
  /** Base URL of the openedai-speech-min PiperTTS deployment that
   * `/v1/synth-speech` proxies to. Falls back to the public Vector-testnet
   * host when not set. Endpoint stays disabled (503) when this is empty. */
  ttsPiperBaseUrl?: string;
  /** Persistent off-chain audit trail. When provided, every successful
   * submitPrompt / submitTts call writes a row + on-disk artefacts and
   * /v1/responses* exposes the archive read-only. When undefined the
   * archive endpoints respond 503 and the lifecycle still works (just
   * without history beyond the indexer). */
  archive?: ResponseArchive;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Operator login password (BUYER_PASSWORD). When missing, all /v1/*
   * non-auth routes and the SPA shell respond 503 auth_unconfigured. */
  password?: string;
  /** HMAC key for the buyer_session cookie (SESSION_SECRET). When missing,
   * auth is treated as unconfigured (same 503 behavior as a missing password). */
  sessionSecret?: string;
  /** When true, the session cookie carries the Secure attribute. Defaults
   * to true; tests and local-loopback dev override to false. */
  cookieSecure?: boolean;
  /** Injectable clock for cookie issued-at / expiry calculations and the
   * brute-force rate-limit window. Defaults to Date.now. Tests use a fake
   * clock to drive expiry and rolling-renewal assertions deterministically. */
  nowMs?: () => number;
  /** PDF book summarizer job registry. When provided, the /v1/pdf-* routes
   * are live; when omitted they respond 503 (feature disabled). Built in
   * runMain from the same marketplace/chain/wallet/archive deps. */
  jobStore?: JobStore;
  /** Sizing/safety knobs for the PDF summarizer. Defaults applied when absent. */
  pdfCaps?: PdfCaps;
}

interface ResolvedDeps {
  chain: ChainProvider;
  walletKey: WalletKey;
  indexerUrl: string;
  fetchImpl: typeof globalThis.fetch;
}

function jsonError(
  res: Response,
  status: number,
  reason: string,
  message: string,
): Response {
  return res.status(status).json({ error: reason, message });
}

/** Coerce req.body to a plain object, treating null/undefined as empty. */
function readBody(reqBody: unknown): Record<string, unknown> {
  if (typeof reqBody !== "object" || reqBody === null) return {};
  return reqBody as Record<string, unknown>;
}

/** Mainnet enterprise (vkh) bech32 address for a given 28-byte PKH hex. The
 * buyer-app exposes this for display only; it matches what lucid actually
 * uses when building txs (lucid is configured with network "Mainnet" because
 * Vector L2 shares mainnet's CIP-19 byte semantics). */
function pkhToMainnetAddress(pubKeyHashHex: string): string {
  if (!/^[0-9a-fA-F]{56}$/.test(pubKeyHashHex)) {
    return "";
  }
  const pkh = new Uint8Array(28);
  for (let i = 0; i < 28; i++) {
    pkh[i] = parseInt(pubKeyHashHex.substring(i * 2, i * 2 + 2), 16);
  }
  const payload = new Uint8Array(29);
  payload[0] = 0x61; // mainnet enterprise vkh header
  payload.set(pkh, 1);
  return bech32.encode("addr", bech32.toWords(payload), 1023);
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // ─── Auth wiring ───────────────────────────────────────────────────────
  // The single-operator login gate. When `password` and `sessionSecret` are
  // both configured, every /v1/* route below (other than /v1/auth/*) and the
  // SPA boot block require a valid buyer_session cookie.
  //
  // When either is missing, `authReady` is false and the gate is bypassed
  // entirely (no /v1/auth/* routes mounted; no requireAuth middleware). This
  // is purely a test-construction shape — the production boot path
  // (runMain → loadConfig) refuses to start without both env vars, so a
  // deployment with `authReady === false` is impossible.
  const authReady =
    typeof deps.password === "string" && deps.password.length > 0 &&
    typeof deps.sessionSecret === "string" && deps.sessionSecret.length > 0;
  const cookieSecure = deps.cookieSecure !== false; // default true
  const nowMs = deps.nowMs ?? (() => Date.now());

  // Brute-force limiter: 5 attempts per 15 minutes per IP. In-memory only;
  // resets on a successful login (legitimate operator who typo'd) and on
  // process restart. For a single-operator service this is the right trade.
  const loginLimiter: RateLimiter = createRateLimiter({
    max: 5,
    windowMs: 15 * 60 * 1000,
    now: nowMs,
  });

  function clientIp(req: Request): string {
    // Default Express req.ip honors `trust proxy`; we deliberately don't
    // enable trust proxy here, so this is the direct socket peer. Operators
    // behind a reverse proxy that masks the client should configure
    // trust proxy on the outer Express; for our brute-force gate, even the
    // proxy IP is a usable bucket key (it just rate-limits the proxy itself).
    return req.ip ?? "unknown";
  }

  function issueSessionCookie(res: Response): void {
    if (!authReady) return;
    const iat = nowMs();
    const exp = iat + SESSION_MAX_AGE_MS;
    const token = signSession(deps.sessionSecret!, { iat, exp });
    res.setHeader(
      "Set-Cookie",
      buildSessionCookieHeader({ value: token, maxAgeMs: SESSION_MAX_AGE_MS, secure: cookieSecure }),
    );
  }

  if (authReady) {
    /**
     * Express middleware that requires a valid buyer_session cookie. On
     * success, refreshes the cookie (rolling SESSION_MAX_AGE_MS expiry).
     * On failure responds 401 unauthenticated for /v1/* — the SPA shell
     * route lower in the file separately handles the unauth HTML case
     * by serving the bundle without the boot block.
     */
    const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
      const raw = getCookie(req.headers.cookie, SESSION_COOKIE_NAME);
      if (raw === null) {
        jsonError(res, 401, "unauthenticated", "no session cookie");
        return;
      }
      const result = verifySession(deps.sessionSecret!, raw, nowMs());
      if (!result.valid) {
        jsonError(res, 401, "unauthenticated", `session ${result.reason ?? "invalid"}`);
        return;
      }
      // Rolling renewal — every authenticated request pushes exp out another
      // SESSION_MAX_AGE_MS. Keeps active operators logged in without ever
      // accumulating long-lived tokens that linger past inactivity.
      issueSessionCookie(res);
      next();
    };

    // /v1/auth/* — login, logout, whoami. Mounted before any protected
    // /v1/* routes so requireAuth doesn't gate login itself. /v1/auth/whoami
    // is intentionally protected — the SPA's AuthProvider uses it as a
    // "do I have a valid session?" probe.
    app.post("/v1/auth/login", (req: Request, res: Response) => {
      const ip = clientIp(req);
      const limit = loginLimiter.attempt(ip);
      if (!limit.allowed) {
        const retryAfterSec = Math.ceil(limit.retryAfterMs / 1000);
        res.setHeader("Retry-After", String(retryAfterSec));
        jsonError(
          res,
          429,
          "rate_limited",
          `too many login attempts; try again in ${retryAfterSec}s`,
        );
        return;
      }
      const body = readBody(req.body);
      const password = body.password;
      if (typeof password !== "string" || password.length === 0) {
        jsonError(res, 400, "password_required", 'body must include { "password": "<string>" }');
        return;
      }
      if (!timingSafeCompareStrings(password, deps.password!)) {
        jsonError(res, 401, "invalid_password", "incorrect password");
        return;
      }
      loginLimiter.reset(ip);
      issueSessionCookie(res);
      res.status(204).end();
    });

    app.post("/v1/auth/logout", (_req: Request, res: Response) => {
      // Idempotent — safe to call without an existing session. We always
      // set the clear cookie header so any stale cookie in the browser is
      // overwritten regardless of whether it was valid.
      res.setHeader("Set-Cookie", buildClearCookieHeader(cookieSecure));
      res.status(204).end();
    });

    app.get("/v1/auth/whoami", requireAuth, (_req: Request, res: Response) => {
      res.status(200).json({ authenticated: true });
    });

    // Every other /v1/* route is protected. Mount the gate as a path-prefix
    // middleware that skips /v1/auth/* (already mounted above) but applies
    // to everything else under /v1/.
    app.use("/v1", (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith("/auth/")) {
        next();
        return;
      }
      requireAuth(req, res, next);
    });
  }

  // chain/walletKey/indexerUrl are required for /v1/* routes; if any is
  // missing we still mount the static bundle but the API endpoints respond
  // 503 service_unavailable so the SPA can render a clear "boot misconfigured"
  // banner instead of the process crashing.
  const apiReady =
    deps.chain !== undefined &&
    deps.walletKey !== undefined &&
    deps.indexerUrl !== undefined &&
    deps.indexerUrl !== "";
  const resolved: ResolvedDeps | null = apiReady
    ? {
        chain: deps.chain!,
        walletKey: deps.walletKey!,
        indexerUrl: deps.indexerUrl!.replace(/\/+$/, ""),
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
      }
    : null;

  app.get("/v1/pending-receipts", async (_req: Request, res: Response) => {
    if (!resolved) {
      return jsonError(
        res,
        503,
        "service_unavailable",
        "buyer-app booted without chain/indexer deps; /v1/* routes disabled",
      );
    }
    try {
      const url = `${resolved.indexerUrl}/escrows?buyer=${resolved.walletKey.pubKeyHash}`;
      const response = await resolved.fetchImpl(url);
      if (!response.ok) {
        return jsonError(
          res,
          502,
          "indexer_error",
          `indexer responded ${response.status}: ${response.statusText}`,
        );
      }
      const rows = (await response.json()) as IndexerEscrowRow[];
      // Three filters, applied in order:
      //   (1) state === "Submitted" — only Submitted rows are Accept-able.
      //   (2) submitted_at + ACCEPT_WINDOW_MS > Date.now() — drop rows whose
      //       Accept window has already expired. The validator's
      //       handle_accept rejects past-window txs, so listing them in the
      //       UI just produces "expired" placeholders the user can't action.
      //       Deterministic time math: avoids the keep-on-error race in
      //       the chain probe below.
      //   (3) chain.queryUtxo returns non-null — the indexer doesn't update
      //       an escrow row's `state` when AcceptEscrow / ReleaseEscrow /
      //       ReclaimEscrow spend the UTxO, so already-terminated
      //       lifecycles linger as state="Submitted" until that's fixed.
      const ACCEPT_WINDOW_MS = 600_000;
      const now = Date.now();
      const submitted = (Array.isArray(rows) ? rows : [])
        .filter((r) => r.state === "Submitted")
        .filter((r) => typeof r.submitted_at === "number"
          && (r.submitted_at + ACCEPT_WINDOW_MS) > now);
      const m = ESCROW_REF_RE;
      const checks = await Promise.all(
        submitted.map(async (row) => {
          const match = m.exec(row.utxo_ref);
          if (!match) return null;
          try {
            const utxo = await resolved.chain.queryUtxo({
              txHash: match[1],
              index: Number(match[2]),
            });
            return utxo === null ? null : row;
          } catch {
            return row; // on chain query error, keep the row (avoids hiding good ones)
          }
        }),
      );
      const live = checks.filter((r): r is IndexerEscrowRow => r !== null);
      return res.status(200).json({ escrows: live });
    } catch (err) {
      return jsonError(
        res,
        502,
        "indexer_unreachable",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // ── /v1/indexer/* — generic GET passthrough to the internal indexer.
  // The SPA's SDK is configured with `indexerUrl = ${origin}/v1/indexer`,
  // so calls like `/suppliers`, `/escrows?buyer=…`, `/capabilities` land
  // here and get forwarded to http://marketplace-indexer:8090/<rest>. This
  // avoids CORS and keeps the indexer host name out of the page bundle.
  // GET-only on purpose: the indexer has no write endpoints, and the
  // browser must never push state through this proxy.
  app.get(/^\/v1\/indexer(\/.*)?$/, async (req: Request, res: Response) => {
    if (!resolved) {
      return jsonError(
        res,
        503,
        "service_unavailable",
        "buyer-app booted without chain/indexer deps; /v1/indexer disabled",
      );
    }
    const subpath = (req.params as { 0?: string })[0] ?? "/";
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const url = `${resolved.indexerUrl}${subpath}${qs}`;
    try {
      const upstream = await resolved.fetchImpl(url);
      const ct = upstream.headers.get("content-type") ?? "application/json";
      res.status(upstream.status);
      res.setHeader("Content-Type", ct);
      const body = await upstream.text();
      res.send(body);
      return;
    } catch (err) {
      return jsonError(
        res,
        502,
        "indexer_unreachable",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // ── POST /v1/submit-prompt — full server-side buyer lifecycle.
  // Body: { advert_ref: "<txhash>#<idx>", messages: ChatMessage[],
  //         payment_lovelace?: string|number, max_output_tokens?: number }
  // Returns: { receipt, receipt_signature, escrow_ref, choices?, usage? }
  // This endpoint blocks for the duration of the lifecycle (PostEscrow
  // confirm → supplier inference → on-chain verify, typically 30–60s on
  // testnet). The SDK's submitPrompt() handles every adversarial branch;
  // we just translate body↔SDK-shape and re-throw structured errors.
  app.post("/v1/submit-prompt", async (req: Request, res: Response) => {
    if (!deps.marketplace) {
      return jsonError(
        res,
        503,
        "service_unavailable",
        "buyer-app booted without Marketplace SDK; /v1/submit-prompt disabled",
      );
    }
    const body = readBody(req.body);
    const rawRef = body.advert_ref;
    if (typeof rawRef !== "string" || !ESCROW_REF_RE.test(rawRef)) {
      return jsonError(
        res,
        400,
        "advert_ref_invalid",
        'body must include { "advert_ref": "<64-hex-txhash>#<index>" }',
      );
    }
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonError(
        res,
        400,
        "messages_required",
        "body must include a non-empty messages[] array",
      );
    }
    const m = ESCROW_REF_RE.exec(rawRef)!;
    const advertRef = { txHash: m[1], index: Number(m[2]) };
    let payment_lovelace: bigint;
    try {
      payment_lovelace = BigInt(body.payment_lovelace as string | number);
    } catch {
      return jsonError(
        res,
        400,
        "payment_lovelace_invalid",
        'body must include `payment_lovelace` (numeric string)',
      );
    }
    const max_output_tokens =
      typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined;
    try {
      const result = await deps.marketplace.submitPrompt({
        advertRef,
        messages: messages as ChatMessage[],
        payment_lovelace,
        max_output_tokens,
      });
      const escrowRefStr = `${result.escrowRef.txHash}#${result.escrowRef.index}`;

      // Persist BEFORE returning so navigation away never loses the audit
      // trail. Best-effort — a write failure is logged but doesn't fail
      // the response (the on-chain receipt is still authoritative).
      if (deps.archive) {
        try {
          // Reproduce the EXACT bytes the supplier hashed for response_hash:
          // sha256(canonicalize({role:"assistant", content: ...})). canonicalize
          // sorts keys alphabetically (content < role) per JCS — JSON.stringify
          // would preserve insertion order and yield different bytes → wrong
          // sha256 → "Verify hash" mismatch on the SPA.
          const canonicalAssistant = canonicalize({
            role: "assistant",
            content: result.response,
          });
          deps.archive.persistChat({
            escrow_ref: escrowRefStr,
            posted_at: Date.now(),
            capability_id: "llm.text.generate.v1",
            supplier_pkh: result.receipt.supplier_pkh,
            model: result.receipt.model,
            payment_lovelace: payment_lovelace.toString(),
            request_messages: messages,
            response_canonical: canonicalAssistant,
            receipt: result.receipt as unknown as Record<string, unknown>,
            receipt_signature: result.receiptSignature,
          });
        } catch (err) {
          console.error(
            `[buyer] archive.persistChat failed for ${escrowRefStr}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Wrap the assistant text in OpenAI-shape `choices[0].message` so
      // downstream clients (PromptForm) can unpack uniformly.
      return res.status(200).json({
        choices: [{ index: 0, message: { role: "assistant", content: result.response }, finish_reason: "stop" }],
        receipt: result.receipt,
        receipt_signature: result.receiptSignature,
        escrow_ref: escrowRefStr,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = err instanceof Error && "reason" in err
        ? String((err as { reason: unknown }).reason)
        : "submit_prompt_failed";
      // Surface the failure to logs so 502 responses aren't a silent black
      // hole during deploy debugging. SDK errors carry .reason; raw Errors
      // carry stack — we want both.
      console.error(
        `[buyer] /v1/submit-prompt failed reason=${reason} message=${message}`,
        err instanceof Error && err.stack ? `\n${err.stack}` : "",
      );
      return res.status(502).json({ error: reason, message });
    }
  });

  // ── POST /v1/synth-speech — PiperTTS-specific proxy.
  // Body: { text, voice, format, speed }
  // Returns: audio bytes (Content-Type from upstream, e.g. audio/mpeg).
  //
  // Path B of the multi-capability story: the SPA's `PiperTTSForm` component
  // hits this directly (no escrow yet) so we can demo the audio.synthesize.
  // piper.v1 capability without waiting for the on-chain TTS-supplier
  // adapter to land. The endpoint is intentionally locked to PiperTTS' OpenAI-
  // shape `/v1/audio/speech` — different TTS providers (xtts, coqui, …) get
  // their own endpoint so each form's parameter space is explicit.
  //
  // Knobs limited to what openedai-speech-min actually honours:
  //   voice ∈ alloy|echo|fable|onyx|nova|shimmer|lessac
  //   format ∈ mp3|wav|opus|aac|flac
  //   speed ∈ [0.5, 1.5]
  const ALLOWED_VOICES = new Set([
    "alloy", "echo", "fable", "onyx", "nova", "shimmer", "lessac",
  ]);
  const ALLOWED_FORMATS = new Set(["mp3", "wav", "opus", "aac", "flac"]);
  const ttsPiperBaseUrl = (deps.ttsPiperBaseUrl ?? "").replace(/\/+$/, "");
  const ttsFetch = deps.fetchImpl ?? globalThis.fetch;

  app.post("/v1/synth-speech", async (req: Request, res: Response) => {
    if (!ttsPiperBaseUrl) {
      return jsonError(
        res,
        503,
        "service_unavailable",
        "buyer-app booted without TTS_PIPER_BASE_URL; /v1/synth-speech disabled",
      );
    }

    const body = readBody(req.body);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0) {
      return jsonError(res, 400, "text_required",
        "body.text must be a non-empty string");
    }
    if (text.length > 4000) {
      return jsonError(res, 400, "text_too_long",
        "body.text must be ≤ 4000 chars (Piper softcap; longer texts can be split client-side)");
    }
    const voice = typeof body.voice === "string" ? body.voice : "nova";
    if (!ALLOWED_VOICES.has(voice)) {
      return jsonError(res, 400, "voice_invalid",
        `voice must be one of: ${[...ALLOWED_VOICES].join(", ")}`);
    }
    const format = typeof body.format === "string" ? body.format : "mp3";
    if (!ALLOWED_FORMATS.has(format)) {
      return jsonError(res, 400, "format_invalid",
        `format must be one of: ${[...ALLOWED_FORMATS].join(", ")}`);
    }
    const speedRaw = body.speed;
    const speed = typeof speedRaw === "number" ? speedRaw
      : typeof speedRaw === "string" ? Number(speedRaw)
      : 1.0;
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 1.5) {
      return jsonError(res, 400, "speed_out_of_range",
        "speed must be a finite number in [0.5, 1.5]");
    }

    try {
      const upstream = await ttsFetch(`${ttsPiperBaseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice,
          response_format: format,
          speed,
        }),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        return jsonError(
          res,
          502,
          "tts_upstream_error",
          `TTS upstream ${upstream.status} ${upstream.statusText}: ${detail.slice(0, 200)}`,
        );
      }
      const contentType = upstream.headers.get("content-type") ?? `audio/${format}`;
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.status(200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(buf.length));
      // Hint a sensible filename for the SPA's download anchor.
      res.setHeader("Content-Disposition",
        `inline; filename="speech.${format}"`);
      return res.send(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[buyer] /v1/synth-speech failed: ${message}`);
      return jsonError(res, 502, "tts_unreachable", message);
    }
  });

  // ── POST /v1/submit-tts — full server-side buyer lifecycle for TTS.
  // Body: { advert_ref, text, voice, format, speed, payment_lovelace }
  // Returns: { audio_b64, format, content_type, byte_length, receipt,
  //            receipt_signature, escrow_ref }
  //
  // Same shape as /v1/submit-prompt but routes to Marketplace.submitTts
  // instead. Audio bytes are base64'd in the JSON response so the SPA's
  // PiperTTSForm can decode → blob → <audio> + Download anchor without
  // negotiating a binary content-type with the SDK layer.
  app.post("/v1/submit-tts", async (req: Request, res: Response) => {
    if (!deps.marketplace) {
      return jsonError(res, 503, "service_unavailable",
        "buyer-app booted without Marketplace SDK; /v1/submit-tts disabled");
    }
    const body = readBody(req.body);
    const rawRef = body.advert_ref;
    if (typeof rawRef !== "string" || !ESCROW_REF_RE.test(rawRef)) {
      return jsonError(res, 400, "advert_ref_invalid",
        'body must include { "advert_ref": "<64-hex-txhash>#<index>" }');
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0) {
      return jsonError(res, 400, "text_required",
        "body.text must be a non-empty string");
    }
    const voice = typeof body.voice === "string" ? body.voice : "nova";
    const format = typeof body.format === "string" ? body.format : "mp3";
    const speedRaw = body.speed;
    const speed = typeof speedRaw === "number" ? speedRaw
      : typeof speedRaw === "string" ? Number(speedRaw)
      : 1.0;
    let payment_lovelace: bigint;
    try {
      payment_lovelace = BigInt(body.payment_lovelace as string | number);
    } catch {
      return jsonError(res, 400, "payment_lovelace_invalid",
        "body must include `payment_lovelace` (numeric string)");
    }
    const m = ESCROW_REF_RE.exec(rawRef)!;
    const advertRef = { txHash: m[1], index: Number(m[2]) };
    try {
      const result = await deps.marketplace.submitTts({
        advertRef,
        text,
        voice,
        format,
        speed,
        payment_lovelace,
      });
      const escrowRefStr = `${result.escrowRef.txHash}#${result.escrowRef.index}`;

      if (deps.archive) {
        try {
          // Decode base64 audio back to raw bytes — storing them on disk in
          // their original form keeps verification simple (sha256 over the
          // same bytes the supplier hashed for response_hash).
          const audio = Buffer.from(result.audio_b64, "base64");
          deps.archive.persistTts({
            escrow_ref: escrowRefStr,
            posted_at: Date.now(),
            capability_id: "audio.synthesize.piper.v1",
            supplier_pkh: result.receipt.supplier_pkh,
            model: result.receipt.model,
            payment_lovelace: payment_lovelace.toString(),
            request_envelope: { text, voice, format, speed },
            response_audio: audio,
            response_content_type: result.content_type,
            receipt: result.receipt as unknown as Record<string, unknown>,
            receipt_signature: result.receiptSignature,
          });
        } catch (err) {
          console.error(
            `[buyer] archive.persistTts failed for ${escrowRefStr}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return res.status(200).json({
        audio_b64: result.audio_b64,
        format: result.format,
        content_type: result.content_type,
        byte_length: result.byte_length,
        receipt: result.receipt,
        receipt_signature: result.receiptSignature,
        escrow_ref: escrowRefStr,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = err instanceof Error && "reason" in err
        ? String((err as { reason: unknown }).reason)
        : "submit_tts_failed";
      console.error(
        `[buyer] /v1/submit-tts failed reason=${reason} message=${message}`,
        err instanceof Error && err.stack ? `\n${err.stack}` : "",
      );
      return res.status(502).json({ error: reason, message });
    }
  });

  app.post("/v1/accept", async (req: Request, res: Response) => {
    if (!resolved) {
      return jsonError(
        res,
        503,
        "service_unavailable",
        "buyer-app booted without chain/indexer deps; /v1/accept disabled",
      );
    }
    const acceptBody = readBody(req.body);
    const rawRef = acceptBody.escrow_ref;
    if (typeof rawRef !== "string" || !ESCROW_REF_RE.test(rawRef)) {
      return jsonError(
        res,
        400,
        "escrow_ref_invalid",
        'body must be { "escrow_ref": "<64-hex-txhash>#<index>" }',
      );
    }

    // Resolve the current Submitted UTxO. Rows in the same lifecycle share
    // posted_at (the validator's expect_unchanged_modulo_state preserves it
    // through Open → Claimed → Submitted). Fetch all of the buyer's escrows,
    // pick the row matching the user-supplied ref to extract its posted_at,
    // then find the Submitted row for that same posted_at. If the user
    // already supplied the current Submitted ref, accept it directly.
    let currentRefStr: string;
    try {
      const url = `${resolved.indexerUrl}/escrows?buyer=${resolved.walletKey.pubKeyHash}`;
      const response = await resolved.fetchImpl(url);
      if (!response.ok) {
        return jsonError(
          res,
          502,
          "indexer_error",
          `indexer responded ${response.status}: ${response.statusText}`,
        );
      }
      const rows = (await response.json()) as IndexerEscrowRow[];
      if (!Array.isArray(rows)) {
        return jsonError(
          res,
          502,
          "indexer_error",
          "indexer /escrows did not return an array",
        );
      }
      const direct = rows.find(
        (r) => r.utxo_ref === rawRef && r.state === "Submitted",
      );
      if (direct) {
        currentRefStr = direct.utxo_ref;
      } else {
        const lifecycleRow = rows.find((r) => r.utxo_ref === rawRef);
        if (!lifecycleRow) {
          return jsonError(
            res,
            404,
            "escrow_not_found",
            `no escrow row matches ${rawRef} for this buyer`,
          );
        }
        const submitted = rows.find(
          (r) =>
            r.posted_at === lifecycleRow.posted_at && r.state === "Submitted",
        );
        if (!submitted) {
          return jsonError(
            res,
            409,
            "no_submitted_state",
            `lifecycle for ${rawRef} has no current Submitted UTxO (state may be ${lifecycleRow.state})`,
          );
        }
        currentRefStr = submitted.utxo_ref;
      }
    } catch (err) {
      return jsonError(
        res,
        502,
        "indexer_unreachable",
        err instanceof Error ? err.message : String(err),
      );
    }

    const m = ESCROW_REF_RE.exec(currentRefStr)!;
    const escrowRef = { txHash: m[1], index: Number(m[2]) };

    // Pre-flight: the indexer can return stale Submitted rows after an
    // accept lands on chain (it doesn't yet propagate spent_slot into the
    // escrow row's state). Verify the UTxO is still unspent before
    // running the live Accept tx, so we surface a clean 409 JSON instead
    // of letting runAccept throw a 5xx with internal Ogmios noise.
    try {
      const utxo = await resolved.chain.queryUtxo(escrowRef);
      if (utxo === null) {
        return jsonError(
          res,
          409,
          "already_accepted",
          `escrow ${currentRefStr} has already been accepted (UTxO is no longer on chain)`,
        );
      }
    } catch (err) {
      // Chain probe failed — proceed to runAccept; if the UTxO is missing,
      // runAccept will fail with a structured TxConstructionError which
      // becomes a 502 below. Don't block on a transient Ogmios hiccup.
    }

    try {
      const result = await runAccept({
        chain: resolved.chain,
        walletKey: resolved.walletKey,
        escrowRef,
        log: (line) => process.stderr.write(`[accept] ${line}\n`),
      });
      return res.status(200).json({
        tx_hash: result.txHash,
        accepted_ref: currentRefStr,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(res, 502, "accept_failed", message);
    }
  });

  // ── Response archive (off-chain audit trail) ────────────────────────
  // Read-only views over the buyer-app's persistent record of every
  // completed lifecycle. The archive persists at the END of submitPrompt
  // / submitTts, BEFORE returning to the SPA, so navigation away never
  // loses the artefact. Each row points at on-disk files in ARCHIVE_DIR
  // that contain the exact bytes the supplier hashed for response_hash —
  // verifiable by computing sha256 over the file and comparing to
  // receipt.response_hash, then verifying the receipt's Ed25519 signature
  // against the supplier's published pub_key_hex. Combined with the
  // on-chain Submit tx's result_receipt_hash commitment, this is a full
  // audit trail for dispute resolution.
  if (!deps.archive) {
    const disabledMsg = "buyer-app booted without ARCHIVE_DIR; /v1/responses* disabled";
    app.get(/^\/v1\/responses(\/.*)?$/, (_req: Request, res: Response) =>
      jsonError(res, 503, "service_unavailable", disabledMsg),
    );
  } else {
    const archive = deps.archive;

    // GET /v1/responses?limit=100 — list metadata, newest first.
    app.get("/v1/responses", (req: Request, res: Response) => {
      const limitRaw = (req.query.limit as string | undefined) ?? "";
      const limit = /^[1-9]\d*$/.test(limitRaw) ? Math.min(Number(limitRaw), 500) : 100;
      const rows = archive.list(limit);
      // Strip the receipt_json string into a parsed object for nicer SPA
      // rendering, but keep receipt_signature alongside for verification.
      const view = rows.map((r) => ({
        escrow_ref: r.escrow_ref,
        posted_at: r.posted_at,
        completed_at: r.completed_at,
        capability_id: r.capability_id,
        supplier_pkh: r.supplier_pkh,
        model: r.model,
        payment_lovelace: r.payment_lovelace,
        response_content_type: r.response_content_type,
        response_byte_length: r.response_byte_length,
        receipt: JSON.parse(r.receipt_json),
        receipt_signature: r.receipt_signature,
      }));
      return res.status(200).json({ responses: view });
    });

    // The archive stores escrow refs in canonical "<txhash>#<index>" form.
    // URL paths can't carry "#" (fragment delimiter) so the API uses the
    // dir-safe "<txhash>_<index>" form in path segments — matches the
    // filesystem layout on disk for trivial debugging. Server normalises
    // back to "#" before SQLite lookup.
    const URL_REF = /^([0-9a-f]{64})_(\d+)$/;
    function normaliseUrlRef(urlRef: string): string | null {
      const m = URL_REF.exec(urlRef);
      return m ? `${m[1]}#${m[2]}` : null;
    }

    // GET /v1/responses/:escrow_ref — single-row metadata + receipt.
    app.get("/v1/responses/:ref", (req: Request, res: Response) => {
      const ref = normaliseUrlRef(typeof req.params.ref === "string" ? req.params.ref : "");
      if (!ref) return jsonError(res, 400, "ref_invalid",
        'path segment must be "<64hex>_<int>" (URL-safe form of escrow_ref)');
      const row = archive.get(ref);
      if (!row) {
        return jsonError(res, 404, "not_found", `no archive entry for ${ref}`);
      }
      return res.status(200).json({
        escrow_ref: row.escrow_ref,
        posted_at: row.posted_at,
        completed_at: row.completed_at,
        capability_id: row.capability_id,
        supplier_pkh: row.supplier_pkh,
        model: row.model,
        payment_lovelace: row.payment_lovelace,
        response_content_type: row.response_content_type,
        response_byte_length: row.response_byte_length,
        request_filename: row.request_filename,
        response_filename: row.response_filename,
        receipt: JSON.parse(row.receipt_json),
        receipt_signature: row.receipt_signature,
      });
    });

    // GET /v1/responses/:escrow_ref/request — raw request artefact bytes.
    app.get("/v1/responses/:ref/request", (req: Request, res: Response) => {
      const ref = normaliseUrlRef(typeof req.params.ref === "string" ? req.params.ref : "");
      if (!ref) return jsonError(res, 400, "ref_invalid", "bad ref");
      const bytes = archive.readRequest(ref);
      if (!bytes) return jsonError(res, 404, "not_found", `no request artefact for ${ref}`);
      res.setHeader("Content-Type", "application/json");
      return res.send(bytes);
    });

    // GET /v1/responses/:escrow_ref/response — raw response artefact bytes.
    app.get("/v1/responses/:ref/response", (req: Request, res: Response) => {
      const ref = normaliseUrlRef(typeof req.params.ref === "string" ? req.params.ref : "");
      if (!ref) return jsonError(res, 400, "ref_invalid", "bad ref");
      const r = archive.readResponse(ref);
      if (!r) return jsonError(res, 404, "not_found", `no response artefact for ${ref}`);
      res.setHeader("Content-Type", r.contentType);
      res.setHeader("Content-Disposition", `inline; filename="${r.filename}"`);
      return res.send(r.bytes);
    });
  }

  // ── PDF book summarizer (/v1/pdf-*) ─────────────────────────────────
  // Registered after the other /v1/* routes (so it's behind the same auth
  // gate) and before the SPA static fallback. When jobStore is absent the
  // routes respond 503 (feature disabled).
  registerPdfRoutes(app, deps.jobStore, deps.pdfCaps ?? defaultPdfCaps());

  if (deps.distPath) {
    let isDir = false;
    try {
      isDir = existsSync(deps.distPath) && statSync(deps.distPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      // Serve hashed asset files via static (CSS, JS chunks, images).
      // index.html is intercepted below so we can inject __BUYER_BOOT__.
      app.use(express.static(deps.distPath, { index: false }));

      // Inject window.__BUYER_BOOT__ into index.html before serving. Only
      // PUBLIC fields are sent — pubKeyHash + display address — so the SPA
      // can show the user their identity without the server leaking the
      // private key into the page bundle. The SPA talks to /v1/* on this
      // origin (relative URLs), so no indexer/ogmios endpoints leak either.
      //
      // The boot block is ALSO gated by auth: unauthenticated requests get
      // the same HTML shell but with NO boot script, so the SPA's
      // AuthProvider renders <Login> and the buyer's address never reaches
      // an unauthenticated browser.
      const indexPath = `${deps.distPath}/index.html`;
      const cachedTemplate = existsSync(indexPath)
        ? readFileSync(indexPath, "utf8")
        : "";
      // Display address: Vector L2 uses mainnet byte semantics (header 0x61,
      // HRP "addr") regardless of NETWORK_ID. Derive once at boot.
      const displayAddress =
        resolved !== null
          ? pkhToMainnetAddress(resolved.walletKey.pubKeyHash)
          : "";
      const bootScript = resolved !== null
        ? `<script>window.__BUYER_BOOT__=${JSON.stringify({
            walletKey: {
              pubKeyHash: resolved.walletKey.pubKeyHash,
              address: displayAddress,
            },
          })};</script>`
        : "";
      const indexWithBoot = cachedTemplate.replace(
        "</head>",
        `${bootScript}\n  </head>`,
      );
      // Anonymous shell: same HTML template but no boot block. The SPA's
      // AuthProvider handles the rest.
      const indexAnonymous = cachedTemplate;

      function isAuthenticatedHtmlRequest(req: Request): boolean {
        if (!authReady) return true; // auth disabled (test mode): no gating
        const raw = getCookie(req.headers.cookie, SESSION_COOKIE_NAME);
        if (raw === null) return false;
        return verifySession(deps.sessionSecret!, raw, nowMs()).valid;
      }

      app.get(/^\/(?!healthz|v1\/).*/, (req: Request, res: Response) => {
        if (!cachedTemplate) {
          return res.status(404).json({ error: "not_found" });
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        const body = isAuthenticatedHtmlRequest(req) ? indexWithBoot : indexAnonymous;
        return res.send(body);
      });
    }
  }

  // Catch-all 404 for unknown paths (after static + SPA fallback).
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
