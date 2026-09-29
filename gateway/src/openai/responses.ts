import type { Request, Response } from "express";
import { TxConstructionError } from "@marketplace/shared/tx";
import { receiptResultHash } from "@marketplace/shared/receipt";
import {
  createResponse,
  responseEvents,
  validateResponseToolOutputs,
  type ResponseItem,
  type ResponseObject,
  type ResponseRequest,
  type ResponseStreamEvent,
  type ResponseUsage,
} from "@marketplace/shared/responses";
import type { PostedPrompt, SubmitPromptResult } from "@marketplace/buyer/sdk";
import { inspectSignedTransaction } from "@marketplace/shared/tx/server";
import type { GatewayDeps } from "../deps.js";
import type { ApiKeyRow, GatewayStore, StoredResponseRow } from "../db/store.js";
import type { KeyContext } from "../sdk/registry.js";
import { requireKey } from "../middleware/apiKeyAuth.js";
import { asyncHandler, requestAbortSignal } from "../middleware/http.js";
import { selectCandidates, type SupplierCandidate } from "../routing/selectSupplier.js";
import { preflight } from "../onchain/preflight.js";
import { resolveSubmittedRef, acceptAndConfirm } from "../onchain/settle.js";
import { ensureWalletHealthy } from "../walletHealth.js";
import { parseResponseRequest, executionRequest, type ParsedResponseRequest } from "./validate.js";
import { runDemoResponse } from "./demoChat.js";
import {
  genId,
  nowSec,
  isResponseObject,
  publicResponse,
  publicStreamEvent,
  responseSse,
  sseEvent,
  streamFailure,
  usageFromReceipt,
} from "./shapes.js";
import {
  completeStoredResponse,
  insertPendingResponse,
  loadResponseChain,
  readStoredResponse,
} from "./responseStore.js";
import { GatewayError, badRequest, notFound, paymentRequired, toGatewayError } from "./errors.js";
import { reserveOneShotSupplier, runOneShotJob, updateOneShotJob } from "../oneShotJobs.js";

const CAPABILITY = "llm.text.generate.v1";

function recordUsage(store: GatewayStore, args: {
  id: string;
  keyId: string;
  model: string;
  supplierPkh: string | null;
  escrowRef: string | null;
  costLovelace: bigint | null;
  usage: ResponseUsage | null;
  status: "completed" | "failed";
  failureReason?: string;
}): void {
  store.upsertUsage({
    id: args.id, key_id: args.keyId, created_at: Date.now(), kind: "completion",
    model: args.model, capability_id: CAPABILITY, supplier_pkh: args.supplierPkh,
    escrow_ref: args.escrowRef,
    cost_lovelace: args.costLovelace === null ? null : args.costLovelace.toString(),
    prompt_tokens: args.usage?.input_tokens ?? 0,
    completion_tokens: args.usage?.output_tokens ?? 0,
    status: args.status, failure_reason: args.failureReason ?? null,
  });
}

function openEventStream(res: Response): NodeJS.Timeout {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write(": connected\n\n");
  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* client disconnected */ }
  }, 10_000);
  keepalive.unref?.();
  res.once("close", () => clearInterval(keepalive));
  return keepalive;
}

export interface ResponseExecutionOptions {
  responseId: string;
  createdAt: number;
  onCommit: () => void;
  onStreamEvent?: (event: ResponseStreamEvent) => void;
  signal?: AbortSignal;
}

/** Shared execution and settlement; HTTP controllers own their wire format. */
export async function executeResponse(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  parsed: ParsedResponseRequest,
  options: ResponseExecutionOptions,
): Promise<ResponseObject> {
  const { responseId, createdAt, onCommit, onStreamEvent } = options;
  let history: ResponseItem[] = [];
  let parent: StoredResponseRow | undefined;
  if (parsed.previousResponseId) {
    const chain = loadResponseChain(deps, keyRow.id, parsed.previousResponseId);
    parent = chain.parent;
    history = chain.history;
    if (parent.model !== parsed.model) {
      throw badRequest("model_mismatch", "`model` must match the previous response model");
    }
  }
  try {
    validateResponseToolOutputs([...history, ...parsed.input]);
  } catch (error) {
    throw badRequest("invalid_function_call_output", error instanceof Error ? error.message : String(error));
  }

  const request = executionRequest(parsed);
  if (parsed.store) {
    insertPendingResponse(deps, {
      id: responseId, keyId: keyRow.id, model: parsed.model,
      previousResponseId: parsed.previousResponseId, request,
    });
  }
  try {
    if (keyRow.demo) {
      return await runDemoResponse({
        deps, keyRow, ctx: deps.registry.getContext(keyRow), parsed, request,
        responseId, createdAt, history, parent, onCommit, onStreamEvent,
      });
    }
    const ctx = deps.registry.getContext(keyRow);
    return await runOneShotJob(
      deps, keyRow, { id: responseId, model: parsed.model, signal: options.signal },
      () => runOneShot(
        deps, keyRow, ctx, parsed, request, history,
        responseId, createdAt, onCommit, onStreamEvent, options.signal,
      ),
    );
  } catch (error) {
    const job = deps.store.getOneShotJob(responseId);
    if (!keyRow.demo && !job?.settle_tx_hash && !(error instanceof GatewayError && error.code === "model_not_found")) {
      recordUsage(deps.store, {
        id: responseId, keyId: keyRow.id, model: parsed.model,
        supplierPkh: job?.supplier_pkh ?? null, escrowRef: job?.escrow_ref ?? null,
        costLovelace: null, usage: null, status: "failed",
        failureReason: toGatewayError(error).code,
      });
    }
    throw error;
  }
}

export function makeResponsesHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const parsed = parseResponseRequest(req.body);
    const responseId = genId();
    const responseCreatedAt = nowSec();
    const signal = requestAbortSignal(res);
    let keepalive: NodeJS.Timeout | undefined;
    let streamedEvents = false;
    let streamSequence = 0;
    const onCommit = (): void => {
      if (parsed.stream && !res.headersSent && !res.destroyed) keepalive = openEventStream(res);
    };
    const onStreamEvent = (event: ResponseStreamEvent): void => {
      if (res.destroyed) return;
      onCommit();
      const terminal = event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed";
      if (!streamedEvents && terminal && isResponseObject(event.response)) {
        const body = responseSse(event.response);
        streamedEvents = true;
        res.write(body);
        return;
      }
      streamedEvents = true;
      res.write(sseEvent({ ...event, sequence_number: streamSequence++ }));
    };
    try {
      const response = await executeResponse(deps, keyRow, parsed, {
        responseId,
        createdAt: responseCreatedAt,
        onCommit,
        onStreamEvent: parsed.stream ? onStreamEvent : undefined,
        signal,
      });
      clearInterval(keepalive);
      if (res.destroyed) return;
      const vector = response.x_vector;
      if (!parsed.stream && typeof vector === "object" && vector !== null &&
          !Array.isArray(vector) && "escrow_ref" in vector &&
          typeof vector.escrow_ref === "string") {
        res.setHeader("X-Vector-Escrow-Ref", vector.escrow_ref);
      }
      if (parsed.stream) {
        onCommit();
        if (!streamedEvents) res.write(responseSse(response));
        res.end();
      } else {
        res.status(200).json(response);
      }
    } catch (error) {
      clearInterval(keepalive);
      if (res.destroyed) {
        if (parsed.store) deps.store.deleteResponseTree(responseId, keyRow.id);
        return;
      }
      if (parsed.stream && res.headersSent) {
        const gatewayError = toGatewayError(error);
        const events = streamFailure(responseId, parsed.model, {
          code: gatewayError.code,
          message: gatewayError.message,
          param: gatewayError.param,
        }).map((event) => publicStreamEvent(event, {
          id: responseId,
          model: parsed.model,
          previousResponseId: parsed.previousResponseId,
          createdAt: responseCreatedAt,
          metadata: parsed.metadata,
        }));
        if (parsed.store) {
          const failedEvent = events.find((event) => event.type === "response.failed");
          if (failedEvent && isResponseObject(failedEvent.response)) {
            completeStoredResponse(deps, {
              id: responseId,
              keyId: keyRow.id,
              response: failedEvent.response,
            });
          }
        }
        events.forEach((event) =>
          res.write(sseEvent({ ...event, sequence_number: streamSequence++ })));
        res.end();
        return;
      }
      if (parsed.store) deps.store.deleteResponseTree(responseId, keyRow.id);
      throw error;
    }
  });
}

async function runOneShot(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  parsed: ParsedResponseRequest,
  request: ResponseRequest,
  history: ResponseItem[],
  responseId: string,
  responseCreatedAt: number,
  onCommit: () => void,
  onStreamEvent?: (event: ResponseStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ResponseObject> {
  const excluded = new Set<string>();
  const input = [...history, ...request.input];
  let posted: PostedPrompt | undefined;
  let used: SupplierCandidate | undefined;
  let lastError: unknown;
  let committed = false;
  while (!posted) {
    const candidate = await reserveOneShotSupplier(deps, responseId, async (admissionSignal) => {
      const candidates = await selectCandidates({
        indexerUrl: deps.config.indexerUrl, model: parsed.model, capabilityId: CAPABILITY,
        supplierPkh: parsed.supplierPkh, preferredSupplierPkh: deps.config.preferredSupplierPkh,
        fetchFn: deps.fetchFn, signal: admissionSignal,
      });
      const eligible = candidates.filter((item) => !excluded.has(item.supplierPkh));
      if (eligible.length === 0 && lastError) throw lastError;
      return eligible;
    }, signal);
    try {
      const prepared = await ctx.sdk.preparePrompt({
        advertRef: candidate.advertRef, ...request, input,
        ...(request.max_output_tokens === undefined ? {} : {
          max_output_tokens: Math.min(request.max_output_tokens, candidate.maxOutputTokens),
        }),
        payment_lovelace: candidate.priceLovelace, public_preview: parsed.publicPreview,
      });
      if (prepared.advert.supplier_pkh !== candidate.supplierPkh) {
        throw new GatewayError(503, "server_error", "supplier_identity_changed", "advert no longer matches the reserved supplier");
      }
      posted = await ctx.mutex.run(async () => {
        if (signal?.aborted) {
          throw new GatewayError(408, "invalid_request_error", "request_cancelled", "request closed before escrow funding");
        }
        const pf = await preflight(ctx.chain, ctx.walletKey.address, candidate);
        if (!pf.ok) {
          throw paymentRequired(
            pf.collateralOk ? "insufficient balance for this request" :
              "wallet has no pure-AP3X UTxO ≥ 5 AP3X for collateral; deposit a little more AP3X",
            { x_vector: {
              required_lovelace: pf.requiredLovelace.toString(),
              available_lovelace: pf.availableLovelace.toString(),
              collateral_ok: pf.collateralOk, deposit_address: ctx.walletKey.address,
            } },
          );
        }
        if (!committed) {
          committed = true;
          onCommit();
          if (onStreamEvent) {
            const initial = publicResponse({
              id: responseId, model: parsed.model, createdAt: responseCreatedAt,
              result: createResponse({
                id: responseId, model: parsed.model, created_at: responseCreatedAt, status: "in_progress",
              }),
              previousResponseId: parsed.previousResponseId, metadata: parsed.metadata,
            });
            onStreamEvent({ type: "response.created", response: initial });
            onStreamEvent({ type: "response.in_progress", response: initial });
          }
        }
        return ctx.sdk.postPrompt(prepared, async (built) => {
          if (signal?.aborted) {
            throw new GatewayError(408, "invalid_request_error", "request_cancelled", "request closed before escrow funding");
          }
          // Persist the exact output before broadcast, including ambiguous
          // submissions. A retry must never create another escrow for this job.
          updateOneShotJob(deps, responseId, {
            state: "funding", escrow_ref: `${built.escrowOutputRef.txHash}#${built.escrowOutputRef.index}`,
            post_valid_until_slot: inspectSignedTransaction(built.txCborHex).validUntilSlot,
          });
        });
      }, "post-response", 0);
      used = candidate;
    } catch (error) {
      lastError = error;
      const job = deps.store.getOneShotJob(responseId);
      if (job?.escrow_ref || !(error instanceof TxConstructionError) ||
          error.reason === "supplier_preflight_failed" || error.reason === "supplier_adapter_incompatible") throw error;
      excluded.add(candidate.supplierPkh);
      updateOneShotJob(deps, responseId, {
        state: "queued", supplier_pkh: null, endpoint_url: null, advert_ref: null,
        price_lovelace: null, max_processing_ms: null,
      });
    }
  }
  if (!used) throw new Error("posted request has no reserved supplier");
  updateOneShotJob(deps, responseId, { state: "running", deliver_by: posted.deliverBy });

  // No wallet lock while the supplier generates and the SDK verifies output.
  const result: SubmitPromptResult = await ctx.sdk.executePrompt(posted, async (jobId) => {
    updateOneShotJob(deps, responseId, { supplier_job_id: jobId });
  });
  const originalRef = `${result.escrowRef.txHash}#${result.escrowRef.index}`;
  const receiptHash = receiptResultHash({ receipt: result.receipt, signature: result.receiptSignature });
  updateOneShotJob(deps, responseId, {
    state: "submitted", receipt_hash: receiptHash,
    submitted_ref: result.submittedRef ? `${result.submittedRef.txHash}#${result.submittedRef.index}` : null,
  });
  const submittedRef = await resolveSubmittedRef({
    chain: ctx.chain, indexerUrl: deps.config.indexerUrl, buyerPkh: ctx.walletKey.pubKeyHash,
    originalRefStr: originalRef, receiptHash,
    hint: result.submittedRef && { ref: result.submittedRef, resultReceiptHash: receiptHash },
    fetchFn: deps.fetchFn,
  });
  await ctx.mutex.run(async () => {
    updateOneShotJob(deps, responseId, {
      state: "settling", submitted_ref: `${submittedRef.txHash}#${submittedRef.index}`,
    });
    const txHash = await acceptAndConfirm(ctx.chain, ctx.walletKey, submittedRef);
    updateOneShotJob(deps, responseId, { settle_tx_hash: txHash });
  }, "accept-response", 0);

  const usage = result.result.usage ?? usageFromReceipt(result.receipt);
  const response = publicResponse({
    id: responseId, model: parsed.model, createdAt: responseCreatedAt,
    result: { ...result.result, usage },
    previousResponseId: parsed.previousResponseId, metadata: parsed.metadata,
    vector: { receipt: result.receipt, receipt_signature: result.receiptSignature, escrow_ref: originalRef },
  });
  if (parsed.store) completeStoredResponse(deps, { id: responseId, keyId: keyRow.id, response });
  recordUsage(deps.store, {
    id: responseId, keyId: keyRow.id, model: parsed.model, supplierPkh: used.supplierPkh,
    escrowRef: originalRef, costLovelace: used.priceLovelace, usage, status: "completed",
  });
  await ctx.mutex.run(() => ensureWalletHealthy(ctx.chain, ctx.walletKey), "response-wallet-health", 0)
    .catch((error) => console.error("[gateway] wallet-health after response:", error instanceof Error ? error.message : error));
  if (onStreamEvent) {
    for (const event of responseEvents(response).slice(2)) onStreamEvent(event);
  }
  return response;
}

export function makeGetResponseHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const id = String(req.params.id ?? "");
    res.status(200).json(readStoredResponse(deps, keyRow.id, id));
  });
}

export function makeDeleteResponseHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    deps.store.deleteExpiredResponses();
    const id = String(req.params.id ?? "");
    const row = deps.store.getOwnedResponse(id, keyRow.id);
    if (!row) throw notFound("response_not_found", "response not found");
    deps.store.deleteResponseTree(id, keyRow.id);
    res.status(200).json({ id, object: "response.deleted", deleted: true });
  });
}
