/**
 * shared-chat-message.test.ts — normalizeChatMessage / chatMessagesEquivalent.
 *
 * The supplier transcript and the gateway mirror must canonicalize to the SAME
 * string (receipt response_hash = sha256(canonicalize(transcript))), so the
 * normalizer's field-presence behavior is load-bearing: absent optional fields
 * must be truly absent, content is never null, vendor extras are stripped.
 */

import { describe, it, expect } from "vitest";
import { normalizeChatMessage, chatMessagesEquivalent } from "../../packages/shared/src/tx/chatMessage.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";

const TOOL_CALL = { id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } };

describe("normalizeChatMessage", () => {
  it("passes through plain user/system/assistant messages", () => {
    expect(normalizeChatMessage({ role: "user", content: "hi" })).toEqual({ role: "user", content: "hi" });
    expect(normalizeChatMessage({ role: "system", content: "be nice" })).toEqual({ role: "system", content: "be nice" });
  });

  it("normalizes null/undefined content to empty string", () => {
    expect(normalizeChatMessage({ role: "assistant", content: null, tool_calls: [TOOL_CALL] })).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [TOOL_CALL],
    });
  });

  it("keeps optional fields ABSENT when not provided (hash identity)", () => {
    const msg = normalizeChatMessage({ role: "assistant", content: "x" })!;
    expect("tool_calls" in msg).toBe(false);
    expect("tool_call_id" in msg).toBe(false);
  });

  it("strips vendor extras from tool calls", () => {
    const msg = normalizeChatMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ ...TOOL_CALL, extra_vendor_field: 42, function: { ...TOOL_CALL.function, parsed: {} } }],
    })!;
    expect(msg.tool_calls).toEqual([TOOL_CALL]);
  });

  it("requires tool role to carry tool_call_id", () => {
    expect(normalizeChatMessage({ role: "tool", content: "result" })).toBeNull();
    expect(normalizeChatMessage({ role: "tool", content: "result", tool_call_id: "call_1" })).toEqual({
      role: "tool",
      content: "result",
      tool_call_id: "call_1",
    });
  });

  it("rejects tool_calls on non-assistant roles and malformed shapes", () => {
    expect(normalizeChatMessage({ role: "user", content: "x", tool_calls: [TOOL_CALL] })).toBeNull();
    expect(normalizeChatMessage({ role: "assistant", content: "", tool_calls: [{ id: "", type: "function", function: { name: "f", arguments: "" } }] })).toBeNull();
    expect(normalizeChatMessage({ role: "bogus", content: "x" })).toBeNull();
    expect(normalizeChatMessage("nope")).toBeNull();
    expect(normalizeChatMessage({ role: "user", content: 42 })).toBeNull();
  });

  it("canonicalizes identically regardless of input key order (mirror vs transcript)", () => {
    const a = normalizeChatMessage({ role: "assistant", content: "", tool_calls: [TOOL_CALL] })!;
    const b = normalizeChatMessage({
      tool_calls: [{ function: { arguments: "{}", name: "get_time" }, type: "function", id: "call_1" }],
      content: null,
      role: "assistant",
    })!;
    expect(canonicalize([a])).toBe(canonicalize([b]));
  });
});

describe("chatMessagesEquivalent", () => {
  it("matches normalized equals and rejects differences", () => {
    const a = normalizeChatMessage({ role: "assistant", content: "", tool_calls: [TOOL_CALL] })!;
    const b = normalizeChatMessage({ role: "assistant", content: null, tool_calls: [TOOL_CALL] })!;
    expect(chatMessagesEquivalent(a, b)).toBe(true);

    const c = normalizeChatMessage({ role: "assistant", content: "hi" })!;
    expect(chatMessagesEquivalent(a, c)).toBe(false);
    const d = normalizeChatMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ ...TOOL_CALL, function: { name: "get_time", arguments: '{"tz":"utc"}' } }],
    })!;
    expect(chatMessagesEquivalent(a, d)).toBe(false);
  });

  it("compares tool results by tool_call_id", () => {
    const a = normalizeChatMessage({ role: "tool", content: "3pm", tool_call_id: "call_1" })!;
    const b = normalizeChatMessage({ role: "tool", content: "3pm", tool_call_id: "call_1" })!;
    const c = normalizeChatMessage({ role: "tool", content: "3pm", tool_call_id: "call_2" })!;
    expect(chatMessagesEquivalent(a, b)).toBe(true);
    expect(chatMessagesEquivalent(a, c)).toBe(false);
  });
});
