/**
 * buyer/src/ui/pages/TaskHistory.tsx — full lifecycle history for this buyer.
 *
 * Two data sources joined client-side:
 *   1. /v1/indexer/escrows — chain state of every lifecycle this buyer
 *      participated in (Open → Claimed → Submitted → Accepted/etc).
 *   2. /v1/responses        — buyer-app's persistent archive (request +
 *      response artefacts on disk + signed receipt + sha256 of response
 *      bytes pre-committed via the on-chain Submit tx).
 *
 * Match key: lifecycle's first row (the original PostEscrow output ref) ==
 * archive row's `escrow_ref`. Lifecycles that completed get inline response
 * rendering (audio player for TTS, JSON pretty-print for chat) plus a
 * Verify-hash button that computes sha256 over the response bytes and
 * compares to `receipt.response_hash`.
 *
 * The verify button only checks bytes-match-hash; it does NOT verify the
 * supplier's Ed25519 signature on the receipt. That requires fetching the
 * supplier's pub_key_hex from /capability and is deferred to a later
 * iteration of this page.
 */

import { useEffect, useState, useMemo } from "react";
import { useMarketplace } from "../state/MarketplaceContext.js";

interface IndexerEscrowRow {
  utxo_ref: string;
  buyer_pkh: string;
  supplier_pkh: string;
  advert_ref: string;
  capability_id: string;
  prompt_hash: string;
  payment_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
  posted_at: number;
  submitted_at: number | null;
  result_receipt_hash: string | null;
  state: string;
  created_slot: number;
}

interface ArchiveReceipt {
  prompt_hash: string;
  response_hash: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  wallclock_ms: number;
  supplier_pkh: string;
  escrow_ref: string;
}

interface ArchiveRow {
  escrow_ref: string;
  posted_at: number;
  completed_at: number;
  capability_id: string;
  supplier_pkh: string;
  model: string;
  payment_lovelace: string;
  response_content_type: string;
  response_byte_length: number;
  receipt: ArchiveReceipt;
  receipt_signature: string;
}

interface Lifecycle {
  posted_at: number;
  supplier_pkh: string;
  capability_id: string;
  payment_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
  advert_ref: string;
  prompt_hash: string;
  rows: IndexerEscrowRow[];
  currentState: string;
  /** archive entry keyed by the original PostEscrow utxo_ref. May be null
   *  for in-flight or pre-archive lifecycles. */
  archive: ArchiveRow | null;
}

const STATE_PRIORITY: Record<string, number> = {
  Open: 0,
  Claimed: 1,
  Submitted: 2,
  Accepted: 3,
  Reclaimed: 3,
  Released: 3,
};

function txHashFromRef(ref: string): string {
  const hash = ref.split("#")[0] ?? "";
  return hash.length >= 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

function fmtAda(lovelace: string): string {
  try {
    const n = BigInt(lovelace);
    const ada = Number(n) / 1_000_000;
    return `${ada.toFixed(2)} AP3X`;
  } catch {
    return lovelace;
  }
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return String(ms);
  }
}

function statePill(state: string): string {
  switch (state) {
    case "Accepted":  return "bg-green-100 text-green-800";
    case "Submitted": return "bg-indigo-100 text-indigo-800";
    case "Claimed":   return "bg-blue-100 text-blue-800";
    case "Open":      return "bg-yellow-100 text-yellow-800";
    case "Reclaimed": return "bg-orange-100 text-orange-800";
    case "Released":  return "bg-red-100 text-red-800";
    default:          return "bg-gray-200 text-gray-700";
  }
}

function refToUrlSafe(escrowRef: string): string {
  return escrowRef.replace("#", "_");
}

function groupByLifecycle(
  rows: IndexerEscrowRow[],
  archive: Map<string, ArchiveRow>,
): Lifecycle[] {
  const buckets = new Map<string, IndexerEscrowRow[]>();
  for (const r of rows) {
    const key = `${r.posted_at}:${r.supplier_pkh}`;
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }
  const out: Lifecycle[] = [];
  for (const [, lcRows] of buckets) {
    lcRows.sort((a, b) => a.created_slot - b.created_slot);
    const first = lcRows[0];          // original PostEscrow output ref — archive key
    const last = lcRows[lcRows.length - 1];
    const top = lcRows.reduce((acc, r) =>
      (STATE_PRIORITY[r.state] ?? 0) > (STATE_PRIORITY[acc.state] ?? 0) ? r : acc,
    last);
    out.push({
      posted_at: last.posted_at,
      supplier_pkh: last.supplier_pkh,
      capability_id: last.capability_id,
      payment_lovelace: last.payment_lovelace,
      buyer_bond_lovelace: last.buyer_bond_lovelace,
      supplier_bond_lovelace: last.supplier_bond_lovelace,
      advert_ref: last.advert_ref,
      prompt_hash: last.prompt_hash,
      rows: lcRows,
      currentState: top.state,
      archive: archive.get(first.utxo_ref) ?? null,
    });
  }
  out.sort((a, b) => b.posted_at - a.posted_at);
  return out;
}

// SubtleCrypto sha256 → 32-byte hex string.
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * For chat: receipt.response_hash = sha256_utf8(canonicalize({role:"assistant",
 * content: ...})). The archive's response.json contains EXACTLY those bytes
 * (the canonical form, not pretty-printed) so a sha256 over the file bytes
 * yields the same hex as the receipt.
 *
 * For TTS: receipt.response_hash = sha256(audio_bytes). The archive's
 * response.{mp3,wav,…} is the raw bytes.
 *
 * Either way, this function is a single sha256-over-bytes comparison.
 */
async function verifyResponseHash(
  escrowRef: string,
  expectedHash: string,
): Promise<{ ok: boolean; computed: string }> {
  const resp = await fetch(`/v1/responses/${refToUrlSafe(escrowRef)}/response`);
  if (!resp.ok) throw new Error(`fetch /response failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const computed = await sha256Hex(buf);
  return { ok: computed === expectedHash, computed };
}

export default function TaskHistory() {
  const marketplace = useMarketplace();
  const buyerPkh = marketplace.getWalletKey().pubKeyHash;
  const [rows, setRows] = useState<IndexerEscrowRow[] | null>(null);
  const [archive, setArchive] = useState<Map<string, ArchiveRow>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    if (!buyerPkh) {
      setError("buyer pkh missing — boot script not injected");
      setRows([]);
      return;
    }
    setError(null);
    try {
      const [escrowsResp, archResp] = await Promise.all([
        fetch(`/v1/indexer/escrows?buyer=${buyerPkh}`),
        fetch(`/v1/responses?limit=200`),
      ]);
      if (!escrowsResp.ok) {
        throw new Error(`indexer responded ${escrowsResp.status} ${escrowsResp.statusText}`);
      }
      const body = (await escrowsResp.json()) as IndexerEscrowRow[];
      setRows(Array.isArray(body) ? body : []);

      // Archive endpoint may be 503 if the buyer-app booted without
      // ARCHIVE_DIR — that's not fatal; we just render lifecycles
      // without inline response bodies.
      if (archResp.ok) {
        const archBody = (await archResp.json()) as { responses: ArchiveRow[] };
        const m = new Map<string, ArchiveRow>();
        for (const r of archBody.responses ?? []) m.set(r.escrow_ref, r);
        setArchive(m);
      } else {
        setArchive(new Map());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [buyerPkh]);

  const lifecycles = useMemo<Lifecycle[]>(
    () => (rows === null ? [] : groupByLifecycle(rows, archive)),
    [rows, archive],
  );

  return (
    <div className="space-y-4" data-testid="task-history-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-gray-300 bg-white px-3 py-1 text-sm hover:bg-gray-50"
          data-testid="task-history-refresh"
        >
          refresh
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
          Failed to load history: {error}
        </div>
      )}

      {rows === null ? (
        <p className="text-sm text-gray-500">loading…</p>
      ) : lifecycles.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="task-history-empty">
          No on-chain lifecycles yet for this buyer. Submit a prompt from the
          Dashboard to start one.
        </p>
      ) : (
        <ul className="space-y-3">
          {lifecycles.map((lc) => (
            <LifecycleCard key={`${lc.posted_at}:${lc.supplier_pkh}`} lc={lc} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LifecycleCard({ lc }: { lc: Lifecycle }): JSX.Element {
  return (
    <li data-testid="task-row" className="rounded-md bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div className="text-xs font-mono text-gray-500">
          {fmtTime(lc.posted_at)}
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${statePill(lc.currentState)}`}>
          {lc.currentState}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700 mb-2">
        <span className="font-medium">{lc.capability_id}</span>
        {lc.archive && (
          <>
            <span className="text-gray-500">·</span>
            <span className="text-xs text-gray-600">model: {lc.archive.model}</span>
          </>
        )}
        <span className="text-gray-500">·</span>
        <span>{fmtAda(lc.payment_lovelace)} payment</span>
        <span className="text-gray-500">·</span>
        <span>{fmtAda(lc.buyer_bond_lovelace)} bond</span>
        <span className="text-gray-500">·</span>
        <span className="font-mono text-xs text-gray-500">
          supplier {lc.supplier_pkh.slice(0, 12)}…
        </span>
      </div>

      {lc.archive && <ArchivePanel row={lc.archive} />}

      <div className="space-y-1 border-t border-gray-100 pt-2 mt-3">
        {lc.rows.map((r) => (
          <div key={r.utxo_ref} className="flex flex-wrap items-center gap-x-3 text-xs">
            <span className={`rounded px-1.5 py-0.5 font-medium ${statePill(r.state)}`}>{r.state}</span>
            <span className="font-mono text-gray-600">{txHashFromRef(r.utxo_ref)}</span>
            <span className="font-mono text-gray-400">slot {r.created_slot}</span>
          </div>
        ))}
      </div>
    </li>
  );
}

function ArchivePanel({ row }: { row: ArchiveRow }): JSX.Element {
  const isAudio = row.response_content_type.startsWith("audio/");
  const responseUrl = `/v1/responses/${refToUrlSafe(row.escrow_ref)}/response`;
  const requestUrl = `/v1/responses/${refToUrlSafe(row.escrow_ref)}/request`;

  const [requestText, setRequestText] = useState<string | null>(null);
  const [chatText, setChatText] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<
    | { state: "idle" }
    | { state: "running" }
    | { state: "ok"; computed: string }
    | { state: "mismatch"; computed: string; expected: string }
    | { state: "error"; message: string }
  >({ state: "idle" });

  // Always fetch the request envelope so we can display it above the response.
  // It's small JSON (chat messages array OR TTS body), no streaming worry.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(requestUrl);
        if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
        const text = await resp.text();
        if (!cancelled) setRequestText(text);
      } catch (err) {
        if (!cancelled) setRequestText(`(failed to load: ${err instanceof Error ? err.message : String(err)})`);
      }
    })();
    return () => { cancelled = true; };
  }, [requestUrl]);

  // For chat, fetch the JSON response so we can render the assistant text inline.
  // For audio, the <audio> element streams from the URL directly.
  useEffect(() => {
    if (isAudio) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(responseUrl);
        if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
        const text = await resp.text();
        if (!cancelled) setChatText(text);
      } catch (err) {
        if (!cancelled) setChatText(`(failed to load: ${err instanceof Error ? err.message : String(err)})`);
      }
    })();
    return () => { cancelled = true; };
  }, [responseUrl, isAudio]);

  const onVerify = async (): Promise<void> => {
    setVerifyResult({ state: "running" });
    try {
      const r = await verifyResponseHash(row.escrow_ref, row.receipt.response_hash);
      if (r.ok) setVerifyResult({ state: "ok", computed: r.computed });
      else setVerifyResult({ state: "mismatch", computed: r.computed, expected: row.receipt.response_hash });
    } catch (err) {
      setVerifyResult({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Try to extract a human-readable summary from the request JSON:
  // chat → first user message's content
  // tts  → the `text` field
  // anything else falls back to raw JSON
  const requestSummary = (() => {
    if (requestText === null) return null;
    try {
      const obj = JSON.parse(requestText) as {
        messages?: Array<{ role?: string; content?: string }>;
        text?: string;
        voice?: string;
        format?: string;
        speed?: number;
      };
      if (obj.messages && Array.isArray(obj.messages)) {
        const userMsg = obj.messages.find((m) => m?.role === "user") ?? obj.messages[0];
        return userMsg?.content ?? requestText;
      }
      if (typeof obj.text === "string") {
        const knobs = [obj.voice, obj.format, obj.speed != null ? `speed ${obj.speed}` : null]
          .filter(Boolean).join(" · ");
        return knobs ? `${obj.text}\n\n[ ${knobs} ]` : obj.text;
      }
      return requestText;
    } catch {
      return requestText;
    }
  })();

  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-3 mt-2 space-y-2" data-testid="archive-panel">
      {/* Request artefact (above response — chronological order) */}
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Request</div>
        {requestSummary === null ? (
          <p className="text-sm text-gray-500">loading…</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded bg-white p-2 text-sm text-gray-800 max-h-48 overflow-auto">
            {requestSummary}
          </pre>
        )}
      </div>

      {/* Response artefact */}
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Response</div>
        {isAudio ? (
          <audio controls src={responseUrl} className="w-full" />
        ) : chatText === null ? (
          <p className="text-sm text-gray-500">loading…</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded bg-white p-2 text-sm text-gray-800 max-h-64 overflow-auto">
            {(() => {
              try {
                const parsed = JSON.parse(chatText) as { content?: string };
                return parsed.content ?? chatText;
              } catch {
                return chatText;
              }
            })()}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600 mt-1">
          <span>{(row.response_byte_length / 1024).toFixed(1)} KB · {row.response_content_type}</span>
          <a
            href={responseUrl}
            download
            className="rounded bg-gray-700 px-2 py-0.5 text-white hover:bg-gray-800"
          >
            Download response
          </a>
          <a
            href={requestUrl}
            download
            className="rounded bg-gray-200 px-2 py-0.5 text-gray-700 hover:bg-gray-300"
          >
            Download request
          </a>
        </div>
      </div>

      {/* Receipt verification */}
      <div className="border-t border-gray-200 pt-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void onVerify()}
            disabled={verifyResult.state === "running"}
            className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:bg-gray-400"
            data-testid="archive-verify"
          >
            {verifyResult.state === "running" ? "Verifying…" : "Verify hash"}
          </button>
          {verifyResult.state === "ok" && (
            <span className="text-xs text-green-700">
              ✓ sha256 matches receipt.response_hash
            </span>
          )}
          {verifyResult.state === "mismatch" && (
            <span className="text-xs text-red-700">
              ✗ mismatch (computed {verifyResult.computed.slice(0, 12)}… vs expected {verifyResult.expected.slice(0, 12)}…)
            </span>
          )}
          {verifyResult.state === "error" && (
            <span className="text-xs text-red-700">error: {verifyResult.message}</span>
          )}
        </div>
        <details className="mt-2 text-xs text-gray-600">
          <summary className="cursor-pointer">Receipt + signature</summary>
          <pre className="mt-1 rounded bg-white p-2 font-mono text-[10px] overflow-auto">
            {JSON.stringify({ receipt: row.receipt, signature: row.receipt_signature }, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
