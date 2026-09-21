import { randomBytes } from "crypto";
import type { Receipt } from "@marketplace/shared/receipt";
import {
  createResponse,
  responseEvents,
  type ResponseObject,
  type ResponseStreamEvent,
  type ResponseUsage,
} from "@marketplace/shared/responses";

export function genId(): string {
  return `resp_${randomBytes(24).toString("hex")}`;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface VectorReceipt {
  receipt: Receipt;
  receipt_signature: string;
  escrow_ref: string;
}

export function usageFromReceipt(receipt: Receipt): ResponseUsage {
  const input = receipt.prompt_tokens ?? 0;
  const output = receipt.completion_tokens ?? 0;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

export function isResponseObject(value: unknown): value is ResponseObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "object" in value && value.object === "response" &&
    "id" in value && typeof value.id === "string" &&
    "model" in value && typeof value.model === "string" &&
    "status" in value && typeof value.status === "string" &&
    ["in_progress", "completed", "incomplete", "failed"].includes(value.status) &&
    "output" in value && Array.isArray(value.output);
}

export function publicResponse(args: {
  id: string;
  model: string;
  createdAt?: number;
  result: ResponseObject;
  previousResponseId?: string;
  metadata?: Record<string, unknown>;
  vector?: VectorReceipt;
}): ResponseObject {
  const {
    id: _providerId,
    model: _providerModel,
    created_at: _providerCreatedAt,
    previous_response_id: _providerPreviousId,
    x_vector: _providerVector,
    metadata: _providerMetadata,
    ...native
  } = args.result;
  return {
    ...native,
    ...createResponse({
      id: args.id,
      model: args.model,
      output: args.result.output,
      usage: args.result.usage,
      status: args.result.status,
      created_at: args.createdAt ?? nowSec(),
      incomplete_details: args.result.incomplete_details,
      error: args.result.error,
    }),
    previous_response_id: args.previousResponseId ?? null,
    ...(args.metadata ? { metadata: args.metadata } : {}),
    ...(args.vector ? { x_vector: args.vector } : {}),
  };
}
export function publicStreamEvent(
  event: ResponseStreamEvent,
  args: {
    id: string;
    model: string;
    previousResponseId?: string;
    metadata?: Record<string, unknown>;
    createdAt?: number;
  },
): ResponseStreamEvent {
  const { sequence_number: _sequence, response: rawResponse, ...fields } = event;
  if (!isResponseObject(rawResponse)) return fields;
  return {
    ...fields,
    response: publicResponse({
      ...args,
      result: rawResponse,
    }),
  };
}
export function responseSse(response: ResponseObject): string {
  return responseEvents(response).map((event) => {
    const terminal = event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed";
    if (terminal || !isResponseObject(event.response) || !("x_vector" in event.response)) {
      return sseEvent(event);
    }
    const responseWithoutVector: ResponseObject = { ...event.response };
    delete responseWithoutVector.x_vector;
    return sseEvent({ ...event, response: responseWithoutVector });
  }).join("");
}

export function sseEvent(event: ResponseStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function streamFailure(id: string, model: string, error: { code: string; message: string }): ResponseStreamEvent[] {
  const failed = createResponse({
    id,
    model,
    status: "failed",
    output: [],
    error: { code: error.code, message: error.message },
  });
  return [
    { type: "error", code: error.code, message: error.message },
    { type: "response.failed", response: failed },
  ];
}

export function buildModelsList(models: string[]): Record<string, unknown> {
  const created = nowSec();
  return {
    object: "list",
    data: models.map((id) => ({ id, object: "model", created, owned_by: "vector-marketplace" })),
  };
}
