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

import express, { type Express, type Request, type Response } from "express";
import { existsSync, readFileSync, statSync } from "fs";
import { bech32 } from "bech32";
import type { ChainProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import type { Marketplace } from "./sdk/Marketplace.js";
import type { ChatMessage } from "@marketplace/shared/tx";
import { runAccept } from "./cli/acceptFlow.js";

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
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
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
      // Wrap the assistant text in OpenAI-shape `choices[0].message` so
      // downstream clients (PromptForm) can unpack uniformly.
      return res.status(200).json({
        choices: [{ index: 0, message: { role: "assistant", content: result.response }, finish_reason: "stop" }],
        receipt: result.receipt,
        receipt_signature: result.receiptSignature,
        escrow_ref: `${result.escrowRef.txHash}#${result.escrowRef.index}`,
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
      return res.status(200).json({
        audio_b64: result.audio_b64,
        format: result.format,
        content_type: result.content_type,
        byte_length: result.byte_length,
        receipt: result.receipt,
        receipt_signature: result.receiptSignature,
        escrow_ref: `${result.escrowRef.txHash}#${result.escrowRef.index}`,
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
      const indexBody = cachedTemplate.replace(
        "</head>",
        `${bootScript}\n  </head>`,
      );

      app.get(/^\/(?!healthz|v1\/).*/, (_req: Request, res: Response) => {
        if (!indexBody) {
          return res.status(404).json({ error: "not_found" });
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(indexBody);
      });
    }
  }

  // Catch-all 404 for unknown paths (after static + SPA fallback).
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
