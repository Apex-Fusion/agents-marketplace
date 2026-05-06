/**
 * indexer-ui/src/hooks/usePolling.ts — generic polling hook.
 *
 * Strategy decision (M1-F-5):
 *   Uses the *real* setInterval / clearInterval so that tests can drive it via
 *   `vi.useFakeTimers() + vi.advanceTimersByTime(N)`. Components must call
 *   `usePolling(fetchFn, intervalMs)` directly — DO NOT mock usePolling from
 *   inside components, because the sync-progress test stubs `fetch` and relies
 *   on the real interval to fire.
 *
 * Behaviour:
 *   - Calls fetchFn() immediately on mount.
 *   - Calls fetchFn() every intervalMs after that.
 *   - On error: keeps `data` stable (last good value), populates `error`.
 *   - On unmount: clears the interval and ignores in-flight fetch results.
 *
 * Why we ref-stash `fetchFn`:
 *   Components typically pass an inline arrow `() => fetchHealthz()`. That ref
 *   changes every render. If we put fetchFn in the effect deps, every poll
 *   completion (which calls setState) re-runs the effect → tears down the
 *   interval and starts another → infinite loop. Stashing in a ref decouples
 *   identity from interval lifetime; only `intervalMs` controls restart.
 */

import { useState, useEffect, useRef } from "react";

export interface UsePollingResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

export function usePolling<T>(
  fetchFn: () => Promise<T>,
  intervalMs: number,
): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  useEffect(() => {
    let mounted = true;

    const run = async (): Promise<void> => {
      try {
        const result = await fetchFnRef.current();
        if (!mounted) return;
        setData(result);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      }
    };

    run();
    const id = setInterval(run, intervalMs);

    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { data, error, loading };
}
