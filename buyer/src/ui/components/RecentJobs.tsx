/**
 * buyer/src/ui/components/RecentJobs.tsx — the past-work list.
 *
 * Fetches GET /v1/pdf-jobs and renders every job (running + finished) newest
 * first. Clicking one calls onOpen(jobId); the page reconnects to a running
 * job's live progress or shows a finished job's result. Re-fetches whenever
 * `refreshKey` changes (e.g. after a job starts/finishes).
 */

import { useEffect, useState } from "react";

interface JobListItem {
  job_id: string;
  filename: string;
  status: string;
  coverage: { done: number; total: number };
  chunk_count: number;
  running_cost_lovelace: string;
  created_at: number;
  has_summary: boolean;
}

function ap3x(lovelace: string): string {
  return (Number(lovelace) / 1e6).toFixed(2);
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function badge(status: string): { label: string; cls: string } {
  switch (status) {
    case "running":
      return { label: "running", cls: "bg-blue-100 text-blue-800" };
    case "completed":
      return { label: "completed", cls: "bg-green-100 text-green-800" };
    case "completed_with_gaps":
      return { label: "gaps", cls: "bg-amber-100 text-amber-800" };
    case "failed":
      return { label: "failed", cls: "bg-red-100 text-red-700" };
    case "interrupted":
      return { label: "interrupted", cls: "bg-gray-200 text-gray-700" };
    default:
      return { label: status, cls: "bg-gray-100 text-gray-600" };
  }
}

export default function RecentJobs({
  refreshKey,
  onOpen,
}: {
  refreshKey: number;
  onOpen: (jobId: string) => void;
}) {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/v1/pdf-jobs", { credentials: "same-origin" })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.message ?? r.statusText);
        if (!cancelled) setJobs(Array.isArray(body.jobs) ? body.jobs : []);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (error) {
    return <p className="text-sm text-red-600">Couldn’t load past summaries: {error}</p>;
  }
  if (jobs.length === 0) {
    return <p className="text-sm text-gray-400">No past summaries yet.</p>;
  }

  return (
    <ul className="divide-y divide-gray-100 rounded border border-gray-200 bg-white">
      {jobs.map((j) => {
        const b = badge(j.status);
        return (
          <li key={j.job_id}>
            <button
              type="button"
              onClick={() => onOpen(j.job_id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50"
            >
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${b.cls}`}>{b.label}</span>
              <span className="flex-1 truncate font-medium text-gray-800">{j.filename}</span>
              <span className="text-xs text-gray-500">
                {j.coverage.done}/{j.coverage.total} · {ap3x(j.running_cost_lovelace)} AP3X
              </span>
              <span className="w-16 text-right text-xs text-gray-400">{ago(j.created_at)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
