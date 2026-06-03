/**
 * buyer/src/ui/pages/BookSummarizer.tsx — the PDF book summarizer wizard.
 *
 *   Upload → Estimate/Confirm → Live progress (SSE) → Result.
 *
 * The summarization runs SERVER-SIDE, so navigating away never stops it. This
 * page remembers the active job (localStorage) and reconnects on return, and
 * lists all past jobs (running + finished) so any can be reopened — a finished
 * job shows its result; a running one reconnects to live progress.
 *
 * Each step talks only to the same-origin /v1/pdf-* server routes (the browser
 * holds no key).
 */

import { useEffect, useState } from "react";
import PdfUploadForm, { type UploadInfo } from "../components/PdfUploadForm.js";
import JobEstimate from "../components/JobEstimate.js";
import JobProgress from "../components/JobProgress.js";
import RecentJobs from "../components/RecentJobs.js";

type Step = "upload" | "estimate" | "running" | "done";

const ACTIVE_JOB_KEY = "pdf_active_job";

interface ChunkResult {
  index: number;
  label: string;
  status: "ok" | "gap" | "pending";
  escrowRef?: string;
  supplierModel?: string;
}

interface JobView {
  job_id: string;
  filename: string;
  status: string;
  page_count: number;
  chunk_count: number;
  coverage: { done: number; total: number };
  running_cost_lovelace: string;
  final_summary_md?: string;
  chunk_results: ChunkResult[];
  escrow_refs: string[];
}

function ap3x(lovelace: string): string {
  return (Number(lovelace) / 1e6).toFixed(2);
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "✅ Completed";
    case "completed_with_gaps":
      return "⚠️ Completed with gaps";
    case "interrupted":
      return "⏸️ Interrupted (server restarted mid-job)";
    case "running":
      return "⏳ Running";
    default:
      return "❌ Failed";
  }
}

function infoFromView(v: JobView): UploadInfo {
  return {
    job_id: v.job_id,
    filename: v.filename,
    page_count: v.page_count,
    chunk_count: v.chunk_count,
    sample_chunk: "",
  };
}

export default function BookSummarizer() {
  const [step, setStep] = useState<Step>("upload");
  const [info, setInfo] = useState<UploadInfo | null>(null);
  const [view, setView] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // On mount, resume an active job if one is still running.
  useEffect(() => {
    const aid = localStorage.getItem(ACTIVE_JOB_KEY);
    if (!aid) return;
    let cancelled = false;
    fetch(`/v1/pdf-jobs/${aid}`, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) {
          localStorage.removeItem(ACTIVE_JOB_KEY);
          return;
        }
        const v = (await r.json()) as JobView;
        if (cancelled) return;
        if (v.status === "running" || v.status === "estimated") {
          setInfo(infoFromView(v));
          setStep("running");
        } else {
          localStorage.removeItem(ACTIVE_JOB_KEY);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const openJob = async (jobId: string): Promise<void> => {
    setError(null);
    try {
      const r = await fetch(`/v1/pdf-jobs/${jobId}`, { credentials: "same-origin" });
      const v = (await r.json()) as JobView & { message?: string };
      if (!r.ok) throw new Error(v.message ?? r.statusText);
      if (v.status === "running" || v.status === "estimated") {
        setInfo(infoFromView(v));
        localStorage.setItem(ACTIVE_JOB_KEY, v.job_id);
        setStep("running");
      } else {
        setView(v);
        setStep("done");
      }
    } catch (e) {
      setError((e as Error).message);
      setStep("done");
    }
  };

  const loadResult = async (jobId: string): Promise<void> => {
    localStorage.removeItem(ACTIVE_JOB_KEY);
    try {
      const r = await fetch(`/v1/pdf-jobs/${jobId}`, { credentials: "same-origin" });
      const body = (await r.json()) as JobView & { message?: string };
      if (!r.ok) throw new Error(body.message ?? r.statusText);
      setView(body);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("done");
    }
  };

  const reset = (): void => {
    setStep("upload");
    setInfo(null);
    setView(null);
    setError(null);
    setRefreshKey((k) => k + 1);
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Book Summarizer</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload a PDF → pay suppliers to summarize each chunk → get a full-book summary.
          Jobs keep running if you navigate away; reopen them below.
        </p>
      </div>

      {step === "upload" && (
        <>
          <PdfUploadForm
            onUploaded={(i) => {
              setInfo(i);
              setStep("estimate");
            }}
          />
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-gray-700">Past &amp; in-progress summaries</h2>
            <RecentJobs refreshKey={refreshKey} onOpen={(id) => void openJob(id)} />
          </div>
        </>
      )}

      {step === "estimate" && info && (
        <JobEstimate
          info={info}
          onStarted={() => {
            localStorage.setItem(ACTIVE_JOB_KEY, info.job_id);
            setStep("running");
          }}
        />
      )}

      {step === "running" && info && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Summarizing “{info.filename}”…</h2>
          <JobProgress
            jobId={info.job_id}
            total={info.chunk_count}
            onDone={() => void loadResult(info.job_id)}
          />
          <p className="text-xs text-gray-400">
            Each chunk is a separate on-chain escrow (PostEscrow → supplier → Accept),
            so this can take a while — that’s real marketplace traffic. You can leave this
            page; the job keeps running and shows up under “Past summaries”.
          </p>
          <button
            type="button"
            onClick={reset}
            className="text-sm text-gray-600 hover:underline"
          >
            ← Back to list (keeps running)
          </button>
        </div>
      )}

      {step === "done" && (
        <div className="space-y-4">
          {error && (
            <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {view && (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <span className="font-medium">{statusLabel(view.status)}</span>
                <span className="truncate text-gray-600">{view.filename}</span>
                <span>
                  Coverage: {view.coverage.done}/{view.coverage.total} chunks
                </span>
                <span>Spent: {ap3x(view.running_cost_lovelace)} AP3X</span>
                <span>{view.escrow_refs.length} escrows</span>
              </div>

              {view.final_summary_md && (
                <a
                  href={`/v1/pdf-jobs/${view.job_id}/summary.md`}
                  className="inline-block rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Download summary (.md)
                </a>
              )}

              {view.final_summary_md ? (
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-4 text-sm text-gray-800">
                  {view.final_summary_md}
                </pre>
              ) : (
                <p className="text-sm text-gray-500">No summary was produced for this job.</p>
              )}

              <details className="text-xs text-gray-500">
                <summary className="cursor-pointer">On-chain escrows ({view.escrow_refs.length})</summary>
                <ul className="mt-2 space-y-0.5 font-mono">
                  {view.escrow_refs.map((ref) => (
                    <li key={ref}>{ref}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
          <button
            type="button"
            onClick={reset}
            className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            ← Back to summaries
          </button>
        </div>
      )}
    </div>
  );
}
