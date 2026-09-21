import { describe, expect, it } from "vitest";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import {
  createResponse,
  normalizeResponseInput,
  normalizeResponseOutput,
  normalizeResponseRequest,
  readResponseEvents,
  responseEvents,
  responseInputToChatMessages,
  responseResultCommitment,
  validateResponseToolOutputs,
} from "../../packages/shared/src/responses.js";

const output = [
  { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque+/==", provider_replay: { token: "keep" } },
  { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"id":7}', status: "completed" },
];

describe("Responses item commitments", () => {
  it("binds opaque reasoning and incomplete status instead of only visible text", () => {
    const result = createResponse({ id: "resp_1", model: "test", output: normalizeResponseOutput(output) });
    const commitment = canonicalize(responseResultCommitment(result));
    const changedReasoning = createResponse({ ...result, output: normalizeResponseOutput([
      { ...output[0], encrypted_content: "different" }, output[1],
    ]) });
    expect(canonicalize(responseResultCommitment(changedReasoning))).not.toBe(commitment);
    const truncated = createResponse({ ...result, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(canonicalize(responseResultCommitment(truncated))).not.toBe(commitment);
    expect(canonicalize(normalizeResponseInput(result.output))).toBe(canonicalize(output));
    expect(() => responseInputToChatMessages(result.output)).toThrow(/cannot replay.*reasoning/);
  });

  it("keeps function IDs and arguments through a compatibility tool round trip", () => {
    const history = normalizeResponseInput([
      { role: "user", content: "look up 7" },
      output[1],
      { type: "function_call_output", call_id: "call_1", output: '{"value":"seven"}' },
    ]);
    validateResponseToolOutputs(history);
    const messages = responseInputToChatMessages(history);
    expect(messages[1].tool_calls?.[0]).toEqual({
      id: "call_1", type: "function", function: { name: "lookup", arguments: '{"id":7}' },
    });
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"value":"seven"}' });
    expect(() => validateResponseToolOutputs(normalizeResponseInput([
      ...history, { type: "function_call_output", call_id: "call_1", output: "duplicate" },
    ]))).toThrow(/no pending call_id/);
    expect(() => validateResponseToolOutputs(normalizeResponseInput([
      { type: "function_call_output", call_id: "other", output: "orphan" },
    ]))).toThrow(/no pending call_id/);
  });

  it("keeps a tool result adjacent when native assistant text follows its function call", () => {
    const nativeOutput = normalizeResponseOutput([
      output[1],
      { type: "message", id: "msg_1", role: "assistant", phase: null,
        content: [{ type: "output_text", text: "Checking.", annotations: [] }] },
    ]);
    const history = normalizeResponseInput([
      ...nativeOutput,
      { type: "function_call_output", call_id: "call_1", output: "seven" },
    ]);
    expect(responseInputToChatMessages(history)).toEqual([
      { role: "assistant", content: "Checking.", tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"id":7}' } },
      ] },
      { role: "tool", content: "seven", tool_call_id: "call_1" },
    ]);
  });

  it("rejects an undefined forced function before executing a request", () => {
    expect(() => normalizeResponseRequest({ input: "hi", tools: [{ type: "function", name: "lookup" }],
      tool_choice: { type: "function", name: "different" } })).toThrow(/undefined function/);
  });
});

function bytesStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1));
      controller.close();
    },
  });
}

describe("Responses SSE framing", () => {
  it("decodes fragmented UTF-8, CRLF, multiline data, comments and the optional sentinel", async () => {
    const body = bytesStream(': heartbeat\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"Žluťoučký"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\ndata: [DONE]\r\n\r\n');
    const events = [];
    for await (const event of readResponseEvents(body)) events.push(event);
    expect(events).toEqual([
      { type: "response.output_text.delta", delta: "Žluťoučký" },
      { type: "response.completed" },
    ]);
  });

  it("rejects disagreement between event and data types", async () => {
    const consume = async (): Promise<void> => {
      for await (const _event of readResponseEvents(bytesStream('event: response.completed\ndata: {"type":"response.failed"}\n\n'))) {
        // Exhaust the stream so framing errors cannot be hidden by an early return.
      }
    };
    await expect(consume()).rejects.toThrow(/does not match/);
  });

  it("does not accept a late completion after an early stream sentinel", async () => {
    const consume = async (): Promise<void> => {
      for await (const _event of readResponseEvents(bytesStream('data: [DONE]\n\ndata: {"type":"response.completed"}\n\n'))) {
        // The stream must fail before a late completion can be accepted.
      }
    };
    await expect(consume()).rejects.toThrow(/before a terminal response/);
  });

  it("emits a refusal as refusal events and retains the full terminal result", () => {
    const response = createResponse({ id: "resp_refusal", model: "test", output: normalizeResponseOutput([
      { type: "message", id: "msg_refusal", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Cannot assist." }] },
    ]) });
    const events = responseEvents(response);
    expect(events.filter(event => event.type.endsWith(".delta"))).toEqual([
      expect.objectContaining({ type: "response.refusal.delta", delta: "Cannot assist.", item_id: "msg_refusal" }),
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "response.completed", response }));
    expect(responseInputToChatMessages(response.output)).toEqual([{ role: "assistant", content: "Cannot assist." }]);
  });
});
