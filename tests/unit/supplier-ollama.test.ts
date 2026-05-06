/**
 * supplier-ollama.test.ts — RED phase tests for supplier/src/ollama.ts
 *
 * All tests mock global.fetch — no real Ollama process required.
 *
 * Covers:
 *   - Request shape: POST to ${ollamaUrl}/api/chat, body has model+messages+stream:false
 *   - Happy path: parses Ollama response, converts total_duration ns → ms
 *   - Error: 5xx → OllamaError reason "ollama_failure"
 *   - Error: timeout → OllamaError reason "ollama_timeout"
 *   - Error: missing message.content → OllamaError reason "ollama_malformed"
 *   - Error: missing message field → OllamaError reason "ollama_malformed"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callOllama, OllamaError } from "../../supplier/src/ollama.js";

const OLLAMA_URL = "http://localhost:11434";
const MODEL = "qwen2.5:0.5b";
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

function makeOllamaResponse(content: string, promptEval = 10, eval_ = 40, totalDuration = 3_200_000_000) {
  return {
    message: { role: "assistant", content },
    done: true,
    prompt_eval_count: promptEval,
    eval_count: eval_,
    total_duration: totalDuration, // nanoseconds
  };
}

// ─── Request shape ─────────────────────────────────────────────────────────

describe("callOllama() — request shape", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("Hi there")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST to ${ollamaUrl}/api/chat", async () => {
    await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OLLAMA_URL}/api/chat`);
  });

  it("sends POST method", async () => {
    await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.method?.toUpperCase()).toBe("POST");
  });

  it("request body contains model", async () => {
    await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(MODEL);
  });

  it("request body contains messages", async () => {
    await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual(MESSAGES);
  });

  it("request body has stream: false", async () => {
    await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
  });
});

// ─── Happy path ─────────────────────────────────────────────────────────────

describe("callOllama() — happy path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns content from message.content", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("Paris is the capital of France.")));
    const result = await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.content).toBe("Paris is the capital of France.");
  });

  it("returns prompt_tokens from prompt_eval_count", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("answer", 15, 40)));
    const result = await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.prompt_tokens).toBe(15);
  });

  it("returns completion_tokens from eval_count", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("answer", 15, 40)));
    const result = await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.completion_tokens).toBe(40);
  });

  it("converts total_duration nanoseconds to wallclock_ms", async () => {
    // 3_200_000_000 ns = 3200 ms
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("answer", 10, 40, 3_200_000_000)));
    const result = await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.wallclock_ms).toBe(3200);
  });

  it("wallclock_ms is floored (not rounded up)", async () => {
    // 1_500_999_999 ns = 1500.999999 ms → floor to 1500
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("answer", 5, 20, 1_500_999_999)));
    const result = await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.wallclock_ms).toBeLessThanOrEqual(1501);
    expect(result.wallclock_ms).toBeGreaterThanOrEqual(1500);
  });
});

// ─── Error: 5xx response ────────────────────────────────────────────────────

describe("callOllama() — ollama_failure (non-2xx)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws OllamaError with reason ollama_failure on 500", async () => {
    vi.stubGlobal("fetch", makeFetchError(500));
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_failure" });
  });

  it("throws OllamaError with reason ollama_failure on 503", async () => {
    vi.stubGlobal("fetch", makeFetchError(503));
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_failure" });
  });

  it("throws OllamaError (not generic Error) on 5xx", async () => {
    vi.stubGlobal("fetch", makeFetchError(500));
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toBeInstanceOf(OllamaError);
  });
});

// ─── Error: timeout ─────────────────────────────────────────────────────────

describe("callOllama() — ollama_timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws OllamaError with reason ollama_timeout when AbortSignal fires", async () => {
    // Simulate fetch rejecting with AbortError (what happens when AbortController aborts)
    const abortErr = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: 10 })
    ).rejects.toMatchObject({ reason: "ollama_timeout" });
  });
});

// ─── Error: malformed response ───────────────────────────────────────────────

describe("callOllama() — ollama_malformed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws OllamaError with reason ollama_malformed when message.content is missing", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchOk({ message: { role: "assistant" }, done: true, prompt_eval_count: 5, eval_count: 5, total_duration: 1e9 })
    );
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_malformed" });
  });

  it("throws OllamaError with reason ollama_malformed when message field is absent", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchOk({ done: true, prompt_eval_count: 5, eval_count: 5, total_duration: 1e9 })
    );
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_malformed" });
  });

  it("throws OllamaError with reason ollama_malformed when message.content is null", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchOk({ message: { role: "assistant", content: null }, done: true, prompt_eval_count: 5, eval_count: 5, total_duration: 1e9 })
    );
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_malformed" });
  });

  it("throws OllamaError with reason ollama_malformed when message.content is empty string", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchOk(makeOllamaResponse(""))
    );
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_malformed" });
  });
});
