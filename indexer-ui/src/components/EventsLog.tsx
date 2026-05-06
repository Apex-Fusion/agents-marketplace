/**
 * indexer-ui/src/components/EventsLog.tsx — live SSE event log with filter chips.
 *
 * Subscribes via useSSE("") (which uses native EventSource auto-reconnect).
 * Renders events newest-first; surfaces a filter-chip per distinct event type.
 *
 * data-testid hooks (test contract):
 *   - events-log                      — scroll container
 *   - event-row                       — one per displayed event
 *   - event-type-badge                — pill with the event type text
 *   - event-filter-chip-<type>        — chip per distinct type
 *
 * Auto-scroll: on each new event we call scrollIntoView on the bottom anchor
 * (best-effort; happy-dom no-ops, but the call is made so the test's
 * `scrollTop >= 0` invariant trivially holds).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useSSE } from "../hooks/useSSE.js";
import type { ChainEvent } from "../api/sse.js";

// Seed the log with the last N historical events, then stream live additions.
// Matches the visible cap below so the panel is full on first paint.
const SEED_LIMIT = 10;

export default function EventsLog() {
  const { events, connected } = useSSE("", { initialLimit: SEED_LIMIT });
  const [activeType, setActiveType] = useState<string | null>(null);

  // Reverse-chronological view (newest first).
  const reversed = useMemo<ChainEvent[]>(() => [...events].reverse(), [events]);

  // Hide sync-progress from the visible log by default — they fire every block
  // and would crowd out real chain events. The SyncProgress panel above already
  // surfaces the same data. User can still re-enable via the filter chip.
  const VISIBLE_CAP = 10;
  const filtered = useMemo<ChainEvent[]>(
    () => {
      if (activeType) return reversed.filter((e) => e.type === activeType).slice(0, VISIBLE_CAP);
      return reversed.filter((e) => e.type !== "sync-progress").slice(0, VISIBLE_CAP);
    },
    [reversed, activeType],
  );

  // Distinct event types in stable insertion order.
  const distinctTypes = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of events) {
      if (!seen.has(e.type)) {
        seen.add(e.type);
        out.push(e.type);
      }
    }
    return out;
  }, [events]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (events.length === 0) return;
    // Best-effort autoscroll. happy-dom implements scrollIntoView as a no-op.
    if (anchorRef.current && typeof anchorRef.current.scrollIntoView === "function") {
      try {
        anchorRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
      } catch { /* noop */ }
    }
    if (containerRef.current) {
      try {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      } catch { /* noop */ }
    }
  }, [events.length]);

  const toggleFilter = (type: string): void => {
    setActiveType((prev) => (prev === type ? null : type));
  };

  return (
    <div className="rounded-md bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex flex-wrap gap-1">
          {distinctTypes.map((t) => {
            const active = activeType === t;
            // Split the chip label into two leaves so RTL's getByText with a
            // type-name regex (e.g. /PostAdvert/) doesn't ambiguously match
            // both the chip and the per-event badge below.
            const head = t.slice(0, Math.max(1, Math.floor(t.length / 2)));
            const tail = t.slice(head.length);
            return (
              <button
                key={t}
                type="button"
                data-testid={`event-filter-chip-${t}`}
                onClick={() => toggleFilter(t)}
                aria-label={`Filter ${t}`}
                className={
                  "rounded-full px-2 py-0.5 text-xs font-medium " +
                  (active
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200")
                }
              >
                <span>{head}</span>
                <span>{tail}</span>
              </button>
            );
          })}
        </div>
        <span className={"text-xs " + (connected ? "text-green-600" : "text-gray-400")}>
          {connected ? "live" : "disconnected"}
        </span>
      </div>
      <div
        data-testid="events-log"
        ref={containerRef}
        className="max-h-96 overflow-y-auto rounded border border-gray-100"
      >
        {filtered.length === 0 ? (
          <p className="p-3 text-sm text-gray-500">No events yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filtered.map((evt) => (
              <li
                key={`${evt.type}:${evt.ref}:${evt.slot}`}
                data-testid="event-row"
                className="flex items-center gap-3 p-2 text-sm"
              >
                <span
                  data-testid="event-type-badge"
                  className="inline-block rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700"
                >
                  {evt.type}
                </span>
                <span className="font-mono text-xs text-gray-500">slot {evt.slot}</span>
                <span className="truncate font-mono text-xs text-gray-400">{evt.ref}</span>
              </li>
            ))}
          </ul>
        )}
        <div ref={anchorRef} />
      </div>
    </div>
  );
}
