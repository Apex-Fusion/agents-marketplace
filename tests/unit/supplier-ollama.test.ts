/**
 * supplier-ollama.test.ts — tests for supplier/src/ollama.ts
 *
 * All tests mock global.fetch — no real Ollama process required.
 *
 * Covers:
 *   - Request: one POST to ${ollamaUrl}/api/chat with model, messages and
 *     stream:false; options.num_predict only when an output cap is given
 *   - Result: content, done_reason and token counts of the response;
 *     total_duration ns → ms, rounded down
 *   - Error: non-2xx → OllamaError reason "ollama_failure"
 *   - Error: timeout → OllamaError reason "ollama_timeout"
 *   - Error: no message, no content, empty content on a stop, or no terminal
 *     done_reason → OllamaError reason "ollama_malformed"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callOllama } from "../../supplier/src/ollama.js";

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

function makeOllamaResponse(
  content: string,
  promptEval = 10,
  eval_ = 40,
  totalDuration = 3_200_000_000,
  doneReason = "stop",
) {
  return {
    message: { role: "assistant", content },
    done: true,
    done_reason: doneReason,
    prompt_eval_count: promptEval,
    eval_count: eval_,
    total_duration: totalDuration, // nanoseconds
  };
}

// ─── Request ───────────────────────────────────────────────────────────────

describe("callOllama() — request", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("Hi there")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the model, the messages and stream:false to ${ollamaUrl}/api/chat", async () => {
    await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect({ url, method: init?.method, body: JSON.parse(init?.body as string) }).toEqual({
      url: `${OLLAMA_URL}/api/chat`,
      method: "POST",
      body: { model: MODEL, messages: MESSAGES, stream: false },
    });
  });

  it("forwards an explicit Responses output cap and omits an absent cap", async () => {
    await callOllama({
      ollamaUrl: OLLAMA_URL,
      model: MODEL,
      messages: MESSAGES,
      timeoutMs: TIMEOUT_MS,
      maxOutputTokens: 64,
    });
    const fetchMock = vi.mocked(fetch);
    let init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).options).toEqual({ num_predict: 64 });

    fetchMock.mockClear();
    await callOllama({
      ollamaUrl: OLLAMA_URL,
      model: MODEL,
      messages: MESSAGES,
      timeoutMs: TIMEOUT_MS,
    });
    init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).options).toBeUndefined();
  });
});

// ─── Result ─────────────────────────────────────────────────────────────────

describe("callOllama() — result", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the Ollama response to the result", async () => {
    // 3_200_000_000 ns = 3200 ms. The two token counts differ, so a swap shows.
    vi.stubGlobal(
      "fetch",
      makeFetchOk(makeOllamaResponse("Paris is the capital of France.", 15, 40, 3_200_000_000)),
    );
    const result = await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result).toEqual({
      content: "Paris is the capital of France.",
      done_reason: "stop",
      prompt_tokens: 15,
      completion_tokens: 40,
      wallclock_ms: 3200,
    });
  });

  it("preserves the terminal done_reason", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("partial", 15, 40, 3_200_000_000, "length")));
    const result = await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.done_reason).toBe("length");
  });

  it("rounds wallclock_ms down to whole milliseconds", async () => {
    // 1_500_999_999 ns = 1500.999999 ms → 1500 (Math.floor, not Math.round)
    vi.stubGlobal("fetch", makeFetchOk(makeOllamaResponse("answer", 5, 20, 1_500_999_999)));
    const result = await callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS });
    expect(result.wallclock_ms).toBe(1500);
  });
});

// ─── Error: non-2xx response, network error ─────────────────────────────────

describe("callOllama() — ollama_failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws OllamaError with reason ollama_failure on 500", async () => {
    vi.stubGlobal("fetch", makeFetchError(500));
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_failure" });
  });

  it("throws OllamaError with reason ollama_failure when fetch fails with a network error", async () => {
    // Ollama is down: fetch rejects with a TypeError, which is not an abort.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_failure", message: "Ollama fetch failed: fetch failed" });
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

  // One row for each check of ollama.ts that throws ollama_malformed on the shape of the body.
  it.each([
    [
      "has no message field",
      { done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 5, total_duration: 1e9 },
    ],
    [
      "has a message without content",
      { message: { role: "assistant" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 5, total_duration: 1e9 },
    ],
    ["has empty content and done_reason stop", makeOllamaResponse("")],
    [
      "has no terminal done_reason",
      {
        message: { role: "assistant", content: "answer" },
        done: true,
        prompt_eval_count: 5,
        eval_count: 5,
        total_duration: 1e9,
      },
    ],
  ])("throws OllamaError with reason ollama_malformed when the response %s", async (_row, body) => {
    vi.stubGlobal("fetch", makeFetchOk(body));
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ reason: "ollama_malformed" });
  });

  it("accepts empty content only for a terminal length result", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchOk(makeOllamaResponse("", 5, 5, 1e9, "length")),
    );
    await expect(
      callOllama({ ollamaUrl: OLLAMA_URL, model: MODEL, messages: MESSAGES, timeoutMs: TIMEOUT_MS }),
    ).resolves.toMatchObject({ content: "", done_reason: "length" });
  });
});
