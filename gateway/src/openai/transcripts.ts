import { open, seal } from "../crypto/seal.js";
import type { GatewayDeps } from "../deps.js";
import type { SessionRow } from "../db/store.js";
import type { ResponseItem } from "@marketplace/shared/responses";
import { Mutex } from "../sdk/registry.js";

/** Operational mirror used while a marketplace chat session is open. */
export const transcripts = new Map<string, ResponseItem[]>();
const sessionLocks = new Map<string, Mutex>();

export function getSessionLock(sessionId: string): Mutex {
  let lock = sessionLocks.get(sessionId);
  if (!lock) {
    lock = new Mutex({ timeoutMs: 0 });
    sessionLocks.set(sessionId, lock);
  }
  return lock;
}

export function loadSessionTranscript(deps: GatewayDeps, session: SessionRow): ResponseItem[] {
  const cached = transcripts.get(session.id);
  if (cached) return cached;
  if (!session.transcript_nonce || !session.transcript_ct || !session.transcript_tag) {
    if (session.transcript_nonce === null && session.transcript_ct === null && session.transcript_tag === null) {
      deps.store.setSessionState(session.id, "invalid", Date.now());
      dropSessionState(session.id);
    }
    throw new Error(`active session ${session.id} has no persisted transcript`);
  }
  const decoded: unknown = JSON.parse(open({
    nonce: session.transcript_nonce,
    ct: session.transcript_ct,
    tag: session.transcript_tag,
  }, deps.config.masterKeyHex));
  if (!Array.isArray(decoded)) {
    throw new Error(`active session ${session.id} has an invalid persisted transcript`);
  }
  const transcript = decoded as ResponseItem[];
  transcripts.set(session.id, transcript);
  return transcript;
}

export function persistSessionTranscript(
  deps: GatewayDeps,
  sessionId: string,
  transcript: ResponseItem[],
): void {
  const encrypted = seal(JSON.stringify(transcript), deps.config.masterKeyHex);
  if (!deps.store.setSessionTranscript(sessionId, {
    transcript_nonce: encrypted.nonce,
    transcript_ct: encrypted.ct,
    transcript_tag: encrypted.tag,
  }, null)) {
    throw new Error(`session ${sessionId} closed while its transcript was being saved`);
  }
  transcripts.set(sessionId, transcript);
}

export function dropSessionState(sessionId: string): void {
  transcripts.delete(sessionId);
  sessionLocks.delete(sessionId);
}
