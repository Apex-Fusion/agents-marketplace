import { afterEach, describe, expect, it, vi } from "vitest";
import { callResponses, callResponsesStream } from "../../supplier/src/openai.js";
import type { ResponseObject, ResponseStreamEvent } from "@marketplace/shared/responses";

const INPUT = [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "hi" }] }];
const BASE = { baseUrl: "http://up", model: "kimi", input: INPUT, timeoutMs: 5_000 };

function terminal(overrides: Partial<ResponseObject> = {}): ResponseObject {
  return {
    id: "resp_stream",
    object: "response",
    created_at: 1_800_000_000,
    model: "kimi",
    status: "completed",
    output: [{
      type: "message",
      id: "msg_stream",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello", annotations: [] }],
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    error: null,
    incomplete_details: null,
    ...overrides,
  };
}

function frame(event: ResponseStreamEvent, newline = "\n"): string {
  return `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
}

function fragmentedResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function streamFetch(parts: string[]) {
  return vi.fn().mockResolvedValue(fragmentedResponse(parts));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callResponsesStream native Responses mode", () => {
  it("passes canonical events through, handles fragmented CRLF, and accepts trailing DONE", async () => {
    const final = terminal({
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "opaque" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello", annotations: [] }] },
      ],
    });
    const wire = [
      frame({ type: "response.created", response: { ...final, status: "in_progress", output: [], usage: null } }, "\r\n"),
      frame({ type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "Hel" }, "\r\n"),
      frame({ type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "lo" }, "\r\n"),
      frame({ type: "response.completed", response: final }, "\r\n"),
      "data: [DONE]\r\n\r\n",
    ].join("");
    vi.stubGlobal("fetch", streamFetch([wire.slice(0, 7), wire.slice(7, 81), wire.slice(81, 203), wire.slice(203)]));
    const events: ResponseStreamEvent[] = [];

    const result = await callResponsesStream(BASE, (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(result.response).toEqual(final);
    expect(result.content).toBe("Hello");
    expect(result.prompt_tokens).toBe(3);
  });

  it("emits the same normalized terminal response that it returns", async () => {
    const providerResponse = terminal({
      output: [{
        type: "message",
        id: "msg_stream",
        role: "assistant",
        status: "completed",
        content: "Hello",
      } as never],
    });
    vi.stubGlobal("fetch", streamFetch([
      frame({ type: "response.completed", response: providerResponse }),
    ]));
    const events: ResponseStreamEvent[] = [];

    const result = await callResponsesStream(BASE, (event) => events.push(event));
    const emittedResponse = events.at(-1)?.response;

    expect(emittedResponse).toBe(result.response);
    expect(result.response.output).toEqual([{
      type: "message",
      id: "msg_stream",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello" }],
    }]);
  });

  it("collects complete item events when terminal metadata omits aggregate output", async () => {
    const reasoning = { type: "reasoning" as const, id: "rs_1", summary: [], encrypted_content: "opaque" };
    const call = { type: "function_call" as const, id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" };
    vi.stubGlobal("fetch", streamFetch([
      frame({ type: "response.output_item.done", output_index: 1, item: call }),
      frame({ type: "response.output_item.done", output_index: 0, item: reasoning }),
      frame({ type: "response.completed", response: terminal({ output: [] }) }),
    ]));
    const events: ResponseStreamEvent[] = [];
    const result = await callResponsesStream(BASE, event => events.push(event));
    expect(result.response.output).toEqual([reasoning, call]);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { output: [reasoning, call] },
    });
  });

  it("serves buffered calls through an explicitly streaming-only Responses backend", async () => {
    const item = terminal().output[0];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).stream !== true) return new Response("streaming required", { status: 400 });
      return fragmentedResponse([
        frame({ type: "response.output_item.done", output_index: 0, item }),
        frame({ type: "response.completed", response: terminal({ output: [] }) }),
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await callResponses({ ...BASE, responsesStreamOnly: true });
    expect(result.content).toBe("Hello");
    expect(result.response.output).toEqual([item]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not invent missing complete items from token deltas or sparse indexes", async () => {
    const done = frame({ type: "response.completed", response: terminal({ output: [] }) });
    vi.stubGlobal("fetch", streamFetch([
      frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" }),
      done,
    ]));
    await expect(callResponsesStream(BASE, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });
    vi.stubGlobal("fetch", streamFetch([
      frame({ type: "response.output_item.done", output_index: 1, item: terminal().output[0] }),
      done,
    ]));
    await expect(callResponsesStream(BASE, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });
  });

  it("accepts a terminal event at EOF without DONE and preserves incomplete details", async () => {
    const final = terminal({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    vi.stubGlobal("fetch", streamFetch([frame({ type: "response.incomplete", response: final })]));
    const result = await callResponsesStream(BASE, () => {});
    expect(result.response.status).toBe("incomplete");
    expect(result.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("parses multiline data fields", async () => {
    const final = terminal();
    const json = JSON.stringify({ type: "response.completed", response: final });
    const split = json.indexOf(',"response"');
    const wire = `event: response.completed\ndata: ${json.slice(0, split + 1)}\ndata: ${json.slice(split + 1)}\n\n`;
    vi.stubGlobal("fetch", streamFetch([wire]));
    expect((await callResponsesStream(BASE, () => {})).response).toEqual(final);
  });

  it("rejects malformed JSON, missing terminal, duplicate terminal, and failed events", async () => {
    vi.stubGlobal("fetch", streamFetch(["event: response.created\ndata: {bad}\n\n"]));
    await expect(callResponsesStream(BASE, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });

    vi.stubGlobal("fetch", streamFetch([frame({ type: "response.created", response: terminal({ status: "in_progress", output: [], usage: null }) }), "data: [DONE]\n\n"]));
    await expect(callResponsesStream(BASE, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });

    const done = frame({ type: "response.completed", response: terminal() });
    vi.stubGlobal("fetch", streamFetch([done, done]));
    await expect(callResponsesStream(BASE, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });

    vi.stubGlobal("fetch", streamFetch(["data: [DONE]\n\n", done]));
    await expect(callResponsesStream(BASE, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });

    vi.stubGlobal("fetch", streamFetch([frame({ type: "response.failed", response: terminal({ status: "failed", output: [], error: { message: "bad" } }) })]));
    await expect(callResponsesStream(BASE, () => {})).rejects.toMatchObject({ reason: "openai_failure" });
  });

  it("classifies a stream abort as timeout", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException("aborted", "AbortError");
      },
    }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(callResponsesStream(BASE, () => {})).rejects.toMatchObject({
      name: "OpenAiError",
      reason: "openai_timeout",
    });
  });
});

describe("callResponsesStream explicit Chat Completions mode", () => {
  function chatFrame(value: unknown, newline = "\n"): string {
    return `data: ${typeof value === "string" ? value : JSON.stringify(value)}${newline}${newline}`;
  }

  it("streams live text and emits synthetic canonical tool lifecycle events", async () => {
    const wire = [
      chatFrame({ id: "chatcmpl_1", model: "kimi", created: 1_800_000_000, choices: [{ delta: { role: "assistant", content: "Hel" }, finish_reason: null }] }, "\r\n"),
      chatFrame({ id: "chatcmpl_1", model: "kimi", choices: [{ delta: { content: "lo", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"x\":" } }] }, finish_reason: null }] }, "\r\n"),
      chatFrame({ id: "chatcmpl_1", model: "kimi", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] }, "\r\n"),
      chatFrame({ id: "chatcmpl_1", model: "kimi", choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12, cost: 0.01 } }, "\r\n"),
      chatFrame("[DONE]", "\r\n"),
    ].join("");
    const fetchMock = streamFetch([wire.slice(0, 3), wire.slice(3, 79), wire.slice(79, 211), wire.slice(211)]);
    vi.stubGlobal("fetch", fetchMock);
    const events: ResponseStreamEvent[] = [];

    const result = await callResponsesStream({
      ...BASE,
      upstreamApi: "chat-completions",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: "auto",
    }, (event) => events.push(event));

    expect(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta)).toEqual(["Hel", "lo"]);
    expect(events.some((event) => event.type === "response.output_item.added")).toBe(true);
    expect(events.some((event) => event.type === "response.function_call_arguments.delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "response.completed", response: result.response });
    expect(result.response.output).toEqual([
      { type: "message", id: "msg_chatcmpl_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] },
      { type: "function_call", id: "call_1", call_id: "call_1", name: "lookup", arguments: "{\"x\":1}", status: "completed" },
    ]);
    expect(result.prompt_tokens).toBe(7);
    expect(result.completion_tokens).toBe(5);
    expect(result.cost_usd).toBe(0.01);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      tool_choice: "auto",
    });
  });

  it("supports refusal-only and maps length to incomplete", async () => {
    const wire = [
      chatFrame({ id: "chatcmpl_2", model: "kimi", choices: [{ delta: { refusal: "Cannot" }, finish_reason: null }] }),
      chatFrame({ id: "chatcmpl_2", model: "kimi", choices: [{ delta: { refusal: " help" }, finish_reason: "length" }] }),
      chatFrame("[DONE]"),
    ].join("");
    vi.stubGlobal("fetch", streamFetch([wire]));
    const result = await callResponsesStream({ ...BASE, upstreamApi: "chat-completions" }, () => {});
    expect(result.response.status).toBe("incomplete");
    expect(result.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(result.response.output).toEqual([
      { type: "message", id: "msg_chatcmpl_2", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Cannot help" }] },
    ]);
  });

  it("rejects malformed chunks, DONE before a finish reason, and incomplete tool calls", async () => {
    vi.stubGlobal("fetch", streamFetch(["data: {bad}\n\n"]));
    await expect(callResponsesStream({ ...BASE, upstreamApi: "chat-completions" }, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });

    vi.stubGlobal("fetch", streamFetch([chatFrame({ id: "x", choices: [{ delta: { content: "partial" }, finish_reason: null }] }), chatFrame("[DONE]")]));
    await expect(callResponsesStream({ ...BASE, upstreamApi: "chat-completions" }, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });

    vi.stubGlobal("fetch", streamFetch([chatFrame({ id: "x", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }] })]));
    await expect(callResponsesStream({ ...BASE, upstreamApi: "chat-completions" }, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });
  });

  it("cancels and unlocks a rejected chat response stream", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chatFrame({
          id: "chatcmpl_rejected",
          model: "kimi",
          choices: [{
            delta: { reasoning_content: "private chain of thought" },
            finish_reason: null,
          }],
        })));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    await expect(callResponsesStream({
      ...BASE,
      upstreamApi: "chat-completions",
    }, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
