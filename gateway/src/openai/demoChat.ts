/**
 * gateway/src/openai/demoChat.ts — session-backed /chat/completions for the
 * shared demo key.
 *
 * Demo requests keep the standard OpenAI wire shape (tools included) but run
 * against real escrow-per-session marketplace conversations: transcript-prefix
 * affinity maps each stateless request onto an open session and forwards only
 * the unseen delta; a miss transparently opens a new session (escrow post —
 * the only chain work, under the key mutex) and replays the full history as
 * the first turn. Supplier idle-closes are healed by reopening; the sweeper
 * settles the abandoned escrow.
 *
 * Demo keys NEVER fall back to the one-shot path: resolveSubmittedRef's
 * lone-Submitted-row fallback assumes ≤1 in-flight escrow per wallet, and the
 * demo wallet holds one escrow per concurrent session.
 */

import { randomUUID } from "crypto";
import type { Response } from "express";
import type { ChatMessage, ToolCall } from "@marketplace/shared/tx";
import type { GatewayDeps } from "../deps.js";
import type { ApiKeyRow, SessionRow } from "../db/store.js";
import type { KeyContext } from "../sdk/registry.js";
import { transcripts, getSessionLock, dropSessionState } from "./transcripts.js";
import { matchSessionPrefix, type AffinityCandidate } from "./affinity.js";
import {
  CAPABILITY,
  SessionGoneError,
  openSessionCore,
  streamSupplierTurn,
  type TurnResult,
} from "./sessions.js";
import type { ParsedChatRequest } from "./validate.js";
import { genId, buildChatCompletion, buildChunk, sseData, SSE_DONE, type Usage } from "./shapes.js";
import { badRequest, toGatewayError, toErrorBody } from "./errors.js";

interface DemoSessionMeta {
  keyId: string;
  model: string;
  lastUsedAt: number;
}

/** Open sessions owned by the demo executor (sessionId → meta). Mirrors live
 * in transcripts.ts; this map scopes affinity to demo-opened sessions. */
const demoSessions = new Map<string, DemoSessionMeta>();

/** Forget a session (closed/settled elsewhere, e.g. by the sweeper). */
export function dropDemoSession(sessionId: string): void {
  demoSessions.delete(sessionId);
}

function candidatesFor(keyId: string, model: string): AffinityCandidate[] {
  const out: AffinityCandidate[] = [];
  for (const [sessionId, meta] of demoSessions) {
    if (meta.keyId !== keyId || meta.model !== model) continue;
    const mirror = transcripts.get(sessionId);
    if (!mirror) continue;
    out.push({ sessionId, model: meta.model, mirror, lastUsedAt: meta.lastUsedAt });
  }
  return out;
}

/** Record the session's flat fee when the demo executor closes its row (the
 * supplier already Submitted; the sweeper Accepts the escrow afterwards). */
function recordSessionCost(deps: GatewayDeps, session: SessionRow): void {
  deps.store.insertUsage({
    id: randomUUID(),
    key_id: session.key_id,
    created_at: Date.now(),
    kind: "chat_session",
    model: session.model,
    capability_id: CAPABILITY,
    supplier_pkh: session.supplier_pkh,
    escrow_ref: session.escrow_ref,
    cost_lovelace: session.price_lovelace,
    prompt_tokens: 0,
    completion_tokens: 0,
    status: "completed",
    failure_reason: null,
  });
}

function markSessionGone(deps: GatewayDeps, session: SessionRow): void {
  deps.store.setSessionState(session.id, "closed", Date.now());
  dropSessionState(session.id);
  dropDemoSession(session.id);
  recordSessionCost(deps, session);
}

type LockedTurnOutcome =
  | { kind: "done"; result: TurnResult }
  | { kind: "retry" } // candidate no longer valid — re-run the match
  | { kind: "gone" }; // supplier lost the session — open a fresh one

/** Streaming sink shared across turn attempts on one response. */
interface StreamSink {
  onToken: (token: string) => void;
  emitToolCalls: (toolCalls: ToolCall[]) => void;
}

export async function runDemoChat(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  parsed: ParsedChatRequest,
  res: Response,
): Promise<void> {
  const last = parsed.messages[parsed.messages.length - 1];
  if (last.role !== "user" && last.role !== "tool") {
    // Reject before any chain work — opening an escrow for an unanswerable
    // request would burn a session fee for a guaranteed supplier 400.
    throw badRequest("invalid_messages", "the last message must have role user or tool");
  }

  const id = genId();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let roleSent = false;
  if (parsed.stream) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(": connected\n\n");
    keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        /* client gone */
      }
    }, 10_000);
  }

  const ensureRole = (): void => {
    if (roleSent) return;
    roleSent = true;
    res.write(sseData(buildChunk({ id, model: parsed.model, delta: { role: "assistant" }, finishReason: null })));
  };
  const sink: StreamSink = {
    onToken: (token) => {
      if (!parsed.stream) return;
      ensureRole();
      res.write(sseData(buildChunk({ id, model: parsed.model, delta: { content: token }, finishReason: null })));
    },
    emitToolCalls: (toolCalls) => {
      if (!parsed.stream) return;
      ensureRole();
      res.write(
        sseData(
          buildChunk({
            id,
            model: parsed.model,
            delta: { tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) },
            finishReason: null,
          }),
        ),
      );
    },
  };

  try {
    const result = await runWithAffinity(deps, keyRow, ctx, parsed, sink);
    if (keepalive) clearInterval(keepalive);

    const usage: Usage = {
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
    };
    if (parsed.stream) {
      if (result.assistantMessage.tool_calls?.length) sink.emitToolCalls(result.assistantMessage.tool_calls);
      ensureRole();
      res.write(sseData(buildChunk({ id, model: parsed.model, delta: {}, finishReason: result.finishReason, usage })));
      res.write(SSE_DONE);
      res.end();
    } else {
      res.status(200).json(
        buildChatCompletion({
          id,
          model: parsed.model,
          content: result.assistantMessage.content,
          toolCalls: result.assistantMessage.tool_calls,
          finishReason: result.finishReason,
          usage,
        }),
      );
    }
  } catch (err) {
    if (keepalive) clearInterval(keepalive);
    if (parsed.stream && res.headersSent) {
      try {
        res.write(sseData(toErrorBody(toGatewayError(err))));
      } catch {
        /* client gone */
      }
      res.end();
      return;
    }
    throw err;
  }
}

async function runWithAffinity(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  parsed: ParsedChatRequest,
  sink: StreamSink,
): Promise<TurnResult> {
  // Affinity: try matching sessions until one serves the turn. The match runs
  // synchronously (no await between match and lock acquire, so the candidate
  // set can't shift underneath us); the prefix is re-checked inside the lock
  // because a concurrent request may have advanced the session first.
  for (let attempt = 0; attempt < 3; attempt++) {
    const match = matchSessionPrefix(candidatesFor(keyRow.id, parsed.model), parsed.messages, parsed.model);
    if (!match) break;

    const outcome: LockedTurnOutcome = await getSessionLock(match.sessionId).run(async () => {
      const meta = demoSessions.get(match.sessionId);
      const mirror = transcripts.get(match.sessionId);
      const session = deps.store.getSession(match.sessionId);
      if (!meta || !mirror || !session || session.state !== "open") {
        dropDemoSession(match.sessionId);
        return { kind: "retry" };
      }
      const recheck = matchSessionPrefix(
        [{ sessionId: session.id, model: meta.model, mirror, lastUsedAt: meta.lastUsedAt }],
        parsed.messages,
        parsed.model,
      );
      if (!recheck) return { kind: "retry" };

      try {
        const result = await streamSupplierTurn(
          deps,
          session,
          { messages: recheck.delta, tools: parsed.tools, tool_choice: parsed.toolChoice },
          sink.onToken,
        );
        meta.lastUsedAt = Date.now();
        return { kind: "done", result };
      } catch (err) {
        if (err instanceof SessionGoneError) {
          // Supplier idle-closed (or restarted). Close our row, record the
          // fee (the escrow settles via the sweeper) and reopen fresh.
          markSessionGone(deps, session);
          return { kind: "gone" };
        }
        throw err;
      }
    });

    if (outcome.kind === "done") return outcome.result;
    if (outcome.kind === "gone") break;
    // retry: candidate vanished/advanced — re-match against current state.
  }

  // Miss: open a new session (chain work → key mutex) and replay the full
  // history as its first turn.
  const session = await ctx.mutex.run(() => openSessionCore(deps, keyRow, ctx, parsed.model));
  demoSessions.set(session.id, { keyId: keyRow.id, model: parsed.model, lastUsedAt: Date.now() });
  return getSessionLock(session.id).run(async () => {
    try {
      return await streamSupplierTurn(
        deps,
        session,
        { messages: parsed.messages, tools: parsed.tools, tool_choice: parsed.toolChoice },
        sink.onToken,
      );
    } catch (err) {
      if (err instanceof SessionGoneError) {
        // Freshly opened yet already gone (supplier crashed mid-claim).
        // Surface as an upstream error rather than looping.
        markSessionGone(deps, session);
      }
      throw err;
    }
  });
}
