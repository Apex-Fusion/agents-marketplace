/**
 * buyer/src/ui/pages/BookSummarizer.tsx — the PDF book summarizer wizard.
 *
 *   Upload → Estimate/Confirm → Live progress (SSE) → Result.
 *
 * Each step talks only to the same-origin /v1/pdf-* server routes (the browser
 * holds no key). One book upload fans out into many on-chain escrows — the
 * traffic the marketplace wants — while producing a real book summary.
 */

import { useState } from "react";
import PdfUploadForm, { type UploadInfo } from "../components/PdfUploadForm.js";
import JobEstimate from "../components/JobEstimate.js";
import JobProgress from "../components/JobProgress.js";

type Step = "upload" | "estimate" | "running" | "done";

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
  coverage: { done: number; total: number };
  running_cost_lovelace: string;
  final_summary_md?: string;
  chunk_results: ChunkResult[];
  escrow_refs: string[];
}

function ap3x(lovelace: string): string {
  return (Number(lovelace) / 1e6).toFixed(2);
}

export default function BookSummarizer() {
  const [step, setStep] = useState<Step>("upload");
  const [info, setInfo] = useState<UploadInfo | null>(null);
  const [view, setView] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setStep("upload");
    setInfo(null);
    setView(null);
    setError(null);
  };

  const loadResult = async (jobId: string): Promise<void> => {
    try {
      const r = await fetch(`/v1/pdf-jobs/${jobId}`, { credentials: "same-origin" });
      const body = await r.json();
      if (!r.ok) throw new Error(`${body.error}: ${body.message ?? ""}`);
      setView(body as JobView);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("done");
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Book Summarizer</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload a PDF → pay suppliers to summarize each chunk → get a full-book summary.
        </p>
      </div>

      {step === "upload" && (
        <PdfUploadForm
          onUploaded={(i) => {
            setInfo(i);
            setStep("estimate");
          }}
        />
      )}

      {step === "estimate" && info && (
        <JobEstimate info={info} onStarted={() => setStep("running")} />
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
            so this can take a while — that’s real marketplace traffic.
          </p>
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
                <span className="font-medium">
                  {view.status === "completed"
                    ? "✅ Completed"
                    : view.status === "completed_with_gaps"
                      ? "⚠️ Completed with gaps"
                      : "❌ Failed"}
                </span>
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

              {view.final_summary_md && (
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-4 text-sm text-gray-800">
                  {view.final_summary_md}
                </pre>
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
            Summarize another book
          </button>
        </div>
      )}
    </div>
  );
}
