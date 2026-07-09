/**
 * affinity.test.ts — transcript-prefix session matching rules.
 */

import { describe, it, expect } from "vitest";
import {
  matchSessionPrefix,
  normalizeAssistantContent,
  trimToRespondable,
  type AffinityCandidate,
} from "../src/openai/affinity.js";
import type { ChatMessage } from "@marketplace/shared/tx";

const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });
const TOOL_CALL = { id: "call_1", type: "function" as const, function: { name: "get_time", arguments: "{}" } };

function cand(sessionId: string, mirror: ChatMessage[], lastUsedAt = 0, model = "m"): AffinityCandidate {
  return { sessionId, model, mirror, lastUsedAt };
}

describe("matchSessionPrefix", () => {
  it("matches an exact prefix and returns the delta", () => {
    const got = matchSessionPrefix([cand("s1", [u("hi"), a("hello")])], [u("hi"), a("hello"), u("more")], "m");
    expect(got).toEqual({ sessionId: "s1", delta: [u("more")] });
  });

  it("accepts a multi-message tool delta ending with a tool result", () => {
    const mirror = [u("hi"), { role: "assistant" as const, content: "", tool_calls: [TOOL_CALL] }];
    const incoming = [...mirror, { role: "tool" as const, content: "3pm", tool_call_id: "call_1" }];
    const got = matchSessionPrefix([cand("s1", mirror)], incoming, "m");
    expect(got?.sessionId).toBe("s1");
    expect(got?.delta).toHaveLength(1);
    expect(got?.delta[0].role).toBe("tool");
  });

  it("rejects deltas that end with a non-respondable role", () => {
    const got = matchSessionPrefix([cand("s1", [u("hi")])], [u("hi"), a("stray assistant")], "m");
    expect(got).toBeNull();
  });

  it("never matches when incoming is not longer than the mirror (retry of answered request)", () => {
    const mirror = [u("hi"), a("hello")];
    expect(matchSessionPrefix([cand("s1", mirror)], mirror, "m")).toBeNull();
    expect(matchSessionPrefix([cand("s1", mirror)], [u("hi")], "m")).toBeNull();
  });

  it("rejects diverged histories (prefix mismatch)", () => {
    const got = matchSessionPrefix([cand("s1", [u("hi"), a("hello")])], [u("hi"), a("DIFFERENT"), u("more")], "m");
    expect(got).toBeNull();
  });

  it("requires the model to match", () => {
    expect(matchSessionPrefix([cand("s1", [u("hi")], 0, "other")], [u("hi"), u("more")], "m")).toBeNull();
  });

  it("prefers the longest mirror, then most recently used", () => {
    const incoming = [u("hi"), a("hello"), u("more")];
    const longest = matchSessionPrefix(
      [cand("short", [u("hi")], 99), cand("long", [u("hi"), a("hello")], 0)],
      incoming,
      "m",
    );
    expect(longest?.sessionId).toBe("long");

    const tie = matchSessionPrefix(
      [cand("old", [u("hi"), a("hello")], 1), cand("recent", [u("hi"), a("hello")], 2)],
      incoming,
      "m",
    );
    expect(tie?.sessionId).toBe("recent");
  });

  it("matches an empty mirror (fresh session) against any respondable history", () => {
    const incoming = [{ role: "system" as const, content: "be nice" }, u("hi")];
    const got = matchSessionPrefix([cand("fresh", [])], incoming, "m");
    expect(got).toEqual({ sessionId: "fresh", delta: incoming });
  });

  it("treats content null-normalization as equivalent (tool-call assistant echo)", () => {
    const mirror = [u("hi"), { role: "assistant" as const, content: "", tool_calls: [TOOL_CALL] }];
    // Client echoes the assistant message back with content:"" (normalized from null upstream).
    const incoming = [u("hi"), { role: "assistant" as const, content: "", tool_calls: [{ ...TOOL_CALL }] }, { role: "tool" as const, content: "x", tool_call_id: "call_1" }];
    expect(matchSessionPrefix([cand("s1", mirror)], incoming, "m")?.sessionId).toBe("s1");
  });

  it("matches leniently when the client reshapes the assistant echo (think-strip + whitespace)", () => {
    const mirror = [u("hi"), a("<think>plan it</think>Hello  there\n")];
    const got = matchSessionPrefix([cand("s1", mirror)], [u("hi"), a("Hello there"), u("more")], "m");
    expect(got).toEqual({ sessionId: "s1", delta: [u("more")] });
  });

  it("stays strict on user/tool divergence even with lenient assistant matching", () => {
    const mirror = [u("hi "), a("Hello")];
    // User content differs by whitespace — client-authored roles must be byte-exact.
    expect(matchSessionPrefix([cand("s1", mirror)], [u("hi"), a("Hello"), u("more")], "m")).toBeNull();
  });

  it("rejects assistant tool_calls divergence under lenient matching", () => {
    const mirror = [u("hi"), { role: "assistant" as const, content: "x", tool_calls: [TOOL_CALL] }];
    const changed = { ...TOOL_CALL, function: { name: "get_time", arguments: '{"tz":"utc"}' } };
    const incoming = [u("hi"), { role: "assistant" as const, content: "x ", tool_calls: [changed] }, { role: "tool" as const, content: "t", tool_call_id: "call_1" }];
    expect(matchSessionPrefix([cand("s1", mirror)], incoming, "m")).toBeNull();
  });

  it("prefers a strict match over a lenient one regardless of recency", () => {
    const incoming = [u("hi"), a("Hello"), u("more")];
    const got = matchSessionPrefix(
      [
        cand("lenient", [u("hi"), a("Hello   ")], 99),
        cand("strict", [u("hi"), a("Hello")], 1),
      ],
      incoming,
      "m",
    );
    expect(got?.sessionId).toBe("strict");
  });
});

describe("normalizeAssistantContent", () => {
  it("strips think blocks, collapses whitespace and trims", () => {
    expect(normalizeAssistantContent("<think>a\nb</think> Hi\n\nthere  friend ")).toBe("Hi there friend");
    expect(normalizeAssistantContent("<THINK>x</THINK>ok")).toBe("ok");
    expect(normalizeAssistantContent("plain")).toBe("plain");
  });
});

describe("trimToRespondable", () => {
  it("drops trailing assistant/system messages", () => {
    expect(trimToRespondable([u("hi"), a("partial")])).toEqual([u("hi")]);
    expect(trimToRespondable([u("hi"), a("x"), { role: "system" as const, content: "nudge" }])).toEqual([u("hi")]);
  });

  it("returns empty when nothing respondable remains", () => {
    expect(trimToRespondable([a("hello")])).toEqual([]);
    expect(trimToRespondable([])).toEqual([]);
  });

  it("keeps already-respondable histories unchanged", () => {
    const msgs = [u("hi"), a("x"), u("more")];
    expect(trimToRespondable(msgs)).toEqual(msgs);
  });
});
