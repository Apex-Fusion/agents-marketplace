import { afterEach, describe, expect, it, vi } from "vitest";
import { callResponses } from "../../supplier/src/openai.js";
import type { ResponseObject } from "@marketplace/shared/responses";

const BASE_URL = "http://localhost:8000";
const MODEL = "gpt-5.4";
const INPUT = [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "Hello" }] }];
const BASE = { baseUrl: BASE_URL, model: MODEL, input: INPUT, timeoutMs: 5_000 };

function response(overrides: Partial<ResponseObject> = {}): ResponseObject {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1_800_000_000,
    model: MODEL,
    status: "completed",
    output: [{
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hi there", annotations: [] }],
    }],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    error: null,
    incomplete_details: null,
    ...overrides,
  };
}

function ok(body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function requestBody(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(call[1].body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callResponses native Responses mode", () => {
  it("sends full replay input to the configured endpoint without provider storage", async () => {
    const fetchMock = ok(response());
    vi.stubGlobal("fetch", fetchMock);

    await callResponses({
      ...BASE,
      responsesUrl: "https://router.example/openai/responses",
      apiKey: "secret",
      instructions: "Be concise",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: false,
      max_output_tokens: 900,
      maxTokens: 400,
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { type: "text" } },
      temperature: 0.3,
      top_p: 0.8,
      user: "session-key",
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://router.example/openai/responses");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(requestBody(fetchMock)).toEqual({
      model: MODEL,
      input: INPUT,
      stream: false,
      store: false,
      include: ["reasoning.encrypted_content"],
      instructions: "Be concise",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: false,
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { type: "text" } },
      temperature: 0.3,
      top_p: 0.8,
      max_output_tokens: 400,
      user: "session-key",
    });
  });

  it("uses /v1/responses and leaves max_output_tokens absent when neither party supplies it", async () => {
    const fetchMock = ok(response());
    vi.stubGlobal("fetch", fetchMock);
    await callResponses(BASE);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/v1/responses`);
    expect(requestBody(fetchMock)).not.toHaveProperty("max_output_tokens");
  });

  it("uses the operator ceiling when the buyer omits a limit and effort none when reasoning is disabled", async () => {
    const fetchMock = ok(response());
    vi.stubGlobal("fetch", fetchMock);
    await callResponses({ ...BASE, maxTokens: 256, disableReasoning: true, reasoning: { summary: "auto" } });
    expect(requestBody(fetchMock)).toMatchObject({
      max_output_tokens: 256,
      reasoning: { effort: "none", summary: "auto" },
    });
  });

  it("rejects reasoning effort that conflicts with disabled reasoning before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(callResponses({
      ...BASE,
      disableReasoning: true,
      reasoning: { effort: "high", summary: "auto" },
    })).rejects.toMatchObject({
      name: "OpenAiError",
      reason: "openai_malformed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves canonical reasoning, tool, refusal, annotations, usage details, and derived text", async () => {
    const terminal = response({
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "opaque" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"city\":\"Paris\"}", status: "completed" },
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          phase: "final_answer",
          status: "completed",
          content: [
            { type: "output_text", text: "Paris", annotations: [{ type: "url_citation", url: "https://example.test" }] },
            { type: "refusal", refusal: "I cannot add private data." },
            { type: "output_text", text: " is in France.", annotations: [] },
          ],
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 9,
        total_tokens: 29,
        output_tokens_details: { reasoning_tokens: 3 },
        cost: 0.002,
      },
    });
    vi.stubGlobal("fetch", ok(terminal));

    const result = await callResponses(BASE);
    expect(result.response).toEqual(terminal);
    expect(result.content).toBe("Paris is in France.");
    expect(result.prompt_tokens).toBe(20);
    expect(result.completion_tokens).toBe(9);
    expect(result.cost_usd).toBe(0.002);
  });

  it("accepts refusal-only, tool-only, and incomplete terminal responses", async () => {
    const refusal = response({
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No." }] }],
    });
    vi.stubGlobal("fetch", ok(refusal));
    expect((await callResponses(BASE)).response.output).toEqual(refusal.output);

    const toolOnly = response({
      output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }],
    });
    vi.stubGlobal("fetch", ok(toolOnly));
    expect((await callResponses(BASE)).response.output).toEqual(toolOnly.output);

    const incomplete = response({
      status: "incomplete",
      output: [],
      incomplete_details: { reason: "max_output_tokens" },
    });
    vi.stubGlobal("fetch", ok(incomplete));
    const result = await callResponses(BASE);
    expect(result.response.status).toBe("incomplete");
    expect(result.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(result.content).toBe("");
  });

  it("classifies failed responses, malformed output, non-2xx, and timeout", async () => {
    vi.stubGlobal("fetch", ok(response({ status: "failed", error: { message: "provider failed" }, output: [] })));
    await expect(callResponses(BASE)).rejects.toMatchObject({ reason: "openai_failure" });

    vi.stubGlobal("fetch", ok(response({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text" }] } as never] })));
    await expect(callResponses(BASE)).rejects.toMatchObject({ reason: "openai_malformed" });

    vi.stubGlobal("fetch", ok(response({ output: [] })));
    await expect(callResponses(BASE)).rejects.toMatchObject({ reason: "openai_malformed" });

    const httpFailure = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", httpFailure);
    await expect(callResponses(BASE)).rejects.toMatchObject({
      name: "OpenAiError",
      reason: "openai_failure",
    });
    expect(httpFailure).toHaveBeenCalledTimes(1);
    expect(httpFailure.mock.calls[0][0]).toBe(`${BASE_URL}/v1/responses`);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    await expect(callResponses({ ...BASE, timeoutMs: 1 })).rejects.toMatchObject({ reason: "openai_timeout" });
  });
});

describe("callResponses explicit Chat Completions mode", () => {
  const chatResult = {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1_800_000_000,
    model: MODEL,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "Checking",
        refusal: "Some fields are private.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"x\":1}" } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 2 }, cost: 0.001 },
  };

  it("converts request messages and tools and normalizes text, refusal, and calls", async () => {
    const fetchMock = ok(chatResult);
    vi.stubGlobal("fetch", fetchMock);
    const result = await callResponses({
      ...BASE,
      upstreamApi: "chat-completions",
      instructions: "System rule",
      tools: [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object" }, strict: true }],
      tool_choice: { type: "function", name: "lookup" },
      max_output_tokens: 300,
      maxTokens: 200,
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          description: "Strict answer envelope",
          strict: false,
          schema: {
            type: "object",
            properties: { answer: { type: "string", enum: ["ZQX-7741"] } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    });

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(requestBody(fetchMock)).toMatchObject({
      model: MODEL,
      stream: false,
      max_tokens: 200,
      messages: [
        { role: "system", content: "System rule" },
        { role: "user", content: "Hello" },
      ],
      tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" }, strict: true } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          description: "Strict answer envelope",
          strict: false,
          schema: {
            type: "object",
            properties: { answer: { type: "string", enum: ["ZQX-7741"] } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(result.response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Checking", annotations: [] },
          { type: "refusal", refusal: "Some fields are private." },
        ],
      },
      { type: "function_call", id: "call_1", call_id: "call_1", name: "lookup", arguments: "{\"x\":1}", status: "completed" },
    ]);
    expect(result.response.usage).toMatchObject({ input_tokens: 7, output_tokens: 5, total_tokens: 12 });
    expect(result.content).toBe("Checking");
  });

  it("maps length to an incomplete canonical response", async () => {
    vi.stubGlobal("fetch", ok({
      ...chatResult,
      choices: [{ index: 0, message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
    }));
    const result = await callResponses({ ...BASE, upstreamApi: "chat-completions" });
    expect(result.response.status).toBe("incomplete");
    expect(result.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("replays function call loops with exact call ids and raw arguments", async () => {
    const fetchMock = ok(chatResult);
    vi.stubGlobal("fetch", fetchMock);
    await callResponses({
      ...BASE,
      upstreamApi: "chat-completions",
      input: [
        INPUT[0],
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
        { type: "function_call", call_id: "call_exact", name: "lookup", arguments: "{\"raw\": true}" },
        { type: "function_call_output", call_id: "call_exact", output: "{\"answer\":42}" },
      ],
    });

    expect(requestBody(fetchMock).messages).toEqual([
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: "Checking",
        tool_calls: [{
          id: "call_exact",
          type: "function",
          function: { name: "lookup", arguments: "{\"raw\": true}" },
        }],
      },
      { role: "tool", content: "{\"answer\":42}", tool_call_id: "call_exact" },
    ]);
  });

  it("rejects reasoning input rather than silently dropping it", async () => {
    vi.stubGlobal("fetch", ok(chatResult));
    await expect(callResponses({
      ...BASE,
      upstreamApi: "chat-completions",
      input: [
        INPUT[0],
        { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
      ],
    })).rejects.toMatchObject({ reason: "openai_malformed" });
  });

  it("rejects unsupported text verbosity before calling Chat upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(callResponses({
      ...BASE,
      upstreamApi: "chat-completions",
      text: { verbosity: "high" },
    })).rejects.toMatchObject({
      reason: "openai_malformed",
      message: expect.stringContaining("text.verbosity"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
