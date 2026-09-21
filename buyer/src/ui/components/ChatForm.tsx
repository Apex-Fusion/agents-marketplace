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
 * Both paths consume canonical OpenAI Responses SSE events. Incremental text
 * is display-only. The terminal Response object supplies the exact Items kept
 * in the local transcript and later committed by the session receipt.
 */

import { useEffect, useRef, useState } from "react";
import type { OutputReference } from "@marketplace/shared/chain";
import {
  normalizeResponseOutput,
  readResponseEvents,
  type ResponseItem,
  type ResponseObject,
} from "@marketplace/shared/responses";

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

function itemText(item: ResponseItem): string {
  if (item.type !== "message") return "";
  return item.content.map((part) =>
    part.type === "refusal" ? part.refusal : part.text
  ).join("");
}

function displayTurns(transcript: readonly ResponseItem[]): ChatTurn[] {
  return transcript.flatMap((item) => {
    if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) {
      return [];
    }
    return [{ role: item.role, content: itemText(item) }];
  });
}

/** Consume canonical Responses SSE. The terminal object is authoritative. */
async function streamChat(
  url: string,
  body: unknown,
  onDelta: (delta: string) => void,
): Promise<ResponseObject> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    let message = `${resp.status} ${resp.statusText}`;
    try {
      const errorBody: unknown = await resp.json();
      if (errorBody && typeof errorBody === "object") {
        if ("message" in errorBody && typeof errorBody.message === "string") {
          message = errorBody.message;
        } else if ("error" in errorBody && typeof errorBody.error === "string") {
          message = errorBody.error;
        }
      }
    } catch {
      /* Keep the HTTP status. */
    }
    throw new Error(message);
  }

  let terminal: ResponseObject | null = null;
  for await (const event of readResponseEvents(resp.body)) {
    if (
      (event.type === "response.output_text.delta" ||
        event.type === "response.refusal.delta") &&
      typeof event.delta === "string"
    ) {
      onDelta(event.delta);
    }
    if (
      event.type !== "response.completed" &&
      event.type !== "response.incomplete" &&
      event.type !== "response.failed"
    ) {
      continue;
    }
    const candidate = event.response;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("terminal stream event is missing its response object");
    }
    const response = candidate as Record<string, unknown>;
    const output = normalizeResponseOutput(response.output);
    const status = response.status;
    const expectedStatus = event.type === "response.completed"
      ? "completed"
      : event.type === "response.incomplete"
        ? "incomplete"
        : "failed";
    const usage = response.usage;
    const usageValid = usage === null || (
      typeof usage === "object" &&
      !Array.isArray(usage) &&
      "input_tokens" in usage &&
      typeof usage.input_tokens === "number" &&
      "output_tokens" in usage &&
      typeof usage.output_tokens === "number" &&
      "total_tokens" in usage &&
      typeof usage.total_tokens === "number"
    );
    const errorValid = response.error === null || (
      typeof response.error === "object" && !Array.isArray(response.error)
    );
    const incompleteDetails = response.incomplete_details;
    const incompleteValid = status === "incomplete"
      ? (
          incompleteDetails !== null &&
          typeof incompleteDetails === "object" &&
          !Array.isArray(incompleteDetails) &&
          "reason" in incompleteDetails &&
          typeof incompleteDetails.reason === "string"
        )
      : incompleteDetails === null;
    if (
      response.object !== "response" ||
      typeof response.id !== "string" ||
      typeof response.created_at !== "number" ||
      typeof response.model !== "string" ||
      status !== expectedStatus ||
      !usageValid ||
      !errorValid ||
      !incompleteValid
    ) {
      throw new Error("terminal stream event contains an invalid response object");
    }
    const parsedResponse = { ...response, status, output } as ResponseObject;
    terminal = parsedResponse;
  }
  if (!terminal) throw new Error("response stream ended without a terminal event");
  return terminal;
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

  const [transcript, setTranscript] = useState<ResponseItem[]>([]);
  const turns = displayTurns(transcript);
  const [streaming, setStreaming] = useState<string | null>(null);
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
      setTranscript([]);
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
    const userItem: ResponseItem = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: content }],
    };
    const nextTranscript = [...transcript, userItem];
    setTranscript(nextTranscript);
    setStreaming("");
    let streamedText = "";
    try {
      const requestBody = isPaid
        ? {
            escrow_ref: sessionRef.current?.escrowRef,
            input: [userItem],
          }
        : { input: nextTranscript };
      if (isPaid && !sessionRef.current) throw new Error("no active chat session");
      const terminal = await streamChat(
        isPaid ? "/v1/chat/message" : "/v1/chat-demo/message",
        requestBody,
        (delta) => {
          streamedText += delta;
          setStreaming(streamedText);
        },
      );
      // Never synthesize the transcript from deltas. Keep exact terminal Items
      // so continuation and the settlement receipt share identical bytes.
      if (terminal.status === "failed") {
        setTranscript(isPaid ? transcript : [...nextTranscript, ...terminal.output]);
        setError(
          `Response failed: ${terminal.error ? JSON.stringify(terminal.error) : "unknown error"}`,
        );
      } else {
        setTranscript([...nextTranscript, ...terminal.output]);
        if (terminal.status === "incomplete") {
          setError(
            `Response incomplete: ${terminal.incomplete_details?.reason ?? "unknown reason"}`,
          );
        }
      }
    } catch (err) {
      setTranscript(transcript);
      setError(err instanceof Error ? err.message : String(err));
      // Failed supplier turns roll back their input. Mirror that rollback.
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
          transcript,
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
      let endBody: { settle_mode?: string } = {};
      try {
        endBody = (await resp.json()) as { settle_mode?: string };
      } catch { /* older buyer-app responses stay full-settle */ }
      // Ticket sessions never charge — the escrow returns via reclaim.
      setCharged(
        endBody.settle_mode === "ticket"
          ? "0 (ticket session — escrow reclaimed)"
          : payment_lovelace !== undefined
            ? ap3x(payment_lovelace)
            : "0",
      );
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
