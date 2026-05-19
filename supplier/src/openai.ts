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
  const { baseUrl, model, messages, timeoutMs } = params;
  const url = `${baseUrl}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
