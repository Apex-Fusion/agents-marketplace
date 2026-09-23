import type { Request, Response } from "express";
import {
  validateResponseToolOutputs,
  type ResponseContentPart,
  type ResponseFunctionCallItem,
  type ResponseItem,
  type ResponseObject,
  type ResponseStreamEvent,
  type ResponseUsage,
} from "@marketplace/shared/responses";
import type { GatewayDeps } from "../deps.js";
import { requireKey } from "../middleware/apiKeyAuth.js";
import { asyncHandler } from "../middleware/http.js";
import { GatewayError, badRequest, toErrorBody, toGatewayError } from "./errors.js";
import { executeResponse } from "./responses.js";
import { genId, nowSec } from "./shapes.js";
import { parseResponseRequest, type ParsedResponseRequest } from "./validate.js";

const TOP_LEVEL_FIELDS: Record<string, true> = {
  model: true,
  messages: true,
  max_tokens: true,
  max_completion_tokens: true,
  temperature: true,
  top_p: true,
  n: true,
  stream: true,
  stream_options: true,
  tools: true,
  tool_choice: true,
  parallel_tool_calls: true,
  response_format: true,
  reasoning_effort: true,
  store: true,
  x_vector: true,
  public_preview: true,
};
const TEXT_PART_FIELDS: Record<string, true> = { type: true, text: true };
const REFUSAL_PART_FIELDS: Record<string, true> = { type: true, refusal: true };
const TOOL_MESSAGE_FIELDS: Record<string, true> = {
  role: true, content: true, tool_call_id: true,
};
const MESSAGE_FIELDS: Record<string, true> = { role: true, content: true };
const ASSISTANT_MESSAGE_FIELDS: Record<string, true> = {
  role: true, content: true, refusal: true, tool_calls: true,
};
const TOOL_CALL_FIELDS: Record<string, true> = {
  id: true, type: true, function: true,
};
const TOOL_CALL_FUNCTION_FIELDS: Record<string, true> = {
  name: true, arguments: true,
};
const TOOL_FIELDS: Record<string, true> = { type: true, function: true };
const TOOL_FUNCTION_FIELDS: Record<string, true> = {
  name: true, description: true, parameters: true, strict: true,
};
const TOOL_CHOICE_FIELDS: Record<string, true> = { type: true, function: true };
const TOOL_CHOICE_FUNCTION_FIELDS: Record<string, true> = { name: true };
const RESPONSE_FORMAT_FIELDS: Record<string, true> = { type: true };
const JSON_RESPONSE_FORMAT_FIELDS: Record<string, true> = {
  type: true, json_schema: true,
};
const JSON_SCHEMA_FIELDS: Record<string, true> = {
  name: true, description: true, schema: true, strict: true,
};
const STREAM_OPTIONS_FIELDS: Record<string, true> = { include_usage: true };

interface ParsedChatRequest {
  response: ParsedResponseRequest;
  includeUsage: boolean;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatAssistantMessage {
  role: "assistant";
  content: string | null;
  refusal: string | null;
  tool_calls?: ChatToolCall[];
}

type ChatFinishReason = "stop" | "length" | "tool_calls" | "content_filter";

function requestObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("invalid_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: Record<string, true>,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (allowed[field] !== true) {
      throw badRequest("unsupported_parameter", `unsupported ${label} field: ${field}`);
    }
  }
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest("invalid_request", `${label} must be a non-empty string`);
  }
  return value;
}

function messageContentParts(
  value: unknown,
  role: "system" | "developer" | "user" | "assistant",
  label: string,
): ResponseContentPart[] {
  const outputType = role === "assistant" ? "output_text" : "input_text";
  if (typeof value === "string") return [{ type: outputType, text: value }];
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest("invalid_request", `${label} must be a string or a non-empty array of text parts`);
  }

  return value.map<ResponseContentPart>((rawPart, partIndex) => {
    const part = requestObject(rawPart, `${label}[${partIndex}]`);
    if (part.type === "text") {
      rejectUnknownFields(part, TEXT_PART_FIELDS, `${label}[${partIndex}]`);
      if (typeof part.text !== "string") {
        throw badRequest("invalid_request", `${label}[${partIndex}].text must be a string`);
      }
      return { type: outputType, text: part.text };
    }
    if (role === "assistant" && part.type === "refusal") {
      rejectUnknownFields(part, REFUSAL_PART_FIELDS, `${label}[${partIndex}]`);
      if (typeof part.refusal !== "string") {
        throw badRequest("invalid_request", `${label}[${partIndex}].refusal must be a string`);
      }
      return { type: "refusal", refusal: part.refusal };
    }
    throw badRequest(
      "unsupported_parameter",
      `unsupported ${label}[${partIndex}] content type: ${String(part.type)}`,
    );
  });
}

function toolOutputContent(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest("invalid_request", `${label} must be a string or a non-empty array of text parts`);
  }
  return value.map((rawPart, partIndex) => {
    const part = requestObject(rawPart, `${label}[${partIndex}]`);
    rejectUnknownFields(part, TEXT_PART_FIELDS, `${label}[${partIndex}]`);
    if (part.type !== "text" || typeof part.text !== "string") {
      throw badRequest("unsupported_parameter", `${label}[${partIndex}] must be a text content part`);
    }
    return part.text;
  }).join("");
}

function assistantToolCalls(value: unknown, label: string): ResponseFunctionCallItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest("invalid_request", `${label} must be a non-empty array`);
  }
  return value.map((rawCall, callIndex) => {
    const call = requestObject(rawCall, `${label}[${callIndex}]`);
    rejectUnknownFields(call, TOOL_CALL_FIELDS, `${label}[${callIndex}]`);
    if (call.type !== "function") {
      throw badRequest("unsupported_parameter", `${label}[${callIndex}].type must be function`);
    }
    const fn = requestObject(call.function, `${label}[${callIndex}].function`);
    rejectUnknownFields(fn, TOOL_CALL_FUNCTION_FIELDS, `${label}[${callIndex}].function`);
    if (typeof fn.arguments !== "string") {
      throw badRequest("invalid_request", `${label}[${callIndex}].function.arguments must be a string`);
    }
    return {
      type: "function_call",
      call_id: nonemptyString(call.id, `${label}[${callIndex}].id`),
      name: nonemptyString(fn.name, `${label}[${callIndex}].function.name`),
      arguments: fn.arguments,
    };
  });
}

function translateMessages(value: unknown): ResponseItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest("invalid_request", "`messages` is required and must be a non-empty array");
  }

  const items: ResponseItem[] = [];
  value.forEach((rawMessage, index) => {
    const label = `messages[${index}]`;
    const message = requestObject(rawMessage, label);
    const role = message.role;

    if (role === "tool") {
      rejectUnknownFields(message, TOOL_MESSAGE_FIELDS, label);
      if (!("content" in message)) {
        throw badRequest("invalid_request", `${label}.content is required`);
      }
      items.push({
        type: "function_call_output",
        call_id: nonemptyString(message.tool_call_id, `${label}.tool_call_id`),
        output: toolOutputContent(message.content, `${label}.content`),
      });
      return;
    }

    if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
      throw badRequest("unsupported_parameter", `unsupported ${label}.role: ${String(role)}`);
    }

    if (role !== "assistant") {
      rejectUnknownFields(message, MESSAGE_FIELDS, label);
      if (!("content" in message)) {
        throw badRequest("invalid_request", `${label}.content is required`);
      }
      items.push({
        type: "message",
        role,
        content: messageContentParts(message.content, role, `${label}.content`),
      });
      return;
    }

    rejectUnknownFields(message, ASSISTANT_MESSAGE_FIELDS, label);
    const content = message.content;
    const contentPresent = content !== undefined && content !== null;
    const refusalPresent = message.refusal !== undefined && message.refusal !== null;
    const callsPresent = message.tool_calls !== undefined && message.tool_calls !== null;
    if (!contentPresent && !refusalPresent && !callsPresent) {
      throw badRequest(
        "invalid_request",
        `${label} must contain content, refusal, or tool_calls`,
      );
    }

    const parts: ResponseContentPart[] = [];
    if (contentPresent) parts.push(...messageContentParts(content, "assistant", `${label}.content`));
    if (refusalPresent) {
      if (typeof message.refusal !== "string") {
        throw badRequest("invalid_request", `${label}.refusal must be a string or null`);
      }
      parts.push({ type: "refusal", refusal: message.refusal });
    }
    if (parts.length > 0) {
      items.push({ type: "message", role: "assistant", content: parts } as ResponseItem);
    }
    if (callsPresent) items.push(...assistantToolCalls(message.tool_calls, `${label}.tool_calls`));
  });
  return items;
}

function translateTools(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw badRequest("invalid_request", "`tools` must be an array");
  return value.map((rawTool, index) => {
    const label = `tools[${index}]`;
    const tool = requestObject(rawTool, label);
    rejectUnknownFields(tool, TOOL_FIELDS, label);
    if (tool.type !== "function") {
      throw badRequest("unsupported_parameter", `${label}.type must be function`);
    }
    const fn = requestObject(tool.function, `${label}.function`);
    rejectUnknownFields(fn, TOOL_FUNCTION_FIELDS, `${label}.function`);
    return { type: "function", ...fn };
  });
}

function translateToolChoice(value: unknown): unknown {
  if (typeof value === "string") return value;
  const choice = requestObject(value, "`tool_choice`");
  rejectUnknownFields(choice, TOOL_CHOICE_FIELDS, "`tool_choice`");
  if (choice.type !== "function") {
    throw badRequest("unsupported_parameter", "`tool_choice.type` must be function");
  }
  const fn = requestObject(choice.function, "`tool_choice.function`");
  rejectUnknownFields(fn, TOOL_CHOICE_FUNCTION_FIELDS, "`tool_choice.function`");
  return { type: "function", name: nonemptyString(fn.name, "`tool_choice.function.name`") };
}

function translateResponseFormat(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  const format = requestObject(value, "`response_format`");
  if (format.type === "text" || format.type === "json_object") {
    rejectUnknownFields(format, RESPONSE_FORMAT_FIELDS, "`response_format`");
    return format.type === "text" ? undefined : { format: { type: format.type } };
  }
  if (format.type !== "json_schema") {
    throw badRequest("unsupported_parameter", `unsupported response format: ${String(format.type)}`);
  }
  rejectUnknownFields(format, JSON_RESPONSE_FORMAT_FIELDS, "`response_format`");
  const schema = requestObject(format.json_schema, "`response_format.json_schema`");
  rejectUnknownFields(
    schema,
    JSON_SCHEMA_FIELDS,
    "`response_format.json_schema`",
  );
  if (schema.description !== undefined && typeof schema.description !== "string") {
    throw badRequest("invalid_request", "`response_format.json_schema.description` must be a string");
  }
  return { format: { type: "json_schema", ...schema } };
}

function parseStreamOptions(value: unknown, stream: unknown): boolean {
  if (value === undefined || value === null) return false;
  const options = requestObject(value, "`stream_options`");
  rejectUnknownFields(options, STREAM_OPTIONS_FIELDS, "`stream_options`");
  if (stream !== true) {
    throw badRequest("invalid_request", "`stream_options` requires `stream: true`");
  }
  if (options.include_usage !== undefined && typeof options.include_usage !== "boolean") {
    throw badRequest("invalid_request", "`stream_options.include_usage` must be a boolean");
  }
  return options.include_usage === true;
}

function parseChatRequest(body: unknown): ParsedChatRequest {
  const raw = requestObject(body, "request body");
  rejectUnknownFields(raw, TOP_LEVEL_FIELDS, "request");

  if (raw.n !== undefined && raw.n !== null && raw.n !== 1) {
    throw badRequest("unsupported_parameter", "only `n: 1` is supported");
  }
  if (raw.store === true) {
    throw badRequest("unsupported_parameter", "Chat Completions storage is not supported; use `store: false`");
  }
  if (raw.store !== undefined && raw.store !== null && typeof raw.store !== "boolean") {
    throw badRequest("invalid_store", "`store` must be a boolean or null");
  }

  const maxTokens = raw.max_tokens;
  const maxCompletionTokens = raw.max_completion_tokens;
  if (maxTokens !== undefined && maxTokens !== null &&
      maxCompletionTokens !== undefined && maxCompletionTokens !== null) {
    throw badRequest(
      "invalid_request",
      "`max_tokens` and `max_completion_tokens` cannot both be provided",
    );
  }

  const includeUsage = parseStreamOptions(raw.stream_options, raw.stream);
  const translated: Record<string, unknown> = {
    model: raw.model,
    input: translateMessages(raw.messages),
    store: false,
  };
  if (raw.stream !== undefined && raw.stream !== null) translated.stream = raw.stream;
  for (const field of ["temperature", "top_p", "parallel_tool_calls", "x_vector", "public_preview"] as const) {
    if (raw[field] !== undefined) translated[field] = raw[field];
  }
  const maxOutputTokens = maxCompletionTokens ?? maxTokens;
  if (maxOutputTokens !== undefined && maxOutputTokens !== null) {
    translated.max_output_tokens = maxOutputTokens;
  }
  if (raw.tools !== undefined) translated.tools = translateTools(raw.tools);
  if (raw.tool_choice !== undefined) translated.tool_choice = translateToolChoice(raw.tool_choice);
  if (raw.reasoning_effort !== undefined && raw.reasoning_effort !== null) {
    translated.reasoning = { effort: raw.reasoning_effort };
  }
  const text = translateResponseFormat(raw.response_format);
  if (text !== undefined) translated.text = text;

  const response = parseResponseRequest(translated);
  try {
    validateResponseToolOutputs(response.input);
  } catch (error) {
    throw badRequest(
      "invalid_function_call_output",
      error instanceof Error ? error.message : String(error),
    );
  }
  return { response, includeUsage };
}

function chatId(responseId: string): string {
  return `chatcmpl-${responseId.startsWith("resp_") ? responseId.slice(5) : responseId}`;
}

function chatUsage(usage: ResponseUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details !== undefined
      ? { prompt_tokens_details: usage.input_tokens_details }
      : {}),
    ...(usage.output_tokens_details !== undefined
      ? { completion_tokens_details: usage.output_tokens_details }
      : {}),
  };
}

function outputMessage(output: readonly ResponseItem[]): ChatAssistantMessage {
  let content = "";
  let refusal = "";
  let hasContent = false;
  let hasRefusal = false;
  const toolCalls: ChatToolCall[] = [];

  for (const item of output) {
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }
    if (item.type === "function_call_output" || item.role !== "assistant") {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier returned an invalid response output item");
    }
    for (const part of item.content) {
      if (part.type === "refusal") {
        hasRefusal = true;
        refusal += part.refusal;
      } else {
        hasContent = true;
        content += part.text;
      }
    }
  }

  return {
    role: "assistant",
    content: hasContent ? content : null,
    refusal: hasRefusal ? refusal : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function finishReason(response: ResponseObject, message: ChatAssistantMessage): ChatFinishReason {
  if (response.status === "completed") {
    return message.tool_calls?.length ? "tool_calls" : "stop";
  }
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
    throw new GatewayError(
      502,
      "server_error",
      "upstream_error",
      `supplier returned an unsupported incomplete reason: ${String(reason)}`,
    );
  }
  if (response.status === "failed") throw responseFailure(response);
  throw new GatewayError(502, "server_error", "upstream_error", "supplier returned a non-terminal response");
}

function responseFailure(response: ResponseObject): GatewayError {
  const error = response.error;
  const code = error && typeof error.code === "string" ? error.code : "upstream_error";
  const message = error && typeof error.message === "string"
    ? error.message
    : "supplier failed to complete the response";
  return new GatewayError(502, "server_error", code, message);
}

function responseVector(response: ResponseObject): Record<string, unknown> {
  return response.x_vector === undefined ? {} : { x_vector: response.x_vector };
}

function setEscrowHeader(res: Response, response: ResponseObject): void {
  const vector = response.x_vector;
  if (typeof vector === "object" && vector !== null && !Array.isArray(vector) &&
      "escrow_ref" in vector && typeof vector.escrow_ref === "string") {
    res.setHeader("X-Vector-Escrow-Ref", vector.escrow_ref);
  }
}

function chatCompletion(
  response: ResponseObject,
  id: string,
  created: number,
  model: string,
): Record<string, unknown> {
  const message = outputMessage(response.output);
  const body: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(response, message), logprobs: null }],
    ...responseVector(response),
  };
  if (response.usage !== null) body.usage = chatUsage(response.usage);
  return body;
}

function streamRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

class ChatStreamWriter {
  private keepalive: NodeJS.Timeout | undefined;
  private opened = false;
  private ended = false;
  private errorSent = false;
  private finishSent = false;
  private readonly partText = new Map<string, string>();
  private readonly tools = new Map<number, ChatToolCall & { index: number }>();

  constructor(
    private readonly res: Response,
    private readonly id: string,
    private readonly created: number,
    private readonly model: string,
    private readonly includeUsage: boolean,
  ) {
    res.once("close", () => this.dispose());
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened || this.res.destroyed) return;
    this.opened = true;
    this.res.status(200);
    this.res.setHeader("Content-Type", "text/event-stream");
    this.res.setHeader("Cache-Control", "no-cache, no-transform");
    this.res.setHeader("Connection", "keep-alive");
    this.res.setHeader("X-Accel-Buffering", "no");
    this.res.write(": connected\n\n");
    this.keepalive = setInterval(() => {
      try { this.res.write(": keepalive\n\n"); } catch { /* client disconnected */ }
    }, 10_000);
    this.keepalive.unref?.();
    this.writeChunk({ role: "assistant", content: "" }, null);
  }

  handle(event: ResponseStreamEvent): void {
    if (this.errorSent || this.finishSent || this.res.destroyed) return;
    switch (event.type) {
      case "response.output_item.added":
      case "response.output_item.done": {
        const item = streamRecord(event.item);
        if (item?.type === "function_call") this.reconcileTool(event.output_index, item);
        break;
      }
      case "response.output_text.delta":
        this.appendPart("content", event);
        break;
      case "response.refusal.delta":
        this.appendPart("refusal", event);
        break;
      case "response.output_text.done":
        this.reconcilePart("content", event, event.text);
        break;
      case "response.refusal.done":
        this.reconcilePart("refusal", event, event.refusal);
        break;
      case "response.function_call_arguments.delta":
        this.appendToolArguments(event);
        break;
      case "response.function_call_arguments.done":
        this.reconcileToolArguments(event.output_index, event.arguments);
        break;
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        break;
      case "error": {
        const code = typeof event.code === "string" ? event.code : "upstream_error";
        const message = typeof event.message === "string" ? event.message : "supplier stream failed";
        this.fail(new GatewayError(502, "server_error", code, message));
        break;
      }
    }
  }

  finish(response: ResponseObject): void {
    if (this.finishSent || this.errorSent || this.res.destroyed) return;
    if (response.status === "failed") throw responseFailure(response);
    if (response.status !== "completed" && response.status !== "incomplete") {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier returned a non-terminal response");
    }
    this.open();
    this.reconcileOutput(response.output);
    const message = outputMessage(response.output);
    const reason = finishReason(response, message);
    this.writeChunk({}, reason, responseVector(response));
    if (this.includeUsage && response.usage !== null) {
      this.writeEnvelope({ choices: [], usage: chatUsage(response.usage) });
    }
    this.res.write("data: [DONE]\n\n");
    this.finishSent = true;
  }

  fail(error: unknown): void {
    if (this.errorSent || this.finishSent || this.res.destroyed) return;
    this.open();
    this.res.write(`data: ${JSON.stringify(toErrorBody(toGatewayError(error)))}\n\n`);
    this.errorSent = true;
  }

  close(): void {
    this.dispose();
    if (!this.ended) {
      this.ended = true;
      if (!this.res.destroyed) this.res.end();
    }
  }

  dispose(): void {
    if (this.keepalive !== undefined) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }

  private writeEnvelope(fields: Record<string, unknown>): void {
    if (this.res.destroyed) return;
    this.open();
    this.res.write(`data: ${JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      ...(this.includeUsage ? { usage: null } : {}),
      ...fields,
    })}\n\n`);
  }

  private writeChunk(
    delta: Record<string, unknown>,
    finishReasonValue: ChatFinishReason | null,
    extension: Record<string, unknown> = {},
  ): void {
    this.writeEnvelope({
      choices: [{ index: 0, delta, finish_reason: finishReasonValue, logprobs: null }],
      ...extension,
    });
  }

  private outputIndex(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream has an invalid output index");
    }
    return value;
  }

  private partKey(event: ResponseStreamEvent): string {
    const outputIndex = this.outputIndex(event.output_index);
    const contentIndex = this.outputIndex(event.content_index);
    return `${outputIndex}:${contentIndex}`;
  }

  private appendPart(kind: "content" | "refusal", event: ResponseStreamEvent): void {
    if (typeof event.delta !== "string") {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream has a non-text delta");
    }
    const key = this.partKey(event);
    this.partText.set(`${kind}:${key}`, (this.partText.get(`${kind}:${key}`) ?? "") + event.delta);
    if (event.delta !== "") this.writeChunk({ [kind]: event.delta }, null);
  }

  private reconcilePart(kind: "content" | "refusal", event: ResponseStreamEvent, finalValue: unknown): void {
    if (typeof finalValue !== "string") {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream has an invalid completed text part");
    }
    this.reconcileText(kind, this.partKey(event), finalValue);
  }

  private reconcileText(kind: "content" | "refusal", key: string, finalValue: string): void {
    const mapKey = `${kind}:${key}`;
    const emitted = this.partText.get(mapKey) ?? "";
    if (!finalValue.startsWith(emitted)) {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream text disagrees with its terminal response");
    }
    const missing = finalValue.slice(emitted.length);
    this.partText.set(mapKey, finalValue);
    if (missing !== "") this.writeChunk({ [kind]: missing }, null);
  }

  private ensureTool(outputIndexValue: unknown, item?: Record<string, unknown>): number {
    const outputIndex = this.outputIndex(outputIndexValue);
    const existing = this.tools.get(outputIndex);
    if (existing !== undefined) {
      if (item && (item.call_id !== existing.id || item.name !== existing.function.name)) {
        throw new GatewayError(502, "server_error", "upstream_error", "supplier stream changed a function call identity");
      }
      return existing.index;
    }
    if (!item || typeof item.call_id !== "string" || item.call_id.length === 0 ||
        typeof item.name !== "string" || item.name.length === 0) {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream omitted function call identity");
    }
    const tool: ChatToolCall & { index: number } = {
      index: this.tools.size,
      id: item.call_id,
      type: "function",
      function: { name: item.name, arguments: "" },
    };
    this.tools.set(outputIndex, tool);
    this.writeChunk({ tool_calls: [tool] }, null);
    return tool.index;
  }

  private reconcileTool(outputIndexValue: unknown, item: Record<string, unknown>): void {
    this.ensureTool(outputIndexValue, item);
    if (typeof item.arguments === "string" && item.arguments !== "") {
      this.reconcileToolArguments(outputIndexValue, item.arguments);
    }
  }

  private appendToolArguments(event: ResponseStreamEvent): void {
    if (typeof event.delta !== "string") {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream has invalid function arguments");
    }
    const outputIndex = this.outputIndex(event.output_index);
    const tool = this.tools.get(outputIndex);
    if (tool === undefined) {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream sent function arguments before the function call");
    }
    tool.function.arguments += event.delta;
    if (event.delta !== "") {
      this.writeChunk({ tool_calls: [{ index: tool.index, function: { arguments: event.delta } }] }, null);
    }
  }

  private reconcileToolArguments(outputIndexValue: unknown, finalValue: unknown): void {
    if (typeof finalValue !== "string") {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream has invalid completed function arguments");
    }
    const outputIndex = this.outputIndex(outputIndexValue);
    const tool = this.tools.get(outputIndex);
    if (tool === undefined) {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream omitted a function call before its arguments");
    }
    const emitted = tool.function.arguments;
    if (!finalValue.startsWith(emitted)) {
      throw new GatewayError(502, "server_error", "upstream_error", "supplier stream function arguments disagree with its terminal response");
    }
    const missing = finalValue.slice(emitted.length);
    tool.function.arguments = finalValue;
    if (missing !== "") {
      this.writeChunk({ tool_calls: [{ index: tool.index, function: { arguments: missing } }] }, null);
    }
  }

  private reconcileOutput(output: readonly ResponseItem[]): void {
    for (const [outputIndex, tool] of this.tools) {
      const item = output[outputIndex];
      if (item?.type !== "function_call" ||
          item.call_id !== tool.id || item.name !== tool.function.name) {
        throw new GatewayError(502, "server_error", "upstream_error", "supplier terminal response changed or omitted a streamed function call");
      }
    }
    for (const [key, emitted] of this.partText) {
      if (emitted === "") continue;
      const [kind, outputIndex, contentIndex] = key.split(":");
      const item = output[Number(outputIndex)];
      const part = item?.type === "message" ? item.content[Number(contentIndex)] : undefined;
      const finalValue = kind === "refusal"
        ? (part?.type === "refusal" ? part.refusal : undefined)
        : (part && part.type !== "refusal" ? part.text : undefined);
      if (typeof finalValue !== "string" || !finalValue.startsWith(emitted)) {
        throw new GatewayError(502, "server_error", "upstream_error", "supplier terminal response changed or omitted streamed text");
      }
    }
    output.forEach((item, outputIndex) => {
      if (item.type === "function_call") {
        this.reconcileTool(outputIndex, item as unknown as Record<string, unknown>);
        return;
      }
      if (item.type !== "message" || item.role !== "assistant") return;
      item.content.forEach((part, contentIndex) => {
        if (part.type === "refusal") {
          this.reconcileText("refusal", `${outputIndex}:${contentIndex}`, part.refusal);
        } else {
          this.reconcileText("content", `${outputIndex}:${contentIndex}`, part.text);
        }
      });
    });
  }
}

/** Report canonical compatibility failures using the caller's Chat field names. */
function chatGatewayError(error: unknown): GatewayError {
  const mapped = toGatewayError(error);
  let param = mapped.param;
  if (param === "reasoning" || param?.startsWith("reasoning.")) param = "reasoning_effort";
  else if (param === "text" || param?.startsWith("text.")) param = "response_format";
  else if (param === "input" || param?.startsWith("input[")) param = "messages";
  return param === mapped.param ? mapped : new GatewayError(
    mapped.httpStatus, mapped.type, mapped.code, mapped.message, mapped.extra, param,
  );
}

export function makeChatCompletionsHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const { response: parsed, includeUsage } = parseChatRequest(req.body);
    const responseId = genId();
    const created = nowSec();
    const id = chatId(responseId);
    const stream = parsed.stream
      ? new ChatStreamWriter(res, id, created, parsed.model, includeUsage)
      : undefined;

    try {
      const response = await executeResponse(deps, keyRow, parsed, {
        responseId,
        createdAt: created,
        onCommit: () => stream?.open(),
        onStreamEvent: stream ? (event: ResponseStreamEvent) => stream.handle(event) : undefined,
      });
      if (stream) {
        stream.finish(response);
        stream.close();
        return;
      }
      setEscrowHeader(res, response);
      res.status(200).json(chatCompletion(response, id, created, parsed.model));
    } catch (error) {
      if (res.destroyed) return;
      const mapped = chatGatewayError(error);
      if (stream?.isOpen || res.headersSent) {
        stream?.fail(mapped);
        stream?.close();
        return;
      }
      throw mapped;
    } finally {
      stream?.dispose();
    }
  });
}
