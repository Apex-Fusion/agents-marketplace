import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { TxConstructionError } from "@marketplace/shared/tx";
import {
  readResponseEvents,
  validateResponseToolOutputs,
  type ResponseObject,
  type ResponseRequest,
  type ResponseStreamEvent,
} from "@marketplace/shared/responses";
import {
  getSessionLock,
  dropSessionState,
  loadSessionTranscript,
  persistSessionTranscript,
  transcripts,
} from "./transcripts.js";
import { SupplierError, type StartChatResult } from "@marketplace/buyer/sdk";
import type { GatewayDeps } from "../deps.js";
import type { ApiKeyRow, GatewayStore, SessionRow } from "../db/store.js";
import type { KeyContext } from "../sdk/registry.js";
import { requireKey } from "../middleware/apiKeyAuth.js";
import { asyncHandler } from "../middleware/http.js";
import { selectCandidates, parseRef } from "../routing/selectSupplier.js";
import { preflight } from "../onchain/preflight.js";
import { ensureWalletHealthy } from "../walletHealth.js";
import { seal } from "../crypto/seal.js";
import { badRequest, notFound, paymentRequired, toGatewayError } from "./errors.js";
import {
  genId,
  nowSec,
  isResponseObject,
  publicResponse,
  publicStreamEvent,
  responseSse,
  sseEvent,
  streamFailure,
} from "./shapes.js";
import { parseSessionTurnRequest } from "./validate.js";

export const CAPABILITY = "llm.chat.v1";

export class SessionGoneError extends Error {
  constructor(sessionId: string) {
    super(`supplier no longer has session ${sessionId}`);
    this.name = "SessionGoneError";
  }
}

function refStr(ref: { txHash: string; index: number }): string {
  return `${ref.txHash}#${ref.index}`;
}

interface ResponsesCapability {
  inference_api: "responses";
  upstream_api: string;
  reasoning_disabled: boolean;
}

async function readResponsesCapability(
  deps: GatewayDeps,
  baseUrl: string,
): Promise<ResponsesCapability> {
  const capabilityResponse = await deps.fetchFn(
    `${baseUrl.replace(/\/+$/, "")}/capability`,
    { headers: { accept: "application/json" } },
  );
  if (!capabilityResponse.ok) {
    throw toGatewayError(new SupplierError("supplier_http_error", {
      status: capabilityResponse.status,
      message: `supplier /capability returned HTTP ${capabilityResponse.status}`,
    }));
  }
  let capability: unknown;
  try {
    capability = await capabilityResponse.json();
  } catch {
    throw toGatewayError(new SupplierError("malformed_response", {
      message: "supplier capability is not valid JSON",
    }));
  }
  if (typeof capability !== "object" || capability === null || Array.isArray(capability) ||
      !("inference_api" in capability) || capability.inference_api !== "responses" ||
      !("upstream_api" in capability) || typeof capability.upstream_api !== "string") {
    throw toGatewayError(new SupplierError("malformed_response", {
      message: "supplier capability does not advertise Responses inference",
    }));
  }
  const reasoningDisabled = "reasoning_disabled" in capability ? capability.reasoning_disabled : false;
  if (typeof reasoningDisabled !== "boolean") {
    throw toGatewayError(new SupplierError("malformed_response", {
      message: "supplier reasoning policy must be boolean",
    }));
  }
  return {
    inference_api: capability.inference_api,
    upstream_api: capability.upstream_api,
    reasoning_disabled: reasoningDisabled,
  };
}

export function makeOpenSessionHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw badRequest("invalid_body", "request body must be a JSON object");
    }
    for (const field of Object.keys(body)) {
      if (field !== "model") throw badRequest("unsupported_parameter", `unsupported parameter: ${field}`);
    }
    const model = "model" in body ? body.model : undefined;
    if (typeof model !== "string" || model.length === 0) {
      throw badRequest("invalid_model", "`model` is required");
    }
    const ctx = deps.registry.getContext(keyRow);
    const session = await ctx.mutex.run(() => openSessionCore(deps, keyRow, ctx, model));
    res.status(200).json({
      id: session.id,
      object: "chat.session",
      model: session.model,
      created: nowSec(),
    });
  });
}

export async function openSessionCore(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  model: string,
  opts?: {
    ignoreStatusFor?: ReadonlySet<string>;
    onPreflightOk?: () => void;
    supplierPkh?: string;
    managedDemo?: boolean;
    responseRequest?: ResponseRequest;
  },
): Promise<SessionRow> {
  const candidates = await selectCandidates({
    indexerUrl: deps.config.indexerUrl,
    model,
    capabilityId: CAPABILITY,
    supplierPkh: opts?.supplierPkh,
    preferredSupplierPkh: deps.config.preferredSupplierPkh,
    fetchFn: deps.fetchFn,
    ignoreStatusFor: opts?.ignoreStatusFor,
  });
  if (candidates.length === 0) {
    throw notFound("model_not_found", `no available chat (llm.chat.v1) supplier for model "${model}"`);
  }
  let sessionCandidates = candidates;
  if (opts?.responseRequest && (
    opts.responseRequest.reasoning !== undefined ||
    opts.responseRequest.text !== undefined ||
    opts.responseRequest.input.some((item) => item.type === "reasoning")
  )) {
    const nativeCandidates: typeof candidates = [];
    let capabilityFailure: unknown;
    let sawIncompatible = false;
    for (const candidate of candidates) {
      try {
        const capability = await readResponsesCapability(deps, candidate.endpointUrl);
        const effort = opts.responseRequest.reasoning?.effort;
        const policyConflict = capability.reasoning_disabled && effort !== undefined && effort !== "none";
        if (capability.upstream_api === "responses" && !policyConflict) nativeCandidates.push(candidate);
        else sawIncompatible = true;
      } catch (error) {
        capabilityFailure ??= error;
      }
    }
    if (nativeCandidates.length === 0) {
      if (sawIncompatible) {
        throw badRequest(
          "unsupported_parameter",
          "available suppliers cannot execute these Responses controls",
        );
      }
      throw toGatewayError(capabilityFailure ?? new Error("supplier capability unavailable"));
    }
    sessionCandidates = nativeCandidates;
  }
  const primary = sessionCandidates[0];
  const pf = await preflight(deps.chain, ctx.walletKey.address, primary);
  if (!pf.ok) {
    throw paymentRequired(
      pf.collateralOk ? "insufficient balance to open a session" : "wallet has no ≥5 AP3X pure-AP3X collateral UTxO",
      { x_vector: {
        required_lovelace: pf.requiredLovelace.toString(),
        available_lovelace: pf.availableLovelace.toString(),
        collateral_ok: pf.collateralOk,
        deposit_address: ctx.walletKey.address,
      } },
    );
  }
  opts?.onPreflightOk?.();

  let started: StartChatResult | undefined;
  let used = primary;
  let lastError: unknown;
  for (const candidate of sessionCandidates) {
    try {
      started = await ctx.sdk.startChat({ advertRef: candidate.advertRef, payment_lovelace: candidate.priceLovelace });
      used = candidate;
      break;
    } catch (error) {
      lastError = error;
      if (error instanceof TxConstructionError &&
          error.reason !== "supplier_preflight_failed" &&
          error.reason !== "supplier_adapter_incompatible") continue;
      if (error instanceof SupplierError && error.reason === "supplier_busy") continue;
      throw error;
    }
  }
  if (!started) throw toGatewayError(lastError ?? new Error("no chat supplier could be engaged"));
  if ((started.settleMode === "ticket") !== (deps.config.chatSettleMode === "ticket")) {
    console.warn(`[gateway] settle-mode mismatch for supplier ${used.supplierPkh.slice(0, 8)}`);
  }

  const sessionId = randomUUID();
  const emptyTranscript = seal("[]", deps.config.masterKeyHex);
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
    managed_demo: opts?.managedDemo ? 1 : 0,
    max_output_tokens: used.maxOutputTokens,
    max_processing_ms: used.maxProcessingMs,
    transcript_nonce: emptyTranscript.nonce,
    transcript_ct: emptyTranscript.ct,
    transcript_tag: emptyTranscript.tag,
  });
  transcripts.set(sessionId, []);
  const session = deps.store.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} vanished after insert`);
  return session;
}

export interface TurnResult {
  response: ResponseObject;
  events: ResponseStreamEvent[];
}

/** Drive one off-chain Responses turn. The caller holds the session lock. */
export async function streamSupplierTurn(
  deps: GatewayDeps,
  session: SessionRow,
  payload: ResponseRequest,
  onEvent?: (event: ResponseStreamEvent) => void,
): Promise<TurnResult> {
  const mirror = loadSessionTranscript(deps, session);
  try {
    validateResponseToolOutputs([...mirror, ...payload.input]);
  } catch (error) {
    throw badRequest(
      "invalid_function_call_output",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (payload.reasoning !== undefined || payload.text !== undefined || payload.input.some((item) => item.type === "reasoning")) {
    const capability = await readResponsesCapability(deps, session.supplier_base_url);
    const effort = payload.reasoning?.effort;
    if (capability.upstream_api !== "responses" ||
        (capability.reasoning_disabled && effort !== undefined && effort !== "none")) {
      throw badRequest(
        "unsupported_parameter",
        "this session supplier cannot execute these Responses controls",
      );
    }
  }

  const turnBudgetMs = (session.max_processing_ms > 0 ? session.max_processing_ms : 300_000) + 30_000;
  const controller = new AbortController();
  const turnTimer = setTimeout(() => controller.abort(), turnBudgetMs);
  turnTimer.unref?.();
  const signal = controller.signal;
  let dispatched = false;
  try {
    // A crash after dispatch can leave an unseen supplier suffix. Do not
    // retain a reusable head or a falsely complete durable checkpoint.
    if (!deps.store.setSessionTranscript(session.id, null, null)) {
      throw new SessionGoneError(session.id);
    }
    dispatched = true;
    const upstream = await deps.fetchFn(`${session.supplier_base_url.replace(/\/+$/, "")}/v1/chat/message`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", "X-Escrow-Ref": session.escrow_ref },
      body: JSON.stringify(payload),
      signal,
    });
    if (upstream.status === 404) {
      await upstream.text().catch(() => "");
      throw new SessionGoneError(session.id);
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      throw toGatewayError(new SupplierError("supplier_http_error", { status: upstream.status, message: detail.slice(0, 200) }));
    }

    const events: ResponseStreamEvent[] = [];
    let terminal: ResponseObject | undefined;
    let terminalType: string | undefined;
    for await (const event of readResponseEvents(upstream.body)) {
      events.push(event);
      onEvent?.(event);
      if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
        terminalType = event.type;
        if (isResponseObject(event.response)) terminal = event.response;
      }
    }
    if (!terminal) throw toGatewayError(new SupplierError("malformed_response", { message: "supplier stream has no terminal response" }));
    const expectedTerminal = terminal.status === "completed"
      ? "response.completed"
      : terminal.status === "incomplete" ? "response.incomplete" : "response.failed";
    if (terminalType !== expectedTerminal) {
      throw toGatewayError(new SupplierError("malformed_response", {
        message: `supplier terminal ${String(terminalType)} disagrees with response status ${terminal.status}`,
      }));
    }
    if (terminal.status === "failed") {
      throw toGatewayError(new SupplierError("upstream_error", { message: JSON.stringify(terminal.error ?? {}) }));
    }

    const nextMirror = [...mirror, ...payload.input, ...terminal.output];
    persistSessionTranscript(deps, session.id, nextMirror);
    return { response: terminal, events };
  } catch (error) {
    if (error instanceof SessionGoneError) throw error;
    if (dispatched) {
      deps.store.setSessionState(session.id, "invalid", Date.now());
      dropSessionState(session.id);
    }
    if (signal.aborted) {
      throw new SupplierError("timeout", {
        message: `supplier turn exceeded ${turnBudgetMs}ms`,
      });
    }
    throw error;
  } finally {
    clearTimeout(turnTimer);
  }
}

export function makeSessionMessageHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const selected = loadOwnedSession(deps.store, req, keyRow);
    if (selected.state !== "open") throw badRequest("session_closed", `session ${selected.id} is ${selected.state}`);
    const parsed = parseSessionTurnRequest(req.body);
    const { stream, ...request } = parsed;
    const responseId = genId();
    const responseCreatedAt = nowSec();
    await getSessionLock(selected.id).run(async () => {
      const session = deps.store.getSession(selected.id);
      if (!session || session.key_id !== keyRow.id) {
        throw notFound("session_not_found", `no chat session ${selected.id}`);
      }
      if (session.state !== "open") {
        throw badRequest("session_closed", `session ${session.id} is ${session.state}`);
      }
      let opened = false;
      let sequence = 0;
      const openStream = (): void => {
        if (opened) return;
        opened = true;
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
      };
      const relay = stream
        ? (event: ResponseStreamEvent): void => {
          if (event.type === "error" ||
              event.type === "response.completed" ||
              event.type === "response.incomplete" ||
              event.type === "response.failed") return;
          openStream();
          const publicEvent = publicStreamEvent(event, {
            id: responseId,
            model: session.model,
            createdAt: responseCreatedAt,
          });
          res.write(sseEvent({ ...publicEvent, sequence_number: sequence++ }));
        }
        : undefined;
      try {
        const result = await streamSupplierTurn(deps, session, request, relay);
        const response = publicResponse({
          id: responseId,
          model: session.model,
          createdAt: responseCreatedAt,
          result: result.response,
        });
        if (!stream) {
          res.status(200).json(response);
          return;
        }
        if (!opened) {
          openStream();
          res.end(responseSse(response));
          return;
        }
        const terminal = response.status === "incomplete"
          ? "response.incomplete"
          : "response.completed";
        res.write(sseEvent({
          type: terminal,
          sequence_number: sequence++,
          response,
        }));
        res.end();
      } catch (error) {
        if (!stream || !opened) throw error;
        const gatewayError = toGatewayError(error);
        for (const event of streamFailure(responseId, session.model, {
          code: gatewayError.code,
          message: gatewayError.message,
        })) {
          res.write(sseEvent({ ...event, sequence_number: sequence++ }));
        }
        res.end();
      }
    });
  });
}

export function makeCloseSessionHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const selected = loadOwnedSession(deps.store, req, keyRow);
    const ctx = deps.registry.getContext(keyRow);
    await getSessionLock(selected.id).run(async () => {
      const session = deps.store.getSession(selected.id);
      if (!session || session.key_id !== keyRow.id) {
        throw notFound("session_not_found", `no chat session ${selected.id}`);
      }
      if (session.state !== "open") {
        throw badRequest("session_closed", `session ${session.id} is already ${session.state}`);
      }
      await ctx.mutex.run(() => closeSession(deps, keyRow, ctx, session, res));
    }, "session-close");
  });
}

async function closeSession(deps: GatewayDeps, keyRow: ApiKeyRow, ctx: KeyContext, session: SessionRow, res: Response): Promise<void> {
  const escrowRef = parseRef(session.escrow_ref);
  if (!escrowRef) throw badRequest("bad_session", "session has an invalid escrow ref");
  const transcript = loadSessionTranscript(deps, session);
  const result = await ctx.sdk.endChat({
    escrowRef,
    sessionNonce: session.session_nonce,
    supplierBaseUrl: session.supplier_base_url,
    transcript,
  });
  deps.store.setSessionState(session.id, "closed", Date.now());
  dropSessionState(session.id);

  const ticket = result.settleMode === "ticket";
  const prompt = ticket ? 0 : result.receipt.prompt_tokens ?? 0;
  const completion = ticket ? 0 : result.receipt.completion_tokens ?? 0;
  deps.store.insertUsage({
    id: randomUUID(), key_id: keyRow.id, created_at: Date.now(), kind: "chat_session",
    model: session.model, capability_id: CAPABILITY, supplier_pkh: session.supplier_pkh,
    escrow_ref: session.escrow_ref, cost_lovelace: ticket ? "0" : session.price_lovelace,
    prompt_tokens: prompt, completion_tokens: completion, status: "completed", failure_reason: null,
  });
  if (!ticket) {
    await ensureWalletHealthy(deps.chain, ctx.walletKey).catch((error) =>
      console.error("[gateway] wallet-health after session close:", error instanceof Error ? error.message : error));
  }
  res.status(200).json(ticket ? {
    status: "ended", escrow_ref: session.escrow_ref, settle_mode: "ticket", model: session.model,
  } : {
    status: "closed", escrow_ref: session.escrow_ref, accepted_ref: refStr(result.acceptedRef), model: session.model,
    x_vector: { receipt: result.receipt, receipt_signature: result.receiptSignature, escrow_ref: session.escrow_ref },
  });
}

function loadOwnedSession(store: GatewayStore, req: Request, keyRow: ApiKeyRow): SessionRow {
  const raw: unknown = req.params.id;
  const id = typeof raw === "string" ? raw : undefined;
  const session = id ? store.getSession(id) : undefined;
  if (!session || session.key_id !== keyRow.id) throw notFound("session_not_found", `no chat session ${id ?? "(none)"}`);
  return session;
}
