/**
 * buyer/src/ui/pages/Paper2Agent.tsx — paper submission and build results.
 *
 *   Submit a paper → generate and execute code → inspect results.
 *   Operator controls retain explicit review and publication approval.
 *
 * Every request goes to the same-origin, session-authenticated
 * /v1/paper2agent/* proxy. The browser never holds the control token or a
 * wallet key. Changes send X-Paper2Agent-Request: 1. The open job lives in
 * ?job=<id>, so a reload or a shared link reconnects to it. Progress polling
 * runs only while a build is active and stops on unmount or job change.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  PaperBuildBudget,
  PaperBuildEvent,
  PaperBuildJob,
  PaperBuildJobSummary,
  PaperBuildState,
  PaperPackageArtifact,
  PaperPublication,
  PaperPublicationState,
  PaperPublishApproval,
  PaperPublishTarget,
  PaperPublishTerms,
  PaperReview,
  PaperVerification,
  PaperWorkflowReadiness,
} from "@marketplace/shared/paper2agent/workflow";

const API = "/v1/paper2agent";
const CHANGE_HEADER = { "X-Paper2Agent-Request": "1" };
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HTTPS_URL_RE = /^https:\/\/\S+$/i;
const POLL_MS = 3_000;
const LIST_POLL_MS = 10_000;
const RETRY_MS = 10_000;
const EVENT_PAGE_SIZE = 100;
const MAX_EVENT_PAGES_PER_POLL = 20;
const MAX_VISIBLE_EVENTS = 2_000;
const MAX_LISTED_FILES = 500;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PAPER_TEXT_CHARS = 100_000;
/** The control service rejects build time limits under one minute. */
const MIN_BUILD_MINUTES = 1;
const LOVELACE_PER_AP3X = 1_000_000n;
/** An advert output holds the supplier bond, but never less than this minimum. */
const MIN_ADVERT_OUTPUT_LOVELACE = 2_000_000n;

const PANEL = "space-y-3 rounded-lg border border-gray-200 bg-white p-4";
const INPUT =
  "mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm font-normal focus:border-gray-400 focus:outline-none disabled:opacity-50";
const PRIMARY_BUTTON =
  "rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-gray-400";
const DANGER_BUTTON =
  "rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-gray-400";
const SECONDARY_BUTTON =
  "rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const CODE_BLOCK =
  "max-h-96 overflow-auto whitespace-pre rounded border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800";

type Tone = "neutral" | "progress" | "attention" | "success" | "danger";
type PaperSource = "url" | "pdf" | "text";
type Attestation = "code_reviewed" | "license_reviewed" | "results_reviewed";

interface JobStateInfo {
  label: string;
  tone: Tone;
  /** Work is running, so the page keeps polling. */
  active: boolean;
  /** The control service accepts a new build approval. */
  buildable: boolean;
}

interface EventPage {
  events: PaperBuildEvent[];
  next_seq: number;
}

interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
}

const TONES: Record<Tone, string> = {
  neutral: "border-gray-300 bg-gray-50 text-gray-700",
  progress: "border-blue-300 bg-blue-50 text-blue-800",
  attention: "border-amber-300 bg-amber-50 text-amber-900",
  success: "border-green-300 bg-green-50 text-green-800",
  danger: "border-red-300 bg-red-50 text-red-700",
};

const JOB_STATES: Record<PaperBuildState, JobStateInfo> = {
  submitted: { label: "Submitted", tone: "neutral", active: false, buildable: true },
  queued: { label: "Queued", tone: "progress", active: true, buildable: false },
  building: { label: "Building", tone: "progress", active: true, buildable: false },
  verifying: { label: "Verifying", tone: "progress", active: true, buildable: false },
  awaiting_review: { label: "Awaiting review", tone: "attention", active: false, buildable: false },
  approved: { label: "Approved", tone: "success", active: false, buildable: false },
  rejected: { label: "Rejected", tone: "danger", active: false, buildable: true },
  failed: { label: "Failed", tone: "danger", active: false, buildable: true },
  interrupted: { label: "Interrupted", tone: "attention", active: false, buildable: true },
  cancelled: { label: "Cancelled", tone: "neutral", active: false, buildable: true },
};

const PUBLICATION_STATES: Record<PaperPublicationState, { label: string; tone: Tone }> = {
  prepared: { label: "Prepared, not published", tone: "attention" },
  publishing: { label: "Publishing", tone: "progress" },
  confirmation_pending: { label: "Confirmation pending", tone: "attention" },
  published: { label: "Published", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const NETWORKS: Record<0 | 1, string> = { 0: "Testnet", 1: "Mainnet" };

const PAPER_SOURCES: Record<PaperSource, string> = {
  url: "Paper URL",
  pdf: "Upload the original PDF",
  text: "Paste the paper text",
};
const PAPER_SOURCE_ORDER: PaperSource[] = ["pdf", "url", "text"];

const ATTESTATIONS: Record<Attestation, { claim: string; record: string }> = {
  code_reviewed: {
    claim: "I read the generated code. It does only what the manifest describes.",
    record: "Code reviewed",
  },
  license_reviewed: {
    claim: "The code license, paper rights, and data rights allow this tool to be offered as a paid service.",
    record: "License and data rights reviewed",
  },
  results_reviewed: {
    claim: "I compared the verification program, its actual output, and the acceptance cases with the paper's results.",
    record: "Results reviewed",
  },
};
const ATTESTATION_ORDER: Attestation[] = ["code_reviewed", "license_reviewed", "results_reviewed"];

// ─── Proxy calls ──────────────────────────────────────────────────────────

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** GET or POST one /v1/paper2agent path and return its JSON object body. */
async function call<T extends object>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { credentials: "same-origin", cache: "no-store", ...init });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, "The buyer server did not respond. Check the connection, then refresh.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
        ? body.message
        : "";
    throw new ApiError(response.status, message || `The request failed with HTTP ${response.status}.`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(response.status, "The buyer server returned an unexpected response.");
  }
  // The control service builds these bodies from the shared workflow types.
  const typed = body as T;
  return typed;
}

function change<T extends object>(path: string, payload: object): Promise<T> {
  return call<T>(path, {
    method: "POST",
    headers: { ...CHANGE_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Read one proxy path. Aborts the request on unmount and on reload. */
function useResource<T extends object>(path: string): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    call<T>(path, { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload };
}

// ─── Formatting ───────────────────────────────────────────────────────────

function jobState(state: PaperBuildState): JobStateInfo {
  // A state from a newer server renders as inactive instead of breaking the page.
  return JOB_STATES[state] ?? { label: state, tone: "neutral", active: false, buildable: false };
}

/** Exact AP3X decimal for a lovelace integer string. */
function ap3xAmount(lovelace: string): string {
  if (!/^\d+$/.test(lovelace)) return lovelace;
  const value = BigInt(lovelace);
  const whole = (value / LOVELACE_PER_AP3X).toString();
  const fraction = (value % LOVELACE_PER_AP3X).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function lovelaceLabel(lovelace: string): string {
  return `${ap3xAmount(lovelace)} AP3X (${lovelace} lovelace)`;
}

/** AP3X with at most 6 decimals → exact lovelace string; null when malformed. */
function parseAp3x(text: string): string | null {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (match === null) return null;
  return (BigInt(match[1]) * LOVELACE_PER_AP3X + BigInt((match[2] ?? "").padEnd(6, "0"))).toString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function budgetText(budget: PaperBuildBudget): string {
  return `${budget.max_model_calls} model calls, ${budget.max_output_tokens} output tokens per call, ${
    budget.timeout_ms / 60_000
  } minutes in total`;
}

/** Validate the operator's build limits against the service maximum. */
function parseBudget(calls: string, tokens: string, minutes: string, max: PaperBuildBudget): PaperBuildBudget | string {
  const whole = (text: string): number => (/^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : 0);
  const maxMinutes = Math.floor(max.timeout_ms / 60_000);
  const callCount = whole(calls);
  const tokenCount = whole(tokens);
  const minuteCount = whole(minutes);
  if (callCount < 4 || callCount > max.max_model_calls) {
    return `Model calls must be a whole number from 4 to ${max.max_model_calls}.`;
  }
  if (tokenCount < 1 || tokenCount > max.max_output_tokens) {
    return `Output tokens per call must be a whole number from 1 to ${max.max_output_tokens}.`;
  }
  if (minuteCount < MIN_BUILD_MINUTES || minuteCount > maxMinutes) {
    return `Total time must be a whole number of minutes from ${MIN_BUILD_MINUTES} to ${maxMinutes}.`;
  }
  return { max_model_calls: callCount, max_output_tokens: tokenCount, timeout_ms: minuteCount * 60_000 };
}

// ─── Small building blocks ────────────────────────────────────────────────

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

function Callout({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <div className={`rounded border p-3 text-sm ${TONES[tone]}`}>{children}</div>;
}

function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={`rounded border p-3 text-sm ${TONES.danger}`}>
      {children}
    </div>
  );
}

function Panel({ id, title, actions, children }: { id: string; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={PANEL}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-gray-900">{children}</dd>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="break-all font-mono text-xs">{children}</code>;
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className={CODE_BLOCK}>{JSON.stringify(value, null, 2)}</pre>;
}

/** Only HTTPS values become links; anything else stays inert text. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!HTTPS_URL_RE.test(href)) return <span className="break-all">{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-indigo-700 hover:underline">
      {children}
    </a>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => {
        // Clipboard access can be blocked (insecure context); the value stays visible.
        void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
      }}
      className="ml-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function PublicationBadge({ state }: { state: PaperPublicationState }) {
  const info: { label: string; tone: Tone } = PUBLICATION_STATES[state] ?? { label: state, tone: "neutral" };
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

function BackLink() {
  return (
    <Link to="/paper2agent" className="text-sm text-gray-600 hover:underline">
      ← All Paper2Agent jobs
    </Link>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function Paper2Agent() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("job");
  const readiness = useResource<PaperWorkflowReadiness>("/status");
  const openJob = useCallback((id: string) => setParams({ job: id }), [setParams]);

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Paper2Agent</h1>
        <p className="text-sm text-gray-600">
          Submit a paper. The marketplace generates code and runs checks automatically.
          The code and results still need marketplace review. Passing checks is not scientific proof.
        </p>
      </div>

      <ReadinessPanel readiness={readiness} />

      {selected === null ? (
        <>
          <SubmissionForm onCreated={(job) => openJob(job.id)} />
          <JobList />
          <details className={PANEL}>
            <summary className="cursor-pointer text-sm font-medium">Open a job by ID</summary>
            <OpenJobForm onOpen={openJob} />
          </details>
        </>
      ) : JOB_ID_RE.test(selected) ? (
        <JobDetail key={selected} jobId={selected} readiness={readiness.data} />
      ) : (
        <div className="space-y-3">
          <BackLink />
          <ErrorMessage>“{selected}” is not a Paper2Agent job ID.</ErrorMessage>
        </div>
      )}
    </div>
  );
}

function ReadinessPanel({ readiness }: { readiness: Resource<PaperWorkflowReadiness> }) {
  const { data, error, loading, reload } = readiness;
  return (
    <Panel
      id="p2a-status"
      title="Service status"
      actions={
        <button type="button" onClick={reload} disabled={loading} className={SECONDARY_BUTTON}>
          {loading ? "Checking…" : "Check again"}
        </button>
      }
    >
      {error !== null ? (
        <ErrorMessage>{error}</ErrorMessage>
      ) : data === null ? (
        <p role="status" className="text-sm text-gray-500">
          Checking the Paper2Agent services…
        </p>
      ) : (
        <>
          <dl>
            <ServiceState name="Build service" ready={data.build_ready} problem={data.build_error} />
          </dl>
          <details>
            <summary className="cursor-pointer text-sm font-medium">Operator service details</summary>
            <dl className="mt-3">
              <ServiceState name="Publisher" ready={data.publisher_ready} problem={data.publisher_error} />
            </dl>
            <p className="mt-2 text-xs text-gray-500">
              Build limits: default {budgetText(data.default_budget)}; maximum {budgetText(data.maximum_budget)}.
            </p>
          </details>
        </>
      )}
    </Panel>
  );
}

function ServiceState({ name, ready, problem }: { name: string; ready: boolean; problem: string | null }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <dt className="flex items-center gap-2 text-sm font-medium">
        {name}
        <Badge tone={ready ? "success" : "danger"}>{ready ? "Ready" : "Not ready"}</Badge>
      </dt>
      <dd className="mt-1 text-sm text-gray-600">
        {problem ?? (ready ? "The service reports that it is ready." : "The service did not report a reason.")}
      </dd>
    </div>
  );
}

// ─── Job list, reconnect and submission ───────────────────────────────────

function JobList() {
  const { data, error, loading, reload } = useResource<{ jobs: PaperBuildJobSummary[] }>("/jobs");
  const jobs = data?.jobs ?? null;
  const anyActive = jobs?.some((job) => jobState(job.state).active) ?? false;

  // Refresh slowly only while a listed build is still running.
  useEffect(() => {
    if (!anyActive || loading) return;
    const timer = setTimeout(reload, LIST_POLL_MS);
    return () => clearTimeout(timer);
  }, [anyActive, loading, reload]);

  return (
    <Panel
      id="p2a-jobs"
      title="Jobs"
      actions={
        <button type="button" onClick={reload} disabled={loading} className={SECONDARY_BUTTON}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      }
    >
      {error !== null && <ErrorMessage>{error}</ErrorMessage>}
      {jobs === null ? (
        error === null && (
          <p role="status" className="text-sm text-gray-500">
            Loading jobs…
          </p>
        )
      ) : jobs.length === 0 ? (
        <p className="text-sm text-gray-500">No Paper2Agent jobs yet. Submit a paper above.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Paper2Agent jobs, newest first</caption>
            <thead className="border-b text-gray-500">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Job</th>
                <th scope="col" className="py-2 pr-4 font-medium">State</th>
                <th scope="col" className="py-2 pr-4 font-medium">Paper</th>
                <th scope="col" className="py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map((job) => {
                const state = jobState(job.state);
                return (
                  <tr key={job.id}>
                    <td className="py-2 pr-4 align-top">
                      <Link to={`/paper2agent?job=${job.id}`} className="font-medium text-indigo-700 hover:underline">
                        {job.title}
                      </Link>
                      <div className="font-mono text-xs text-gray-500">{job.id}</div>
                    </td>
                    <td className="py-2 pr-4 align-top">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={state.tone}>{state.label}</Badge>
                        {job.publication_state !== null && <PublicationBadge state={job.publication_state} />}
                      </div>
                    </td>
                    <td className="py-2 pr-4 align-top">
                      {job.paper_url === "" ? "Uploaded PDF or text" : (
                        <ExternalLink href={job.paper_url}>{job.paper_url}</ExternalLink>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 align-top text-gray-600">
                      {new Date(job.updated_at).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function OpenJobForm({ onOpen }: { onOpen: (id: string) => void }) {
  const [value, setValue] = useState("");
  const id = value.trim().toLowerCase();
  const valid = JOB_ID_RE.test(id);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onOpen(id);
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <label className="block w-full max-w-md text-sm font-medium text-gray-700">
        Open a job by ID
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Job ID (UUID)"
          spellCheck={false}
          autoComplete="off"
          className={`${INPUT} font-mono`}
        />
      </label>
      <button type="submit" disabled={!valid} className={SECONDARY_BUTTON}>
        Open job
      </button>
    </form>
  );
}

interface SubmissionDraft {
  source: PaperSource;
  paperUrl: string;
  pdf: File | null;
  paperText: string;
}

/** First reason the draft cannot be submitted, or null. The server validates again. */
function submissionProblem(draft: SubmissionDraft): string | null {
  const paperUrl = draft.paperUrl.trim();
  if (draft.source === "url" && !HTTPS_URL_RE.test(paperUrl)) return "Enter the paper's HTTPS URL.";
  if (draft.source === "pdf" && draft.pdf === null) return "Choose the paper PDF.";
  if (draft.source === "pdf" && draft.pdf !== null && draft.pdf.size > MAX_PDF_BYTES) {
    return "The PDF is larger than 5 MiB.";
  }
  if (draft.source === "text" && draft.paperText.trim() === "") return "Paste the paper text.";
  if (draft.source === "text" && draft.paperText.length > MAX_PAPER_TEXT_CHARS) {
    return "The paper text is longer than 100,000 characters.";
  }
  return null;
}

function SubmissionForm({ onCreated }: { onCreated: (job: PaperBuildJob) => void }) {
  const [draft, setDraft] = useState<SubmissionDraft>({
    source: "pdf",
    paperUrl: "",
    pdf: null,
    paperText: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = submissionProblem(draft);
  const update = (patch: Partial<SubmissionDraft>): void => setDraft((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (problem !== null || submitting) return;
    setSubmitting(true);
    setError(null);
    const form = new FormData();
    if (draft.source === "url") form.append("paper_url", draft.paperUrl.trim());
    if (draft.source === "text") form.append("paper_text", draft.paperText);
    if (draft.source === "pdf" && draft.pdf !== null) form.append("paper_pdf", draft.pdf, draft.pdf.name);
    try {
      onCreated(await call<PaperBuildJob>("/jobs", { method: "POST", headers: CHANGE_HEADER, body: form }));
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="p2a-submit" className={PANEL}>
      <h2 id="p2a-submit" className="text-lg font-semibold">
        New submission
      </h2>
      <p className="text-sm text-gray-600">
        Submission starts code generation and execution. Missing data or an unsupported method can stop the build.
        Do not submit confidential or personal data. Papers, code, and results are stored as plain text.
      </p>

      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700">Paper source</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {PAPER_SOURCE_ORDER.map((source) => (
              <label key={source} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="p2a-paper-source"
                  value={source}
                  checked={draft.source === source}
                  onChange={() => update({ source })}
                  disabled={submitting}
                />
                {PAPER_SOURCES[source]}
              </label>
            ))}
          </div>
        </fieldset>

        {draft.source === "url" && (
          <div>
          <label className="block text-sm font-medium text-gray-700">
            Paper URL
            <input
              type="url"
              value={draft.paperUrl}
              onChange={(e) => update({ paperUrl: e.target.value })}
              placeholder="https://arxiv.org/pdf/…"
              disabled={submitting}
              className={INPUT}
            />
          </label>
          <p className="mt-1 text-xs text-gray-500">
            The builder downloads this HTTPS URL.
          </p>
          </div>
        )}

        {draft.source === "pdf" && (
          <label className="block text-sm font-medium text-gray-700">
            Paper PDF <span className="font-normal text-gray-400">(5 MiB maximum)</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => update({ pdf: e.target.files?.[0] ?? null })}
              disabled={submitting}
              className="mt-1 block text-sm text-gray-700 file:mr-3 file:rounded file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-white hover:file:bg-indigo-700"
            />
          </label>
        )}

        {draft.source === "text" && (
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Paper text{" "}
              <span className="font-normal text-gray-400">
                ({draft.paperText.length.toLocaleString()} of {MAX_PAPER_TEXT_CHARS.toLocaleString()} characters)
              </span>
              <textarea
                value={draft.paperText}
                onChange={(e) => update({ paperText: e.target.value })}
                rows={8}
                disabled={submitting}
                className={INPUT}
              />
            </label>
            <p className="mt-1 text-xs text-gray-500">The agent treats this text as reference material, not as instructions.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={problem !== null || submitting} className={PRIMARY_BUTTON}>
            {submitting ? "Submitting…" : "Submit and build"}
          </button>
          {problem !== null && <span className="text-xs text-gray-500">{problem}</span>}
        </div>
        {error !== null && <ErrorMessage>{error}</ErrorMessage>}
      </form>
    </section>
  );
}

// ─── Job detail ───────────────────────────────────────────────────────────

function JobDetail({ jobId, readiness }: { jobId: string; readiness: PaperWorkflowReadiness | null }) {
  const [job, setJob] = useState<PaperBuildJob | null>(null);
  const [events, setEvents] = useState<PaperBuildEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const lastSeq = useRef(0);
  const active = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: number | undefined;

    async function readEvents(): Promise<void> {
      for (let page = 0; page < MAX_EVENT_PAGES_PER_POLL; page++) {
        const result = await call<EventPage>(`/jobs/${jobId}/events?after=${lastSeq.current}`, { signal });
        const fresh = result.events.filter((event) => event.seq > lastSeq.current);
        if (fresh.length > 0) setEvents((previous) => [...previous, ...fresh].slice(-MAX_VISIBLE_EVENTS));
        if (result.next_seq <= lastSeq.current) return;
        lastSeq.current = result.next_seq;
        if (result.events.length < EVENT_PAGE_SIZE) return;
      }
    }

    async function poll(): Promise<void> {
      let delay = POLL_MS;
      try {
        const next = await call<PaperBuildJob>(`/jobs/${jobId}`, { signal });
        active.current = jobState(next.state).active;
        setJob(next);
        setLoadError(null);
        await readEvents();
      } catch (error) {
        if (signal.aborted) return;
        setLoadError(errorText(error));
        if (error instanceof ApiError && error.status === 404) return;
        delay = RETRY_MS;
      }
      // Finished jobs are read once; only running work keeps polling.
      if (!signal.aborted && active.current) timer = window.setTimeout(() => void poll(), delay);
    }

    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [jobId, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const applyJob = useCallback((next: PaperBuildJob) => {
    active.current = jobState(next.state).active;
    setJob(next);
    // Read new events and resume polling when the change started work.
    setVersion((v) => v + 1);
  }, []);

  if (job === null) {
    return (
      <div className="space-y-3">
        <BackLink />
        {loadError === null ? (
          <p role="status" className="text-sm text-gray-500">
            Loading job…
          </p>
        ) : (
          <>
            <ErrorMessage>{loadError}</ErrorMessage>
            <button type="button" onClick={reload} className={SECONDARY_BUTTON}>
              Try again
            </button>
          </>
        )}
      </div>
    );
  }

  const state = jobState(job.state);
  return (
    <div className="space-y-4">
      <BackLink />
      <JobHeader job={job} onRefresh={reload} />
      {loadError !== null && (
        <ErrorMessage>
          This job could not be refreshed: {loadError}
          {state.active ? " Retrying automatically." : ""}
        </ErrorMessage>
      )}
      <ProgressPanel job={job} events={events} />
      {job.artifact !== null && <ResultsPanel job={job} artifact={job.artifact} />}
      <details className={PANEL}>
        <summary className="cursor-pointer font-medium">Operator review and publication</summary>
        <p className="text-sm text-gray-600">
          Review and publication need explicit approval.
          Submitting a paper does not spend wallet funds.
        </p>
        <SubmissionDetails job={job} />
        {job.budget !== null && (
          <p className="text-sm text-gray-600">Approved build limits: {budgetText(job.budget)}.</p>
        )}
        {state.buildable && job.publication === null && <BuildPanel job={job} readiness={readiness} onJob={applyJob} />}
        {state.active && <CancelBuild job={job} onJob={applyJob} />}
        {job.artifact !== null && <ArtifactPanel job={job} artifact={job.artifact} />}
        {job.artifact !== null && <VerificationPanel verification={job.artifact.verification} />}
        {job.state === "awaiting_review" && job.artifact !== null ? (
          <ReviewForm job={job} artifact={job.artifact} onJob={applyJob} />
        ) : (
          job.review !== null && <ReviewRecord job={job} review={job.review} />
        )}
        {(job.state === "approved" || job.publication !== null) && (
          <PublicationPanel job={job} onJob={applyJob} onReload={reload} />
        )}
      </details>
    </div>
  );
}

function JobHeader({ job, onRefresh }: { job: PaperBuildJob; onRefresh: () => void }) {
  const state = jobState(job.state);
  return (
    <div className={PANEL}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{job.submission.title}</h2>
        <Badge tone={state.tone}>{state.label}</Badge>
        {job.publication !== null && <PublicationBadge state={job.publication.state} />}
        <button type="button" onClick={onRefresh} className={`${SECONDARY_BUTTON} ml-auto`}>
          Refresh
        </button>
      </div>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <Detail label="Job ID">
          <Mono>{job.id}</Mono>
          <CopyButton value={job.id} label="Copy" />
        </Detail>
        <Detail label="Build attempts">{job.attempt}</Detail>
        <Detail label="Created">{new Date(job.created_at).toLocaleString()}</Detail>
        <Detail label="Updated">{new Date(job.updated_at).toLocaleString()}</Detail>
      </dl>
      {job.error !== null && <ErrorMessage>{job.error}</ErrorMessage>}
    </div>
  );
}

function SubmissionDetails({ job }: { job: PaperBuildJob }) {
  const { submission } = job;
  return (
    <Panel id="p2a-submission" title="Submission">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Detail label="Paper">
          {submission.paper_url === "" ? (
            "Uploaded PDF or paper text"
          ) : (
            <ExternalLink href={submission.paper_url}>{submission.paper_url}</ExternalLink>
          )}
        </Detail>
      </dl>
      {submission.paper_text !== undefined && submission.paper_text !== "" && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Supplied paper text ({submission.paper_text.length.toLocaleString()} characters)
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800">
            {submission.paper_text}
          </pre>
        </details>
      )}
    </Panel>
  );
}

// ─── Build approval, cancellation and progress ────────────────────────────

function BuildPanel({
  job,
  readiness,
  onJob,
}: {
  job: PaperBuildJob;
  readiness: PaperWorkflowReadiness | null;
  onJob: (job: PaperBuildJob) => void;
}) {
  return (
    <Panel id="p2a-build" title={job.attempt > 0 ? "Approve a new build attempt" : "Approve build"}>
      {readiness === null ? (
        <p className="text-sm text-gray-600">
          Build approval needs the service status. Use “Check again” under Service status.
        </p>
      ) : (
        <BuildApprovalForm job={job} readiness={readiness} onJob={onJob} />
      )}
    </Panel>
  );
}

function BuildApprovalForm({
  job,
  readiness,
  onJob,
}: {
  job: PaperBuildJob;
  readiness: PaperWorkflowReadiness;
  onJob: (job: PaperBuildJob) => void;
}) {
  const max = readiness.maximum_budget;
  const initial = job.budget ?? readiness.default_budget;
  const maxMinutes = Math.floor(max.timeout_ms / 60_000);
  const [calls, setCalls] = useState(String(Math.min(initial.max_model_calls, max.max_model_calls)));
  const [tokens, setTokens] = useState(String(Math.min(initial.max_output_tokens, max.max_output_tokens)));
  const [minutes, setMinutes] = useState(
    String(Math.min(Math.max(MIN_BUILD_MINUTES, Math.round(initial.timeout_ms / 60_000)), maxMinutes)),
  );
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const budget = parseBudget(calls, tokens, minutes, max);

  const startBuild = async (): Promise<void> => {
    if (typeof budget === "string" || !approved || busy) return;
    setBusy(true);
    setError(null);
    try {
      onJob(await change<PaperBuildJob>(`/jobs/${job.id}/build`, { confirm: true, budget }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // Any edit to the limits withdraws the approval for the old limits.
  const edit = (setter: (value: string) => void) => (value: string): void => {
    setter(value);
    setApproved(false);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        The build service calls the configured language model. The generated code runs in an isolated container.
        A separate verifier run uses a fresh conversation to write and run its own test program.
        You approve the limits below for this job only.
      </p>
      <Callout tone="attention">
        These are resource limits, not a price quote. The model provider bills its configured account for actual
        usage. The marketplace does not convert these limits to AP3X or to any other currency.
      </Callout>
      {job.artifact !== null && (
        <p className="text-sm text-gray-600">A new attempt builds a new artifact that you must review again.</p>
      )}
      {!readiness.build_ready && (
        <ErrorMessage>The build service is not ready: {readiness.build_error ?? "it did not report a reason."}</ErrorMessage>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-medium text-gray-700">
          Model calls (4–{max.max_model_calls})
          <input
            type="number"
            inputMode="numeric"
            min={4}
            max={max.max_model_calls}
            step={1}
            value={calls}
            onChange={(e) => edit(setCalls)(e.target.value)}
            disabled={busy}
            className={INPUT}
          />
        </label>
        <label className="block text-sm font-medium text-gray-700">
          Output tokens per call (1–{max.max_output_tokens})
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={max.max_output_tokens}
            step={1}
            value={tokens}
            onChange={(e) => edit(setTokens)(e.target.value)}
            disabled={busy}
            className={INPUT}
          />
        </label>
        <label className="block text-sm font-medium text-gray-700">
          Total time in minutes ({MIN_BUILD_MINUTES}–{maxMinutes})
          <input
            type="number"
            inputMode="numeric"
            min={MIN_BUILD_MINUTES}
            max={maxMinutes}
            step={1}
            value={minutes}
            onChange={(e) => edit(setMinutes)(e.target.value)}
            disabled={busy}
            className={INPUT}
          />
        </label>
      </div>
      {typeof budget === "string" ? (
        <p className="text-xs text-red-700">{budget}</p>
      ) : (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
            disabled={busy}
            className="mt-1"
          />
          <span>I approve model spending for this job within these limits: {budgetText(budget)}.</span>
        </label>
      )}
      <button
        type="button"
        onClick={() => void startBuild()}
        disabled={typeof budget === "string" || !approved || busy || !readiness.build_ready}
        className={PRIMARY_BUTTON}
      >
        {busy ? "Starting…" : "Start build"}
      </button>
      {error !== null && <ErrorMessage>{error}</ErrorMessage>}
    </div>
  );
}

function CancelBuild({ job, onJob }: { job: PaperBuildJob; onJob: (job: PaperBuildJob) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onJob(await change<PaperBuildJob>(`/jobs/${job.id}/cancel`, {}));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Stop this build now? Model usage so far is still billed.</span>
          <button type="button" onClick={() => void cancel()} disabled={busy} className={DANGER_BUTTON}>
            {busy ? "Cancelling…" : "Confirm cancellation"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={SECONDARY_BUTTON}>
            Keep building
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={SECONDARY_BUTTON}>
          Cancel build
        </button>
      )}
      {error !== null && <ErrorMessage>{error}</ErrorMessage>}
    </div>
  );
}

function ProgressPanel({ job, events }: { job: PaperBuildJob; events: PaperBuildEvent[] }) {
  const state = jobState(job.state);
  const logRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const log = logRef.current;
    if (log !== null) log.scrollTop = log.scrollHeight;
  }, [events.length]);

  return (
    <Panel id="p2a-progress" title="Build progress">
      {state.active && (
        <p role="status" className="text-sm text-blue-800">
          {state.label}. This page refreshes every 3 seconds while the build runs. You can leave and reopen this job
          later; the build continues on the server.
        </p>
      )}
      {events.length === 0 ? (
        <p className="text-sm text-gray-500">
          {job.state === "submitted" ? "No build has run yet." : "No build events are recorded yet."}
        </p>
      ) : (
        <ol
          ref={logRef}
          aria-label="Build events"
          className="max-h-80 space-y-1 overflow-auto rounded border border-gray-200 bg-gray-50 p-3 font-mono text-xs"
        >
          {events.map((event) => (
            <li key={event.seq} className="whitespace-pre-wrap break-words">
              <span className="text-gray-500">{new Date(event.at).toLocaleTimeString()}</span>{" "}
              <span className="font-semibold">[{event.phase}]</span> {event.message}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ─── Artifact, files and verification ─────────────────────────────────────

function ResultsPanel({ job, artifact }: { job: PaperBuildJob; artifact: PaperPackageArtifact }) {
  const { verification } = artifact;
  return (
    <Panel
      id="p2a-results"
      title="Executed results"
      actions={
        <a href={`${API}/jobs/${job.id}/package`} download className={PRIMARY_BUTTON}>
          Download code (.zip)
        </a>
      }
    >
      <p className="whitespace-pre-wrap text-sm text-gray-700">{artifact.manifest.description}</p>
      <p className="text-sm text-gray-600">
        This is the check program's actual output. Passing these checks does not prove the paper's claims.
        See the operator view for the code and full review.
      </p>
      <pre aria-label="Executed check output" className={CODE_BLOCK}>
        {verification.test_stdout === "" ? "(The program printed nothing.)" : verification.test_stdout}
      </pre>
      <h3 className="text-sm font-semibold">Check cases ({verification.cases.length})</h3>
      {verification.cases.length === 0 ? (
        <p className="text-sm text-gray-500">No check cases are recorded.</p>
      ) : (
        <ul className="space-y-2">
          {verification.cases.map((testCase, index) => (
            <li key={`${index}:${testCase.name}`}>
              <details className="rounded border border-gray-200 p-2">
                <summary className="cursor-pointer text-sm font-medium">{testCase.name}</summary>
                <div className="mt-2 grid gap-2 lg:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium text-gray-500">Input</p>
                    <JsonBlock value={testCase.input} />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500">Expected output (not an executed result)</p>
                    <JsonBlock value={testCase.expected} />
                  </div>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ArtifactPanel({ job, artifact }: { job: PaperBuildJob; artifact: PaperPackageArtifact }) {
  const { manifest } = artifact;
  return (
    <Panel
      id="p2a-artifact"
      title="Built artifact"
      actions={
        <a href={`${API}/jobs/${job.id}/package`} download className={PRIMARY_BUTTON}>
          Download code (.zip)
        </a>
      }
    >
      {manifest.package_sha256 !== artifact.sha256 && (
        <ErrorMessage>
          The manifest's package hash does not match the bundle hash. Do not approve this artifact.
        </ErrorMessage>
      )}
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Detail label="Publication bundle SHA-256">
          <Mono>{artifact.sha256}</Mono>
        </Detail>
        <Detail label="Manifest hash">
          <Mono>{artifact.manifest_hash}</Mono>
        </Detail>
        <Detail label="Paper SHA-256">
          <Mono>{artifact.paper_sha256}</Mono>
        </Detail>
        <Detail label="Runtime base image">
          <Mono>{artifact.runtime_image}</Mono>
        </Detail>
      </dl>
      <p className="text-xs text-gray-500">
        The ZIP contains the verified package files. This hash identifies the internal publication bundle,
        not the ZIP download. Each file's SHA-256 appears in the file list below.
      </p>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Tool manifest</h3>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <Detail label="Tool name">
            <Mono>{manifest.name}</Mono>
          </Detail>
          <Detail label="Limits per call">
            Input up to {formatBytes(manifest.limits.max_input_bytes)}, output up to{" "}
            {formatBytes(manifest.limits.max_output_bytes)}, run time up to {manifest.limits.max_runtime_ms / 1000} s
          </Detail>
        </dl>
        <p className="whitespace-pre-wrap text-sm text-gray-700">{manifest.description}</p>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Input schema</summary>
          <JsonBlock value={manifest.input_schema} />
        </details>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Output schema</summary>
          <JsonBlock value={manifest.output_schema} />
        </details>
      </div>

      <FileBrowser jobId={job.id} artifact={artifact} />
    </Panel>
  );
}

function FileBrowser({ jobId, artifact }: { jobId: string; artifact: PaperPackageArtifact }) {
  const files = useMemo(() => [...artifact.files].sort((a, b) => a.path.localeCompare(b.path)), [artifact.files]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(
    () => artifact.files.find((file) => file.path === "server.py")?.path ?? null,
  );
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (selected === null) return;
    const controller = new AbortController();
    call<FilePreview>(`/jobs/${jobId}/files?path=${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setPreview(next);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [jobId, artifact.sha256, selected]);

  const needle = filter.trim().toLowerCase();
  const matches = needle === "" ? files : files.filter((file) => file.path.toLowerCase().includes(needle));
  const listed = matches.slice(0, MAX_LISTED_FILES);
  const selectedFile = files.find((file) => file.path === selected) ?? null;
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">
        Files ({files.length}, {formatBytes(totalBytes)})
      </h3>
      <label className="block max-w-sm text-sm font-medium text-gray-700">
        Filter files
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} className={INPUT} />
      </label>
      <div className="grid gap-3 lg:grid-cols-5">
        <div className="space-y-1 lg:col-span-2">
          <ul aria-label="Artifact files" className="max-h-[28rem] divide-y divide-gray-100 overflow-auto rounded border border-gray-200">
            {listed.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setSelected(file.path)}
                  aria-pressed={file.path === selected}
                  title={`SHA-256 ${file.sha256}`}
                  className={`flex w-full items-start justify-between gap-2 px-2 py-1 text-left font-mono text-xs hover:bg-gray-50 ${
                    file.path === selected ? "bg-indigo-50" : ""
                  }`}
                >
                  <span className="break-all">{file.path}</span>
                  <span className="shrink-0 text-gray-500">{formatBytes(file.bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
          {matches.length === 0 && <p className="text-xs text-gray-500">No file matches the filter.</p>}
          {matches.length > listed.length && (
            <p className="text-xs text-gray-500">
              Showing the first {MAX_LISTED_FILES} of {matches.length} matching files. Narrow the filter to see the
              others.
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-2 lg:col-span-3">
          {selectedFile === null ? (
            <p className="text-sm text-gray-500">Select a file to read its content.</p>
          ) : (
            <>
              <p className="text-xs text-gray-600">
                <Mono>{selectedFile.path}</Mono> · {formatBytes(selectedFile.bytes)} · SHA-256{" "}
                <Mono>{selectedFile.sha256}</Mono>
              </p>
              {error !== null && <ErrorMessage>{error}</ErrorMessage>}
              {preview === null && error === null && (
                <p role="status" className="text-sm text-gray-500">
                  Loading file…
                </p>
              )}
              {preview !== null && (
                <>
                  {preview.truncated && (
                    <Callout tone="attention">
                      This view shows the first 64 KiB. Download the bundle to read the whole file.
                    </Callout>
                  )}
                  <pre
                    aria-label={`Content of ${selectedFile.path}`}
                    className="max-h-[32rem] overflow-auto whitespace-pre rounded border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800"
                  >
                    {preview.content}
                  </pre>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function VerificationPanel({ verification }: { verification: PaperVerification }) {
  return (
    <Panel id="p2a-verification" title="Independent verification">
      {verification.builder_run_id === verification.verifier_run_id && (
        <ErrorMessage>
          The builder and the verifier share one run ID, so this evidence is not independent. Do not approve this
          artifact.
        </ErrorMessage>
      )}
      <p className="text-sm text-gray-600">
        A separate verifier run with a fresh conversation wrote the test program below and ran it against the built
        package. The output is the program's actual output, not a model summary.
      </p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Detail label="Builder run">
          <Mono>{verification.builder_run_id}</Mono>
        </Detail>
        <Detail label="Verifier run">
          <Mono>{verification.verifier_run_id}</Mono>
        </Detail>
        <Detail label="Model calls used">{verification.model_calls}</Detail>
        <Detail label="Model tokens">
          {verification.input_tokens === null ? "not reported" : verification.input_tokens.toLocaleString()} input,{" "}
          {verification.output_tokens === null ? "not reported" : verification.output_tokens.toLocaleString()} output
        </Detail>
      </dl>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Verification program</h3>
        <pre aria-label="Verification program" className={CODE_BLOCK}>
          {verification.test_source}
        </pre>
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Actual output</h3>
        <pre aria-label="Verification output" className={CODE_BLOCK}>
          {verification.test_stdout === "" ? "(The program printed nothing.)" : verification.test_stdout}
        </pre>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Acceptance cases ({verification.cases.length})</h3>
        {verification.cases.length === 0 ? (
          <p className="text-sm text-gray-500">No acceptance cases are recorded.</p>
        ) : (
          <ul className="space-y-2">
            {verification.cases.map((testCase, index) => (
              <li key={`${index}:${testCase.name}`}>
                <details className="rounded border border-gray-200 p-2">
                  <summary className="cursor-pointer text-sm font-medium">{testCase.name}</summary>
                  <div className="mt-2 grid gap-2 lg:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium text-gray-500">Input</p>
                      <JsonBlock value={testCase.input} />
                    </div>
                    <div>
                      <p className="text-xs font-medium text-gray-500">Expected output</p>
                      <JsonBlock value={testCase.expected} />
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Paper references</h3>
        <p className="text-xs text-gray-500">Paper sections and equations used by the tool.</p>
        <ul className="list-disc pl-5 font-mono text-xs">
          {verification.paper_references.map((binding, index) => (
            <li key={`${index}:${binding}`} className="break-all">
              {binding}
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Checks reported by the verifier</h3>
        <p className="text-xs text-gray-500">
          These are model statements. Confirm them against the program and its output above.
        </p>
        <ul className="list-disc pl-5 text-sm">
          {verification.checks.map((check, index) => (
            <li key={`${index}:${check}`}>{check}</li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

// ─── Review ───────────────────────────────────────────────────────────────

function ReviewForm({
  job,
  artifact,
  onJob,
}: {
  job: PaperBuildJob;
  artifact: PaperPackageArtifact;
  onJob: (job: PaperBuildJob) => void;
}) {
  const [checks, setChecks] = useState<Record<Attestation, boolean>>({
    code_reviewed: false,
    license_reviewed: false,
    results_reviewed: false,
  });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allChecked = ATTESTATION_ORDER.every((key) => checks[key]);

  const decide = async (decision: "approve" | "reject"): Promise<void> => {
    setBusy(decision);
    setError(null);
    try {
      onJob(
        await change<PaperBuildJob>(`/jobs/${job.id}/review`, {
          decision,
          artifact_sha256: artifact.sha256,
          ...checks,
          notes: notes.trim(),
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel id="p2a-review" title="Review">
      <p className="text-sm text-gray-600">
        Read the files, the verification program and its output, and the code license above. Your decision
        applies only to bundle <Mono>{artifact.sha256}</Mono>. Review does not publish anything or spend funds.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">Attestations (all three are required to approve)</legend>
        {ATTESTATION_ORDER.map((key) => (
          <label key={key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={checks[key]}
              onChange={(e) => setChecks((current) => ({ ...current, [key]: e.target.checked }))}
              disabled={busy !== null}
              className="mt-1"
            />
            <span>{ATTESTATIONS[key].claim}</span>
          </label>
        ))}
      </fieldset>
      <label className="block text-sm font-medium text-gray-700">
        Notes <span className="font-normal text-gray-400">(required to reject: give the reason)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={busy !== null}
          className={INPUT}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void decide("approve")}
          disabled={!allChecked || busy !== null}
          className={PRIMARY_BUTTON}
        >
          {busy === "approve" ? "Approving…" : "Approve artifact"}
        </button>
        <button
          type="button"
          onClick={() => void decide("reject")}
          disabled={notes.trim() === "" || busy !== null}
          className={DANGER_BUTTON}
        >
          {busy === "reject" ? "Rejecting…" : "Reject artifact"}
        </button>
      </div>
      {error !== null && <ErrorMessage>{error}</ErrorMessage>}
    </Panel>
  );
}

function ReviewRecord({ job, review }: { job: PaperBuildJob; review: PaperReview }) {
  const decision =
    job.state === "rejected" ? (
      <Badge tone="danger">Rejected</Badge>
    ) : job.state === "approved" ? (
      <Badge tone="success">Approved</Badge>
    ) : (
      <Badge tone="neutral">Earlier review</Badge>
    );
  return (
    <Panel id="p2a-review" title="Review record">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        {decision}
        <span>Recorded {new Date(review.reviewed_at).toLocaleString()}</span>
      </p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Detail label="Reviewed bundle">
          <Mono>{review.artifact_sha256}</Mono>
          {job.artifact !== null && job.artifact.sha256 !== review.artifact_sha256 && (
            <span className="block text-xs text-amber-800">This is not the current artifact.</span>
          )}
        </Detail>
        <Detail label="Attestations">
          <ul>
            {ATTESTATION_ORDER.map((key) => (
              <li key={key}>
                {ATTESTATIONS[key].record}: {review[key] ? "confirmed" : "not confirmed"}
              </li>
            ))}
          </ul>
        </Detail>
      </dl>
      {review.notes !== "" && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">
            {job.state === "rejected" ? "Rejection reason" : "Notes"}
          </h3>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-gray-900">{review.notes}</p>
        </div>
      )}
    </Panel>
  );
}

// ─── Publication ──────────────────────────────────────────────────────────

function PublicationPanel({
  job,
  onJob,
  onReload,
}: {
  job: PaperBuildJob;
  onJob: (job: PaperBuildJob) => void;
  onReload: () => void;
}) {
  const targets = useResource<{ targets: PaperPublishTarget[] }>("/targets");
  const publication = job.publication;
  // A new preparation is allowed first, or again after preparation failed without a transaction.
  const canPrepare =
    job.state === "approved" &&
    (publication === null || (publication.state === "failed" && publication.tx_hash === null));
  return (
    <Panel id="p2a-publication" title="Publication">
      <p className="text-sm text-gray-600">
        Publishing runs the reviewed bundle as a marketplace supplier from one operator-funded target wallet. Buyers
        send one JSON object per call and get one JSON object back. Each call must finish within the manifest's run
        time limit, which is at most 120 seconds. Tool inputs and results are stored as plaintext on the publisher and
        supplier hosts.
      </p>
      {publication !== null && (
        <PublicationStatus
          job={job}
          publication={publication}
          targets={targets.data?.targets ?? null}
          onJob={onJob}
          onReload={onReload}
        />
      )}
      {canPrepare && <PrepareForm job={job} previous={publication} targets={targets} onJob={onJob} />}
    </Panel>
  );
}

/** Validated publication terms, or the first reason they are incomplete. */
function publishTerms(
  reviewedSha: string | null,
  artifactSha: string | null,
  target: PaperPublishTarget | null,
  price: string,
  buyerBond: string,
  supplierBond: string,
): PaperPublishTerms | string {
  if (reviewedSha === null || reviewedSha !== artifactSha) {
    return "The approved review does not cover the current artifact, so it cannot be published.";
  }
  if (target === null) return "Choose a target wallet.";
  if (!target.available) return "This target wallet is unavailable. Choose another one.";
  const priceLovelace = parseAp3x(price);
  if (priceLovelace === null || priceLovelace === "0") return "Enter a price above zero, with at most 6 decimals.";
  const buyerBondLovelace = parseAp3x(buyerBond);
  if (buyerBondLovelace === null) return "Enter the buyer bond in AP3X, with at most 6 decimals.";
  const supplierBondLovelace = parseAp3x(supplierBond);
  if (supplierBondLovelace === null) return "Enter the supplier bond in AP3X, with at most 6 decimals.";
  return {
    target_id: target.id,
    artifact_sha256: reviewedSha,
    price_lovelace: priceLovelace,
    buyer_bond_lovelace: buyerBondLovelace,
    supplier_bond_lovelace: supplierBondLovelace,
  };
}

function PrepareForm({
  job,
  previous,
  targets,
  onJob,
}: {
  job: PaperBuildJob;
  previous: PaperPublication | null;
  targets: Resource<{ targets: PaperPublishTarget[] }>;
  onJob: (job: PaperBuildJob) => void;
}) {
  const [targetId, setTargetId] = useState(previous?.terms.target_id ?? "");
  const [price, setPrice] = useState(previous === null ? "" : ap3xAmount(previous.terms.price_lovelace));
  const [buyerBond, setBuyerBond] = useState(previous === null ? "" : ap3xAmount(previous.terms.buyer_bond_lovelace));
  const [supplierBond, setSupplierBond] = useState(
    previous === null ? "" : ap3xAmount(previous.terms.supplier_bond_lovelace),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = targets.data?.targets ?? null;
  const target = list?.find((candidate) => candidate.id === targetId) ?? null;
  const terms = publishTerms(
    job.review?.artifact_sha256 ?? null,
    job.artifact?.sha256 ?? null,
    target,
    price,
    buyerBond,
    supplierBond,
  );

  const prepare = async (): Promise<void> => {
    if (typeof terms === "string" || busy) return;
    setBusy(true);
    setError(null);
    try {
      onJob(await change<PaperBuildJob>(`/jobs/${job.id}/prepare-publication`, terms));
    } catch (e) {
      setError(`${errorText(e)} Preparation is safe to repeat for this job.`);
    } finally {
      setBusy(false);
    }
  };

  const amountField = (label: string, hint: string, value: string, setValue: (next: string) => void): ReactNode => {
    const lovelace = parseAp3x(value);
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700">
          {label} (AP3X)
          <input
            type="text"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.000000"
            disabled={busy}
            className={INPUT}
          />
        </label>
        <p className="mt-1 text-xs text-gray-500">
          {hint} {lovelace === null ? "" : `= ${lovelace} lovelace.`}
        </p>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">
        {previous === null ? "Prepare publication" : "Prepare the publication again"}
      </h3>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">Target wallet</legend>
        {targets.error !== null && <ErrorMessage>{targets.error}</ErrorMessage>}
        {list === null ? (
          targets.error === null && (
            <p role="status" className="text-sm text-gray-500">
              Loading publishing targets…
            </p>
          )
        ) : list.length === 0 ? (
          <p className="text-sm text-gray-600">
            The publisher has no target wallets. Add one to the publisher's targets file, then check again.
          </p>
        ) : (
          list.map((candidate) => (
            <label
              key={candidate.id}
              className={`flex items-start gap-3 rounded border border-gray-200 p-3 ${candidate.available ? "" : "opacity-60"}`}
            >
              <input
                type="radio"
                name="p2a-target"
                value={candidate.id}
                checked={targetId === candidate.id}
                onChange={() => setTargetId(candidate.id)}
                disabled={!candidate.available || busy}
                className="mt-1"
              />
              <span className="min-w-0 space-y-1 text-sm">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {candidate.label}
                  <Badge tone="neutral">{NETWORKS[candidate.network_id] ?? `Network ${candidate.network_id}`}</Badge>
                  {!candidate.available && <Badge tone="danger">Unavailable</Badge>}
                  {!candidate.live_chain && <Badge tone="attention">LIVE_CHAIN off: publishing is refused</Badge>}
                </span>
                <span className="block text-xs text-gray-600">
                  Deposit address (fund it manually): <Mono>{candidate.deposit_address}</Mono>
                </span>
                <span className="block text-xs text-gray-600">
                  Supplier key hash: <Mono>{candidate.supplier_pkh}</Mono>
                </span>
                <span className="block break-all text-xs text-gray-600">Endpoint: {candidate.endpoint_url}</span>
              </span>
            </label>
          ))
        )}
        <button type="button" onClick={targets.reload} disabled={targets.loading} className={SECONDARY_BUTTON}>
          {targets.loading ? "Loading…" : "Reload targets"}
        </button>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        {amountField("Price per call", "Paid by the buyer for each accepted call.", price, setPrice)}
        {amountField("Buyer bond", "Each buyer also locks this amount in every call's escrow.", buyerBond, setBuyerBond)}
        {amountField(
          "Supplier bond",
          "Locked from the target wallet in the advert output when you publish.",
          supplierBond,
          setSupplierBond,
        )}
      </div>

      <p className="text-sm text-gray-600">
        Preparing sends the reviewed bundle to the publisher, which builds and checks an isolated runtime image. It
        makes no chain transaction and can take up to 5 minutes.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void prepare()}
          disabled={typeof terms === "string" || busy}
          className={PRIMARY_BUTTON}
        >
          {busy ? "Preparing…" : "Prepare publication (no transaction)"}
        </button>
        {typeof terms === "string" && <span className="text-xs text-gray-500">{terms}</span>}
      </div>
      {busy && (
        <p role="status" className="text-sm text-blue-800">
          The publisher is building the runtime image. Keep this page open; this can take up to 5 minutes.
        </p>
      )}
      {error !== null && <ErrorMessage>{error}</ErrorMessage>}
    </div>
  );
}

function PublicationStatus({
  job,
  publication,
  targets,
  onJob,
  onReload,
}: {
  job: PaperBuildJob;
  publication: PaperPublication;
  targets: PaperPublishTarget[] | null;
  onJob: (job: PaperBuildJob) => void;
  onReload: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<ApiError | null>(null);
  /** Set when a publish request failed; publishing stays locked until a refresh succeeds. */
  const [unresolved, setUnresolved] = useState<string | null>(null);
  const target = targets?.find((candidate) => candidate.id === publication.terms.target_id) ?? null;
  const uncertain = publication.state === "publishing" || publication.state === "confirmation_pending";

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      // Read-only: the publisher reports recorded chain evidence; it never makes a new transaction.
      onJob(await call<PaperBuildJob>(`/jobs/${job.id}/publication`));
      setUnresolved(null);
    } catch (e) {
      setRefreshError(e instanceof ApiError ? e : new ApiError(0, errorText(e)));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PublicationBadge state={publication.state} />
        <button type="button" onClick={() => void refresh()} disabled={refreshing} className={SECONDARY_BUTTON}>
          {refreshing ? "Refreshing…" : "Refresh publication status"}
        </button>
      </div>
      {uncertain && (
        <Callout tone="attention">
          The advert transaction outcome is not confirmed yet. Do not publish again. Refresh to read the recorded
          status; the publisher never creates a second advert transaction for this publication.
        </Callout>
      )}
      {publication.state === "failed" &&
        (publication.tx_hash === null ? (
          <Callout tone="danger">
            Preparation failed and no transaction was made. Prepare the publication again below, with the same or
            changed terms.
          </Callout>
        ) : (
          <Callout tone="danger">
            The advert transaction expired without confirmation. This target slot is permanently retired for this
            publication.
          </Callout>
        ))}
      {publication.error !== null &&
        (publication.state === "published" ? (
          <Callout tone="attention">Supplier health: {publication.error}</Callout>
        ) : (
          <ErrorMessage>{publication.error}</ErrorMessage>
        ))}
      {refreshError !== null &&
        (refreshError.status === 409 ? (
          <Callout tone="attention">{refreshError.message}</Callout>
        ) : (
          <ErrorMessage>{refreshError.message}</ErrorMessage>
        ))}
      {unresolved !== null && (
        <ErrorMessage>
          The publish request did not complete: {unresolved} Refresh the publication status before you do anything
          else. Publish again only if the refreshed status is “Prepared, not published”.
        </ErrorMessage>
      )}
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Detail label="Target wallet">
          {target === null
            ? publication.terms.target_id
            : `${target.label} (${NETWORKS[target.network_id] ?? `network ${target.network_id}`})`}
        </Detail>
        <Detail label="Deposit address (fund manually)">
          <Mono>{publication.deposit_address}</Mono>
          <CopyButton value={publication.deposit_address} label="Copy address" />
        </Detail>
        <Detail label="Supplier key hash">
          <Mono>{publication.supplier_pkh}</Mono>
        </Detail>
        <Detail label="Tool endpoint">
          <ExternalLink href={publication.endpoint_url}>{publication.endpoint_url}</ExternalLink>
        </Detail>
        <Detail label="Price per call">{lovelaceLabel(publication.terms.price_lovelace)}</Detail>
        <Detail label="Buyer bond per call">{lovelaceLabel(publication.terms.buyer_bond_lovelace)}</Detail>
        <Detail label="Supplier bond">{lovelaceLabel(publication.terms.supplier_bond_lovelace)}</Detail>
        <Detail label="Published bundle">
          <Mono>{publication.terms.artifact_sha256}</Mono>
        </Detail>
        <Detail label="Advert transaction">
          {publication.tx_hash === null ? "None" : <Mono>{publication.tx_hash}</Mono>}
        </Detail>
        <Detail label="Advert reference">
          {publication.advert_ref === null ? "None" : <Mono>{publication.advert_ref}</Mono>}
        </Detail>
        <Detail label="Actual wallet debit">
          {publication.actual_debit_lovelace === null ? "Not recorded" : lovelaceLabel(publication.actual_debit_lovelace)}
        </Detail>
      </dl>
      {publication.state === "prepared" && unresolved === null && (
        <PublishForm
          job={job}
          publication={publication}
          target={target}
          onJob={onJob}
          onUnresolved={(message) => {
            setUnresolved(message);
            // Show the outcome the control service recorded; this never resends the publish request.
            onReload();
          }}
        />
      )}
    </div>
  );
}

function PublishForm({
  job,
  publication,
  target,
  onJob,
  onUnresolved,
}: {
  job: PaperBuildJob;
  publication: PaperPublication;
  target: PaperPublishTarget | null;
  onJob: (job: PaperBuildJob) => void;
  onUnresolved: (message: string) => void;
}) {
  const [maxDebit, setMaxDebit] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);

  const reviewedSha = job.review?.artifact_sha256 ?? null;
  const maxLovelace = parseAp3x(maxDebit);
  const bond = /^\d+$/.test(publication.terms.supplier_bond_lovelace)
    ? BigInt(publication.terms.supplier_bond_lovelace)
    : 0n;
  // The advert output holds the supplier bond, raised to the minimum output value; the fee comes on top.
  const advertOutput = (bond > MIN_ADVERT_OUTPUT_LOVELACE ? bond : MIN_ADVERT_OUTPUT_LOVELACE).toString();
  const network = target === null ? "the target's network" : NETWORKS[target.network_id] ?? `network ${target.network_id}`;

  let problem: string | null = null;
  if (reviewedSha === null || reviewedSha !== publication.terms.artifact_sha256) {
    problem = "The prepared bundle is not the reviewed artifact.";
  } else if (target !== null && !target.live_chain) {
    problem = "LIVE_CHAIN is off for this target, so the publisher refuses live publication.";
  } else if (maxLovelace === null) {
    problem = "Enter the maximum total wallet debit in AP3X, with at most 6 decimals.";
  } else if (BigInt(maxLovelace) <= BigInt(advertOutput)) {
    problem = `The maximum must be more than ${lovelaceLabel(advertOutput)}, because the transaction also pays a network fee.`;
  }

  const publish = async (): Promise<void> => {
    if (problem !== null || !approved || busy || reviewedSha === null || maxLovelace === null) return;
    setBusy(true);
    const approval: PaperPublishApproval = {
      artifact_sha256: reviewedSha,
      confirm: true,
      max_debit_lovelace: maxLovelace,
    };
    try {
      // Sent exactly once. A failure is resolved by refreshing the status, never by resending.
      onJob(await change<PaperBuildJob>(`/jobs/${job.id}/publish`, approval));
    } catch (e) {
      onUnresolved(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-red-300 bg-white p-4">
      <h3 className="text-base font-semibold text-red-800">Publish advert (live transaction)</h3>
      <Callout tone="danger">
        This submits a live chain transaction that spends funds from the target wallet on {network}. It is separate
        from the build and review approvals. The publisher signs one advert transaction, checks that its exact wallet
        debit is not more than your maximum, and only then submits it. If the outcome is unclear, refresh the status.
        Never publish again to retry.
      </Callout>
      <p className="text-sm text-gray-700">
        Fund <Mono>{publication.deposit_address}</Mono> manually before you publish. The advert output locks{" "}
        {lovelaceLabel(advertOutput)} (the supplier bond, at least 2 AP3X), and the transaction pays a network fee.
      </p>
      <label className="block max-w-xs text-sm font-medium text-gray-700">
        Maximum total wallet debit (AP3X)
        <input
          type="text"
          inputMode="decimal"
          value={maxDebit}
          onChange={(e) => {
            setMaxDebit(e.target.value);
            // A new amount needs a new approval.
            setApproved(false);
          }}
          disabled={busy}
          className={INPUT}
        />
      </label>
      {problem !== null ? (
        <p className="text-xs text-red-700">{problem}</p>
      ) : (
        maxLovelace !== null && <p className="text-xs text-gray-600">= {maxLovelace} lovelace</p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={approved}
          onChange={(e) => setApproved(e.target.checked)}
          disabled={busy || problem !== null}
          className="mt-1"
        />
        <span>
          I approve one live advert transaction from <Mono>{publication.deposit_address}</Mono> that debits at most{" "}
          {maxLovelace === null ? "the maximum above" : lovelaceLabel(maxLovelace)}, for bundle{" "}
          <Mono>{publication.terms.artifact_sha256}</Mono>.
        </span>
      </label>
      <button
        type="button"
        onClick={() => void publish()}
        disabled={problem !== null || !approved || busy}
        className={DANGER_BUTTON}
      >
        {busy ? "Publishing… keep this page open" : "Publish advert (live transaction)"}
      </button>
    </div>
  );
}
