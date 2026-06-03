/**
 * buyer/src/ui/components/JobProgress.tsx — step 3: live progress via SSE.
 *
 * Opens EventSource('/v1/pdf-jobs/:id/events'). The server replays buffered
 * frames on connect, so a refresh mid-job catches up. On the terminal `done`
 * event we close the stream and hand control back to the page.
 */

import { useEffect, useRef, useState } from "react";

interface ProgressFrame {
  phase: "map" | "reduce" | "done" | "error";
  label?: string;
  completed: number;
  failed: number;
  total: number;
  reduce_level?: number;
  running_cost_lovelace: string;
  coverage: { done: number; total: number };
  message?: string;
  status?: string;
}

function ap3x(lovelace: string): string {
  return (Number(lovelace) / 1e6).toFixed(2);
}

export default function JobProgress({
  jobId,
  total,
  onDone,
}: {
  jobId: string;
  total: number;
  onDone: () => void;
}) {
  const [frame, setFrame] = useState<ProgressFrame | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const es = new EventSource(`/v1/pdf-jobs/${jobId}/events`);
    es.addEventListener("progress", (e: MessageEvent) => {
      const f = JSON.parse(e.data) as ProgressFrame;
      setFrame(f);
      if (f.message) setLog((prev) => [...prev.slice(-20), `${f.label ?? f.phase}: ${f.message}`]);
    });
    es.addEventListener("done", (e: MessageEvent) => {
      setFrame(JSON.parse(e.data) as ProgressFrame);
      es.close();
      onDoneRef.current();
    });
    es.onerror = () => {
      // Transient drop — EventSource auto-reconnects; the server replays
      // buffered frames so we don't lose state.
    };
    return () => es.close();
  }, [jobId]);

  const done = frame?.coverage.done ?? 0;
  const totalCount = frame?.total ?? total;
  const pct = totalCount > 0 ? Math.round((done / totalCount) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="h-3 w-full overflow-hidden rounded bg-gray-200">
        <div className="h-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-sm text-gray-700">
        <span>
          {frame?.phase === "reduce" ? `Reducing (level ${frame.reduce_level ?? "?"})` : "Summarizing chunks"} —{" "}
          {done}/{totalCount} ({pct}%)
        </span>
        <span>
          {frame ? `${frame.failed} gaps · ${ap3x(frame.running_cost_lovelace)} AP3X spent` : "starting…"}
        </span>
      </div>
      {log.length > 0 && (
        <pre className="max-h-40 overflow-auto rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-600">
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}
