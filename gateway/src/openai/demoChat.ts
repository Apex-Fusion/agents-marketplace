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
import { matchSessionPrefix, trimToRespondable, type AffinityCandidate } from "./affinity.js";
import {
  CAPABILITY,
  SessionGoneError,
  openSessionCore,
  streamSupplierTurn,
  type TurnResult,
} from "./sessions.js";
import type { ParsedChatRequest } from "./validate.js";
import { genId, buildChatCompletion, buildChunk, sseData, SSE_DONE, type Usage } from "./shapes.js";
import { GatewayError, badRequest, toGatewayError, toErrorBody } from "./errors.js";

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

/** Ask the supplier to settle (Submit) the session. NO gateway chain work —
 * the sweeper Accepts the resulting Submitted escrow. The supplier releases
 * its single slot as part of ending, so a truthy return means the supplier is
 * free again. Best-effort: on failure the sweeper reclaims later. */
async function requestSupplierEnd(deps: GatewayDeps, session: SessionRow): Promise<boolean> {
  try {
    const res = await deps.fetchFn(`${session.supplier_base_url.replace(/\/+$/, "")}/v1/chat/end`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Escrow-Ref": session.escrow_ref },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(90_000),
    });
    await res.text().catch(() => "");
    return res.ok;
  } catch {
    return false;
  }
}

/** Close one demo session (evicted for capacity, or idle-janitored). Runs
 * under the session lock so an in-flight turn finishes first; takes NO key
 * mutex (no chain work here — see requestSupplierEnd). Returns the freed
 * supplier_pkh, or null when the session was already gone or (janitor) was
 * used again while we waited for the lock. */
async function closeDemoSession(
  deps: GatewayDeps,
  sessionId: string,
  opts: { reason: "evicted" | "idle"; idleCutoffMs?: number; nowMs?: number },
): Promise<string | null> {
  if (!demoSessions.has(sessionId)) return null;
  return getSessionLock(sessionId).run(async () => {
    const meta = demoSessions.get(sessionId);
    if (!meta) return null; // lost a race with another closer
    // Re-check idleness inside the lock: a turn that won the lock first has
    // bumped lastUsedAt past the sweep's reference clock.
    if (opts.idleCutoffMs !== undefined && (opts.nowMs ?? Date.now()) - meta.lastUsedAt < opts.idleCutoffMs) {
      return null;
    }
    const session = deps.store.getSession(sessionId);
    if (!session || session.state !== "open") {
      dropDemoSession(sessionId);
      return null;
    }
    await requestSupplierEnd(deps, session);
    markSessionGone(deps, session);
    // eslint-disable-next-line no-console
    console.log(`[gateway:demo] closed session ${sessionId} (${opts.reason}), freed supplier ${session.supplier_pkh}`);
    return session.supplier_pkh;
  });
}

/** Least-recently-used open demo session for (key, model), excluding prior
 * victims. Same-model scoping doubles as a guard: a bogus model name has no
 * demo sessions, so eviction can never loop on a genuine model_not_found. */
function pickLruDemoSession(keyId: string, model: string, exclude: ReadonlySet<string>): string | null {
  let lruId: string | null = null;
  let lruAt = Infinity;
  for (const [sessionId, meta] of demoSessions) {
    if (meta.keyId !== keyId || meta.model !== model || exclude.has(sessionId)) continue;
    if (meta.lastUsedAt < lruAt) {
      lruAt = meta.lastUsedAt;
      lruId = sessionId;
    }
  }
  return lruId;
}

/** Close demo sessions idle past deps.config.demoSessionIdleMs so abandoned
 * conversations (client gone, title-gen one-offs) release their single-slot
 * suppliers. Called from the sweeper tick; sequential to keep supplier
 * /v1/chat/end calls orderly. */
export async function sweepIdleDemoSessions(deps: GatewayDeps, nowMs = Date.now()): Promise<void> {
  const idleMs = deps.config.demoSessionIdleMs;
  for (const [sessionId, meta] of [...demoSessions]) {
    if (nowMs - meta.lastUsedAt < idleMs) continue;
    try {
      await closeDemoSession(deps, sessionId, { reason: "idle", idleCutoffMs: idleMs, nowMs });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[gateway:demo] idle close of ${sessionId} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

const MAX_EVICTIONS = 2;

function isNoSupplierError(err: unknown): boolean {
  return err instanceof GatewayError && (err.code === "model_not_found" || err.code === "overloaded");
}

/** Open a session, evicting up to MAX_EVICTIONS LRU demo sessions when every
 * supplier is pinned. Eviction frees the supplier immediately (its slot
 * releases at Submit) but the indexer's status poll lags, so the retry passes
 * the freed pkhs through selectCandidates' ignoreStatusFor. Lock ordering is
 * safe: eviction holds only the session lock, the open holds only the key
 * mutex — never nested. */
async function openSessionWithEviction(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  model: string,
): Promise<SessionRow> {
  const freedPkhs = new Set<string>();
  const evicted = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.mutex.run(() =>
        openSessionCore(deps, keyRow, ctx, model, freedPkhs.size > 0 ? { ignoreStatusFor: freedPkhs } : undefined),
      );
    } catch (err) {
      if (attempt >= MAX_EVICTIONS || !isNoSupplierError(err)) throw err;
      const victimId = pickLruDemoSession(keyRow.id, model, evicted);
      if (!victimId) throw err;
      evicted.add(victimId);
      const pkh = await closeDemoSession(deps, victimId, { reason: "evicted" });
      if (!pkh) throw err; // nothing actually freed — don't loop
      freedPkhs.add(pkh);
    }
  }
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
  // Clients sometimes send histories ending in an assistant (continue/retry
  // flows) or system message; the chat.v1 supplier can only respond to a
  // user/tool-terminated turn. Trim trailing unrespondable messages
  // (regenerate semantics) and reject — before any chain work — only when
  // nothing respondable remains.
  const trimmed = trimToRespondable(parsed.messages);
  if (trimmed.length === 0) {
    throw badRequest("invalid_messages", "no user or tool message to respond to");
  }
  const effective: ParsedChatRequest =
    trimmed.length === parsed.messages.length ? parsed : { ...parsed, messages: trimmed };

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
    const result = await runWithAffinity(deps, keyRow, ctx, effective, sink);
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

  // Miss: open a new session (chain work → key mutex; evicts an LRU demo
  // session when every supplier is pinned) and replay the full history as its
  // first turn.
  const session = await openSessionWithEviction(deps, keyRow, ctx, parsed.model);
  demoSessions.set(session.id, { keyId: keyRow.id, model: parsed.model, lastUsedAt: Date.now() });
  return getSessionLock(session.id).run(async () => {
    try {
      const result = await streamSupplierTurn(
        deps,
        session,
        { messages: parsed.messages, tools: parsed.tools, tool_choice: parsed.toolChoice },
        sink.onToken,
      );
      // Refresh recency after the (possibly long) first stream so this live
      // thread isn't the LRU/janitor's first victim.
      const meta = demoSessions.get(session.id);
      if (meta) meta.lastUsedAt = Date.now();
      return result;
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
