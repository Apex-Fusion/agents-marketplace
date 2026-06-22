/**
 * gateway/src/openai/shapes.ts — OpenAI response object builders.
 *
 * Produces spec-clean ChatCompletion / ChatCompletionChunk / model-list objects
 * plus the `x_vector` receipt extension. SSE helpers frame chunks for streaming.
 */

import { randomBytes } from "crypto";
import type { Receipt } from "@marketplace/shared/receipt";

export function genId(): string {
  return `chatcmpl-${randomBytes(16).toString("hex")}`;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface VectorReceipt {
  receipt: Receipt;
  receipt_signature: string;
  escrow_ref: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function usageFromReceipt(receipt: Receipt): Usage {
  const prompt = receipt.prompt_tokens ?? 0;
  const completion = receipt.completion_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** Non-streaming chat.completion object. */
export function buildChatCompletion(args: {
  id: string;
  model: string;
  content: string;
  usage: Usage;
  vector?: VectorReceipt;
}): Record<string, unknown> {
  return {
    id: args.id,
    object: "chat.completion",
    created: nowSec(),
    model: args.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: args.content },
        finish_reason: "stop",
      },
    ],
    usage: args.usage,
    ...(args.vector ? { x_vector: args.vector } : {}),
  };
}

/** A streaming chat.completion.chunk. `delta` is the incremental content (or {}). */
export function buildChunk(args: {
  id: string;
  model: string;
  delta: { role?: string; content?: string } | Record<string, never>;
  finishReason: "stop" | null;
  usage?: Usage;
  vector?: VectorReceipt;
}): Record<string, unknown> {
  return {
    id: args.id,
    object: "chat.completion.chunk",
    created: nowSec(),
    model: args.model,
    choices: [{ index: 0, delta: args.delta, finish_reason: args.finishReason }],
    ...(args.usage ? { usage: args.usage } : {}),
    ...(args.vector ? { x_vector: args.vector } : {}),
  };
}

/** Frame any object as an SSE `data:` event. */
export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function buildModelsList(models: string[]): Record<string, unknown> {
  const created = nowSec();
  return {
    object: "list",
    data: models.map((id) => ({ id, object: "model", created, owned_by: "vector-marketplace" })),
  };
}

/** Render OpenAI messages[] into a single prompt string for the chat.v1 session
 * supplier (which has no system-role channel — see docs/gateway.md). */
export function renderMessages(messages: Array<{ role: string; content: string }>): string {
  return messages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");
}
