import { randomUUID } from "crypto";
import type {
  ResponseItem,
  ResponseObject,
  ResponseRequest,
  ResponseStreamEvent,
} from "@marketplace/shared/responses";
import type { GatewayDeps } from "../deps.js";
import type { ApiKeyRow, SessionRow, StoredResponseRow } from "../db/store.js";
import type { KeyContext } from "../sdk/registry.js";
import { getSessionLock, dropSessionState } from "./transcripts.js";
import { CAPABILITY, SessionGoneError, openSessionCore, streamSupplierTurn } from "./sessions.js";
import type { ParsedResponseRequest } from "./validate.js";
import { publicResponse, publicStreamEvent } from "./shapes.js";
import { completeStoredResponse } from "./responseStore.js";
import { GatewayError } from "./errors.js";

function recordSessionCost(deps: GatewayDeps, session: SessionRow): void {
  deps.store.insertUsage({
    id: randomUUID(), key_id: session.key_id, created_at: Date.now(), kind: "chat_session",
    model: session.model, capability_id: CAPABILITY, supplier_pkh: session.supplier_pkh,
    escrow_ref: session.escrow_ref,
    cost_lovelace: deps.config.chatSettleMode === "ticket" ? "0" : session.price_lovelace,
    prompt_tokens: 0, completion_tokens: 0, status: "completed", failure_reason: null,
  });
}

function markSessionGone(deps: GatewayDeps, session: SessionRow): void {
  const current = deps.store.getSession(session.id);
  if (!current || current.state !== "open") return;
  deps.store.setSessionState(session.id, "closed", Date.now());
  dropSessionState(session.id);
  recordSessionCost(deps, session);
}

async function requestSupplierEnd(deps: GatewayDeps, session: SessionRow): Promise<boolean> {
  try {
    const response = await deps.fetchFn(`${session.supplier_base_url.replace(/\/+$/, "")}/v1/chat/end`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Escrow-Ref": session.escrow_ref },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(90_000),
    });
    await response.text().catch(() => "");
    return response.ok;
  } catch {
    return false;
  }
}

async function closeDemoSession(
  deps: GatewayDeps,
  sessionId: string,
  opts: { reason: "evicted" | "idle"; idleCutoffMs?: number; nowMs?: number },
): Promise<string | null> {
  return getSessionLock(sessionId).run(async () => {
    const session = deps.store.getSession(sessionId);
    if (!session || session.state !== "open" || session.managed_demo !== 1) return null;
    if (opts.idleCutoffMs !== undefined &&
        (opts.nowMs ?? Date.now()) - session.last_used_at < opts.idleCutoffMs) return null;
    await requestSupplierEnd(deps, session);
    markSessionGone(deps, session);
    console.log(`[gateway:demo] closed session ${sessionId} (${opts.reason})`);
    return session.supplier_pkh;
  });
}

export async function sweepIdleDemoSessions(deps: GatewayDeps, nowMs = Date.now()): Promise<void> {
  for (const session of deps.store.listOpenSessions()) {
    if (session.managed_demo !== 1 || nowMs - session.last_used_at < deps.config.demoSessionIdleMs) continue;
    try {
      await closeDemoSession(deps, session.id, {
        reason: "idle", idleCutoffMs: deps.config.demoSessionIdleMs, nowMs,
      });
    } catch (error) {
      console.error(`[gateway:demo] idle close of ${session.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

const MAX_EVICTIONS = 2;

function pickLru(deps: GatewayDeps, keyId: string, model: string, excluded: ReadonlySet<string>): SessionRow | undefined {
  return deps.store.listOpenSessionsByKey(keyId)
    .filter((session) => session.managed_demo === 1 && session.model === model && !excluded.has(session.id))
    .sort((left, right) => left.last_used_at - right.last_used_at)[0];
}

async function openSessionWithEviction(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  parsed: ParsedResponseRequest,
  request: ResponseRequest,
  onCommit: () => void,
): Promise<SessionRow> {
  const freedPkhs = new Set<string>();
  const evicted = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.mutex.run(() => openSessionCore(deps, keyRow, ctx, parsed.model, {
        ignoreStatusFor: freedPkhs.size > 0 ? freedPkhs : undefined,
        onPreflightOk: onCommit,
        supplierPkh: parsed.supplierPkh,
        managedDemo: true,
        responseRequest: request,
      }));
    } catch (error) {
      const unavailable = error instanceof GatewayError &&
        (error.code === "model_not_found" ||
          error.code === "overloaded" ||
          error.code === "suppliers_unavailable");
      if (!unavailable || attempt >= MAX_EVICTIONS) throw error;
      const victim = pickLru(deps, keyRow.id, parsed.model, evicted);
      if (!victim) throw error;
      evicted.add(victim.id);
      const freed = await closeDemoSession(deps, victim.id, { reason: "evicted" });
      if (!freed) throw error;
      freedPkhs.add(freed);
    }
  }
}

interface DemoRunArgs {
  deps: GatewayDeps;
  keyRow: ApiKeyRow;
  ctx: KeyContext;
  parsed: ParsedResponseRequest;
  request: ResponseRequest;
  responseId: string;
  createdAt: number;
  history: ResponseItem[];
  parent?: StoredResponseRow;
  onCommit: () => void;
  onStreamEvent?: (event: ResponseStreamEvent) => void;
}

export async function runDemoResponse(args: DemoRunArgs): Promise<ResponseObject> {
  const {
    deps, keyRow, ctx, parsed, request, responseId, createdAt,
    history, parent, onCommit, onStreamEvent,
  } = args;
  const publicEvent = (event: ResponseStreamEvent): ResponseStreamEvent =>
    publicStreamEvent(event, {
      id: responseId,
      model: parsed.model,
      previousResponseId: parsed.previousResponseId,
      createdAt,
      metadata: parsed.metadata,
    });
  const relaySupplierEvent = onStreamEvent
    ? (event: ResponseStreamEvent): void => {
      if (event.type === "error" ||
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed") return;
      onStreamEvent(publicEvent(event));
    }
    : undefined;
  const finish = (session: SessionRow, result: ResponseObject): ResponseObject => {
    const response = publicResponse({
      id: responseId,
      model: parsed.model,
      result,
      previousResponseId: parsed.previousResponseId,
      createdAt,
      metadata: parsed.metadata,
    });
    if (parsed.store) {
      completeStoredResponse(deps, {
        id: responseId,
        keyId: keyRow.id,
        sessionId: session.id,
        response,
      });
    } else {
      deps.store.setSessionHead(session.id, null);
    }
    if (onStreamEvent) {
      const terminal = response.status === "incomplete"
        ? "response.incomplete"
        : response.status === "failed" ? "response.failed" : "response.completed";
      onStreamEvent({ type: terminal, response });
    }
    return response;
  };

  if (parent?.session_id) {
    const session = deps.store.getSession(parent.session_id);
    if (session && session.state === "open" && session.key_id === keyRow.id &&
        session.model === parsed.model && session.head_response_id === parent.id &&
        (parsed.supplierPkh === undefined || session.supplier_pkh === parsed.supplierPkh)) {
      const outcome = await getSessionLock(session.id).run(async () => {
        const current = deps.store.getSession(session.id);
        if (!current || current.state !== "open" || current.head_response_id !== parent.id ||
            (parsed.supplierPkh !== undefined && current.supplier_pkh !== parsed.supplierPkh)) return undefined;
        onCommit();
        try {
          const capped = request.max_output_tokens === undefined || session.max_output_tokens <= 0 ? request : {
            ...request,
            max_output_tokens: Math.min(request.max_output_tokens, session.max_output_tokens),
          };
          const turn = await streamSupplierTurn(deps, session, capped, relaySupplierEvent);
          return finish(session, turn.response);
        } catch (error) {
          if (error instanceof SessionGoneError) {
            markSessionGone(deps, session);
            return undefined;
          }
          throw error;
        }
      });
      if (outcome) return outcome;
    }
  }

  const replay: ResponseRequest = { ...request, input: [...history, ...request.input] };
  const session = await openSessionWithEviction(deps, keyRow, ctx, parsed, replay, onCommit);
  return getSessionLock(session.id).run(async () => {
    const capped = replay.max_output_tokens === undefined || session.max_output_tokens <= 0 ? replay : {
      ...replay,
      max_output_tokens: Math.min(replay.max_output_tokens, session.max_output_tokens),
    };
    try {
      const turn = await streamSupplierTurn(deps, session, capped, relaySupplierEvent);
      return finish(session, turn.response);
    } catch (error) {
      if (error instanceof SessionGoneError) markSessionGone(deps, session);
      throw error;
    }
  });
}
