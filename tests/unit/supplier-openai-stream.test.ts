/**
 * supplier-openai-stream.test.ts — callOpenAiStream tools passthrough.
 *
 * Mocks global.fetch with SSE-shaped Response bodies. Covers:
 *   - tools/tool_choice included in the upstream payload only when provided
 *   - fragmented delta.tool_calls accumulation across frames
 *   - pure tool-call turns (empty content) no longer throw openai_malformed
 *   - empty content AND no tool calls still throws
 *   - finish_reason capture
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { callOpenAiStream, OpenAiError } from "../../supplier/src/openai.js";

const BASE = { baseUrl: "http://up", model: "kimi", messages: [{ role: "user" as const, content: "hi" }], timeoutMs: 5_000 };
const TOOLS = [{ type: "function", function: { name: "get_time", parameters: {} } }];

function sse(frames: unknown[]): string {
  return frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
}

function makeStreamFetch(body: string) {
  return vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callOpenAiStream — tools passthrough", () => {
  const CONTENT_FRAMES = sse([
    { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    "[DONE]",
  ]);

  it("includes tools + tool_choice in the payload when provided", async () => {
    const fetchFn = makeStreamFetch(CONTENT_FRAMES);
    vi.stubGlobal("fetch", fetchFn);
    await callOpenAiStream({ ...BASE, tools: TOOLS, toolChoice: "auto" }, () => {});
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.tools).toEqual(TOOLS);
    expect(body.tool_choice).toBe("auto");
  });

  it("omits tools from the payload when not provided", async () => {
    const fetchFn = makeStreamFetch(CONTENT_FRAMES);
    vi.stubGlobal("fetch", fetchFn);
    await callOpenAiStream(BASE, () => {});
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("includes user in the payload when provided (session passthrough)", async () => {
    const fetchFn = makeStreamFetch(CONTENT_FRAMES);
    vi.stubGlobal("fetch", fetchFn);
    await callOpenAiStream({ ...BASE, user: `${"f".repeat(64)}#0` }, () => {});
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.user).toBe(`${"f".repeat(64)}#0`);
  });

  it("omits user from the payload when not provided", async () => {
    const fetchFn = makeStreamFetch(CONTENT_FRAMES);
    vi.stubGlobal("fetch", fetchFn);
    await callOpenAiStream(BASE, () => {});
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect("user" in body).toBe(false);
  });

  it("accumulates fragmented delta.tool_calls across frames", async () => {
    const frames = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_time", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"tz":' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"utc"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 5 } },
      "[DONE]",
    ]);
    vi.stubGlobal("fetch", makeStreamFetch(frames));
    const result = await callOpenAiStream({ ...BASE, tools: TOOLS }, () => {});
    expect(result.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_time", arguments: '{"tz":"utc"}' } },
    ]);
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.content).toBe("");
    expect(result.prompt_tokens).toBe(7);
  });

  it("orders multiple tool calls by index", async () => {
    const frames = sse([
      { choices: [{ delta: { tool_calls: [
        { index: 1, id: "call_b", type: "function", function: { name: "b", arguments: "{}" } },
        { index: 0, id: "call_a", type: "function", function: { name: "a", arguments: "{}" } },
      ] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
    vi.stubGlobal("fetch", makeStreamFetch(frames));
    const result = await callOpenAiStream({ ...BASE, tools: TOOLS }, () => {});
    expect(result.tool_calls?.map((t) => t.id)).toEqual(["call_a", "call_b"]);
  });

  it("still throws openai_malformed when content AND tool calls are both empty", async () => {
    const frames = sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
    vi.stubGlobal("fetch", makeStreamFetch(frames));
    await expect(callOpenAiStream(BASE, () => {})).rejects.toMatchObject({ reason: "openai_malformed" });
    await expect(callOpenAiStream(BASE, () => {})).rejects.toBeInstanceOf(OpenAiError);
  });

  it("still streams plain content unchanged (no tools)", async () => {
    vi.stubGlobal("fetch", makeStreamFetch(CONTENT_FRAMES));
    const tokens: string[] = [];
    const result = await callOpenAiStream(BASE, (t) => tokens.push(t));
    expect(tokens).toEqual(["Hello"]);
    expect(result.content).toBe("Hello");
    expect(result.tool_calls).toBeUndefined();
    expect(result.finish_reason).toBe("stop");
  });
});
