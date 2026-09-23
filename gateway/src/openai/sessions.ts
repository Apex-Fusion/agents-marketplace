import { randomUUID } from "crypto";
import { TxConstructionError } from "@marketplace/shared/tx";
import {
  readResponseEvents,
  validateResponseToolOutputs,
  responseCompatibilityError,
  type ResponseAdapterApi,
  type ResponseCompatibilityError,
  type ResponseObject,
  type ResponseRequest,
  type ResponseStreamEvent,
} from "@marketplace/shared/responses";
import {
  dropSessionState,
  loadSessionTranscript,
  persistSessionTranscript,
  transcripts,
} from "./transcripts.js";
import { SupplierError, type StartChatResult } from "@marketplace/buyer/sdk";
import type { GatewayDeps } from "../deps.js";
import type { ApiKeyRow, SessionRow } from "../db/store.js";
import type { KeyContext } from "../sdk/registry.js";
import { selectCandidates } from "../routing/selectSupplier.js";
import { preflight } from "../onchain/preflight.js";
import { seal } from "../crypto/seal.js";
import { badRequest, notFound, paymentRequired, toGatewayError } from "./errors.js";
import { isResponseObject } from "./shapes.js";

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
  upstream_api: ResponseAdapterApi;
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
      !("upstream_api" in capability) ||
      (capability.upstream_api !== "responses" && capability.upstream_api !== "chat-completions" &&
        capability.upstream_api !== "ollama")) {
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
    throw notFound("model_not_found", `no active supplier for model "${model}" with capability "${CAPABILITY}"`, "model");
  }
  let sessionCandidates = candidates;
  if (opts?.responseRequest && (
    opts.responseRequest.reasoning !== undefined ||
    opts.responseRequest.text !== undefined ||
    opts.responseRequest.input.some((item) => item.type === "reasoning")
  )) {
    const compatibleCandidates: typeof candidates = [];
    let capabilityFailure: unknown;
    let incompatibility: ResponseCompatibilityError | undefined;
    for (const candidate of candidates) {
      try {
        const capability = await readResponsesCapability(deps, candidate.endpointUrl);
        const problem = responseCompatibilityError(
          opts.responseRequest,
          capability.upstream_api,
          capability.reasoning_disabled,
        );
        if (problem) incompatibility ??= problem;
        else compatibleCandidates.push(candidate);
      } catch (error) {
        capabilityFailure ??= error;
      }
    }
    if (compatibleCandidates.length === 0) {
      if (incompatibility) {
        throw badRequest("unsupported_parameter", incompatibility.message, incompatibility.param);
      }
      throw toGatewayError(capabilityFailure ?? new Error("supplier capability unavailable"));
    }
    sessionCandidates = compatibleCandidates;
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
  const input = [...mirror, ...payload.input];
  try {
    validateResponseToolOutputs(input);
  } catch (error) {
    throw badRequest(
      "invalid_function_call_output",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (payload.reasoning !== undefined || payload.text !== undefined || input.some((item) => item.type === "reasoning")) {
    const capability = await readResponsesCapability(deps, session.supplier_base_url);
    const problem = responseCompatibilityError(
      { ...payload, input },
      capability.upstream_api,
      capability.reasoning_disabled,
    );
    if (problem) {
      throw badRequest("unsupported_parameter", problem.message, problem.param);
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

    const nextMirror = [...input, ...terminal.output];
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

