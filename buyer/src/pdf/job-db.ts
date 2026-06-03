/**
 * buyer/src/pdf/job-db.ts — durable persistence for PDF summarization jobs.
 *
 * Jobs are otherwise in-memory (lost on restart), so "past work" would vanish
 * on every redeploy. This SQLite table (its own file under ARCHIVE_DIR, beside
 * the response archive) records every job's metadata, final summary, per-chunk
 * results, and escrow refs so the operator can list + reopen past summaries
 * across restarts.
 *
 * Synchronous (better-sqlite3) like db/archive.ts — volume is low (a handful
 * of writes per book) and the simplicity is worth more than async overhead.
 */

import { mkdirSync } from "fs";
import { join, resolve } from "path";
import Database from "better-sqlite3";
import type { Database as BetterDatabase } from "better-sqlite3";

export interface JobRecord {
  job_id: string;
  filename: string;
  status: string;
  page_count: number;
  chunk_count: number;
  coverage_done: number;
  coverage_total: number;
  running_cost_lovelace: string;
  final_summary_md: string | null;
  chunk_results_json: string;
  escrow_refs_json: string;
  created_at: number;
  updated_at: number;
}

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS pdf_jobs (
    job_id                TEXT PRIMARY KEY,
    filename              TEXT NOT NULL,
    status                TEXT NOT NULL,
    page_count            INTEGER NOT NULL,
    chunk_count           INTEGER NOT NULL,
    coverage_done         INTEGER NOT NULL,
    coverage_total        INTEGER NOT NULL,
    running_cost_lovelace TEXT NOT NULL,
    final_summary_md      TEXT,
    chunk_results_json    TEXT NOT NULL,
    escrow_refs_json      TEXT NOT NULL,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pdf_jobs_created ON pdf_jobs (created_at DESC);
`;

export class PdfJobDb {
  private readonly db: BetterDatabase;
  private readonly upsertStmt;
  private readonly listStmt;
  private readonly getStmt;

  constructor(archiveDir: string) {
    const dir = resolve(archiveDir);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "pdf-jobs.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CREATE_SQL);

    this.upsertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO pdf_jobs (
        job_id, filename, status, page_count, chunk_count, coverage_done,
        coverage_total, running_cost_lovelace, final_summary_md,
        chunk_results_json, escrow_refs_json, created_at, updated_at
      ) VALUES (
        @job_id, @filename, @status, @page_count, @chunk_count, @coverage_done,
        @coverage_total, @running_cost_lovelace, @final_summary_md,
        @chunk_results_json, @escrow_refs_json, @created_at, @updated_at
      )
    `);
    this.listStmt = this.db.prepare(`SELECT * FROM pdf_jobs ORDER BY created_at DESC LIMIT @limit`);
    this.getStmt = this.db.prepare(`SELECT * FROM pdf_jobs WHERE job_id = @job_id`);
  }

  upsert(rec: JobRecord): void {
    this.upsertStmt.run(rec as unknown as Record<string, unknown>);
  }

  list(limit = 100): JobRecord[] {
    return this.listStmt.all({ limit }) as JobRecord[];
  }

  get(jobId: string): JobRecord | null {
    return (this.getStmt.get({ job_id: jobId }) as JobRecord | undefined) ?? null;
  }

  close(): void {
    this.db.close();
  }
}
