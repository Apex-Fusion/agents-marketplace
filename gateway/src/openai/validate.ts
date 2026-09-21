import { normalizeResponseRequest, type ResponseRequest } from "@marketplace/shared/responses";
import { badRequest } from "./errors.js";

export interface ParsedResponseRequest extends ResponseRequest {
  model: string;
  stream: boolean;
  store: boolean;
  previousResponseId?: string;
  metadata?: Record<string, unknown>;
  include?: ["reasoning.encrypted_content"];
  publicPreview: boolean;
  supplierPkh?: string;
}

const EXECUTION_FIELDS: Record<string, true> = {
  input: true,
  instructions: true,
  max_output_tokens: true,
  tools: true,
  tool_choice: true,
  parallel_tool_calls: true,
  reasoning: true,
  text: true,
  temperature: true,
  top_p: true,
};
const PUBLIC_FIELDS: Record<string, true> = {
  model: true,
  stream: true,
  store: true,
  previous_response_id: true,
  metadata: true,
  include: true,
  x_vector: true,
  public_preview: true,
};

function normalizeExecution(raw: Record<string, unknown>): ResponseRequest {
  const execution: Record<string, unknown> = {};
  for (const field of Object.keys(EXECUTION_FIELDS)) {
    if (field in raw) execution[field] = raw[field];
  }
  if (!("input" in execution)) execution.input = [];
  try {
    return normalizeResponseRequest(execution);
  } catch (error) {
    throw badRequest("invalid_request", error instanceof Error ? error.message : String(error));
  }
}

export function parseResponseRequest(body: unknown): ParsedResponseRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("invalid_body", "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const field of Object.keys(raw)) {
    if (EXECUTION_FIELDS[field] !== true && PUBLIC_FIELDS[field] !== true) {
      throw badRequest("unsupported_parameter", `unsupported parameter: ${field}`);
    }
  }
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    throw badRequest("invalid_model", "`model` is required and must be a non-empty string");
  }
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") {
    throw badRequest("invalid_stream", "`stream` must be a boolean");
  }
  if (raw.store !== undefined && typeof raw.store !== "boolean") {
    throw badRequest("invalid_store", "`store` must be a boolean");
  }
  if (raw.previous_response_id !== undefined &&
      (typeof raw.previous_response_id !== "string" || raw.previous_response_id.length === 0)) {
    throw badRequest("invalid_previous_response_id", "`previous_response_id` must be a non-empty string");
  }
  if (raw.metadata !== undefined &&
      (typeof raw.metadata !== "object" || raw.metadata === null || Array.isArray(raw.metadata))) {
    throw badRequest("invalid_metadata", "`metadata` must be an object");
  }

  let include: ["reasoning.encrypted_content"] | undefined;
  if (raw.include !== undefined) {
    if (!Array.isArray(raw.include) || raw.include.some((value) => value !== "reasoning.encrypted_content")) {
      throw badRequest("unsupported_parameter", "only `reasoning.encrypted_content` is supported in `include`");
    }
    if (raw.include.length > 0) include = ["reasoning.encrypted_content"];
  }
  if (raw.public_preview !== undefined && typeof raw.public_preview !== "boolean") {
    throw badRequest("invalid_public_preview", "`public_preview` must be a boolean when provided");
  }

  let supplierPkh: string | undefined;
  if (raw.x_vector !== undefined) {
    if (typeof raw.x_vector !== "object" || raw.x_vector === null || Array.isArray(raw.x_vector)) {
      throw badRequest("invalid_x_vector", "`x_vector` must be an object");
    }
    const vector = raw.x_vector as Record<string, unknown>;
    for (const field of Object.keys(vector)) {
      if (field !== "supplier_pkh") throw badRequest("unsupported_parameter", `unsupported x_vector parameter: ${field}`);
    }
    const requested = vector.supplier_pkh;
    if (requested !== undefined && (typeof requested !== "string" || !/^[0-9a-fA-F]{56}$/.test(requested))) {
      throw badRequest("invalid_supplier_pkh", "`x_vector.supplier_pkh` must be a 28-byte hex payment-key hash");
    }
    if (typeof requested === "string") supplierPkh = requested.toLowerCase();
  }

  const request = normalizeExecution(raw);
  const previousResponseId = raw.previous_response_id as string | undefined;
  if (request.input.length === 0 && request.instructions === undefined && previousResponseId === undefined) {
    throw badRequest("invalid_input", "`input` must not be empty without instructions or previous_response_id");
  }
  return {
    ...request,
    model: raw.model,
    stream: raw.stream === true,
    store: raw.store !== false,
    previousResponseId,
    metadata: raw.metadata as Record<string, unknown> | undefined,
    include,
    publicPreview: raw.public_preview === true,
    supplierPkh,
  };
}

export function executionRequest(parsed: ParsedResponseRequest): ResponseRequest {
  const request: ResponseRequest & Record<string, unknown> = { input: parsed.input };
  for (const field of Object.keys(EXECUTION_FIELDS)) {
    if (field === "input") continue;
    const value = parsed[field as keyof ParsedResponseRequest];
    if (value !== undefined) request[field] = value;
  }
  return request;
}

export function parseSessionTurnRequest(body: unknown): ResponseRequest & { stream: boolean } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("invalid_body", "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const field of Object.keys(raw)) {
    if (field !== "stream" && EXECUTION_FIELDS[field] !== true) {
      throw badRequest("unsupported_parameter", `unsupported parameter: ${field}`);
    }
  }
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") {
    throw badRequest("invalid_stream", "`stream` must be a boolean");
  }
  const request = normalizeExecution(raw);
  if (request.input.length === 0 && request.instructions === undefined) {
    throw badRequest("invalid_input", "`input` must not be empty without instructions");
  }
  return { ...request, stream: raw.stream !== false };
}
