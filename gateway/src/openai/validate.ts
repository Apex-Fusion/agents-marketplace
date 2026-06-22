/**
 * gateway/src/openai/validate.ts — request body validation for chat endpoints.
 */

import type { ChatMessage } from "@marketplace/shared/tx";
import { badRequest } from "./errors.js";

export interface ParsedChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  stream: boolean;
}

const ROLES = new Set(["system", "user", "assistant"]);

/** Validate an OpenAI chat.completions-style body. Rejects tools/functions;
 * silently ignores temperature/n/stop/top_p/etc (documented). */
export function parseChatRequest(body: unknown): ParsedChatRequest {
  if (typeof body !== "object" || body === null) {
    throw badRequest("invalid_body", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  if ("tools" in b || "tool_choice" in b || "functions" in b || "function_call" in b) {
    throw badRequest("unsupported_parameter", "tools and function-calling are not supported by this gateway");
  }

  const model = b.model;
  if (typeof model !== "string" || model === "") {
    throw badRequest("invalid_model", "`model` is required and must be a non-empty string");
  }

  const rawMessages = b.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw badRequest("invalid_messages", "`messages` is required and must be a non-empty array");
  }
  const messages: ChatMessage[] = [];
  for (const m of rawMessages) {
    if (
      typeof m !== "object" ||
      m === null ||
      typeof (m as { role?: unknown }).role !== "string" ||
      typeof (m as { content?: unknown }).content !== "string" ||
      !ROLES.has((m as { role: string }).role)
    ) {
      throw badRequest("invalid_messages", "each message must be {role: system|user|assistant, content: string}");
    }
    const mm = m as { role: "system" | "user" | "assistant"; content: string };
    messages.push({ role: mm.role, content: mm.content });
  }

  let maxTokens: number | undefined;
  const mt = b.max_tokens ?? b.max_completion_tokens;
  if (mt !== undefined && mt !== null) {
    if (typeof mt !== "number" || !Number.isInteger(mt) || mt <= 0) {
      throw badRequest("invalid_max_tokens", "`max_tokens` must be a positive integer");
    }
    maxTokens = mt;
  }

  const stream = b.stream === true;
  return { model, messages, maxTokens, stream };
}
