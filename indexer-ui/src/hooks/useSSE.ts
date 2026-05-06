/**
 * indexer-ui/src/hooks/useSSE.ts — subscribes to /events?stream=1, exposes append-only event[].
 *
 * Buffer is capped at MAX_EVENTS (500) to prevent unbounded memory growth on
 * long-running dashboards.
 *
 * Reconnect strategy:
 *   subscribeToEvents creates an EventSource which auto-reconnects on transport
 *   drop. The browser does NOT carry our `since_slot` query string across
 *   reconnects — the SSE spec uses Last-Event-ID, which we are not (yet) wiring
 *   into the server. We track `lastSeenSlot` here so a future enhancement can
 *   close+reopen the EventSource on long disconnects and resume from the right
 *   slot. For M1-F-5 the basic auto-reconnect is sufficient.
 *
 * Order: events are stored in chronological insertion order (oldest first).
 *   Components that want newest-first display reverse the array on render.
 */

import { useState, useEffect } from "react";
import { subscribeToEvents, type ChainEvent } from "../api/sse.js";

export const MAX_EVENTS = 500;

export interface UseSSEResult {
  events: ChainEvent[];
  lastSeenSlot: number | null;
  connected: boolean;
}

export interface UseSSEOptions {
  /** When set, the server seeds the stream with the most-recent N buffered
   * events (chronological ASC) before live events begin. */
  initialLimit?: number;
}

export function useSSE(baseUrl: string, opts?: UseSSEOptions): UseSSEResult {
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [lastSeenSlot, setLastSeenSlot] = useState<number | null>(null);
  const [connected, setConnected] = useState<boolean>(true);

  const initialLimit = opts?.initialLimit;

  useEffect(() => {
    const cleanup = subscribeToEvents(
      baseUrl,
      (evt) => {
        setEvents((prev) => {
          const next = [...prev, evt];
          // Cap from the front; preserve the most-recent MAX_EVENTS.
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
        if (typeof evt.slot === "number") {
          setLastSeenSlot((prev) => (prev == null || evt.slot > prev ? evt.slot : prev));
        }
        // A successful event implies the channel is live again.
        setConnected(true);
      },
      undefined,
      () => setConnected(false),
      initialLimit,
    );
    return cleanup;
    // baseUrl + initialLimit are the stable inputs; lastSeenSlot is
    // intentionally NOT a dep — see file header for the manual close+reopen
    // plan.
  }, [baseUrl, initialLimit]);

  return { events, lastSeenSlot, connected };
}
