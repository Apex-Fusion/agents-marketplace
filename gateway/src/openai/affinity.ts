/**
 * gateway/src/openai/affinity.ts — transcript-prefix session matching.
 *
 * Stateless OpenAI clients resend the FULL message history each call; sessions
 * are stateful. An incoming request belongs to an open session when that
 * session's mirrored transcript is a strict prefix of the incoming messages —
 * the suffix (delta) is the next turn. Agentic tool loops extend the
 * transcript monotonically, so affinity hits nearly always; history divergence
 * (IDE compaction, regenerate, retry) just misses and costs one new session.
 *
 * Pure module — no I/O — so the matching rules are unit-testable.
 */

import { chatMessagesEquivalent, type ChatMessage } from "@marketplace/shared/tx";

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

function isPrefix(mirror: ChatMessage[], incoming: ChatMessage[]): boolean {
  if (mirror.length >= incoming.length) return false;
  return mirror.every((m, i) => chatMessagesEquivalent(m, incoming[i]));
}

function deltaRespondable(delta: ChatMessage[]): boolean {
  const last = delta[delta.length - 1];
  return last !== undefined && (last.role === "user" || last.role === "tool");
}

/**
 * Pick the open session whose mirror best matches the incoming history.
 * Longest mirror wins (most conversation reuse); ties go to the most recently
 * used session. Returns null when nothing matches — caller opens a new
 * session and replays the full history. Note `incoming.length <= mirror.length`
 * never matches (a client retry of an already-answered request is a miss by
 * design: the session transcript must stay append-only).
 */
export function matchSessionPrefix(
  candidates: AffinityCandidate[],
  incoming: ChatMessage[],
  model: string,
): AffinityMatch | null {
  let best: AffinityCandidate | null = null;
  for (const cand of candidates) {
    if (cand.model !== model) continue;
    if (!isPrefix(cand.mirror, incoming)) continue;
    if (!deltaRespondable(incoming.slice(cand.mirror.length))) continue;
    if (
      best === null ||
      cand.mirror.length > best.mirror.length ||
      (cand.mirror.length === best.mirror.length && cand.lastUsedAt > best.lastUsedAt)
    ) {
      best = cand;
    }
  }
  if (!best) return null;
  return { sessionId: best.sessionId, delta: incoming.slice(best.mirror.length) };
}
