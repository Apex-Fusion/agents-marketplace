/**
 * gateway/src/openai/affinity.ts — transcript-prefix session matching.
 *
 * Stateless OpenAI clients resend the FULL message history each call; sessions
 * are stateful. An incoming request belongs to an open session when that
 * session's mirrored transcript is a prefix of the incoming messages — the
 * suffix (delta) is the next turn. Client-authored messages (user/system/tool)
 * must match byte-exactly, but clients routinely reshape ASSISTANT text when
 * echoing it back (strip <think> reasoning, re-render whitespace), so
 * assistant content is compared normalized. Strict (byte-exact) matches are
 * preferred over lenient ones to disambiguate concurrent threads that share a
 * user-message prefix. The mirror itself is NEVER rewritten with client text:
 * the delta is forwarded verbatim and mirrored only after a successful turn,
 * so the gateway mirror and the supplier transcript stay hash-identical for
 * the receipt response_hash.
 *
 * Pure module — no I/O — so the matching rules are unit-testable.
 */

import { chatMessagesEquivalent, toolCallsEqual, type ChatMessage } from "@marketplace/shared/tx";

export interface AffinityCandidate {
  sessionId: string;
  model: string;
  mirror: ChatMessage[];
  lastUsedAt: number;
}

export interface AffinityMatch {
  sessionId: string;
  /** Messages the session has not seen yet — forwarded as the next turn. */
  delta: ChatMessage[];
}

/** Canonicalize assistant text the way clients mangle it when re-echoing
 * history: drop <think>…</think> reasoning blocks, collapse whitespace runs,
 * trim. Exported for tests. */
export function normalizeAssistantContent(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lenient equality: strict for client-authored roles (the client sends the
 * same bytes both times); assistant content is compared normalized while
 * assistant tool_calls stay strict (ids anchor tool-result turns). */
function chatMessagesLenientEquivalent(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.role !== "assistant") return chatMessagesEquivalent(a, b);
  return (
    normalizeAssistantContent(a.content) === normalizeAssistantContent(b.content) &&
    toolCallsEqual(a.tool_calls, b.tool_calls)
  );
}

type PrefixQuality = "strict" | "lenient";

function classifyPrefix(mirror: ChatMessage[], incoming: ChatMessage[]): PrefixQuality | null {
  if (mirror.length >= incoming.length) return null;
  let strict = true;
  for (let i = 0; i < mirror.length; i++) {
    if (chatMessagesEquivalent(mirror[i], incoming[i])) continue;
    if (!chatMessagesLenientEquivalent(mirror[i], incoming[i])) return null;
    strict = false;
  }
  return strict ? "strict" : "lenient";
}

function deltaRespondable(delta: ChatMessage[]): boolean {
  const last = delta[delta.length - 1];
  return last !== undefined && (last.role === "user" || last.role === "tool");
}

/** Drop trailing assistant/system messages so the history ends with a
 * respondable message (regenerate semantics for clients that send a trailing
 * assistant turn). Empty result = nothing to answer. */
export function trimToRespondable(messages: ChatMessage[]): ChatMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role !== "user" && messages[end - 1].role !== "tool") end--;
  return messages.slice(0, end);
}

/**
 * Pick the open session whose mirror best matches the incoming history.
 * Strict prefixes beat lenient ones; then longest mirror wins (most
 * conversation reuse); ties go to the most recently used session. Returns
 * null when nothing matches — caller opens a new session and replays the full
 * history. Note `incoming.length <= mirror.length` never matches (a client
 * retry of an already-answered request is a miss by design: the session
 * transcript must stay append-only).
 */
export function matchSessionPrefix(
  candidates: AffinityCandidate[],
  incoming: ChatMessage[],
  model: string,
): AffinityMatch | null {
  let best: { cand: AffinityCandidate; quality: PrefixQuality } | null = null;
  for (const cand of candidates) {
    if (cand.model !== model) continue;
    const quality = classifyPrefix(cand.mirror, incoming);
    if (quality === null) continue;
    if (!deltaRespondable(incoming.slice(cand.mirror.length))) continue;
    if (
      best === null ||
      (quality === "strict" && best.quality === "lenient") ||
      (quality === best.quality &&
        (cand.mirror.length > best.cand.mirror.length ||
          (cand.mirror.length === best.cand.mirror.length && cand.lastUsedAt > best.cand.lastUsedAt)))
    ) {
      best = { cand, quality };
    }
  }
  if (!best) return null;
  return { sessionId: best.cand.sessionId, delta: incoming.slice(best.cand.mirror.length) };
}
