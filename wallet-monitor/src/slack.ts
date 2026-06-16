/**
 * wallet-monitor/src/slack.ts — post a message to a Slack Incoming Webhook.
 *
 * Never throws: returns { ok, error } so the caller can decide whether to
 * advance the dedup state. A failed post leaves state untouched so the alert
 * retries on the next run.
 */

export interface SlackResult {
  ok: boolean;
  error?: string;
}

const TIMEOUT_MS = 15_000;

export async function postSlack(
  webhookUrl: string,
  text: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<SlackResult> {
  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(TIMEOUT_MS);
    }
    const res = await fetchImpl(webhookUrl, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Slack HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
