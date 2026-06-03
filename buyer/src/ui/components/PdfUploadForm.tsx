/**
 * buyer/src/ui/components/PdfUploadForm.tsx — step 1 of the book summarizer.
 *
 * Posts a PDF as multipart/form-data to POST /v1/pdf-upload. The server
 * extracts + chunks it (no escrow yet) and returns a job_id + chunk count.
 * No private key or chain access in the browser — everything goes through the
 * same-origin /v1/* server routes.
 */

import { useState } from "react";

export interface UploadInfo {
  job_id: string;
  filename: string;
  page_count: number;
  chunk_count: number;
  sample_chunk: string;
}

export default function PdfUploadForm({ onUploaded }: { onUploaded: (info: UploadInfo) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch("/v1/pdf-upload", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      const body = (await resp.json()) as UploadInfo & { error?: string; message?: string };
      if (!resp.ok) {
        throw new Error(`${body.error ?? resp.statusText}: ${body.message ?? ""}`);
      }
      onUploaded(body);
    } catch (err) {
      setError((err as Error).message ?? "upload failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-gray-600">
        Upload a text-based PDF book. The buyer will chunk it and pay marketplace
        suppliers to summarize each chunk, then synthesize a full-book summary.
      </p>
      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={loading}
        aria-label="pdf file"
        className="block text-sm text-gray-700 file:mr-3 file:rounded file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-white hover:file:bg-indigo-700"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading || !file}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-gray-400"
        >
          Upload &amp; analyze
        </button>
        {loading && <span className="text-sm text-gray-500">Extracting &amp; chunking…</span>}
      </div>
      {error && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </form>
  );
}
