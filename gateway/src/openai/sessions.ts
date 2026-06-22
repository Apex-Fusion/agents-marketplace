/**
 * gateway/src/openai/sessions.ts — chat sessions (Vector extension).
 *
 * One escrow per SESSION (fixed price locked at open, settled at close). Real
 * token streaming per turn against an llm.chat.v1 supplier. Endpoints:
 *   POST /openai/v1/chat/sessions            → open  (startChat)
 *   POST /openai/v1/chat/sessions/:id/messages → one streamed turn
 *   POST /openai/v1/chat/sessions/:id/close  → settle (endChat: Submit+Accept)
 *
 * The chat.v1 supplier has no system-role channel and accumulates the transcript
 * server-side, so we send one user `content` per turn and mirror the transcript
 * in-memory (for endChat's response_hash verification). A process restart loses
 * the mirror; an abandoned session is reclaimed by the sweeper.
 */

import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { TxConstructionError, type ChatMessage } from "@marketplace/shared/tx";
import { SupplierError } from "@marketplace/buyer/sdk";
import type { GatewayDeps } from "../deps.js";
import type { ApiKeyRow, GatewayStore, SessionRow } from "../db/store.js";
import type { KeyContext } from "../sdk/registry.js";
import { requireKey } from "../middleware/apiKeyAuth.js";
import { asyncHandler } from "../middleware/http.js";
import { selectCandidates, parseRef } from "../routing/selectSupplier.js";
import { preflight } from "../onchain/preflight.js";
import { ensureWalletHealthy } from "../walletHealth.js";
import { badRequest, notFound, paymentRequired, toGatewayError, toErrorBody } from "./errors.js";
import {
  genId,
  nowSec,
  buildChatCompletion,
  buildChunk,
  sseData,
  SSE_DONE,
  type Usage,
} from "./shapes.js";

const CAPABILITY = "llm.chat.v1";

/** In-memory per-session transcript mirror (sessionId → messages). */
const transcripts = new Map<string, ChatMessage[]>();

function refStr(ref: { txHash: string; index: number }): string {
  return `${ref.txHash}#${ref.index}`;
}

// ─── open ──────────────────────────────────────────────────────────────────

export function makeOpenSessionHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = body.model;
    if (typeof model !== "string" || model === "") {
      throw badRequest("invalid_model", "`model` is required");
    }
    const ctx = deps.registry.getContext(keyRow);
    await ctx.mutex.run(() => openSession(deps, keyRow, ctx, model, res));
  });
}

async function openSession(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  model: string,
  res: Response,
): Promise<void> {
  const candidates = await selectCandidates({
    indexerUrl: deps.config.indexerUrl,
    model,
    capabilityId: CAPABILITY,
    fetchFn: deps.fetchFn,
  });
  if (candidates.length === 0) {
    throw notFound("model_not_found", `no available chat (llm.chat.v1) supplier for model "${model}"`);
  }
  const primary = candidates[0];
  const pf = await preflight(deps.chain, ctx.walletKey.address, primary);
  if (!pf.ok) {
    throw paymentRequired(
      pf.collateralOk ? "insufficient balance to open a session" : "wallet has no ≥5 ADA pure-ADA collateral UTxO",
      {
        x_vector: {
          required_lovelace: pf.requiredLovelace.toString(),
          available_lovelace: pf.availableLovelace.toString(),
          collateral_ok: pf.collateralOk,
          deposit_address: ctx.walletKey.address,
        },
      },
    );
  }

  // startChat posts the escrow + supplier Claim. Fall back to the next supplier
  // only on a pre-post error (TxConstructionError, or a busy supplier caught by
  // startChat's /status pre-check before any funds are locked).
  let started: Awaited<ReturnType<typeof ctx.sdk.startChat>> | undefined;
  let used: (typeof candidates)[number] | undefined;
  let lastErr: unknown;
  for (const cand of candidates) {
    try {
      started = await ctx.sdk.startChat({ advertRef: cand.advertRef, payment_lovelace: cand.priceLovelace });
      used = cand;
      break;
    } catch (err) {
      lastErr = err;
      if (err instanceof TxConstructionError) continue;
      if (err instanceof SupplierError && err.reason === "supplier_busy") continue;
      throw err;
    }
  }
  if (!started || !used) throw toGatewayError(lastErr ?? new Error("no chat supplier could be engaged"));

  const sessionId = randomUUID();
  deps.store.insertSession({
    id: sessionId,
    key_id: keyRow.id,
    escrow_ref: refStr(started.escrowRef),
    session_nonce: started.sessionNonce,
    supplier_base_url: started.supplierBaseUrl,
    supplier_pkh: used.supplierPkh,
    model,
    price_lovelace: used.priceLovelace.toString(),
    state: "open",
    opened_at: Date.now(),
  });
  transcripts.set(sessionId, []);

  res.status(200).json({ id: sessionId, object: "chat.session", model, created: nowSec() });
}

// ─── messages (one streamed turn) ────────────────────────────────────────────

export function makeSessionMessageHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const session = loadOwnedSession(deps.store, req, keyRow);
    if (session.state !== "open") {
      throw badRequest("session_closed", `session ${session.id} is ${session.state}`);
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const stream = body.stream !== false; // sessions default to streaming
    const content = resolveTurnContent(session.id, body);
    if (content === "") throw badRequest("content_required", "no user content in this turn");

    const ctx = deps.registry.getContext(keyRow);
    await ctx.mutex.run(() => streamTurn(deps, session, content, stream, res));
  });
}

function resolveTurnContent(sessionId: string, body: Record<string, unknown>): string {
  if (typeof body.content === "string") {
    return foldSystem(sessionId, body.content, body);
  }
  if (Array.isArray(body.messages)) {
    const msgs = body.messages as Array<{ role?: unknown; content?: unknown }>;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user" && typeof m.content === "string");
    const userContent = typeof lastUser?.content === "string" ? lastUser.content : "";
    return foldSystem(sessionId, userContent, body);
  }
  return "";
}

/** On the first turn only, prepend any system message (chat.v1 has no system channel). */
function foldSystem(sessionId: string, content: string, body: Record<string, unknown>): string {
  const mirror = transcripts.get(sessionId) ?? [];
  if (mirror.length > 0) return content;
  if (Array.isArray(body.messages)) {
    const sys = (body.messages as Array<{ role?: unknown; content?: unknown }>)
      .filter((m) => m.role === "system" && typeof m.content === "string")
      .map((m) => m.content as string)
      .join("\n\n");
    if (sys) return `System: ${sys}\n\n${content}`;
  }
  return content;
}

async function streamTurn(
  deps: GatewayDeps,
  session: SessionRow,
  content: string,
  stream: boolean,
  res: Response,
): Promise<void> {
  const id = genId();
  const upstream = await deps.fetchFn(`${session.supplier_base_url.replace(/\/+$/, "")}/v1/chat/message`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", "X-Escrow-Ref": session.escrow_ref },
    body: JSON.stringify({ content }),
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    throw toGatewayError(new SupplierError("supplier_http_error", { status: upstream.status, message: detail.slice(0, 200) }));
  }

  if (stream) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(sseData(buildChunk({ id, model: session.model, delta: { role: "assistant" }, finishReason: null })));
  }

  let assistant = "";
  let errored: string | undefined;
  await readSupplierSse(upstream.body as ReadableStream<Uint8Array>, (frame) => {
    if (frame.type === "token" && typeof frame.value === "string") {
      assistant += frame.value;
      if (stream) res.write(sseData(buildChunk({ id, model: session.model, delta: { content: frame.value }, finishReason: null })));
    } else if (frame.type === "error") {
      errored = typeof frame.message === "string" ? frame.message : "supplier stream error";
    }
  });

  if (errored !== undefined) {
    if (stream) {
      res.write(sseData(toErrorBody(toGatewayError(new SupplierError("upstream_error", { message: errored })))));
      res.end();
      return;
    }
    throw toGatewayError(new SupplierError("upstream_error", { message: errored }));
  }

  // Mirror the transcript for endChat's response_hash verification.
  const mirror = transcripts.get(session.id) ?? [];
  mirror.push({ role: "user", content });
  mirror.push({ role: "assistant", content: assistant });
  transcripts.set(session.id, mirror);

  if (stream) {
    res.write(sseData(buildChunk({ id, model: session.model, delta: {}, finishReason: "stop" })));
    res.write(SSE_DONE);
    res.end();
  } else {
    const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    res.status(200).json(buildChatCompletion({ id, model: session.model, content: assistant, usage }));
  }
}

interface SupplierFrame {
  type?: string;
  value?: string;
  message?: string;
}

/** Read a supplier SSE stream of {type:token|done|error} frames. */
async function readSupplierSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SupplierFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        try {
          onFrame(JSON.parse(data) as SupplierFrame);
        } catch {
          /* ignore non-JSON keepalive/comment frames */
        }
      }
    }
  }
}

// ─── close (settle) ──────────────────────────────────────────────────────────

export function makeCloseSessionHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const session = loadOwnedSession(deps.store, req, keyRow);
    if (session.state !== "open") {
      throw badRequest("session_closed", `session ${session.id} is already ${session.state}`);
    }
    const ctx = deps.registry.getContext(keyRow);
    await ctx.mutex.run(() => closeSession(deps, keyRow, ctx, session, res));
  });
}

async function closeSession(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  session: SessionRow,
  res: Response,
): Promise<void> {
  const escrowRef = parseRef(session.escrow_ref);
  if (!escrowRef) throw badRequest("bad_session", "session has an invalid escrow ref");

  const result = await ctx.sdk.endChat({
    escrowRef,
    sessionNonce: session.session_nonce,
    supplierBaseUrl: session.supplier_base_url,
    transcript: transcripts.get(session.id),
  });

  deps.store.setSessionState(session.id, "closed", Date.now());
  transcripts.delete(session.id);

  const prompt = result.receipt.prompt_tokens ?? 0;
  const completion = result.receipt.completion_tokens ?? 0;
  deps.store.insertUsage({
    id: randomUUID(),
    key_id: keyRow.id,
    created_at: Date.now(),
    kind: "chat_session",
    model: session.model,
    capability_id: CAPABILITY,
    supplier_pkh: session.supplier_pkh,
    escrow_ref: session.escrow_ref,
    cost_lovelace: session.price_lovelace,
    prompt_tokens: prompt,
    completion_tokens: completion,
    status: "completed",
    failure_reason: null,
  });

  await ensureWalletHealthy(deps.chain, ctx.walletKey).catch((e) =>
    // eslint-disable-next-line no-console
    console.error("[gateway] wallet-health after session close:", e instanceof Error ? e.message : e),
  );

  res.status(200).json({
    status: "closed",
    escrow_ref: session.escrow_ref,
    accepted_ref: refStr(result.acceptedRef),
    model: session.model,
    x_vector: { receipt: result.receipt, receipt_signature: result.receiptSignature, escrow_ref: session.escrow_ref },
  });
}

function loadOwnedSession(store: GatewayStore, req: Request, keyRow: ApiKeyRow): SessionRow {
  const raw = (req.params as Record<string, string | string[] | undefined>).id;
  const id = typeof raw === "string" ? raw : undefined;
  const session = id ? store.getSession(id) : undefined;
  if (!session || session.key_id !== keyRow.id) {
    throw notFound("session_not_found", `no chat session ${id ?? "(none)"}`);
  }
  return session;
}
