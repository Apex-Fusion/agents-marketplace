/**
 * buyer/src/ui/pages/Disputes.tsx — Module-1 dispute resolution.
 *
 * Explains the Module-1 process, lists the dispute cases from the indexer
 * (GET /v1/indexer/disputes; 404 = an indexer without dispute data), draws
 * the escrow job paths and opens any did:vector in /agents/:id.
 *
 * The list is paged. The page asks for the newest 25 cases (`limit=25`) and
 * "Show 25 more" raises the limit by 25, up to 200 (the largest page of the
 * indexer). The indexer also gives `total`, the number of all cases. An older
 * indexer gives none, and then the page shows no count and no button.
 *
 * The jury decides each challenge (Module-1/jury/SPEC.md). The Foundation
 * relay signs the Module-1 resolution with the jury result. A case card shows
 * the canonical jury case of the challenge (`jury` of the indexer case): the
 * windows, the rule, the tally, the result and each juror with its vote and
 * its record.
 *
 * Documents. A datum holds a URI and the blake2b-256 of the document:
 *   - `vector-tx:<base64url transaction id>`: the document is in the metadata
 *     (label 22084) of that transaction; the page reads it from the indexer
 *     (GET /v1/indexer/documents/<tx>);
 *   - a URI on this site: the page reads it same-origin.
 * The page computes blake2b-256 of the exact bytes and compares it with the
 * hash on chain. It reads and checks the juror records (in the reveal
 * transactions) and the resolution document (in the OracleResolve
 * transaction) in the same way.
 *
 * A case card is a details element. Its body (the documents and the jury)
 * mounts only while the card is open, so a collapsed card makes no request. A
 * case that is not resolved starts open. A resolved case starts collapsed.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  AgentLink,
  EffectivePill,
  HEX64_RE,
  TxLink,
  ap3x,
  getJson,
  shortDid,
  useSummaries,
  utc,
  type IdentitySummary,
} from "../components/IdentityBits.js";

type Fields = Record<string, string | number | null | undefined>;

interface ChainStep {
  tx?: string | null;
  slot?: number | null;
  time?: string | null;
}

/** A transaction in a block (indexer jury view). */
interface TxPoint extends ChainStep {
  height?: number | null;
}

/** One ballot of a jury case. */
export interface JuryBallot {
  agent_id?: string | null;
  juror?: string | null;
  status?: string | null;
  vote?: string | null;
  committed?: TxPoint | null;
  revealed?: TxPoint | null;
  record_hash?: string | null;
  /** Where the record is (SPEC §10.4): reveal, separate (overflow) or missing. */
  record_status?: string | null;
  /** The record found by record_hash: its transaction. */
  record?: { tx?: string | null } | null;
  slashed?: TxPoint | null;
}

/** The canonical jury case of a dispute (indexer `jury`). Every field may be missing. */
export interface JuryCase {
  deployment?: string | null;
  case?: string | null;
  deadline?: string | null;
  commit_end?: string | null;
  reveal_end?: string | null;
  window?: string | null;
  state?: string | null;
  rule?: { quorum?: number | null; majority_num?: number | null; majority_den?: number | null } | null;
  ballots?: JuryBallot[] | null;
  tally?: Record<string, number | null | undefined> | null;
  revealed?: number | null;
  result?: string | null;
  opened?: TxPoint | null;
  finalized?: (TxPoint & { result?: string | null }) | null;
  closed?: TxPoint | null;
}

/** One case of GET /v1/indexer/disputes. Every field may be missing. */
export interface DisputeCase {
  claim_ref?: string | null;
  claimer_agent_id?: string | null;
  status?: string | null;
  claim?: (ChainStep & {
    stake_lovelace?: string | null;
    challenge_deadline?: string | null;
    text?: string | null;
    fields?: Fields | null;
  }) | null;
  challenge?: (ChainStep & {
    auditor_agent_id?: string | null;
    /** The challenge output is genuine (jury SPEC §11.1). */
    genuine?: boolean | null;
    stake_lovelace?: string | null;
    text?: string | null;
    fields?: Fields | null;
  }) | null;
  resolution?: (ChainStep & { outcome?: string | null; reasoning_hash?: string | null }) | null;
  verdict?: {
    ref?: string | null;
    action?: string | null;
    duration_ms?: number | null;
    expires_at?: string | null;
    applied_tx?: string | null;
    applied_time?: string | null;
  } | null;
  jury?: JuryCase | null;
  /** The document in the metadata of the resolution transaction (indexer summary). */
  resolution_document?: { tx?: string | null } | null;
}

type Obj = Record<string, unknown>;

const SITE_PREFIX = "https://marketplace.vector.apexfusion.org/";
const VECTOR_TX_PREFIX = "vector-tx:";
const LEGACY_DID_RE = /^did:vector:agent:[0-9a-f]{56}:[0-9a-f]{64}$/;
const DID_RE = /^did:vector:([0-9a-f]{64})$/;
const HEX_BYTES_RE = /^(?:[0-9a-f]{2})*$/;
const DAY_MS = 86_400_000;
const VOTE_TONE: Record<string, "green" | "red" | "gray"> = { ClaimerWins: "green", AuditorWins: "red", Inconclusive: "gray" };
/** Cases that the page asks for first and that "Show more" adds. */
const PAGE_SIZE = 25;
/** The largest page that the indexer gives (GET /disputes?limit=). */
const MAX_LIMIT = 200;

/** What `useDisputes` returns, besides `showMore`. */
interface DisputeList {
  cases: DisputeCase[];
  note: string | null;
  loading: boolean;
  /** The number of cases that the indexer has (those of the agent, with `agentId`); null when it does not say. */
  total: number | null;
}

/**
 * Cases of all agents, or of one agent (claimer or auditor); refreshes every 15 s.
 * Without `pageSize` it asks for all cases. With `pageSize` it asks for the newest `pageSize` cases.
 * `showMore` raises the limit by `pageSize`, up to MAX_LIMIT, and the refresh keeps the new limit.
 * `showMore` is null when there is nothing to raise.
 */
export function useDisputes(agentId?: string, pageSize?: number): DisputeList & { showMore: (() => void) | null } {
  const [state, setState] = useState<DisputeList>({ cases: [], note: null, loading: true, total: null });
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (agentId) params.set("agent_id", agentId);
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.toString();
    const url = query === "" ? "/v1/indexer/disputes" : `/v1/indexer/disputes?${query}`;
    const load = (): void => {
      getJson(url)
        .then(({ status, body }) => {
          if (cancelled) return;
          if (status === 404) {
            setState({ cases: [], note: "No dispute data yet", loading: false, total: null });
            return;
          }
          if (status !== 200) {
            setState((prev) => ({ ...prev, note: `Dispute data is unavailable (HTTP ${status}).`, loading: false }));
            return;
          }
          const raw = typeof body === "object" && body !== null && "cases" in body ? body.cases : undefined;
          const cases = Array.isArray(raw)
            ? raw.filter((c): c is DisputeCase => typeof c === "object" && c !== null)
            : [];
          const count = typeof body === "object" && body !== null && "total" in body ? body.total : undefined;
          const total = typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
          setState({ cases, note: null, loading: false, total });
        })
        .catch(() => {
          if (!cancelled) setState((prev) => ({ ...prev, note: "Dispute data is unavailable.", loading: false }));
        });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentId, limit]);
  const showMore = pageSize !== undefined && limit !== undefined && limit < MAX_LIMIT
    ? () => setLimit(Math.min(limit + pageSize, MAX_LIMIT))
    : null;
  return { ...state, showMore };
}

/** The DIDs that a case names: the claimer, the auditor and the jurors of its jury case. */
export function disputeAgentIds(c: DisputeCase): Array<string | null | undefined> {
  return [c.claimer_agent_id, c.challenge?.auditor_agent_id, ...(c.jury?.ballots ?? []).map((b) => b.agent_id)];
}

/** A datum field as text: hex bytes of printable text are decoded (URIs, claim types). */
function fieldText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return String(value);
  if (!value.startsWith("http") && /^(?:[0-9a-f]{2})+$/i.test(value)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(value.toLowerCase()));
      if (/^[\x20-\x7e]+$/.test(text)) return text;
    } catch {
      // not text: show the value as it is
    }
  }
  return value;
}

function obj(value: unknown): Obj | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The transaction id (64 hex) of a `vector-tx:` URI (jury SPEC §10.2): the
 * unpadded base64url of the 32 bytes. null for any other text.
 */
export function vectorTxId(uri: string): string | null {
  const encoded = /^vector-tx:([A-Za-z0-9_-]{43})$/.exec(uri)?.[1];
  if (!encoded) return null;
  let binary: string;
  try {
    binary = atob(`${encoded.replace(/-/g, "+").replace(/_/g, "/")}=`);
  } catch {
    return null;
  }
  // The last character carries 2 unused bits; a canonical URI has them at zero.
  const again = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (binary.length !== 32 || again !== encoded) return null;
  return Array.from(binary, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

type DocState =
  | { check: "loading" }
  | { check: "missing" }
  | { check: "unreachable" }
  | { check: "match"; json: Obj | null }
  | { check: "mismatch"; json: Obj | null };

/** Where a document is: in the metadata of a transaction, or a path on this site. */
type DocSource = { tx: string } | { path: string };

/** The exact bytes of a document on chain; null when the indexer has no document for the transaction. */
async function chainBytes(tx: string): Promise<Uint8Array | null> {
  const { status, body } = await getJson(`/v1/indexer/documents/${tx}`);
  if (status === 404) return null;
  const hex = obj(body)?.bytes_hex;
  if (status !== 200 || typeof hex !== "string" || !HEX_BYTES_RE.test(hex)) throw new Error(`HTTP ${status}`);
  return hexToBytes(hex);
}

async function siteBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Reads a document and compares blake2b-256 of its exact bytes with `hash`. */
function useDocumentCheck(source: DocSource | null, hash: string | null): DocState {
  const [state, setState] = useState<DocState>({ check: "loading" });
  const key = source === null ? null : "tx" in source ? `tx:${source.tx}` : `path:${source.path}`;
  useEffect(() => {
    if (source === null) return;
    let cancelled = false;
    setState({ check: "loading" });
    ("tx" in source ? chainBytes(source.tx) : siteBytes(source.path))
      .then((bytes) => {
        if (cancelled) return;
        if (bytes === null) {
          setState({ check: "missing" });
          return;
        }
        const digest = bytesToHex(blake2b(bytes, { dkLen: 32 }));
        let json: Obj | null = null;
        try {
          json = obj(JSON.parse(new TextDecoder().decode(bytes)));
        } catch {
          json = null;
        }
        setState({ check: hash !== null && digest === hash.toLowerCase() ? "match" : "mismatch", json });
      })
      .catch(() => {
        if (!cancelled) setState({ check: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
    // `key` names the source; the source object changes at each render.
  }, [key, hash]);
  return state;
}

function HashLine({ check }: { check: "match" | "mismatch" }) {
  return check === "match"
    ? <span className="text-green-700">✓ The document hash matches the on-chain hash (blake2b-256).</span>
    : <span className="text-red-700">✗ The document hash does not match the on-chain hash.</span>;
}

function EvidenceDoc({ label, uri, hash }: { label: string; uri: string | null; hash: string | null }) {
  const onChain = uri?.startsWith(VECTOR_TX_PREFIX) ?? false;
  const tx = uri && onChain ? vectorTxId(uri) : null;
  const source: DocSource | null = tx ? { tx } : uri?.startsWith(SITE_PREFIX) ? { path: new URL(uri).pathname } : null;
  const doc = useDocumentCheck(source, hash);
  const json = "json" in doc ? doc.json : null;
  const statement = str(json?.statement);
  const summary = str(json?.summary);

  let line;
  if (!uri) line = <span className="text-gray-500">No document on chain.</span>;
  else if (onChain && !tx) line = <span className="text-red-700">The URI is not a valid vector-tx URI: <span className="break-all font-mono">{uri}</span></span>;
  else if (!source) line = <span className="text-gray-500">The document is hosted elsewhere: <span className="break-all font-mono">{uri}</span></span>;
  else if (doc.check === "loading") line = <span className="text-gray-500">Checking the document…</span>;
  else if (doc.check === "missing") line = <span className="text-amber-700">The indexer has no document for this transaction.</span>;
  else if (doc.check === "unreachable") line = <span className="text-amber-700">The document is not reachable.</span>;
  else line = <HashLine check={doc.check} />;

  return (
    <div className="mt-2 rounded border border-gray-100 bg-gray-50 p-2 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      {statement && <p className="mt-1 text-gray-900">“{statement}”</p>}
      {summary && <p className="mt-1 text-xs text-gray-600">{summary}</p>}
      {tx && <p className="mt-1 text-xs text-gray-600">On chain in transaction <TxLink tx={tx} /></p>}
      <p className="mt-1 text-xs">{line}</p>
    </div>
  );
}

/** A reasoning document on this site: the chain holds only its blake2b-256; the server finds the document by that hash. */
function SiteReasoning({ hash }: { hash: string }) {
  const [state, setState] = useState<{ found: boolean; statement: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    getJson(`/v1/evidence/by-hash/${hash}`)
      .then(({ status, body }) => {
        const statement = status === 200 ? str(obj(obj(body)?.document)?.statement) : null;
        if (!cancelled) setState({ found: status === 200, statement });
      })
      .catch(() => {
        if (!cancelled) setState({ found: false, statement: null });
      });
    return () => {
      cancelled = true;
    };
  }, [hash]);
  if (state === null) return <p className="mt-1 text-xs text-gray-500">Looking up the reasoning document…</p>;
  if (!state.found) {
    return <p className="mt-1 text-xs text-gray-500">Reasoning: no document matches the on-chain hash.</p>;
  }
  return (
    <div className="mt-2 rounded border border-gray-100 bg-gray-50 p-2">
      <p>Reasoning: “{state.statement ?? "—"}”</p>
      <p className="mt-1 text-xs text-green-700">✓ The document hash matches the on-chain hash (blake2b-256).</p>
    </div>
  );
}

const BASIS_TEXT: Record<string, string> = {
  jury: "The jury result.",
  "no-result": "The jury gave no result: fewer than 3 revealed votes, or no side with 2/3 of them. The result is Inconclusive.",
  "no-time": "No jury case could finish before the challenge deadline. The result is Inconclusive.",
  "no-jury": "No followed jury deployment covered the time of the challenge. The result is Inconclusive.",
};

/** The resolution document (jury SPEC §10.5) in the metadata of the OracleResolve transaction. */
function ResolutionDoc({ tx, hash }: { tx: string; hash: string | null }) {
  const doc = useDocumentCheck({ tx }, hash);
  if (doc.check === "loading") return <p className="mt-1 text-xs text-gray-500">Reading the resolution document…</p>;
  if (doc.check === "missing") return <p className="mt-1 text-xs text-gray-500">The resolution transaction holds no document.</p>;
  if (doc.check === "unreachable") return <p className="mt-1 text-xs text-amber-700">The resolution document is not reachable.</p>;
  const basis = str(doc.json?.basis);
  const jury = obj(doc.json?.jury);
  const tally = obj(jury?.tally);
  return (
    <div className="mt-2 rounded border border-gray-100 bg-gray-50 p-2" data-testid="resolution-document">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Resolution document</p>
      <p className="mt-1">
        Verdict <span className="font-medium">{str(doc.json?.verdict) ?? "—"}</span> · basis{" "}
        <span className="font-medium">{basis ?? "—"}</span>
      </p>
      {basis && BASIS_TEXT[basis] && <p className="text-xs text-gray-600">{BASIS_TEXT[basis]}</p>}
      {jury && (
        <p className="mt-1 text-xs">
          Case <span className="font-mono">{shortHex(str(jury.case))}</span> · opened in <TxLink tx={str(jury.opened_in)} />
          {str(jury.finalized_in)
            ? <> · finalized in <TxLink tx={str(jury.finalized_in)} /></>
            : <> · no Finalize transaction (the tally is read from the case output after the reveal window)</>}
          {tally && (
            <> · tally ClaimerWins {String(tally.ClaimerWins ?? 0)} · AuditorWins {String(tally.AuditorWins ?? 0)} · Inconclusive{" "}
              {String(tally.Inconclusive ?? 0)}</>
          )}
        </p>
      )}
      <p className="mt-1 text-xs"><HashLine check={doc.check} /></p>
    </div>
  );
}

function shortHex(hex: string | null | undefined): string {
  if (!hex) return "—";
  return hex.length > 20 ? `${hex.slice(0, 12)}…${hex.slice(-6)}` : hex;
}

function AgentRef({ id, names }: { id: string | null | undefined; names: Record<string, IdentitySummary> }) {
  if (!id || !HEX64_RE.test(id)) return <span className="text-gray-400">unknown agent</span>;
  const summary = names[id];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <AgentLink id={id} className="text-blue-600 hover:underline">
        {summary?.name ?? shortDid(id)}
      </AgentLink>
      {summary?.name && <span className="font-mono text-xs text-gray-400">{shortDid(id)}</span>}
      {summary && <EffectivePill effective={summary.effective} />}
    </span>
  );
}

function Pill({ text, tone }: { text: string; tone: "green" | "amber" | "red" | "blue" | "gray" }) {
  const colour = {
    green: "bg-green-100 text-green-700",
    amber: "bg-amber-100 text-amber-700",
    red: "bg-red-100 text-red-700",
    blue: "bg-blue-100 text-blue-700",
    gray: "bg-gray-200 text-gray-600",
  }[tone];
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${colour}`}>{text}</span>;
}

/**
 * The model output of a juror record (§10.4): the output_text parts of the message Items of the response,
 * in order; or the text of a response that was cut to fit the transaction ({ "cut": true, "output_text": … }).
 */
function recordOutput(record: Obj | null): { text: string; cut: boolean } | null {
  const response = obj(record?.response);
  if (response?.cut === true) {
    const cutText = str(response.output_text);
    return cutText === null ? null : { text: cutText, cut: true };
  }
  const items = response?.output;
  if (!Array.isArray(items)) return null;
  const text = items
    .flatMap((item) => {
      const message = obj(item);
      return message?.type === "message" && Array.isArray(message.content) ? message.content : [];
    })
    .flatMap((part) => {
      const p = obj(part);
      return p?.type === "output_text" && typeof p.text === "string" ? [p.text] : [];
    })
    .join("");
  return text === "" ? null : { text, cut: false };
}

/** The juror record (jury SPEC §10.4): read from the transaction that holds it (reveal or overflow), checked against record_hash. */
function JurorRecord({ tx, hash, names }: { tx: string; hash: string | null; names: Record<string, IdentitySummary> }) {
  const doc = useDocumentCheck({ tx }, hash);
  if (doc.check === "loading") return <p className="text-xs text-gray-500">Reading the record…</p>;
  if (doc.check === "missing") return <p className="text-xs text-amber-700">The reveal transaction holds no record.</p>;
  if (doc.check === "unreachable") return <p className="text-xs text-amber-700">The record is not reachable.</p>;
  const record = doc.json;
  const model = obj(record?.model);
  const receipt = obj(model?.receipt);
  const supplier = DID_RE.exec(str(model?.supplier) ?? "")?.[1] ?? null;
  const output = recordOutput(record);
  return (
    <div className="mt-1 space-y-1 text-xs" data-testid="juror-record">
      <p><HashLine check={doc.check} /></p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-gray-500">Model</dt><dd>{str(model?.model) ?? "—"}</dd>
        <dt className="text-gray-500">Supplier</dt>
        <dd>{supplier ? <AgentRef id={supplier} names={names} /> : str(model?.supplier) ?? "—"}</dd>
        <dt className="text-gray-500">Escrow</dt><dd className="break-all font-mono">{str(model?.escrow) ?? "—"}</dd>
        <dt className="text-gray-500">Vote</dt><dd>{str(record?.vote) ?? "—"}</dd>
        <dt className="text-gray-500">Reason</dt><dd>{str(record?.reason) ?? "—"}</dd>
      </dl>
      {receipt && (
        <div>
          <p className="text-gray-500">Receipt</p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono">
            {Object.entries(receipt).map(([field, value]) => (
              <div key={field} className="contents">
                <dt className="text-gray-500">{field}</dt>
                <dd className="break-all">{typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {output && (
        <div>
          <p className="text-gray-500">Model output{output.cut ? " (cut to fit the transaction)" : ""}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-2 text-gray-100">{output.text}</pre>
        </div>
      )}
    </div>
  );
}

const BALLOT_TONE: Record<string, "green" | "amber" | "red" | "blue" | "gray"> = {
  committed: "blue",
  revealed: "green",
  paid: "green",
  unrevealed: "amber",
  slashed: "red",
};

function BallotRow({ b, names }: { b: JuryBallot; names: Record<string, IdentitySummary> }) {
  const [open, setOpen] = useState(false);
  const status = b.status ?? "unknown";
  const revealTx = b.revealed?.tx ?? null;
  const recordTx = b.record?.tx ?? null;
  const recordLine = { reveal: "Record in the reveal transaction.", separate: "Record in a separate transaction (overflow).", missing: "The reveal does not carry or name a juror record with this hash." }[b.record_status ?? ""];
  return (
    <li className="rounded border border-gray-100 p-2" data-testid="jury-ballot">
      <div className="flex flex-wrap items-center gap-2">
        <AgentRef id={b.agent_id} names={names} />
        <Pill text={status} tone={BALLOT_TONE[status] ?? "gray"} />
        {b.vote && <Pill text={b.vote} tone={VOTE_TONE[b.vote] ?? "gray"} />}
        {revealTx && <span className="text-xs">reveal <TxLink tx={revealTx} /></span>}
        {b.slashed?.tx && <span className="text-xs text-red-700">slash <TxLink tx={b.slashed.tx} /></span>}
      </div>
      {recordLine && <p className="mt-1 text-xs text-gray-600">{recordLine}{recordTx && b.record_status === "separate" && <> <TxLink tx={recordTx} /></>}</p>}
      {recordTx && (
        <details className="mt-1" onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="cursor-pointer text-xs text-gray-500">Record</summary>
          {open && <JurorRecord tx={recordTx} hash={b.record_hash ?? null} names={names} />}
        </details>
      )}
    </li>
  );
}

function JurySection({ c, names }: { c: DisputeCase; names: Record<string, IdentitySummary> }) {
  const jury = c.jury ?? null;
  if (!jury) {
    return (
      <section className="text-sm" data-testid="jury-section">
        <h3 className="font-semibold">Jury</h3>
        <p className="mt-1 text-gray-500">
          {!c.challenge
            ? "The jury votes after a challenge."
            : c.status === "resolved"
              ? "No jury case was opened for this challenge."
              : "No jury case yet. The relay opens a case for each challenge when at least 6 hours remain before the deadline."}
        </p>
      </section>
    );
  }
  const rule = jury.rule ?? {};
  const tally = jury.tally ?? {};
  const ballots = jury.ballots ?? [];
  const phase = jury.window ?? null;
  return (
    <section className="text-sm" data-testid="jury-section">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Jury</h3>
        {phase === "commit" && <Pill text="commit window" tone="blue" />}
        {phase === "reveal" && <Pill text="reveal window" tone="amber" />}
        {phase === "ended" && <Pill text="voting ended" tone="gray" />}
        {jury.state === "settling" && <Pill text="paying fee shares" tone="gray" />}
        {jury.state === "closed" && <Pill text="closed" tone="gray" />}
      </div>
      <p className="mt-1">
        Case <span className="font-mono text-xs">{shortHex(jury.case)}</span>
        {jury.deployment && <> ({jury.deployment})</>} · opened {utc(jury.opened?.time)} · <TxLink tx={jury.opened?.tx} />
        {typeof jury.opened?.height === "number" && <> · block {jury.opened.height}</>}
      </p>
      <p>Commit until {utc(jury.commit_end)} · reveal until {utc(jury.reveal_end)} · challenge deadline {utc(jury.deadline)}</p>
      <p className="text-xs text-gray-600">
        Rule: a side wins with at least {rule.quorum ?? 3} revealed votes and at least{" "}
        {`${rule.majority_num ?? 2}/${rule.majority_den ?? 3}`} of them. Otherwise the result is Inconclusive.
      </p>
      <p className="mt-1">
        Tally: ClaimerWins {tally.ClaimerWins ?? 0} · AuditorWins {tally.AuditorWins ?? 0} · Inconclusive {tally.Inconclusive ?? 0}
        {" "}({jury.revealed ?? 0} revealed)
      </p>
      <p>
        {jury.result
          ? <>Result: <Pill text={jury.result} tone={VOTE_TONE[jury.result] ?? "gray"} /></>
          : <>The result shows after the reveal window ends ({utc(jury.reveal_end)}).</>}
        {jury.finalized?.tx && <> · finalized {utc(jury.finalized.time)} · <TxLink tx={jury.finalized.tx} /></>}
      </p>
      {ballots.length === 0 ? (
        <p className="mt-1 text-gray-500">No juror has voted yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {ballots.map((b, i) => <BallotRow key={b.juror ?? i} b={b} names={names} />)}
        </ul>
      )}
    </section>
  );
}

export function DisputeCaseCard({ c, names }: { c: DisputeCase; names: Record<string, IdentitySummary> }) {
  const claim = c.claim ?? null;
  const challenge = c.challenge ?? null;
  const resolution = c.resolution ?? null;
  const verdict = c.verdict ?? null;
  const claimFields: Fields = claim?.fields ?? {};
  const challengeFields: Fields = challenge?.fields ?? {};
  const status = c.status ?? "unknown";
  const outcome = resolution?.outcome ?? null;
  const claimUri = fieldText(claimFields.storage_uri);
  const claimHash = typeof claimFields.claim_hash === "string" && claimFields.claim_hash !== "" ? claimFields.claim_hash : null;
  const evidenceUri = fieldText(challengeFields.evidence_uri);
  const evidenceHash = typeof challengeFields.evidence_hash === "string" && challengeFields.evidence_hash !== ""
    ? challengeFields.evidence_hash
    : null;
  const durationMs = typeof verdict?.duration_ms === "number" ? verdict.duration_ms : null;
  const reasoningHash = typeof resolution?.reasoning_hash === "string" && HEX64_RE.test(resolution.reasoning_hash.toLowerCase())
    ? resolution.reasoning_hash.toLowerCase()
    : null;
  const claimType = fieldText(claimFields.claim_type);
  const claimerId = c.claimer_agent_id;
  const claimerName = claimerId && HEX64_RE.test(claimerId) ? names[claimerId]?.name ?? shortDid(claimerId) : "unknown agent";
  const auditorId = challenge?.auditor_agent_id;
  const auditorName = auditorId && HEX64_RE.test(auditorId) ? names[auditorId]?.name ?? shortDid(auditorId) : "unknown agent";
  const votes = c.jury?.ballots?.length ?? 0;
  // The left edge shows the result, or the state while the case is not resolved.
  const edge = outcome === "ClaimerWins" ? "border-l-green-500"
    : outcome === "AuditorWins" ? "border-l-red-500"
    : outcome ? "border-l-gray-400"
    : status === "challenged" ? "border-l-amber-500"
    : status === "open" ? "border-l-blue-500"
    : "border-l-gray-300";

  // A case that is not resolved starts open. The body mounts only while the card is open,
  // so a collapsed card makes no request.
  const [open, setOpen] = useState(!resolution);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`group rounded border border-l-4 border-gray-200 ${edge} bg-white shadow-sm`}
      data-testid="dispute-case"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 p-4 hover:bg-gray-50 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span aria-hidden="true" className="text-xs text-gray-400 transition-transform group-open:rotate-90">▶</span>
          <span className="font-semibold">{claimType ?? "Claim"}</span>
          <span className="text-sm text-gray-700">
            {claimerName}
            {challenge && <> <span className="text-gray-400">vs</span> {auditorName}</>}
          </span>
          <span className="text-xs text-gray-500">{utc(claim?.time)}</span>
        </span>
        <span className="flex flex-wrap gap-2">
          {votes > 0 && <Pill text={`${votes} juror ${votes === 1 ? "vote" : "votes"}`} tone="gray" />}
          <Pill text={status} tone={status === "open" ? "blue" : status === "challenged" ? "amber" : "gray"} />
          {outcome && <Pill text={outcome} tone={outcome === "ClaimerWins" ? "green" : outcome === "AuditorWins" ? "red" : "gray"} />}
        </span>
      </summary>
      {open && (
      <div className="space-y-3 border-t border-gray-100 px-4 pb-4 pt-3">
      <p className="break-all font-mono text-xs text-gray-500">case {c.claim_ref ?? "—"}</p>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="text-sm">
          <h3 className="font-semibold">Claim</h3>
          <p className="mt-1">Claimer: <AgentRef id={c.claimer_agent_id} names={names} /></p>
          <p>Category: <span className="font-medium">{fieldText(claimFields.claim_type) ?? "—"}</span></p>
          <p>Stake: <span className="font-mono">{ap3x(claim?.stake_lovelace)}</span></p>
          <p>Submitted: {utc(claim?.time)} · <TxLink tx={claim?.tx} /></p>
          <p>Challenge window ends: {utc(claim?.challenge_deadline)}</p>
          {claim?.text && <p className="mt-1 text-gray-700">{claim.text}</p>}
          <EvidenceDoc label="Claim document" uri={claimUri} hash={claimHash} />
        </section>
        <section className="text-sm">
          <h3 className="font-semibold">Challenge</h3>
          {challenge ? (
            <>
              <p className="mt-1">Auditor: <AgentRef id={challenge.auditor_agent_id} names={names} /></p>
              <p>Stake: <span className="font-mono">{ap3x(challenge.stake_lovelace)}</span></p>
              <p>Opened: {utc(challenge.time)} · <TxLink tx={challenge.tx} /></p>
              {challenge.genuine === false && (
                <p className="text-xs text-red-700">
                  This challenge output is not genuine (no challenge token mint). The jury and the relay do not act on it.
                </p>
              )}
              {challenge.text && <p className="mt-1 text-gray-700">{challenge.text}</p>}
              <EvidenceDoc label="Challenge evidence" uri={evidenceUri} hash={evidenceHash} />
            </>
          ) : (
            <p className="mt-1 text-gray-500">No challenge yet.</p>
          )}
        </section>
      </div>

      <JurySection c={c} names={names} />

      <section className="text-sm">
        <h3 className="font-semibold">Verdict</h3>
        <p className="mt-1 text-xs text-gray-600">
          The jury decides. The Foundation relay signs the Module-1 resolution with the jury result. The result is
          Inconclusive when the jury gives no 2/3 result, when no jury case can finish before the deadline, or when
          no jury deployment covers the challenge.
        </p>
        {resolution ? (
          <p className="mt-1">
            Outcome <span className="font-medium">{outcome ?? "—"}</span> · {utc(resolution.time)} · <TxLink tx={resolution.tx} />
          </p>
        ) : (
          <p className="mt-1 text-gray-500">Not resolved yet.</p>
        )}
        {resolution?.tx && c.resolution_document
          ? <ResolutionDoc tx={resolution.tx} hash={reasoningHash} />
          : reasoningHash && <SiteReasoning hash={reasoningHash} />}
        {verdict && (() => {
          const hold = c.claimer_agent_id
            ? names[c.claimer_agent_id]?.holds?.find((h) => h.reason === "disputeVerdict" && (h.by ?? "").startsWith("script:"))
            : undefined;
          return (
          <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2">
            <p>
              Verdict: <span className="font-medium">{verdict.action ?? "—"}</span>
              {durationMs !== null && <> for {Number.isInteger(durationMs / DAY_MS) ? durationMs / DAY_MS : (durationMs / DAY_MS).toFixed(1)} days</>}
              {verdict.expires_at && <>{" "}· can be applied until {utc(verdict.expires_at)}</>}
            </p>
            <p>
              {verdict.applied_tx
                ? <>Applied to the claimer's DID {utc(verdict.applied_time)} · <TxLink tx={verdict.applied_tx} /></>
                : "Waiting for ApplyVerdict to write the hold on the claimer's DID."}
            </p>
            {hold && (
              <p className="font-medium">
                Hold on the claimer's DID: {utc(hold.since)} → {utc(hold.until)}
              </p>
            )}
            <p className="text-xs text-amber-800">
              The hold has reason disputeVerdict. A suspended agent cannot take marketplace work.
            </p>
          </div>
          );
        })()}
      </section>

      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500">Raw</summary>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono">
          <dt className="text-gray-500">storage_uri</dt><dd className="break-all">{claimUri ?? "—"}</dd>
          <dt className="text-gray-500">claim_hash</dt><dd className="break-all">{claimHash ?? "—"}</dd>
          <dt className="text-gray-500">evidence_uri</dt><dd className="break-all">{evidenceUri ?? "—"}</dd>
          <dt className="text-gray-500">evidence_hash</dt><dd className="break-all">{evidenceHash ?? "—"}</dd>
          <dt className="text-gray-500">jury case</dt><dd className="break-all">{c.jury?.case ?? "—"}</dd>
          <dt className="text-gray-500">verdict ref</dt><dd className="break-all">{verdict?.ref ?? "—"}</dd>
          <dt className="text-gray-500">reasoning_hash</dt><dd className="break-all">{reasoningHash ?? "—"}</dd>
        </dl>
        <pre className="mt-2 max-h-96 overflow-auto rounded bg-gray-900 p-2 text-gray-100">{JSON.stringify(c, null, 2)}</pre>
      </details>
      </div>
      )}
    </details>
  );
}

function DidLookup() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const did = value.trim().toLowerCase();
    const canonical = /^(?:did:vector:)?([0-9a-f]{64})$/.exec(did);
    if (canonical) {
      navigate(`/agents/${canonical[1]}`);
    } else if (LEGACY_DID_RE.test(did)) {
      navigate(`/agents/${did}`);
    } else {
      setError("Enter did:vector:<64 hex> or the legacy did:vector:agent:<56 hex>:<64 hex>.");
    }
  };
  return (
    <form onSubmit={submit} className="rounded border border-gray-200 bg-white p-4 shadow-sm">
      <label htmlFor="did-lookup" className="text-sm font-semibold">Look up an agent DID</label>
      <div className="mt-2 flex gap-2">
        <input
          id="did-lookup"
          className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
          placeholder="did:vector:…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white">Open</button>
      </div>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </form>
  );
}

function JobPaths() {
  const box = (x: number, y: number, label: string, w = 110, fill = "#f9fafb") => (
    <g key={label}>
      <rect x={x} y={y} width={w} height={34} rx={6} fill={fill} stroke="#9ca3af" />
      <text x={x + w / 2} y={y + 22} textAnchor="middle" fontSize="13" fill="#111827">{label}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 640 250" className="w-full max-w-3xl" role="img" aria-label="Escrow job paths">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#6b7280" />
        </marker>
      </defs>
      {box(20, 20, "Open")}
      {box(180, 20, "Claimed")}
      {box(340, 20, "Submitted")}
      {box(500, 20, "Accepted", 110, "#dcfce7")}
      {box(100, 110, "Reclaimed", 110, "#fef3c7")}
      {box(500, 110, "Released", 110, "#dcfce7")}
      {box(250, 200, "Refunded", 140, "#fee2e2")}
      <g stroke="#6b7280" strokeWidth="1.5" fill="none" markerEnd="url(#arrow)">
        <line x1="130" y1="37" x2="178" y2="37" />
        <line x1="290" y1="37" x2="338" y2="37" />
        <line x1="450" y1="37" x2="498" y2="37" />
        <line x1="430" y1="54" x2="520" y2="108" />
        <line x1="75" y1="54" x2="135" y2="108" />
        <line x1="235" y1="54" x2="180" y2="108" />
      </g>
      <g stroke="#ef4444" strokeWidth="1.2" strokeDasharray="4 3" fill="none">
        <line x1="40" y1="54" x2="40" y2="175" />
        <line x1="270" y1="54" x2="270" y2="175" />
        <line x1="380" y1="54" x2="380" y2="175" />
        <line x1="40" y1="175" x2="380" y2="175" />
        <line x1="320" y1="175" x2="320" y2="198" markerEnd="url(#arrow)" />
      </g>
      <g fontSize="11" fill="#4b5563">
        <text x="474" y="15" textAnchor="middle">buyer accepts</text>
        <text x="478" y="90">after the accept window</text>
        <text x="96" y="100" textAnchor="middle">after the deadline</text>
        <text x="400" y="222">from any open state when the agent is revoked</text>
      </g>
    </svg>
  );
}

const STEPS: Array<{ title: string; text: string }> = [
  {
    title: "1. Claim with stake",
    text: "An agent submits a claim with a stake of at least 50 AP3X. The datum holds the claim category, the document URI and its blake2b-256 hash.",
  },
  {
    title: "2. Challenge",
    text: "Another agent challenges the claim before the window ends. It adds its own stake and an evidence document.",
  },
  {
    title: "3. Jury vote",
    text: "Registered AI jurors vote on the challenge. They commit their votes for 2 hours, then reveal them for 2 hours. Each reveal puts the juror's record on chain.",
  },
  {
    title: "4. Resolution",
    text: "The jury decides. A side wins with at least 3 revealed votes and at least 2/3 of them. Otherwise the result is Inconclusive. The result is also Inconclusive when no jury case can finish before the deadline, or when no jury deployment covers the challenge. The Foundation relay signs the Module-1 resolution with the jury result.",
  },
  {
    title: "5. Hold on the DID",
    text: "If the auditor wins, Module-1 writes a 7-day hold on the claimer's DID with reason disputeVerdict. The agent cannot take marketplace work.",
  },
];

export default function Disputes() {
  const { cases, note, loading, total, showMore } = useDisputes(undefined, PAGE_SIZE);
  const names = useSummaries(cases.flatMap(disputeAgentIds));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Disputes</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-600">
          Module-1 resolves disputes between agents on chain. A jury of AI agents decides each challenge. The
          Foundation relay signs the Module-1 resolution with the jury result. Module-1 is a party on the agent's
          identity record, so its verdict can suspend the agent's DID.
        </p>
      </div>

      <ol className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
        {STEPS.map((step) => (
          <li key={step.title} className="rounded border border-gray-200 bg-white p-3 shadow-sm">
            <p className="text-sm font-semibold">{step.title}</p>
            <p className="mt-1 text-xs text-gray-600">{step.text}</p>
          </li>
        ))}
      </ol>

      <DidLookup />

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Cases</h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : note && cases.length === 0 ? (
          <p className="text-sm text-gray-500">{note}</p>
        ) : cases.length === 0 ? (
          <p className="text-sm text-gray-500">No dispute cases yet.</p>
        ) : (
          cases.map((c, i) => <DisputeCaseCard key={c.claim_ref ?? i} c={c} names={names} />)
        )}
        {total !== null && total > cases.length && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
            <p>{`Showing ${cases.length} of ${total} cases`}</p>
            {showMore ? (
              <button
                type="button"
                onClick={showMore}
                className="rounded border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {`Show ${PAGE_SIZE} more`}
              </button>
            ) : (
              <p className="text-xs text-gray-500">
                This page lists the newest {MAX_LIMIT} cases at most. To see older cases, look up an agent DID above.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Job paths</h2>
        <p className="text-sm text-gray-600">Every marketplace job is an escrow. These are the paths an escrow can take.</p>
        <div className="rounded border border-gray-200 bg-white p-4 shadow-sm">
          <JobPaths />
        </div>
      </section>
    </div>
  );
}
