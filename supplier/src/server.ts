/**
 * supplier/src/server.ts — Express app factory for the supplier node.
 *
 * createApp(deps) returns an Express Application with all routes wired.
 * deps is injected so tests can swap in mock chain providers, state, etc.
 *
 * Routes:
 *   GET  /capability                        — ARCHITECTURE.md §5.1
 *   GET  /status                            — ARCHITECTURE.md §5.1
 *   POST /v1/chat/completions               — async claim+enqueue (M1-F-async-chat)
 *   GET  /v1/chat/completions/:jobId        — poll job status
 *
 * Async chat flow (M1-F-async-chat-green):
 *   POST validates → acquires lock → buildClaimTx → awaitTx Claim
 *     → jobs.create → runChatJob (fire-and-forget) → 202 {job_id, status, escrow_ref}
 *   GET dispatches by record.status:
 *     - 404 job_not_found / 400 invalid_job_id
 *     - 202 {status: "accepted"|"running", escrow_ref}
 *     - 200 with full payload for "done"
 *     - failure.httpStatus with {status: "failed", reason, message, escrow_ref}
 *
 * Error envelope (every non-2xx response):
 *   { reason, message, error: { reason, message } }
 *
 * Tests assert on `res.body.reason ?? res.body.error` against a regex —
 * we set both top-level and nested fields so either pathway matches.
 *
 * The chat handler reaches for `fetch` and `chain.submitTx` through live
 * references (`ollama.callOllama` via the imported namespace; `deps.chain`
 * via the closure) rather than top-level destructuring. That keeps
 * vi.stubGlobal("fetch") and vi.spyOn(chain, "submitTx") effective.
 */

import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { createHash } from "crypto";

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import { decodeAdvertDatum, decodeEscrowDatum, canonicalize } from "@marketplace/shared/cbor";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import type { WalletKey } from "@marketplace/shared/tx";
import { buildClaimTx, chatSessionPromptHash, mockSlotToWallclockMs, detectCborBackend } from "@marketplace/shared/tx";

import type { SupplierState } from "./state.js";
import type { SupplierConfig } from "./config.js";
import { JobStore } from "./jobs.js";
import { runChatJob, runTtsJob } from "./jobRunner.js";
import { ChatSessionStore, type ChatSessionRecord } from "./chatSession.js";
import { endChatSession, type EndChatSessionDeps } from "./chatSessionRunner.js";
import { callOpenAiStream } from "./openai.js";
import { healthzRouter } from "./routes/healthz.js";
import { triggerOnFailureConsolidate } from "./walletHealth.js";

export interface SupplierDeps {
  chain: ChainProvider;
  state: SupplierState;
  config: SupplierConfig;
  supplierKey: WalletKey;
  /** Optional: defaults to a fresh JobStore. M1-F-async-chat. */
  jobs?: JobStore;
  /** Optional: defaults to a fresh ChatSessionStore (chat-session capability). */
  chatSessions?: ChatSessionStore;
}

const ESCROW_REF_RE = /^[0-9a-fA-F]{64}#(?:0|[1-9]\d*)$/;
const UUID_V4_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function parseEscrowRef(ref: string): OutputReference | null {
  if (!ESCROW_REF_RE.test(ref)) return null;
  const idx = ref.indexOf("#");
  return { txHash: ref.slice(0, idx), index: Number(ref.slice(idx + 1)) };
}

function jsonError(res: Response, status: number, reason: string, message: string): Response {
  return res
    .status(status)
    .json({ reason, message, error: { reason, message } });
}

// ─── /capability ───────────────────────────────────────────────────────────

interface ResolvedDeps {
  chain: ChainProvider;
  state: SupplierState;
  config: SupplierConfig;
  supplierKey: WalletKey;
  jobs: JobStore;
  chatSessions: ChatSessionStore;
}

function makeCapabilityHandler(deps: ResolvedDeps) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");

      const utxo = await deps.chain.queryUtxo(deps.config.advertRef);
      if (utxo === null || !utxo.datumHex) {
        return jsonError(res, 503, "advert_unavailable", "advert UTxO not found on chain");
      }

      let datum: AdvertDatum;
      try {
        datum = decodeAdvertDatum(utxo.datumHex);
      } catch (err) {
        return jsonError(res, 503, "advert_decode_failed",
          `unable to decode advert datum: ${(err as Error).message}`);
      }

      if (datum.status !== "Active") {
        return jsonError(res, 503, "advert_not_active",
          `advert is retired (status=${datum.status})`);
      }

      const advertRefStr = `${deps.config.advertRef.txHash}#${deps.config.advertRef.index}`;
      return res.status(200).json({
        capability_id: datum.capability_id,
        model: datum.model,
        max_output_tokens: datum.max_output_tokens,
        max_processing_ms: datum.max_processing_ms,
        price_lovelace: datum.price_lovelace.toString(),
        advert_ref: advertRefStr,
        supplier_pkh: datum.supplier_pkh,
        // SPEC FIX 2026-04-25: pub_key_hex required for buyer-side receipt verification
        pub_key_hex: deps.supplierKey.pubKeyHex,
      });
    } catch (err) {
      next(err);
      return;
    }
  };
}

// ─── /status ───────────────────────────────────────────────────────────────

function makeStatusHandler(deps: ResolvedDeps) {
  return (_req: Request, res: Response) => {
    const snap = deps.state.snapshot();
    const payload: Record<string, unknown> = {
      status: snap.status,
      last_seen: snap.lastSeenIso,
    };
    if (snap.status === "working" && snap.currentEscrowRef) {
      payload.current_escrow_ref = snap.currentEscrowRef;
    }
    return res.status(200).json(payload);
  };
}

// ─── /v1/chat/completions ──────────────────────────────────────────────────

interface ChatBody {
  model?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  functions?: unknown;
}

type AdvertResult =
  | { datum: AdvertDatum }
  | { error: { status: number; reason: string; message: string } };

async function fetchActiveAdvert(deps: ResolvedDeps): Promise<AdvertResult> {
  const utxo = await deps.chain.queryUtxo(deps.config.advertRef);
  if (utxo === null || !utxo.datumHex) {
    return { error: { status: 503, reason: "advert_unavailable", message: "advert UTxO missing on chain" } };
  }
  let datum: AdvertDatum;
  try {
    datum = decodeAdvertDatum(utxo.datumHex);
  } catch (err) {
    return { error: { status: 503, reason: "advert_decode_failed", message: (err as Error).message } };
  }
  if (datum.status !== "Active") {
    return { error: { status: 503, reason: "advert_not_active", message: `advert status=${datum.status}` } };
  }
  return { datum };
}

function makeChatHandler(deps: ResolvedDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ── 1. Header validation ──────────────────────────────────────────
      const headerVal = req.header("X-Escrow-Ref");
      if (!headerVal) {
        return jsonError(res, 400, "escrow_ref_required", "X-Escrow-Ref header is required");
      }
      const escrowRef = parseEscrowRef(headerVal);
      if (escrowRef === null) {
        return jsonError(res, 400, "escrow_ref_malformed",
          'X-Escrow-Ref must match "<64-hex>#<int>"');
      }
      const escrowRefStr = `${escrowRef.txHash}#${escrowRef.index}`;

      // ── 2. Body shape validation ─────────────────────────────────────
      const body = (req.body ?? {}) as ChatBody;
      if (body.stream === true) {
        return jsonError(res, 400, "streaming_not_supported", "stream:true is not supported");
      }
      if (body.tools !== undefined) {
        return jsonError(res, 400, "tools_not_supported", "tools[] is not supported");
      }
      if (body.tool_choice !== undefined) {
        return jsonError(res, 400, "tools_not_supported", "tool_choice is not supported");
      }
      if (body.functions !== undefined) {
        return jsonError(res, 400, "tools_not_supported", "functions[] is not supported");
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return jsonError(res, 400, "messages_required", "messages must be a non-empty array");
      }
      const messages = body.messages as Array<{ role: unknown; content: unknown }>;
      for (const m of messages) {
        if (!m || typeof m !== "object" || typeof m.role !== "string" || typeof m.content !== "string") {
          return jsonError(res, 400, "messages_required",
            "each message must have string role and string content");
        }
      }
      const validatedMessages = messages as Array<{ role: "system" | "user" | "assistant"; content: string }>;

      // ── 3. Resolve advert ────────────────────────────────────────────
      const advertResult = await fetchActiveAdvert(deps);
      if ("error" in advertResult) {
        const e = advertResult.error;
        return jsonError(res, e.status, e.reason, e.message);
      }
      const advert = advertResult.datum;

      const maxTokensRaw = body.max_tokens;
      if (maxTokensRaw !== undefined) {
        if (typeof maxTokensRaw !== "number" || !Number.isFinite(maxTokensRaw) || maxTokensRaw < 0) {
          return jsonError(res, 400, "max_tokens_invalid",
            "max_tokens must be a non-negative number");
        }
        if (maxTokensRaw > advert.max_output_tokens) {
          return jsonError(res, 400, "output_cap_exceeded",
            `max_tokens ${maxTokensRaw} exceeds advertised cap ${advert.max_output_tokens}`);
        }
      }

      // ── 4. Resolve escrow UTxO ───────────────────────────────────────
      const escrowUtxo = await deps.chain.queryUtxo(escrowRef);
      if (escrowUtxo === null || !escrowUtxo.datumHex) {
        return jsonError(res, 404, "escrow_not_found",
          `escrow UTxO ${escrowRefStr} not found on chain`);
      }
      let escrowDatum: EscrowDatum;
      try {
        escrowDatum = decodeEscrowDatum(escrowUtxo.datumHex);
      } catch (err) {
        return jsonError(res, 404, "escrow_decode_failed", (err as Error).message);
      }

      // ── 5. State / identity / capability ─────────────────────────────
      if (escrowDatum.state !== "Open") {
        return jsonError(res, 409, "escrow_not_claimable",
          `escrow state is ${escrowDatum.state}, expected Open`);
      }
      if (escrowDatum.supplier_pkh !== deps.supplierKey.pubKeyHash) {
        return jsonError(res, 403, "wrong_supplier",
          "escrow supplier_pkh does not match this node");
      }
      if (escrowDatum.capability_id !== advert.capability_id) {
        return jsonError(res, 409, "capability_mismatch",
          `escrow capability ${escrowDatum.capability_id} != advert ${advert.capability_id}`);
      }

      // ── 6. Hash checks ───────────────────────────────────────────────
      const expectedRequestSpecHash = sha256Hex(canonicalize({
        capability_id: advert.capability_id,
        max_output_tokens: advert.max_output_tokens,
        model: advert.model,
      }));
      if (escrowDatum.request_spec_hash !== expectedRequestSpecHash) {
        return jsonError(res, 409, "request_spec_mismatch",
          "request_spec_hash in escrow does not match advert spec");
      }
      const expectedPromptHash = sha256Hex(canonicalize(validatedMessages));
      if (escrowDatum.prompt_hash !== expectedPromptHash) {
        return jsonError(res, 409, "prompt_mismatch",
          "prompt_hash in escrow does not match request body messages");
      }

      // ── 7. Deadline ──────────────────────────────────────────────────
      const tipSlot = await deps.chain.tip();
      const isLive = detectCborBackend(deps.chain) === "live";
      const nowMs = isLive
        ? Date.now()
        : Math.max(mockSlotToWallclockMs(tipSlot), escrowDatum.posted_at);
      if (nowMs >= escrowDatum.deliver_by) {
        return jsonError(res, 408, "past_deliver_by",
          `now ${nowMs} >= deliver_by ${escrowDatum.deliver_by}`);
      }

      // ── 8. Acquire single-slot lock ──────────────────────────────────
      if (!deps.state.tryAcquire(escrowRefStr)) {
        return jsonError(res, 409, "supplier_busy", "supplier is already working another job");
      }
      // From here on, every error path MUST release the lock until the
      // runner takes ownership of the lock.

      // ── 9. Submit Claim tx ───────────────────────────────────────────
      let claimResult;
      try {
        claimResult = await buildClaimTx({
          chain: deps.chain,
          supplierKey: deps.supplierKey,
          escrowRef,
        });
      } catch (err) {
        deps.state.release();
        // Backstop the periodic wallet-health ticker: most Claim build failures
        // we see in practice are wallet-shape problems (fragmentation, dust).
        // Fire-and-forget a debounced consolidate so the NEXT buyer retry
        // finds a clean 2-UTxO wallet. Safe no-op if already healthy.
        triggerOnFailureConsolidate({
          chain: deps.chain,
          state: deps.state,
          supplierKey: deps.supplierKey,
        });
        return jsonError(res, 503, "chain_submit_failed",
          `Claim tx submit failed: ${(err as Error).message}`);
      }

      // ── 10. Await Claim confirmation ─────────────────────────────────
      try {
        await deps.chain.awaitTx(claimResult.expectedTxHash, 60_000);
      } catch (err) {
        deps.state.release();
        return jsonError(res, 504, "claim_timeout",
          `Claim awaitTx failed: ${(err as Error).message}`);
      }

      // ── 11. Continuing-output ref + create job + fire-and-forget ─────
      const claimedRef: OutputReference = {
        txHash: claimResult.expectedTxHash,
        index: 0,
      };
      const jobId = deps.jobs.create(escrowRefStr);

      // Lock release now happens inside runChatJob's finally.
      void runChatJob({
        deps: {
          chain: deps.chain,
          state: deps.state,
          config: deps.config,
          supplierKey: deps.supplierKey,
          jobs: deps.jobs,
        },
        jobId,
        escrowRef: escrowRefStr,
        claimedRef,
        advert,
        escrowDatum,
        requestBody: { messages: validatedMessages },
      });

      // ── 12. 202 Accepted ─────────────────────────────────────────────
      return res.status(202).json({
        job_id: jobId,
        status: "accepted",
        escrow_ref: escrowRefStr,
      });
    } catch (err) {
      try { deps.state.release(); } catch { /* ignore */ }
      next(err);
      return;
    }
  };
}

// ─── GET /v1/chat/completions/:jobId ───────────────────────────────────────

function makeGetJobHandler(deps: ResolvedDeps) {
  return (req: Request, res: Response) => {
    const rawJobId = req.params.jobId;
    const jobId = typeof rawJobId === "string" ? rawJobId : "";
    if (!UUID_V4_RE.test(jobId)) {
      return jsonError(res, 400, "invalid_job_id",
        "jobId must be a UUIDv4 string");
    }
    const record = deps.jobs.get(jobId);
    if (!record) {
      return jsonError(res, 404, "job_not_found",
        `no job found with id ${jobId}`);
    }
    res.setHeader("Content-Type", "application/json");
    if (record.status === "accepted" || record.status === "running") {
      return res.status(202).json({
        status: record.status,
        escrow_ref: record.escrowRef,
      });
    }
    if (record.status === "done") {
      const payload = record.responsePayload!;
      // Defensive narrowing: this poll route only knows how to render the
      // chat shape. A future shared JobStore could mix capabilities; we'd
      // want each kind's poll to be sure it's reading its own.
      if ("audio_b64" in payload) {
        return jsonError(res, 500, "wrong_payload_kind",
          "tts payload returned to chat poll route");
      }
      return res.status(200).json({
        choices: payload.choices,
        usage: payload.usage,
        receipt: payload.receipt,
        receipt_signature: payload.receipt_signature,
        escrow_ref: record.escrowRef,
      });
    }
    // failed
    const f = record.failure!;
    return res.status(f.httpStatus).json({
      status: "failed",
      reason: f.reason,
      message: f.message,
      escrow_ref: record.escrowRef,
    });
  };
}

// ─── POST /v1/audio/synthesize ──────────────────────────────────────────────
//
// Mirror of makeChatHandler for the audio.synthesize.piper.v1 capability.
// Same lifecycle (validate → resolve advert → resolve escrow → hash check →
// claim → fire-and-forget runner → 202). Differences:
//   - body shape: { text, voice, format, speed } (no messages array)
//   - prompt_hash is sha256(canonical({text, voice, format, speed})), so the
//     escrow datum the buyer commits MUST hash the same object shape — see
//     packages/shared/src/tx/escrow/postEscrow*.ts (TTS variant).

const ALLOWED_TTS_VOICES = new Set([
  "alloy", "echo", "fable", "onyx", "nova", "shimmer", "lessac",
]);
const ALLOWED_TTS_FORMATS = new Set(["mp3", "wav", "opus", "aac", "flac"]);

function makeTtsHandler(deps: ResolvedDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ── 1. Header ───────────────────────────────────────────────────
      const headerVal = req.header("X-Escrow-Ref");
      if (!headerVal) {
        return jsonError(res, 400, "escrow_ref_required", "X-Escrow-Ref header is required");
      }
      const escrowRef = parseEscrowRef(headerVal);
      if (escrowRef === null) {
        return jsonError(res, 400, "escrow_ref_malformed",
          'X-Escrow-Ref must match "<64-hex>#<int>"');
      }
      const escrowRefStr = `${escrowRef.txHash}#${escrowRef.index}`;

      // ── 2. Body ─────────────────────────────────────────────────────
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.text === "string" ? body.text : "";
      if (text.length === 0) {
        return jsonError(res, 400, "text_required", "body.text must be a non-empty string");
      }
      const voice = typeof body.voice === "string" ? body.voice : "";
      if (!ALLOWED_TTS_VOICES.has(voice)) {
        return jsonError(res, 400, "voice_invalid",
          `voice must be one of: ${[...ALLOWED_TTS_VOICES].join(", ")}`);
      }
      const format = typeof body.format === "string" ? body.format : "";
      if (!ALLOWED_TTS_FORMATS.has(format)) {
        return jsonError(res, 400, "format_invalid",
          `format must be one of: ${[...ALLOWED_TTS_FORMATS].join(", ")}`);
      }
      const speedRaw = body.speed;
      const speed = typeof speedRaw === "number" ? speedRaw : Number(speedRaw);
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 1.5) {
        return jsonError(res, 400, "speed_out_of_range",
          "speed must be a finite number in [0.5, 1.5]");
      }

      // ── 3. Advert ───────────────────────────────────────────────────
      const advertResult = await fetchActiveAdvert(deps);
      if ("error" in advertResult) {
        const e = advertResult.error;
        return jsonError(res, e.status, e.reason, e.message);
      }
      const advert = advertResult.datum;

      // ── 4. Escrow ───────────────────────────────────────────────────
      const escrowUtxo = await deps.chain.queryUtxo(escrowRef);
      if (escrowUtxo === null || !escrowUtxo.datumHex) {
        return jsonError(res, 404, "escrow_not_found",
          `escrow UTxO ${escrowRefStr} not found on chain`);
      }
      let escrowDatum: EscrowDatum;
      try {
        escrowDatum = decodeEscrowDatum(escrowUtxo.datumHex);
      } catch (err) {
        return jsonError(res, 404, "escrow_decode_failed", (err as Error).message);
      }

      // ── 5. State / identity / capability ────────────────────────────
      if (escrowDatum.state !== "Open") {
        return jsonError(res, 409, "escrow_not_claimable",
          `escrow state is ${escrowDatum.state}, expected Open`);
      }
      if (escrowDatum.supplier_pkh !== deps.supplierKey.pubKeyHash) {
        return jsonError(res, 403, "wrong_supplier",
          "escrow supplier_pkh does not match this node");
      }
      if (escrowDatum.capability_id !== advert.capability_id) {
        return jsonError(res, 409, "capability_mismatch",
          `escrow capability ${escrowDatum.capability_id} != advert ${advert.capability_id}`);
      }

      // ── 6. Hash checks ──────────────────────────────────────────────
      const expectedRequestSpecHash = sha256Hex(canonicalize({
        capability_id: advert.capability_id,
        max_output_tokens: advert.max_output_tokens,
        model: advert.model,
      }));
      if (escrowDatum.request_spec_hash !== expectedRequestSpecHash) {
        return jsonError(res, 409, "request_spec_mismatch",
          "request_spec_hash in escrow does not match advert spec");
      }
      // The TTS prompt commitment is the canonicalisation of the full
      // request envelope (text + voice + format + speed). The buyer SDK
      // computes the same shape when building the escrow datum.
      const expectedPromptHash = sha256Hex(canonicalize({
        text, voice, format, speed,
      }));
      if (escrowDatum.prompt_hash !== expectedPromptHash) {
        return jsonError(res, 409, "prompt_mismatch",
          "prompt_hash in escrow does not match request body");
      }

      // ── 7. Deadline ─────────────────────────────────────────────────
      const tipSlot = await deps.chain.tip();
      const isLive = detectCborBackend(deps.chain) === "live";
      const nowMs = isLive
        ? Date.now()
        : Math.max(mockSlotToWallclockMs(tipSlot), escrowDatum.posted_at);
      if (nowMs >= escrowDatum.deliver_by) {
        return jsonError(res, 408, "past_deliver_by",
          `now ${nowMs} >= deliver_by ${escrowDatum.deliver_by}`);
      }

      // ── 8. Lock ─────────────────────────────────────────────────────
      if (!deps.state.tryAcquire(escrowRefStr)) {
        return jsonError(res, 409, "supplier_busy", "supplier is already working another job");
      }

      // ── 9. Claim tx ─────────────────────────────────────────────────
      let claimResult;
      try {
        claimResult = await buildClaimTx({
          chain: deps.chain,
          supplierKey: deps.supplierKey,
          escrowRef,
        });
      } catch (err) {
        deps.state.release();
        return jsonError(res, 503, "chain_submit_failed",
          `Claim tx submit failed: ${(err as Error).message}`);
      }
      try {
        await deps.chain.awaitTx(claimResult.expectedTxHash, 60_000);
      } catch (err) {
        deps.state.release();
        return jsonError(res, 504, "claim_timeout",
          `Claim awaitTx failed: ${(err as Error).message}`);
      }

      // ── 10. Spawn runner + 202 ──────────────────────────────────────
      const claimedRef: OutputReference = {
        txHash: claimResult.expectedTxHash,
        index: 0,
      };
      const jobId = deps.jobs.create(escrowRefStr);

      void runTtsJob({
        deps: {
          chain: deps.chain,
          state: deps.state,
          config: deps.config,
          supplierKey: deps.supplierKey,
          jobs: deps.jobs,
        },
        jobId,
        escrowRef: escrowRefStr,
        claimedRef,
        advert,
        escrowDatum,
        requestBody: { text, voice, format, speed },
      });

      return res.status(202).json({
        job_id: jobId,
        status: "accepted",
        escrow_ref: escrowRefStr,
      });
    } catch (err) {
      try { deps.state.release(); } catch { /* ignore */ }
      next(err);
      return;
    }
  };
}

// ─── GET /v1/audio/synthesize/:jobId ────────────────────────────────────────
function makeGetTtsJobHandler(deps: ResolvedDeps) {
  return (req: Request, res: Response) => {
    const rawJobId = req.params.jobId;
    const jobId = typeof rawJobId === "string" ? rawJobId : "";
    if (!UUID_V4_RE.test(jobId)) {
      return jsonError(res, 400, "invalid_job_id", "jobId must be a UUIDv4 string");
    }
    const record = deps.jobs.get(jobId);
    if (!record) {
      return jsonError(res, 404, "job_not_found", `no job found with id ${jobId}`);
    }
    res.setHeader("Content-Type", "application/json");
    if (record.status === "accepted" || record.status === "running") {
      return res.status(202).json({
        status: record.status,
        escrow_ref: record.escrowRef,
      });
    }
    if (record.status === "done") {
      const payload = record.responsePayload!;
      if (!("audio_b64" in payload)) {
        return jsonError(res, 500, "wrong_payload_kind",
          "chat payload returned to tts poll route");
      }
      return res.status(200).json({
        audio_b64: payload.audio_b64,
        format: payload.format,
        content_type: payload.content_type,
        byte_length: payload.byte_length,
        receipt: payload.receipt,
        receipt_signature: payload.receipt_signature,
        escrow_ref: record.escrowRef,
      });
    }
    // failed
    const f = record.failure!;
    return res.status(f.httpStatus).json({
      status: "failed",
      reason: f.reason,
      message: f.message,
      escrow_ref: record.escrowRef,
    });
  };
}

// ─── /v1/chat/{start,message,end} — multi-turn chat session (llm.chat.v1) ───
//
// Escrow bookends with off-chain turns:
//   start   → validate (mirror makeChatHandler 1-7, but no messages) → Claim
//             (Open→Claimed) → create session + arm idle/hard-cap watchdog → 200
//   message → SSE stream a turn via callOpenAiStream; zero chain interaction
//   end     → endChatSession (Submit transcript receipt; Claimed→Submitted) → 200
//
// The buyer then Accepts off this route (server-side, in the buyer-app),
// which is when the user is actually charged. Single-slot: the SupplierState
// mutex is held from Claim (start) to Submit (end), so one paid chat at a time.

interface ChatStartBody {
  model?: unknown;
  session_nonce?: unknown;
}

function makeChatSessionHandlers(deps: ResolvedDeps) {
  const endDeps: EndChatSessionDeps = {
    chain: deps.chain,
    state: deps.state,
    config: deps.config,
    supplierKey: deps.supplierKey,
    jobs: deps.jobs,
    sessions: deps.chatSessions,
  };

  function armIdleTimer(record: ChatSessionRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => {
      void endChatSession({ deps: endDeps, escrowRef: record.escrowRef, trigger: "idle" });
    }, deps.config.chatIdleTimeoutMs);
    record.idleTimer.unref?.();
  }

  function armHardCapTimer(record: ChatSessionRecord, nowMs: number): void {
    // Force-end before deliver_by so the Submit tx (60s awaitTx budget) lands
    // in time. 90s margin = Submit awaitTx + buffer.
    const margin = 90_000;
    const capMs = Math.max(1_000, record.escrowDatum.deliver_by - nowMs - margin);
    record.hardCapTimer = setTimeout(() => {
      void endChatSession({ deps: endDeps, escrowRef: record.escrowRef, trigger: "hard-cap" });
    }, capMs);
    record.hardCapTimer.unref?.();
  }

  const start = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ── 1. Header ───────────────────────────────────────────────────
      const headerVal = req.header("X-Escrow-Ref");
      if (!headerVal) {
        return jsonError(res, 400, "escrow_ref_required", "X-Escrow-Ref header is required");
      }
      const escrowRef = parseEscrowRef(headerVal);
      if (escrowRef === null) {
        return jsonError(res, 400, "escrow_ref_malformed", 'X-Escrow-Ref must match "<64-hex>#<int>"');
      }
      const escrowRefStr = `${escrowRef.txHash}#${escrowRef.index}`;

      // ── 2. Body (session_nonce; no messages) ─────────────────────────
      const body = (req.body ?? {}) as ChatStartBody;
      const sessionNonce = typeof body.session_nonce === "string" ? body.session_nonce : "";
      if (sessionNonce.length === 0) {
        return jsonError(res, 400, "session_nonce_required", "body.session_nonce must be a non-empty string");
      }

      // ── 3. Advert ───────────────────────────────────────────────────
      const advertResult = await fetchActiveAdvert(deps);
      if ("error" in advertResult) {
        const e = advertResult.error;
        return jsonError(res, e.status, e.reason, e.message);
      }
      const advert = advertResult.datum;

      // ── 4. Escrow ───────────────────────────────────────────────────
      const escrowUtxo = await deps.chain.queryUtxo(escrowRef);
      if (escrowUtxo === null || !escrowUtxo.datumHex) {
        return jsonError(res, 404, "escrow_not_found", `escrow UTxO ${escrowRefStr} not found on chain`);
      }
      let escrowDatum: EscrowDatum;
      try {
        escrowDatum = decodeEscrowDatum(escrowUtxo.datumHex);
      } catch (err) {
        return jsonError(res, 404, "escrow_decode_failed", (err as Error).message);
      }

      // ── 5. State / identity / capability ─────────────────────────────
      if (escrowDatum.state !== "Open") {
        return jsonError(res, 409, "escrow_not_claimable", `escrow state is ${escrowDatum.state}, expected Open`);
      }
      if (escrowDatum.supplier_pkh !== deps.supplierKey.pubKeyHash) {
        return jsonError(res, 403, "wrong_supplier", "escrow supplier_pkh does not match this node");
      }
      if (escrowDatum.capability_id !== advert.capability_id) {
        return jsonError(res, 409, "capability_mismatch",
          `escrow capability ${escrowDatum.capability_id} != advert ${advert.capability_id}`);
      }

      // ── 6. Hash checks (request spec + session-init prompt) ──────────
      const expectedRequestSpecHash = sha256Hex(canonicalize({
        capability_id: advert.capability_id,
        max_output_tokens: advert.max_output_tokens,
        model: advert.model,
      }));
      if (escrowDatum.request_spec_hash !== expectedRequestSpecHash) {
        return jsonError(res, 409, "request_spec_mismatch", "request_spec_hash in escrow does not match advert spec");
      }
      const expectedPromptHash = chatSessionPromptHash({ session_nonce: sessionNonce });
      if (escrowDatum.prompt_hash !== expectedPromptHash) {
        return jsonError(res, 409, "prompt_mismatch", "prompt_hash in escrow does not match session_nonce");
      }

      // ── 7. Deadline ──────────────────────────────────────────────────
      const tipSlot = await deps.chain.tip();
      const isLive = detectCborBackend(deps.chain) === "live";
      const nowMs = isLive
        ? Date.now()
        : Math.max(mockSlotToWallclockMs(tipSlot), escrowDatum.posted_at);
      if (nowMs >= escrowDatum.deliver_by) {
        return jsonError(res, 408, "past_deliver_by", `now ${nowMs} >= deliver_by ${escrowDatum.deliver_by}`);
      }

      // ── 8. Single-slot lock ──────────────────────────────────────────
      if (!deps.state.tryAcquire(escrowRefStr)) {
        return jsonError(res, 409, "supplier_busy", "supplier is already working another chat");
      }

      // ── 9. Claim (Open → Claimed) — hold the lock on success ─────────
      let claimResult;
      try {
        claimResult = await buildClaimTx({ chain: deps.chain, supplierKey: deps.supplierKey, escrowRef });
      } catch (err) {
        deps.state.release();
        triggerOnFailureConsolidate({ chain: deps.chain, state: deps.state, supplierKey: deps.supplierKey });
        return jsonError(res, 503, "chain_submit_failed", `Claim tx submit failed: ${(err as Error).message}`);
      }
      try {
        await deps.chain.awaitTx(claimResult.expectedTxHash, 60_000);
      } catch (err) {
        deps.state.release();
        return jsonError(res, 504, "claim_timeout", `Claim awaitTx failed: ${(err as Error).message}`);
      }

      // ── 10. Create session + arm watchdog ────────────────────────────
      const claimedRef: OutputReference = { txHash: claimResult.expectedTxHash, index: 0 };
      const record = deps.chatSessions.create({ escrowRef: escrowRefStr, claimedRef, advert, escrowDatum });
      armIdleTimer(record);
      armHardCapTimer(record, nowMs);

      return res.status(200).json({ status: "claimed", escrow_ref: escrowRefStr });
    } catch (err) {
      try { deps.state.release(); } catch { /* ignore */ }
      next(err);
      return;
    }
  };

  const message = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const headerVal = req.header("X-Escrow-Ref");
      if (!headerVal) {
        return jsonError(res, 400, "escrow_ref_required", "X-Escrow-Ref header is required");
      }
      const escrowRef = parseEscrowRef(headerVal);
      if (escrowRef === null) {
        return jsonError(res, 400, "escrow_ref_malformed", 'X-Escrow-Ref must match "<64-hex>#<int>"');
      }
      const escrowRefStr = `${escrowRef.txHash}#${escrowRef.index}`;
      const record = deps.chatSessions.get(escrowRefStr);
      if (!record || record.status !== "active") {
        return jsonError(res, 404, "chat_session_not_found",
          `no active chat session for ${escrowRefStr}`);
      }
      const body = (req.body ?? {}) as { content?: unknown };
      const content = typeof body.content === "string" ? body.content : "";
      if (content.length === 0) {
        return jsonError(res, 400, "content_required", "body.content must be a non-empty string");
      }

      // Pause the idle timer while a turn is in flight; re-arm when it ends so
      // a long generation never trips the auto-end mid-stream.
      if (record.idleTimer) { clearTimeout(record.idleTimer); record.idleTimer = undefined; }
      deps.chatSessions.appendUser(escrowRefStr, content);

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === "function") {
        (res as Response & { flushHeaders: () => void }).flushHeaders();
      }
      const sse = (frame: Record<string, unknown>): void => {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      };

      try {
        const result = await callOpenAiStream(
          {
            baseUrl: deps.config.openaiBaseUrl,
            model: record.advert.model,
            messages: record.transcript,
            timeoutMs: deps.config.openaiTimeoutMs,
            apiKey: deps.config.openaiApiKey,
            maxTokens: deps.config.openaiMaxTokens,
            disableReasoning: deps.config.openaiReasoningDisabled,
          },
          (delta) => sse({ type: "token", value: delta }),
        );
        deps.chatSessions.appendAssistant(escrowRefStr, result.content, {
          prompt_tokens: result.prompt_tokens,
          completion_tokens: result.completion_tokens,
        });
        sse({ type: "done" });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sse({ type: "error", message: errMsg });
      } finally {
        if (record.status === "active") armIdleTimer(record);
        res.end();
      }
      return;
    } catch (err) {
      next(err);
      return;
    }
  };

  const end = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const headerVal = req.header("X-Escrow-Ref");
      if (!headerVal) {
        return jsonError(res, 400, "escrow_ref_required", "X-Escrow-Ref header is required");
      }
      const escrowRef = parseEscrowRef(headerVal);
      if (escrowRef === null) {
        return jsonError(res, 400, "escrow_ref_malformed", 'X-Escrow-Ref must match "<64-hex>#<int>"');
      }
      const escrowRefStr = `${escrowRef.txHash}#${escrowRef.index}`;
      if (!deps.chatSessions.get(escrowRefStr)) {
        return jsonError(res, 404, "chat_session_not_found", `no chat session for ${escrowRefStr}`);
      }
      const record = await endChatSession({ deps: endDeps, escrowRef: escrowRefStr, trigger: "end" });
      if (!record) {
        return jsonError(res, 404, "chat_session_not_found", `no chat session for ${escrowRefStr}`);
      }
      if (record.endFailure) {
        return jsonError(res, 502, record.endFailure.reason, record.endFailure.message);
      }
      if (!record.endResult) {
        return jsonError(res, 500, "chat_end_incomplete", "session ended without a receipt");
      }
      return res.status(200).json({
        status: "submitted",
        escrow_ref: escrowRefStr,
        submitted_ref: record.endResult.submitted_ref,
        receipt: record.endResult.receipt,
        receipt_signature: record.endResult.receipt_signature,
      });
    } catch (err) {
      next(err);
      return;
    }
  };

  return { start, message, end };
}

// ─── App factory ───────────────────────────────────────────────────────────

export function createApp(deps: SupplierDeps): Application {
  const resolved: ResolvedDeps = {
    chain: deps.chain,
    state: deps.state,
    config: deps.config,
    supplierKey: deps.supplierKey,
    jobs: deps.jobs ?? new JobStore(),
    chatSessions: deps.chatSessions ?? new ChatSessionStore(),
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // /healthz is mounted FIRST and uses no deps — it must succeed regardless
  // of chain/state/config (independent of /status free/working/offline).
  app.use(healthzRouter());

  app.get("/capability", makeCapabilityHandler(resolved));
  app.get("/status", makeStatusHandler(resolved));

  // Dispatch by configured capability. The supplier is a single-capability
  // process — it advertises one on-chain capability_id and serves one route
  // shape. Hard-mounting the wrong route would let a misconfigured client
  // hang on a request that's guaranteed to fail capability validation; we'd
  // rather it 404 immediately. (The on-chain capability_id check still runs
  // on every request, so this is belt-and-braces.)
  if (resolved.config.capabilityKind === "tts") {
    app.post("/v1/audio/synthesize", makeTtsHandler(resolved));
    app.get("/v1/audio/synthesize/:jobId", makeGetTtsJobHandler(resolved));
  } else if (resolved.config.capabilityKind === "chat-session") {
    const chat = makeChatSessionHandlers(resolved);
    app.post("/v1/chat/start", chat.start);
    app.post("/v1/chat/message", chat.message);
    app.post("/v1/chat/end", chat.end);
  } else {
    app.post("/v1/chat/completions", makeChatHandler(resolved));
    app.get("/v1/chat/completions/:jobId", makeGetJobHandler(resolved));
  }

  // Centralised error handler (4 args required by Express).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({
        reason: "internal_error",
        message,
        error: { reason: "internal_error", message },
      });
    }
  });

  return app;
}
