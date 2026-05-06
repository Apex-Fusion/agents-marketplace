/**
 * indexer-ui/src/api/sse.ts — SSE subscription with native EventSource auto-reconnect.
 *
 * SSE reconnect strategy decision (spec resolution, M1-F-5):
 *   We use the browser's native EventSource API. EventSource auto-reconnects
 *   per the SSE spec on transport drop. On reconnect the browser does NOT
 *   carry over our `?since_slot=N` query string, so callers (useSSE) track
 *   `lastSeenSlot` themselves and may close+reopen the EventSource on long
 *   disconnects to resume from the last-seen slot.
 *   We do NOT use Fetch+ReadableStream (manual reconnect) because EventSource
 *   is simpler and sufficient for a read-only dashboard.
 *
 * Each known event type is subscribed via addEventListener; we also listen
 * for the default `message` event in case the server emits without a type
 * (legacy / heartbeat replay).
 */

export interface ChainEvent {
  type: string;
  ref: string;
  slot: number;
  txHash?: string;
  address?: string;
}

export type SSECleanup = () => void;

const KNOWN_EVENT_TYPES = [
  "PostAdvert",
  "UpdateAdvert",
  "RetireAdvert",
  "PostEscrow",
  "ClaimEscrow",
  "SubmitEscrow",
  "AcceptEscrow",
  "ReclaimEscrow",
  "ReleaseEscrow",
  "sync-progress",
] as const;

/**
 * Subscribe to /events?stream=1 via EventSource.
 *
 * - When `initialSinceSlot` is provided, appends `&since_slot=<slot>` so the
 *   server replays buffered events from that slot.
 * - When `initialLimit` is provided, appends `&limit=<n>` so the server's
 *   replay is capped to the most recent N events. Use without `since_slot`
 *   to seed the UI with the last N historical events before the live stream.
 * - Returns a cleanup function that closes the EventSource.
 * - `onClose` is invoked when the EventSource fires `error` (browser will
 *   auto-reconnect; we surface the disconnect so the UI can show a state).
 */
export function subscribeToEvents(
  baseUrl: string,
  onEvent: (event: ChainEvent) => void,
  initialSinceSlot?: number,
  onClose?: () => void,
  initialLimit?: number,
): SSECleanup {
  const parts: string[] = ["stream=1"];
  if (initialSinceSlot != null) parts.push(`since_slot=${initialSinceSlot}`);
  if (initialLimit != null && initialLimit > 0) parts.push(`limit=${initialLimit}`);
  const qs = `?${parts.join("&")}`;
  const es = new EventSource(`${baseUrl}/events${qs}`);

  const handler = (typeFromListener: string) => (msg: MessageEvent) => {
    try {
      const parsed = JSON.parse(msg.data);
      // Server emits {type, ref, slot, ...} — but the addEventListener type
      // is the authoritative source. Normalize so callers always see `type`.
      const evt: ChainEvent = {
        type: typeof parsed.type === "string" ? parsed.type : typeFromListener,
        ref: typeof parsed.ref === "string" ? parsed.ref : "",
        slot: typeof parsed.slot === "number" ? parsed.slot : 0,
        txHash: typeof parsed.txHash === "string" ? parsed.txHash : undefined,
        address: typeof parsed.address === "string" ? parsed.address : undefined,
      };
      onEvent(evt);
    } catch {
      // Malformed payload — drop silently rather than crash the stream.
    }
  };

  for (const t of KNOWN_EVENT_TYPES) {
    es.addEventListener(t, handler(t));
  }
  es.addEventListener("message", handler("message"));

  es.onerror = (): void => {
    onClose?.();
  };

  return () => {
    es.close();
  };
}
