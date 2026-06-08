/**
 * buyer/src/ui/components/ChatForm.tsx — capability form for `llm.chat.v1`
 * (multi-turn chat sessions).
 *
 * Two modes, controlled by whether `advertRef` is provided (mirrors
 * PiperTTSForm's demo-vs-marketplace split):
 *
 *   - **Demo mode** (no advertRef): the synthetic "Kimi K2.6 (demo)" tile.
 *     No escrow, no payment, no Start/End. Every turn streams straight from
 *     OpenRouter via /v1/chat-demo/message. Fully concurrent + free.
 *
 *   - **Marketplace mode** (advertRef + payment_lovelace): the paid chat type.
 *     "Start chat" opens the escrow (POST /v1/chat/start → PostEscrow + supplier
 *     Claim). Turns stream off-chain via /v1/chat/message (zero chain per turn).
 *     "End chat" settles (POST /v1/chat/end → supplier Submit + buyer Accept),
 *     which is when the user is actually charged.
 *
 * Both paths stream a uniform SSE wire format over fetch+ReadableStream:
 *   data: {"type":"token","value":"<delta>"}\n\n
 *   data: {"type":"done"}\n\n
 *   data: {"type":"error","message":"…"}\n\n
 */

import { useEffect, useRef, useState } from "react";
import type { OutputReference } from "@marketplace/shared/chain";

export interface ChatFormProps {
  /** When set, runs the paid marketplace lifecycle; when undefined, demo mode. */
  advertRef?: OutputReference;
  /** Required iff advertRef is set; matches the supplier's advertised price. */
  payment_lovelace?: bigint;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface Session {
  escrowRef: string;
  sessionNonce: string;
}

function ap3x(lovelace: bigint | string): string {
  return (Number(lovelace) / 1e6).toFixed(2);
}

/** Stream a uniform SSE response, invoking onToken per content delta.
 * Resolves when the `done` frame arrives; rejects on `error` frame or
 * transport failure. */
async function streamChat(
  url: string,
  body: unknown,
  onToken: (delta: string) => void,
): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    let msg = `${resp.status} ${resp.statusText}`;
    try {
      const j = (await resp.json()) as { error?: string; message?: string };
      if (j.error || j.message) msg = `${j.error ?? "error"}: ${j.message ?? ""}`;
    } catch { /* keep status fallback */ }
    throw new Error(msg);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleFrame = (payload: string): boolean => {
    const trimmed = payload.trim();
    if (trimmed.length === 0) return false;
    let frame: { type?: string; value?: string; message?: string };
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (frame.type === "token" && typeof frame.value === "string") {
      onToken(frame.value);
    } else if (frame.type === "done") {
      return true;
    } else if (frame.type === "error") {
      throw new Error(frame.message ?? "stream error");
    }
    return false;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIdx: number;
    while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:") && handleFrame(line.slice(5))) return;
      }
    }
  }
}

/** Animated "Thinking …" placeholder shown while waiting for the model's
 * first token (the assistant bubble exists but no content has streamed yet). */
function ThinkingDots(): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-gray-500" data-testid="chat-thinking">
      Thinking
      <span className="inline-flex items-end gap-0.5 pb-0.5">
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
    </span>
  );
}

export default function ChatForm({ advertRef, payment_lovelace }: ChatFormProps = {}): JSX.Element {
  const isPaid = advertRef !== undefined && payment_lovelace !== undefined;
  const advertRefStr = advertRef ? `${advertRef.txHash}#${advertRef.index}` : null;

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null); // in-progress assistant text
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Paid-only session + finalization state.
  const [session, setSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [charged, setCharged] = useState<string | null>(null);
  // Live supplier availability (paid mode): null = unknown/checking, true = free, false = busy/offline.
  const [available, setAvailable] = useState<boolean | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  const active = isPaid ? session !== null && charged === null : true;

  // Poll the supplier's status while the Start button is showing, so a second
  // user can't start a chat while one is already active. The supplier is
  // single-slot (status "working" between Claim and Submit); we disable Start
  // until it's "free" again. (startChat also does an authoritative pre-flight
  // /status check, so this is the UX layer over that guard.)
  useEffect(() => {
    if (!isPaid || !advertRefStr || session !== null || charged !== null) return;
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const r = await fetch("/v1/indexer/suppliers?capability_id=llm.chat.v1");
        if (!r.ok) throw new Error(String(r.status));
        const rows = (await r.json()) as Array<{ utxo_ref: string; status: string }>;
        const row = rows.find((x) => x.utxo_ref === advertRefStr);
        // Unknown (row missing / indexer hiccup) → null, which does NOT hard-block
        // (the pre-flight check still guards funds); only an explicit non-free
        // status disables the button.
        if (!cancelled) setAvailable(row ? row.status === "free" : null);
      } catch {
        if (!cancelled) setAvailable(null);
      }
    };
    void check();
    const id = setInterval(check, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isPaid, advertRefStr, session, charged]);

  async function startChat(): Promise<void> {
    if (!advertRef || payment_lovelace === undefined) return;
    setStarting(true);
    setError(null);
    try {
      const resp = await fetch("/v1/chat/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          advert_ref: `${advertRef.txHash}#${advertRef.index}`,
          payment_lovelace: payment_lovelace.toString(),
        }),
      });
      if (!resp.ok) {
        let msg = `${resp.status} ${resp.statusText}`;
        try {
          const j = (await resp.json()) as { error?: string; message?: string };
          if (resp.status === 409) msg = "Supplier is busy with another chat — try again shortly.";
          else if (j.error || j.message) msg = `${j.error ?? "error"}: ${j.message ?? ""}`;
        } catch { /* keep fallback */ }
        throw new Error(msg);
      }
      const j = (await resp.json()) as { escrow_ref: string; session_nonce: string };
      setSession({ escrowRef: j.escrow_ref, sessionNonce: j.session_nonce });
      setTurns([]);
      setCharged(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function sendMessage(): Promise<void> {
    const content = input.trim();
    if (content.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    const nextTurns: ChatTurn[] = [...turns, { role: "user", content }];
    setTurns(nextTurns);
    setStreaming("");
    let acc = "";
    try {
      if (isPaid) {
        const s = sessionRef.current;
        if (!s) throw new Error("no active chat session");
        await streamChat(
          "/v1/chat/message",
          { escrow_ref: s.escrowRef, content },
          (delta) => { acc += delta; setStreaming(acc); },
        );
      } else {
        // Demo: send the full running transcript (no server-side state).
        const demoMessages = nextTurns.map((t) => ({ role: t.role, content: t.content }));
        await streamChat(
          "/v1/chat-demo/message",
          { messages: demoMessages },
          (delta) => { acc += delta; setStreaming(acc); },
        );
      }
      setTurns([...nextTurns, { role: "assistant", content: acc }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep the user's turn but drop the half-streamed assistant bubble.
    } finally {
      setStreaming(null);
      setBusy(false);
    }
  }

  async function endChat(): Promise<void> {
    const s = sessionRef.current;
    if (!s) return;
    setEnding(true);
    setError(null);
    try {
      const resp = await fetch("/v1/chat/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          escrow_ref: s.escrowRef,
          session_nonce: s.sessionNonce,
          transcript: turns,
        }),
      });
      if (!resp.ok) {
        let msg = `${resp.status} ${resp.statusText}`;
        try {
          const j = (await resp.json()) as { error?: string; message?: string };
          if (j.error || j.message) msg = `${j.error ?? "error"}: ${j.message ?? ""}`;
        } catch { /* keep fallback */ }
        throw new Error(msg);
      }
      setCharged(payment_lovelace !== undefined ? ap3x(payment_lovelace) : "0");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnding(false);
    }
  }

  return (
    <div className="space-y-4 rounded border border-gray-200 bg-white p-4" data-testid="chat-form">
      {isPaid && session === null && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={startChat}
            disabled={starting || available === false}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-400"
            data-testid="chat-start"
          >
            {starting
              ? "Opening escrow…"
              : available === false
                ? "Supplier busy"
                : "Start chat"}
          </button>
          {available === false && (
            <p className="text-sm text-amber-700" data-testid="chat-busy">
              Another chat is in progress on this supplier. The button re-enables when it ends.
            </p>
          )}
        </div>
      )}

      {(active || streaming !== null || turns.length > 0) && (
        <div className="space-y-3">
          <div className="max-h-96 space-y-2 overflow-auto" data-testid="chat-transcript">
            {turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "text-right" : "text-left"}>
                <span
                  className={
                    "inline-block max-w-[85%] whitespace-pre-wrap rounded px-3 py-2 text-sm " +
                    (t.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-900")
                  }
                >
                  {t.content}
                </span>
              </div>
            ))}
            {streaming !== null && (
              <div className="text-left">
                <span className="inline-block max-w-[85%] whitespace-pre-wrap rounded bg-gray-100 px-3 py-2 text-sm text-gray-900">
                  {streaming.length > 0 ? streaming : <ThinkingDots />}
                </span>
              </div>
            )}
          </div>

          {active && (
            <form
              onSubmit={(e) => { e.preventDefault(); void sendMessage(); }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message…"
                disabled={busy}
                className="flex-1 rounded border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none"
                data-testid="chat-input"
              />
              <button
                type="submit"
                disabled={busy || input.trim().length === 0}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-400"
                data-testid="chat-send"
              >
                {busy ? "…" : "Send"}
              </button>
            </form>
          )}

          {isPaid && active && (
            <button
              type="button"
              onClick={endChat}
              disabled={ending || busy}
              className="rounded bg-gray-700 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-400"
              data-testid="chat-end"
            >
              {ending ? "Finalizing payment…" : "End chat"}
            </button>
          )}
        </div>
      )}

      {charged !== null && (
        <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700" data-testid="chat-charged">
          Chat ended — charged {charged} AP3X, bond refunded.
        </div>
      )}

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700" data-testid="chat-error">
          {error}
        </div>
      )}
    </div>
  );
}
