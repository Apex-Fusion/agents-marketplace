/**
 * gateway/src/openai/transcripts.ts — in-memory per-session state shared by
 * the session routes (sessions.ts), the demo affinity executor (demoChat.ts)
 * and the sweeper's housekeeping.
 *
 * transcripts: mirror of each open session's transcript (sessionId → messages).
 *   Kept hash-identical to the supplier's authoritative transcript (endChat's
 *   response_hash check). Lost on restart — abandoned sessions are recovered
 *   by the supplier idle watchdog + gateway sweeper.
 * sessionLocks: per-session Mutex serializing turns on ONE session (concurrent
 *   turns would interleave supplier transcript appends). Distinct from the
 *   per-key Mutex, which only serializes on-chain wallet work.
 */

import type { ChatMessage } from "@marketplace/shared/tx";
import { Mutex } from "../sdk/registry.js";

export const transcripts = new Map<string, ChatMessage[]>();

const sessionLocks = new Map<string, Mutex>();

export function getSessionLock(sessionId: string): Mutex {
  let lock = sessionLocks.get(sessionId);
  if (!lock) {
    lock = new Mutex();
    sessionLocks.set(sessionId, lock);
  }
  return lock;
}

/** Forget all in-memory state for a session (closed/gone). */
export function dropSessionState(sessionId: string): void {
  transcripts.delete(sessionId);
  sessionLocks.delete(sessionId);
}
