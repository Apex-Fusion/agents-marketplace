/**
 * buyer/src/ui/pages/Disputes.tsx — Module-1 dispute resolution.
 *
 * Explains the Module-1 process, lists the dispute cases from the indexer
 * (GET /v1/indexer/disputes; 404 = an indexer without dispute data), draws
 * the escrow job paths and opens any did:vector in /agents/:id.
 *
 * Claim and challenge documents are off chain: the datum holds the URI and
 * the blake2b-256 hash. A document on this site is fetched same-origin and
 * its hash is checked against the on-chain hash.
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
}

const SITE_PREFIX = "https://marketplace.vector.apexfusion.org/";
const LEGACY_DID_RE = /^did:vector:agent:[0-9a-f]{56}:[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

/** Cases of all agents, or of one agent (claimer or auditor); refreshes every 15 s. */
export function useDisputes(agentId?: string): { cases: DisputeCase[]; note: string | null; loading: boolean } {
  const [state, setState] = useState<{ cases: DisputeCase[]; note: string | null; loading: boolean }>({
    cases: [],
    note: null,
    loading: true,
  });
  useEffect(() => {
    let cancelled = false;
    const url = agentId ? `/v1/indexer/disputes?agent_id=${agentId}` : "/v1/indexer/disputes";
    const load = (): void => {
      getJson(url)
        .then(({ status, body }) => {
          if (cancelled) return;
          if (status === 404) {
            setState({ cases: [], note: "No dispute data yet", loading: false });
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
          setState({ cases, note: null, loading: false });
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
  }, [agentId]);
  return state;
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

type DocCheck = "loading" | "match" | "mismatch" | "unreachable" | "external" | "none";

function EvidenceDoc({ label, uri, hash }: { label: string; uri: string | null; hash: string | null }) {
  const [doc, setDoc] = useState<{ statement: string | null; summary: string | null } | null>(null);
  const [check, setCheck] = useState<DocCheck>("loading");

  useEffect(() => {
    let cancelled = false;
    if (!uri) {
      setCheck("none");
    } else if (!uri.startsWith(SITE_PREFIX)) {
      setCheck("external");
    } else {
      fetch(new URL(uri).pathname, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          const digest = bytesToHex(blake2b(bytes, { dkLen: 32 }));
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            parsed = null;
          }
          const obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
          if (cancelled) return;
          setDoc({
            statement: typeof obj.statement === "string" ? obj.statement : null,
            summary: typeof obj.summary === "string" ? obj.summary : null,
          });
          setCheck(hash !== null && digest === hash.toLowerCase() ? "match" : "mismatch");
        })
        .catch(() => {
          if (!cancelled) setCheck("unreachable");
        });
    }
    return () => {
      cancelled = true;
    };
  }, [uri, hash]);

  const line = {
    loading: <span className="text-gray-500">Checking the document…</span>,
    match: <span className="text-green-700">✓ The document hash matches the on-chain hash (blake2b-256).</span>,
    mismatch: <span className="text-red-700">✗ The document hash does not match the on-chain hash.</span>,
    unreachable: <span className="text-amber-700">The document is not reachable.</span>,
    external: <span className="text-gray-500">The document is hosted elsewhere: <span className="break-all font-mono">{uri}</span></span>,
    none: <span className="text-gray-500">No document on chain.</span>,
  }[check];

  return (
    <div className="mt-2 rounded border border-gray-100 bg-gray-50 p-2 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      {doc?.statement && <p className="mt-1 text-gray-900">“{doc.statement}”</p>}
      {doc?.summary && <p className="mt-1 text-xs text-gray-600">{doc.summary}</p>}
      <p className="mt-1 text-xs">{line}</p>
    </div>
  );
}

/** The oracle's reasoning document: the chain holds only its blake2b-256; the server finds the document by that hash. */
function OracleReasoning({ hash }: { hash: string }) {
  const [state, setState] = useState<{ found: boolean; statement: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    getJson(`/v1/evidence/by-hash/${hash}`)
      .then(({ status, body }) => {
        const doc = status === 200 && typeof body === "object" && body !== null && "document" in body ? body.document : null;
        const statement = typeof doc === "object" && doc !== null && "statement" in doc && typeof doc.statement === "string"
          ? doc.statement
          : null;
        if (!cancelled) setState({ found: status === 200, statement });
      })
      .catch(() => {
        if (!cancelled) setState({ found: false, statement: null });
      });
    return () => {
      cancelled = true;
    };
  }, [hash]);
  if (state === null) return <p className="mt-1 text-xs text-gray-500">Looking up the oracle reasoning…</p>;
  if (!state.found) {
    return <p className="mt-1 text-xs text-gray-500">Oracle reasoning: no document matches the on-chain hash.</p>;
  }
  return (
    <div className="mt-2 rounded border border-gray-100 bg-gray-50 p-2">
      <p>Oracle reasoning: “{state.statement ?? "—"}”</p>
      <p className="mt-1 text-xs text-green-700">✓ The document hash matches the on-chain hash (blake2b-256).</p>
    </div>
  );
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

  return (
    <div className="space-y-3 rounded border border-gray-200 bg-white p-4 shadow-sm" data-testid="dispute-case">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="break-all font-mono text-xs text-gray-500">case {c.claim_ref ?? "—"}</span>
        <span className="flex flex-wrap gap-2">
          <Pill text={status} tone={status === "open" ? "blue" : status === "challenged" ? "amber" : "gray"} />
          {outcome && <Pill text={outcome} tone={outcome === "ClaimerWins" ? "green" : outcome === "AuditorWins" ? "red" : "gray"} />}
        </span>
      </div>

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
              {challenge.text && <p className="mt-1 text-gray-700">{challenge.text}</p>}
              <EvidenceDoc label="Challenge evidence" uri={evidenceUri} hash={evidenceHash} />
            </>
          ) : (
            <p className="mt-1 text-gray-500">No challenge yet.</p>
          )}
        </section>
      </div>

      <section className="text-sm">
        <h3 className="font-semibold">Oracle verdict</h3>
        {resolution ? (
          <p className="mt-1">
            Outcome <span className="font-medium">{outcome ?? "—"}</span> · {utc(resolution.time)} · <TxLink tx={resolution.tx} />
          </p>
        ) : (
          <p className="mt-1 text-gray-500">Not resolved yet.</p>
        )}
        {reasoningHash && <OracleReasoning hash={reasoningHash} />}
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
          <dt className="text-gray-500">verdict ref</dt><dd className="break-all">{verdict?.ref ?? "—"}</dd>
          <dt className="text-gray-500">reasoning_hash</dt><dd className="break-all">{reasoningHash ?? "—"}</dd>
        </dl>
        <pre className="mt-2 max-h-96 overflow-auto rounded bg-gray-900 p-2 text-gray-100">{JSON.stringify(c, null, 2)}</pre>
      </details>
    </div>
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
    title: "3. Oracle verdict",
    text: "The Module-1 oracle resolves the case: ClaimerWins, AuditorWins, Inconclusive or Timeout. The claim and challenge outputs are spent.",
  },
  {
    title: "4. Hold on the DID",
    text: "If the auditor wins, Module-1 writes a 7-day hold on the claimer's DID with reason disputeVerdict. The agent cannot take marketplace work.",
  },
];

export default function Disputes() {
  const { cases, note, loading } = useDisputes();
  const names = useSummaries(cases.flatMap((c) => [c.claimer_agent_id, c.challenge?.auditor_agent_id]));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Disputes</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-600">
          Module-1 resolves disputes between agents on chain. Module-1 is a party on the agent's identity
          record, so its verdict can suspend the agent's DID.
        </p>
      </div>

      <ol className="grid gap-3 md:grid-cols-4">
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
