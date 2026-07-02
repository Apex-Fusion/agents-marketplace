/**
 * supplier/src/openai.ts — HTTP client for an OpenAI-compatible /v1/chat/completions
 * endpoint. Used by the mainnet supplier when LLM_BACKEND=openai is routed at a
 * localhost Codex-OAuth proxy (e.g. ChatMock).
 *
 * callOpenAi({ baseUrl, model, messages, timeoutMs })
 *   POST to ${baseUrl}/v1/chat/completions with body { model, messages, stream: false }
 *   Returns { content, prompt_tokens, completion_tokens, wallclock_ms }
 *
 * Error reasons:
 *   "openai_failure"   — non-2xx HTTP response, network error, or unexpected fetch failure
 *   "openai_timeout"   — request exceeded timeoutMs (AbortError surfaced from AbortController)
 *   "openai_malformed" — response body missing choices[0].message.content (or empty)
 *
 * /v1/chat/completions response shape (OpenAI / ChatMock):
 *   { choices: [{ index, message: { role: "assistant", content: string }, finish_reason }],
 *     usage: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * Implementation notes:
 *   - Mirrors supplier/src/ollama.ts so jobRunner can branch between backends
 *     without changing downstream receipt-building code (same return shape).
 *   - wallclock_ms is measured LOCALLY via Date.now() bracketing fetch — the
 *     OpenAI response has no total_duration field, so we time the round-trip
 *     here. Inclusive of network + upstream model + JSON parse.
 *   - Uses global fetch + AbortController so tests can vi.stubGlobal("fetch").
 *   - Empty-string content is treated as malformed (matches ollama.ts).
 */

import type { ChatMessage } from "@marketplace/shared/tx";

export interface CallOpenAiParams {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  /**
   * Optional bearer token. When non-empty, an `authorization: Bearer <apiKey>`
   * header is sent. Omit (or pass "") for endpoints that don't require auth,
   * e.g. the ChatMock localhost proxy.
   */
  apiKey?: string;
  /**
   * Forwarded as `max_tokens` when a positive number; omitted otherwise. The
   * caller is responsible for keeping prompt+max_tokens within the model's
   * context window (some providers 400 when it exceeds context).
   */
  maxTokens?: number;
  /**
   * When true, sends `reasoning: { enabled: false }` to disable OpenRouter
   * "thinking" tokens — faster/cheaper straight answers, and avoids reasoning
   * starving the completion budget into a length-truncated (empty) answer.
   * Only valid for OpenRouter endpoints; leave false for ChatMock / direct
   * DeepSeek, which don't accept the param.
   */
  disableReasoning?: boolean;
}

export interface OpenAiResult {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  wallclock_ms: number;
}

export type OpenAiErrorReason = "openai_failure" | "openai_timeout" | "openai_malformed";

export class OpenAiError extends Error {
  public readonly reason: OpenAiErrorReason;
  constructor(reason: OpenAiErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "OpenAiError";
    this.reason = reason;
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if ((err as { code?: string }).code === "ABORT_ERR") return true;
  }
  return false;
}

export async function callOpenAi(params: CallOpenAiParams): Promise<OpenAiResult> {
  const { baseUrl, model, messages, timeoutMs, apiKey, maxTokens, disableReasoning } = params;
  const url = `${baseUrl}/v1/chat/completions`;
  const payload: Record<string, unknown> = { model, messages, stream: false };
  if (typeof maxTokens === "number" && maxTokens > 0) payload.max_tokens = maxTokens;
  if (disableReasoning) payload.reasoning = { enabled: false };
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new OpenAiError("openai_timeout", `OpenAI request exceeded ${timeoutMs}ms`);
    }
    throw new OpenAiError(
      "openai_failure",
      `OpenAI fetch failed: ${(err as Error)?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore — body unavailable
    }
    throw new OpenAiError(
      "openai_failure",
      `OpenAI returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new OpenAiError(
      "openai_malformed",
      `OpenAI response was not valid JSON: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new OpenAiError("openai_malformed", "OpenAI response was not an object");
  }

  const obj = parsed as Record<string, unknown>;
  const choicesRaw = obj.choices;
  if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
    throw new OpenAiError("openai_malformed", "OpenAI response missing 'choices' array");
  }
  const firstChoice = choicesRaw[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    throw new OpenAiError("openai_malformed", "OpenAI response choices[0] not an object");
  }
  const messageRaw = (firstChoice as Record<string, unknown>).message;
  if (!messageRaw || typeof messageRaw !== "object") {
    throw new OpenAiError("openai_malformed", "OpenAI response missing 'choices[0].message'");
  }
  const content = (messageRaw as Record<string, unknown>).content;
  if (typeof content !== "string" || content.length === 0) {
    throw new OpenAiError(
      "openai_malformed",
      "OpenAI response missing/empty choices[0].message.content",
    );
  }

  const usageRaw = obj.usage;
  let promptTokens = 0;
  let completionTokens = 0;
  if (usageRaw && typeof usageRaw === "object") {
    const usage = usageRaw as Record<string, unknown>;
    if (typeof usage.prompt_tokens === "number") promptTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") completionTokens = usage.completion_tokens;
  }

  const wallclockMs = Date.now() - startedAt;

  return {
    content,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    wallclock_ms: wallclockMs,
  };
}

/**
 * callOpenAiStream — streaming variant of callOpenAi for the chat-session
 * supplier. POSTs with `stream: true` and invokes `onToken(delta)` for each
 * content delta as it arrives, then returns the SAME OpenAiResult shape
 * (full accumulated content + token usage) so receipt-building code is shared.
 *
 * Parses the OpenAI/OpenRouter SSE wire format:
 *   data: {"choices":[{"delta":{"content":"tok"}}]}\n\n
 *   ...
 *   data: {"choices":[],"usage":{prompt_tokens,completion_tokens,...}}\n\n   (include_usage)
 *   data: [DONE]\n\n
 *
 * Error reasons match callOpenAi (openai_failure / openai_timeout / openai_malformed).
 * The timeout bounds the WHOLE stream (AbortController), matching the non-stream path.
 */
export async function callOpenAiStream(
  params: CallOpenAiParams,
  onToken: (delta: string) => void,
): Promise<OpenAiResult> {
  const { baseUrl, model, messages, timeoutMs, apiKey, maxTokens, disableReasoning } = params;
  const url = `${baseUrl}/v1/chat/completions`;
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof maxTokens === "number" && maxTokens > 0) payload.max_tokens = maxTokens;
  if (disableReasoning) payload.reasoning = { enabled: false };
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err)) {
      throw new OpenAiError("openai_timeout", `OpenAI request exceeded ${timeoutMs}ms`);
    }
    throw new OpenAiError(
      "openai_failure",
      `OpenAI fetch failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  if (!response.ok) {
    clearTimeout(timer);
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore — body unavailable
    }
    throw new OpenAiError(
      "openai_failure",
      `OpenAI returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  if (!response.body) {
    clearTimeout(timer);
    throw new OpenAiError("openai_malformed", "OpenAI streaming response had no body");
  }

  let accumulated = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let buffer = "";

  const handleData = (payload: string): void => {
    const trimmed = payload.trim();
    if (trimmed.length === 0 || trimmed === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Skip non-JSON keepalive/comment frames.
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    const choices = obj.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const delta = (choices[0] as Record<string, unknown>)?.delta as
        | Record<string, unknown>
        | undefined;
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        accumulated += content;
        onToken(content);
      }
    }
    const usageRaw = obj.usage;
    if (usageRaw && typeof usageRaw === "object") {
      const usage = usageRaw as Record<string, unknown>;
      if (typeof usage.prompt_tokens === "number") promptTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") completionTokens = usage.completion_tokens;
    }
  };

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) handleData(line.slice(5));
        }
      }
    }
    // Flush any trailing frame without a final blank line.
    if (buffer.length > 0) {
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data:")) handleData(line.slice(5));
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      throw new OpenAiError("openai_timeout", `OpenAI stream exceeded ${timeoutMs}ms`);
    }
    throw new OpenAiError(
      "openai_failure",
      `OpenAI stream read failed: ${(err as Error)?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (accumulated.length === 0) {
    throw new OpenAiError("openai_malformed", "OpenAI stream produced no content");
  }

  return {
    content: accumulated,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    wallclock_ms: Date.now() - startedAt,
  };
}
