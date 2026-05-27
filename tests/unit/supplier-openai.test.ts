/**
 * supplier-openai.test.ts — unit tests for supplier/src/openai.ts.
 *
 * Mirrors supplier-ollama.test.ts. All tests mock global.fetch — no real
 * ChatMock / OpenAI process required.
 *
 * Covers:
 *   - Request shape: POST to ${baseUrl}/v1/chat/completions, body has model+messages+stream:false
 *   - Happy path: parses /v1/chat/completions response, measures wallclock_ms locally
 *   - Error: 5xx → OpenAiError reason "openai_failure"
 *   - Error: timeout → OpenAiError reason "openai_timeout"
 *   - Error: missing choices[0].message.content → OpenAiError reason "openai_malformed"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callOpenAi, OpenAiError } from "../../supplier/src/openai.js";

const BASE_URL = "http://localhost:8000";
const MODEL = "gpt-5.4";
const MESSAGES = [{ role: "user" as const, content: "Hello" }];
const TIMEOUT_MS = 5_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function makeFetchError(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: "server error" }),
    text: async () => "server error",
  });
}

function makeOpenAiResponse(content: string, promptTokens = 10, completionTokens = 40) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ─── Request shape ─────────────────────────────────────────────────────────

describe("callOpenAi() — request shape", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchOk(makeOpenAiResponse("Hi there")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST to ${baseUrl}/v1/chat/completions", async () => {
    await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/chat/completions`);
  });

  it("sends POST method", async () => {
    await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.method?.toUpperCase()).toBe("POST");
  });

  it("request body contains model", async () => {
    await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(MODEL);
  });

  it("request body contains messages", async () => {
    await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual(MESSAGES);
  });

  it("request body has stream: false", async () => {
    await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
  });

  it("omits authorization header when apiKey is not provided (ChatMock path)", async () => {
    await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("sends authorization: Bearer <apiKey> when apiKey is provided (DeepSeek/OpenAI path)", async () => {
    await callOpenAi({
      baseUrl: BASE_URL,
      model: MODEL,
      messages: MESSAGES,
      timeoutMs: TIMEOUT_MS,
      apiKey: "sk-test-deepseek-key",
    });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test-deepseek-key");
  });

  it("omits authorization header when apiKey is empty string", async () => {
    await callOpenAi({
      baseUrl: BASE_URL,
      model: MODEL,
      messages: MESSAGES,
      timeoutMs: TIMEOUT_MS,
      apiKey: "",
    });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });
});

// ─── Happy path ─────────────────────────────────────────────────────────────

describe("callOpenAi() — happy path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns content from choices[0].message.content", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOpenAiResponse("Paris is the capital of France.")));
    const result = await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.content).toBe("Paris is the capital of France.");
  });

  it("returns prompt_tokens from usage.prompt_tokens", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOpenAiResponse("answer", 15, 40)));
    const result = await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.prompt_tokens).toBe(15);
  });

  it("returns completion_tokens from usage.completion_tokens", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOpenAiResponse("answer", 15, 40)));
    const result = await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.completion_tokens).toBe(40);
  });

  it("wallclock_ms is measured locally (non-negative finite integer)", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOpenAiResponse("answer")));
    const result = await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(Number.isFinite(result.wallclock_ms)).toBe(true);
    expect(result.wallclock_ms).toBeGreaterThanOrEqual(0);
  });

  it("falls back to 0 token counts when usage block is absent", async () => {
    const body = makeOpenAiResponse("answer");
    delete (body as { usage?: unknown }).usage;
    vi.stubGlobal("fetch", makeFetchOk(body));
    const result = await callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.prompt_tokens).toBe(0);
    expect(result.completion_tokens).toBe(0);
  });
});

// ─── Error: 5xx response ────────────────────────────────────────────────────

describe("callOpenAi() — openai_failure (non-2xx)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws OpenAiError with reason openai_failure on 500", async () => {
    vi.stubGlobal("fetch", makeFetchError(500));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "openai_failure" });
  });

  it("throws OpenAiError with reason openai_failure on 401 (Codex auth revoked)", async () => {
    vi.stubGlobal("fetch", makeFetchError(401));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "openai_failure" });
  });

  it("throws OpenAiError (not generic Error) on non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetchError(500));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toBeInstanceOf(OpenAiError);
  });
});

// ─── Error: timeout ─────────────────────────────────────────────────────────

describe("callOpenAi() — openai_timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws OpenAiError with reason openai_timeout when AbortSignal fires", async () => {
    const abortErr = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: 10 })
    ).rejects.toMatchObject({ reason: "openai_timeout" });
  });
});

// ─── Error: malformed response ───────────────────────────────────────────────

describe("callOpenAi() — openai_malformed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws OpenAiError with reason openai_malformed when choices array is missing", async () => {
    vi.stubGlobal("fetch", makeFetchOk({ id: "x", object: "chat.completion", usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "openai_malformed" });
  });

  it("throws OpenAiError with reason openai_malformed when choices array is empty", async () => {
    vi.stubGlobal("fetch", makeFetchOk({ id: "x", object: "chat.completion", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "openai_malformed" });
  });

  it("throws OpenAiError with reason openai_malformed when choices[0].message is missing", async () => {
    vi.stubGlobal("fetch", makeFetchOk({ id: "x", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop" }] }));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "openai_malformed" });
  });

  it("throws OpenAiError with reason openai_malformed when content is null", async () => {
    vi.stubGlobal("fetch", makeFetchOk({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }] }));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "openai_malformed" });
  });

  it("throws OpenAiError with reason openai_malformed when content is empty string", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOpenAiResponse("")));
    await expect(
      callOpenAi({ baseUrl: BASE_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "openai_malformed" });
  });
});
