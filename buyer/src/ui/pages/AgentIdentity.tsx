/**
 * buyer/src/ui/pages/AgentIdentity.tsx — /agents/:id, one agent's identity.
 *
 * `:id` is a 64-hex vector id, a canonical did:vector or the legacy
 * did:vector:agent:<policy>:<vector-id>. Reads the gateway through the
 * same-origin /v1/identity/* proxy and the indexer through /v1/indexer/*.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  AgentLink,
  EffectivePill,
  TxLink,
  ap3x,
  getJson,
  useSummaries,
  utc,
} from "../components/IdentityBits.js";
import { DisputeCaseCard, useDisputes } from "./Disputes.js";

type Obj = Record<string, unknown>;

const LEGACY_DID_RE = /^did:vector:agent:[0-9a-f]{56}:([0-9a-f]{64})$/;
const CANONICAL_RE = /^(?:did:vector:)?([0-9a-f]{64})$/;
const MODULE1_SIGNER_PREFIX = "script:f6b094a8";
const JOB_OUTCOMES = ["open", "claimed", "submitted", "accepted", "reclaimed", "released", "refunded"] as const;

function obj(value: unknown): Obj | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null;
}

function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

function list(value: unknown): Obj[] {
  if (obj(value)) return [value as Obj];
  return Array.isArray(value) ? value.map(obj).filter((item): item is Obj => item !== null) : [];
}

function words(value: unknown): string {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") || "—" : text(value) ?? "—";
}

function b64url(value: string) {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface StatusBits {
  list: string;
  totalBits: number;
  entries: Array<{ purpose: string; index: number | null; bit: number | null }>;
}

/** Reads the bits of the credential's status entries from /v1/identity/status/bsl/<n>. */
async function readStatusBits(entries: Obj[]): Promise<StatusBits> {
  const url = entries.map((e) => text(e.statusListCredential)).find((u): u is string => u !== null);
  const n = url ? /\/status\/bsl\/(\d+)/.exec(url)?.[1] : undefined;
  if (n === undefined) throw new Error("the credential names no status list");
  const res = await fetch(`/v1/identity/status/bsl/${n}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`status list HTTP ${res.status}`);
  const jwt = (await res.text()).trim();
  const payload = obj(JSON.parse(new TextDecoder().decode(b64url(jwt.split(".")[1] ?? ""))));
  const subject = obj(payload?.credentialSubject) ?? obj(obj(payload?.vc)?.credentialSubject);
  const encoded = text(subject?.encodedList);
  if (encoded === null) throw new Error("the status list has no encodedList");
  const gzip = b64url(encoded.startsWith("u") ? encoded.slice(1) : encoded);
  const stream = new Blob([gzip]).stream().pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return {
    list: n,
    totalBits: bytes.length * 8,
    entries: entries.map((e) => {
      const index = Number(text(e.statusListIndex));
      const valid = Number.isInteger(index) && index >= 0 && index < bytes.length * 8;
      return {
        purpose: text(e.statusPurpose) ?? "unknown",
        index: valid ? index : null,
        // Bit 0 is the most significant bit of the first byte (Bitstring Status List v1.0).
        bit: valid ? (bytes[index >> 3]! >> (7 - (index & 7))) & 1 : null,
      };
    }),
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Raw({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="rounded border border-gray-200 bg-white p-3 text-xs">
      <summary className="cursor-pointer font-medium text-gray-700">{title}</summary>
      <pre className="mt-2 max-h-[32rem] overflow-auto rounded bg-gray-900 p-2 text-gray-100">
        {value === undefined ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

const TH = "py-1 pr-4 text-left text-xs font-medium uppercase tracking-wide text-gray-500";
const TD = "py-1 pr-4 align-top";

export default function AgentIdentity() {
  const { id: param = "" } = useParams();
  const value = param.trim().toLowerCase();
  const canonical = CANONICAL_RE.exec(value);
  const legacy = LEGACY_DID_RE.exec(value);
  if (canonical) return <AgentView did={`did:vector:${canonical[1]}`} vectorId={canonical[1]!} />;
  if (legacy) return <AgentView did={value} vectorId={legacy[1]!} />;
  return (
    <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
      Not a did:vector: <span className="font-mono">{param}</span>
    </div>
  );
}

function AgentView({ did, vectorId }: { did: string; vectorId: string }) {
  const [resolution, setResolution] = useState<{ status: number; body: Obj | null } | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [credential, setCredential] = useState<{ status: number; header: Obj | null; payload: Obj | null; message: string | null } | null>(null);
  const [bits, setBits] = useState<StatusBits | null>(null);
  const [bitsError, setBitsError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<{ status: number; body: Obj | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const disputes = useDisputes(vectorId);
  const names = useSummaries(disputes.cases.flatMap((c) => [c.claimer_agent_id, c.challenge?.auditor_agent_id]));

  useEffect(() => {
    let cancelled = false;
    setResolution(null);
    setResolutionError(null);
    getJson(`/v1/identity/resolve/${did}`)
      .then(({ status, body }) => {
        if (!cancelled) setResolution({ status, body: obj(body) });
      })
      .catch((err: unknown) => {
        if (!cancelled) setResolutionError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [did]);

  useEffect(() => {
    let cancelled = false;
    setCredential(null);
    setBits(null);
    setBitsError(null);
    setJobs(null);
    getJson(`/v1/identity/credential/${vectorId}`)
      .then(async ({ status, body }) => {
        const b = obj(body);
        const payload = obj(b?.payload);
        if (cancelled) return;
        setCredential({
          status: typeof b?.status === "number" ? b.status : status,
          header: obj(b?.header),
          payload,
          message: text(b?.message) ?? text(b?.error),
        });
        const entries = list(payload?.credentialStatus);
        if (entries.length > 0) {
          const read = await readStatusBits(entries);
          if (!cancelled) setBits(read);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setBitsError(err instanceof Error ? err.message : String(err));
      });
    getJson(`/v1/indexer/agents/${vectorId}/jobs`)
      .then(({ status, body }) => {
        if (!cancelled) setJobs({ status, body: obj(body) });
      })
      .catch(() => {
        if (!cancelled) setJobs({ status: 0, body: null });
      });
    return () => {
      cancelled = true;
    };
  }, [vectorId]);

  if (resolutionError) {
    return <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">Resolution failed: {resolutionError}</div>;
  }
  if (resolution === null) return <p className="text-sm text-gray-500">Resolving {did}…</p>;

  const body = resolution.body;
  const found = resolution.status === 200 || resolution.status === 410;
  if (!found) {
    const error = obj(obj(body?.didResolutionMetadata)?.error);
    return (
      <div className="space-y-4">
        <h1 className="break-all font-mono text-lg">{did}</h1>
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {resolution.status === 404
            ? "This DID does not resolve to a registered agent."
            : `The gateway cannot resolve this DID (HTTP ${resolution.status}).`}
          {text(error?.title) && <span className="block text-xs">{text(error?.title)}</span>}
        </div>
        <Raw title="Resolution JSON" value={body} />
      </div>
    );
  }

  const meta = obj(body?.didDocumentMetadata) ?? {};
  const vectorStatus = obj(meta.vectorStatus) ?? {};
  const current = obj(meta.vectorCurrent);
  const profile = obj(meta.vectorProfile) ?? {};
  const ledger = obj(meta.vectorLedger);
  const parties = list(meta.vectorParties);
  const keys = list(meta.vectorKeys);
  const holds = list(vectorStatus.holds);
  const deactivated = resolution.status === 410 || meta.deactivated === true;
  const effective = text(vectorStatus.effective) ?? text(current?.effective) ?? (deactivated ? "deactivated" : null);
  const effectiveReason = text(vectorStatus.effectiveReason) ?? text(current?.effectiveReason);
  const origin = text(meta.vectorOrigin);
  const canonicalId = text(meta.canonicalId);
  const canonicalHex = canonicalId ? CANONICAL_RE.exec(canonicalId)?.[1] ?? null : null;
  const isLegacyForm = LEGACY_DID_RE.test(did);
  const payload = credential?.payload ?? null;
  const statusEntries = list(payload?.credentialStatus);
  const jobBody = jobs?.body ?? null;
  const counts = obj(jobBody?.counts) ?? {};
  const recent = list(jobBody?.recent);
  const pending = Array.isArray(meta.vectorPending)
    ? meta.vectorPending.filter((tx): tx is string => typeof tx === "string" && tx !== "")
    : [];

  return (
    <div className="space-y-4">
      <header className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{text(profile.name) ?? "Unnamed agent"}</h1>
          <EffectivePill effective={effective} />
          {origin && <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{origin}</span>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-sm">{did}</span>
          <button
            type="button"
            className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50"
            onClick={() => {
              navigator.clipboard?.writeText(did).then(() => setCopied(true), () => undefined);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {text(profile.description) && <p className="mt-2 text-sm text-gray-700">{text(profile.description)}</p>}
        {isLegacyForm && (
          <p className="mt-2 text-sm text-gray-600">
            Legacy DID form.{" "}
            {canonicalHex && (
              <>Canonical DID: <AgentLink id={canonicalHex} className="font-mono text-blue-600 hover:underline">{canonicalId}</AgentLink></>
            )}
          </p>
        )}
        {origin === "legacy" && !isLegacyForm && (
          <p className="mt-2 text-sm text-gray-600">Legacy agent (registered in the v1 registry). Equivalent: {words(meta.equivalentId)}</p>
        )}
        {deactivated && (
          <div className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
            Deactivated: status {text(vectorStatus.status) ?? "—"}
            {text(vectorStatus.reason) && <> · reason {text(vectorStatus.reason)}</>}
            {text(vectorStatus.at) && <> · {utc(text(vectorStatus.at))}</>}
          </div>
        )}
        <div className="mt-3 text-sm">
          <p>
            Effective status <span className="font-medium">{effective ?? "unknown"}</span>
            {effectiveReason && <> (reason {effectiveReason})</>} · registry status {text(vectorStatus.status) ?? "—"}
          </p>
          {holds.length > 0 && (
            <ul className="mt-2 space-y-1">
              {holds.map((hold, i) => (
                <li key={i} className="rounded border border-amber-200 bg-amber-50 p-2">
                  Hold: reason <span className="font-medium">{text(hold.reason) ?? "—"}</span> · by{" "}
                  <span className="font-mono text-xs">{text(hold.by) ?? "—"}</span>
                  {text(hold.by)?.startsWith(MODULE1_SIGNER_PREFIX) && " (Module-1)"} · since {utc(text(hold.since))} · until{" "}
                  <span className="font-medium">{utc(text(hold.until))}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-500">A suspended agent cannot take marketplace work.</p>
          {pending.map((tx) => (
            <p key={tx} className="mt-1 text-xs text-amber-700">
              Update pending, waits for 30 confirmations: <TxLink tx={tx} />
            </p>
          ))}
        </div>
      </header>

      <Section title="Accountability">
        {parties.length === 0 ? (
          <p className="text-sm text-gray-500">No parties on record.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className={TH}>Role</th><th className={TH}>Signer</th><th className={TH}>Rights</th><th className={TH}>Period</th></tr></thead>
              <tbody>
                {parties.map((party, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className={TD}>
                      {text(party.role) ?? "—"}
                      {text(party.signer)?.startsWith(MODULE1_SIGNER_PREFIX) && (
                        <span className="ml-1 rounded bg-purple-100 px-1.5 py-0.5 text-xs font-medium text-purple-700">Module-1</span>
                      )}
                    </td>
                    <td className={`${TD} break-all font-mono text-xs`}>
                      {text(party.signer) ?? "—"}
                      {text(party.organisation) && <span className="block font-sans text-gray-600">{text(party.organisation)}</span>}
                    </td>
                    <td className={TD}>{words(party.rights)}</td>
                    <td className={`${TD} text-xs`}>{utc(text(party.notBefore))} → {text(party.notAfter) ? utc(text(party.notAfter)) : "open"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Keys">
        {keys.length === 0 ? (
          <p className="text-sm text-gray-500">No verification methods.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className={TH}>Id</th><th className={TH}>Type</th><th className={TH}>Purposes</th></tr></thead>
              <tbody>
                {keys.map((key, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className={`${TD} break-all font-mono text-xs`}>{text(key.id) ?? "—"}</td>
                    <td className={TD}>{text(key.type) ?? "—"}</td>
                    <td className={TD}>{words(key.purposes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Ledger">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-500">Confirmed version tx</dt>
          <dd><TxLink tx={text(ledger?.txId)} />{text(ledger?.outputIndex) && <span className="font-mono text-xs">#{text(ledger?.outputIndex)}</span>}</dd>
          <dt className="text-gray-500">Slot</dt><dd>{text(ledger?.slot) ?? "—"}</dd>
          <dt className="text-gray-500">Block</dt><dd>{text(ledger?.blockHeight) ?? "—"} <span className="break-all font-mono text-xs text-gray-400">{text(ledger?.blockHash) ?? ""}</span></dd>
          <dt className="text-gray-500">Confirmations</dt><dd>{text(ledger?.confirmations) ?? "—"}</dd>
          <dt className="text-gray-500">Version</dt><dd className="break-all font-mono text-xs">{text(meta.versionId) ?? "—"}</dd>
          <dt className="text-gray-500">Registered</dt><dd>{utc(text(meta.created))}</dd>
          <dt className="text-gray-500">Updated</dt><dd>{utc(text(meta.updated))}</dd>
        </dl>
      </Section>

      <Section title="Credential and status list">
        {credential === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : credential.status === 200 && payload ? (
          <div className="space-y-2 text-sm">
            <p>Type: <span className="font-medium">{words(payload.type)}</span></p>
            <p>Issuer: <span className="break-all font-mono text-xs">{text(payload.issuer) ?? text(obj(payload.issuer)?.id) ?? "—"}</span></p>
            <p>Valid: {utc(text(payload.validFrom))} → {utc(text(payload.validUntil))}</p>
            {statusEntries.length === 0 ? (
              <p className="text-amber-700">Status-list index pending (a new record gets its index after 30 confirmations, about 2 minutes).</p>
            ) : (
              <ul className="space-y-1">
                {statusEntries.map((entry, i) => {
                  const read = bits?.entries.find((b) => b.purpose === text(entry.statusPurpose));
                  return (
                    <li key={i}>
                      {text(entry.statusPurpose) ?? "—"}: list index <span className="font-mono">{text(entry.statusListIndex) ?? "—"}</span>
                      {" "}· bit{" "}
                      {read?.bit === undefined || read.bit === null ? (
                        <span className="text-gray-500">{bitsError ? `unreadable (${bitsError})` : "…"}</span>
                      ) : (
                        <span className={read.bit === 1 ? "font-medium text-red-700" : "font-medium text-green-700"}>
                          {read.bit} ({read.bit === 1 ? `${read.purpose === "revocation" ? "revoked" : "suspended"}` : `not ${read.purpose === "revocation" ? "revoked" : "suspended"}`})
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : credential.status === 409 || credential.status === 410 ? (
          <p className="text-sm text-gray-700">No credential: the agent is not active.</p>
        ) : credential.message?.includes("index") ? (
          <p className="text-sm text-amber-700">Status-list index pending (a new record gets its index after 30 confirmations, about 2 minutes).</p>
        ) : credential.status === 404 ? (
          <p className="text-sm text-gray-700">No credential: the DID is not registered.</p>
        ) : (
          <p className="text-sm text-gray-700">Credential unavailable (HTTP {credential.status}).</p>
        )}
      </Section>

      <Section title="Disputes">
        {disputes.loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : disputes.cases.length === 0 ? (
          <p className="text-sm text-gray-500">{disputes.note ?? "No dispute cases for this agent."}</p>
        ) : (
          <div className="space-y-3">
            {disputes.cases.map((c, i) => <DisputeCaseCard key={c.claim_ref ?? i} c={c} names={names} />)}
          </div>
        )}
      </Section>

      <Section title="Jobs">
        {jobs === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : jobs.status === 404 ? (
          <p className="text-sm text-gray-500">No job data yet</p>
        ) : jobs.status !== 200 ? (
          <p className="text-sm text-gray-500">Job data is unavailable{jobs.status ? ` (HTTP ${jobs.status})` : ""}.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {JOB_OUTCOMES.map((outcome) => (
                <span key={outcome} className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs">
                  {outcome} <span className="font-semibold">{text(counts[outcome]) ?? "0"}</span>
                </span>
              ))}
            </div>
            {recent.length === 0 ? (
              <p className="text-sm text-gray-500">No jobs yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr><th className={TH}>Job</th><th className={TH}>Capability</th><th className={TH}>Payment</th><th className={TH}>Outcome</th><th className={TH}>Last tx</th><th className={TH}>Slot</th></tr></thead>
                  <tbody>
                    {recent.map((job, i) => (
                      <tr key={text(job.job_ref) ?? i} className="border-t border-gray-100">
                        <td className={`${TD} font-mono text-xs`}>{(text(job.job_ref) ?? "—").slice(0, 14)}…</td>
                        <td className={TD}>{text(job.capability_id) ?? "—"}</td>
                        <td className={`${TD} font-mono text-xs`}>{ap3x(text(job.payment_lovelace))}</td>
                        <td className={TD}>{text(job.outcome) ?? "—"}</td>
                        <td className={TD}><TxLink tx={text(job.last_tx)} /></td>
                        <td className={TD}>{text(job.created_slot) ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Section>

      <div className="space-y-2">
        <Raw title="Resolution JSON" value={body} />
        <Raw title="DID document" value={body?.didDocument} />
        <Raw title="Decoded credential" value={credential ? { status: credential.status, header: credential.header, payload: credential.payload, message: credential.message } : undefined} />
        <Raw title="Status-list bits" value={bits ?? (bitsError ? { error: bitsError } : undefined)} />
      </div>
    </div>
  );
}
