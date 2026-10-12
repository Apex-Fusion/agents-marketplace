/** Node 20 can collect timeout sources composed with AbortSignal.any. Keep a
 * strong controller in the timer and explicitly release the parent listener. */
export function requestDeadline(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); },
  };
}
