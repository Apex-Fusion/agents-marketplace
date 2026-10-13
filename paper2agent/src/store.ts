/**
 * Durable Paper2Agent control state. SQLite only: an open, schema, or write
 * failure is fatal and never falls back to memory.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase, Statement } from "better-sqlite3";
import type {
  PaperBuildEvent,
  PaperBuildJob,
  PaperBuildJobSummary,
  PaperBuildPause,
  PaperBuildState,
  PaperPackageArtifact,
  PaperPublication,
  PaperPublishTerms,
  PaperReview,
} from "@marketplace/shared/paper2agent/workflow";

const MAX_EVENTS_PER_JOB = 1000;
const MAX_PHASE_CHARS = 40;
const MAX_MESSAGE_CHARS = 2000;

const STATES: readonly PaperBuildState[] = [
  "submitted", "queued", "building", "verifying", "awaiting_review",
  "approved", "rejected", "failed", "interrupted", "cancelled",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${STATES.map((state) => `'${state}'`).join(", ")})),
  attempt INTEGER NOT NULL,
  title TEXT NOT NULL,
  paper_url TEXT NOT NULL,
  submission_json TEXT NOT NULL,
  paper_pdf BLOB,
  pause_json TEXT,
  artifact_json TEXT,
  archive_path TEXT,
  files_dir TEXT,
  review_json TEXT,
  publication_terms_json TEXT,
  publication_json TEXT,
  error TEXT,
  queued_at INTEGER,
  builder_attempt INTEGER,
  last_event_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (state, queued_at);
CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL REFERENCES jobs (id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
) WITHOUT ROWID;
`;

const JOB_COLUMNS = "id, created_at, updated_at, state, attempt, submission_json, pause_json, artifact_json, " +
  "archive_path, files_dir, review_json, publication_terms_json, publication_json, error";

export type PaperSubmissionView = PaperBuildJob["submission"];

export interface PaperJobRecord {
  job: PaperBuildJob;
  /** Host paths of the verified build output. Internal: never part of the public job view. */
  archivePath: string | null;
  filesDir: string | null;
  /** Terms of the latest publication request. Once set, the artifact and review are frozen. */
  publicationTerms: PaperPublishTerms | null;
}

export interface PaperJobPatch {
  state?: PaperBuildState;
  attempt?: number;
  pause?: PaperBuildPause | null;
  artifact?: PaperPackageArtifact | null;
  archivePath?: string | null;
  filesDir?: string | null;
  review?: PaperReview | null;
  publication?: PaperPublication | null;
  publicationTerms?: PaperPublishTerms | null;
  error?: string | null;
  queuedAt?: number | null;
  /** Attempt whose builder call has not settled yet; it may still own sandbox resources. */
  builderAttempt?: number | null;
}

/** A transition applies only while the job still has this attempt and one of these states. */
export interface PaperJobGuard {
  states: readonly PaperBuildState[];
  attempt: number;
}

export interface PaperEventInput {
  phase: string;
  message: string;
}

const PATCH_COLUMNS: Record<keyof PaperJobPatch, { column: string; json: boolean }> = {
  state: { column: "state", json: false },
  attempt: { column: "attempt", json: false },
  pause: { column: "pause_json", json: true },
  artifact: { column: "artifact_json", json: true },
  archivePath: { column: "archive_path", json: false },
  filesDir: { column: "files_dir", json: false },
  review: { column: "review_json", json: true },
  publication: { column: "publication_json", json: true },
  publicationTerms: { column: "publication_terms_json", json: true },
  error: { column: "error", json: false },
  queuedAt: { column: "queued_at", json: false },
  builderAttempt: { column: "builder_attempt", json: false },
};

interface JobRow {
  id: string;
  created_at: number;
  updated_at: number;
  state: PaperBuildState;
  attempt: number;
  submission_json: string;
  pause_json: string | null;
  artifact_json: string | null;
  archive_path: string | null;
  files_dir: string | null;
  review_json: string | null;
  publication_terms_json: string | null;
  publication_json: string | null;
  error: string | null;
}

/** Removes control characters (keeping tab and newline when multiline), trims, and bounds length. */
export function boundedText(text: string, maximum: number, multiline = true): string {
  const cleaned = (multiline
    ? text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ")
    : text.replace(/[\x00-\x1f\x7f]+/g, " ")).trim();
  return cleaned.length > maximum ? `${cleaned.slice(0, maximum - 1)}…` : cleaned;
}

function parsed<T>(text: string | null): T | null {
  return text === null ? null : JSON.parse(text) as T;
}

function toRecord(row: JobRow): PaperJobRecord {
  return {
    job: {
      id: row.id,
      submission: JSON.parse(row.submission_json) as PaperSubmissionView,
      state: row.state,
      attempt: row.attempt,
      created_at: row.created_at,
      updated_at: row.updated_at,
      pause: parsed<PaperBuildPause>(row.pause_json),
      artifact: parsed<PaperPackageArtifact>(row.artifact_json),
      review: parsed<PaperReview>(row.review_json),
      publication: parsed<PaperPublication>(row.publication_json),
      error: row.error,
    },
    archivePath: row.archive_path,
    filesDir: row.files_dir,
    publicationTerms: parsed<PaperPublishTerms>(row.publication_terms_json),
  };
}

/**
 * Keep the complete pre-cutover rows in a private archive before removing old
 * columns. Old build outputs have no paper digest, so they cannot be approved
 * or published under the new contract. Publication records remain available
 * for read-only reconciliation. No old queued build resumes model spending.
 */
function migratePaperOnly(db: SqliteDatabase): void {
  const columns = db.pragma("table_info(jobs)") as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "repository_url")) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE legacy_jobs AS SELECT * FROM jobs;
      ALTER TABLE jobs ADD COLUMN paper_url TEXT NOT NULL DEFAULT '';
      UPDATE jobs SET
        paper_url = COALESCE(json_extract(submission_json, '$.paper_url'), ''),
        submission_json = json_remove(submission_json, '$.repository_url', '$.revision', '$.task'),
        state = CASE WHEN publication_json IS NOT NULL OR publication_terms_json IS NOT NULL THEN state ELSE 'interrupted' END,
        artifact_json = NULL, archive_path = NULL, files_dir = NULL, review_json = NULL,
        queued_at = NULL,
        error = 'This job uses the old input format. Original records and artifacts remain in the private legacy archive. A new paper-only build requires an explicit retry. Existing publications can only be refreshed.',
        last_event_seq = last_event_seq + 1;
      INSERT INTO events (job_id, seq, at, phase, message)
        SELECT id, last_event_seq, ${Date.now()}, 'migration', error FROM jobs;
      ALTER TABLE jobs DROP COLUMN repository_url;
      ALTER TABLE jobs DROP COLUMN revision;
    `);
  })();
}

/** Builds have no stored call, token, or time limit; a running build can record a funds pause. */
function migrateFundsLimit(db: SqliteDatabase): void {
  const columns = new Set((db.pragma("table_info(jobs)") as Array<{ name: string }>).map(({ name }) => name));
  db.transaction(() => {
    if (columns.has("budget_json")) db.exec("ALTER TABLE jobs DROP COLUMN budget_json");
    if (!columns.has("pause_json")) db.exec("ALTER TABLE jobs ADD COLUMN pause_json TEXT");
  })();
}

export class PaperControlStore {
  private readonly db: SqliteDatabase;
  private readonly statements = new Map<string, Statement>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const db = new Database(join(dataDir, "control.db"));
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.pragma("busy_timeout = 5000");
      db.pragma("foreign_keys = ON");
      db.exec(SCHEMA);
      migratePaperOnly(db);
      migrateFundsLimit(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  create(id: string, submission: PaperSubmissionView, paperPdf: Buffer | null, now: number, event: PaperEventInput): PaperJobRecord {
    return this.db.transaction(() => {
      this.sql("INSERT INTO jobs (id, created_at, updated_at, state, attempt, title, paper_url, submission_json, paper_pdf, queued_at) " +
        "VALUES (?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?)")
        .run(id, now, now, submission.title, submission.paper_url, JSON.stringify(submission), paperPdf, now);
      this.insertEvent(id, event, now);
      return this.required(id);
    })();
  }

  job(id: string): PaperJobRecord | undefined {
    const row = this.sql(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    return row && toRecord(row);
  }

  /** Newest first. Reads only list columns: never the paper text, PDF, artifact, or review. */
  summaries(limit: number): PaperBuildJobSummary[] {
    const rows = this.sql("SELECT id, title, paper_url, state, json_extract(publication_json, '$.state') AS publication_state, " +
      "pause_json IS NOT NULL AS paused, created_at, updated_at FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as Array<Omit<PaperBuildJobSummary, "paused"> & { paused: number }>;
    return rows.map((row) => ({ ...row, paused: row.paused === 1 }));
  }

  jobsInStates(states: readonly PaperBuildState[]): PaperJobRecord[] {
    const rows = this.sql(`SELECT ${JOB_COLUMNS} FROM jobs WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY rowid`)
      .all(...states) as JobRow[];
    return rows.map(toRecord);
  }

  /** The oldest queued build. */
  nextQueued(): PaperJobRecord | undefined {
    const row = this.sql(`SELECT ${JOB_COLUMNS} FROM jobs WHERE state = 'queued' ORDER BY queued_at, rowid LIMIT 1`).get() as JobRow | undefined;
    return row && toRecord(row);
  }

  queuedCount(): number {
    // COUNT(*) always yields exactly one row with this column.
    const row = this.sql("SELECT COUNT(*) AS count FROM jobs WHERE state = 'queued'").get() as { count: number };
    return row.count;
  }

  /** Cheap lookup for frequent builder progress callbacks. */
  buildState(id: string): { state: PaperBuildState; attempt: number } | undefined {
    return this.sql("SELECT state, attempt FROM jobs WHERE id = ?").get(id) as { state: PaperBuildState; attempt: number } | undefined;
  }

  /** Builder calls that never settled, for example because the process died during a build. */
  unsettledBuilds(): Array<{ id: string; attempt: number }> {
    return this.sql("SELECT id, builder_attempt AS attempt FROM jobs WHERE builder_attempt IS NOT NULL ORDER BY rowid")
      .all() as Array<{ id: string; attempt: number }>;
  }

  /** Clears the marker once the builder call for this attempt has settled and released its resources. */
  builderSettled(id: string, attempt: number): void {
    this.sql("UPDATE jobs SET builder_attempt = NULL WHERE id = ? AND builder_attempt = ?").run(id, attempt);
  }

  paperPdf(id: string): Buffer | null {
    const row = this.sql("SELECT paper_pdf FROM jobs WHERE id = ?").get(id) as { paper_pdf: Buffer | null } | undefined;
    return row?.paper_pdf ?? null;
  }

  /**
   * Applies `patch` and appends `event` atomically, only if the guard still
   * holds. Returns undefined when another transition won.
   */
  transition(id: string, guard: PaperJobGuard, patch: PaperJobPatch, event: PaperEventInput | null, now: number): PaperJobRecord | undefined {
    if (guard.states.length === 0) throw new Error("PaperControlStore.transition: the guard needs at least one state");
    const assignments = ["updated_at = @now"];
    const params: Record<string, string | number | null> = { id, now, guard_attempt: guard.attempt };
    for (const key of Object.keys(patch) as Array<keyof PaperJobPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      const { column, json } = PATCH_COLUMNS[key];
      assignments.push(`${column} = @${key}`);
      params[key] = value === null ? null
        : json ? JSON.stringify(value)
        : key === "error" ? boundedText(value as string, MAX_MESSAGE_CHARS)
        : value as string | number;
    }
    const states = guard.states.map((state, index) => {
      params[`state_${index}`] = state;
      return `@state_${index}`;
    });
    return this.db.transaction(() => {
      const { changes } = this.sql(`UPDATE jobs SET ${assignments.join(", ")} ` +
        `WHERE id = @id AND attempt = @guard_attempt AND state IN (${states.join(", ")})`).run(params);
      if (changes === 0) return undefined;
      if (event) this.insertEvent(id, event, now);
      return this.required(id);
    })();
  }

  appendEvent(id: string, event: PaperEventInput, now: number): PaperBuildEvent {
    return this.db.transaction(() => this.insertEvent(id, event, now))();
  }

  events(id: string, after: number, limit: number): PaperBuildEvent[] {
    return this.sql("SELECT seq, at, phase, message FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(id, after, limit) as PaperBuildEvent[];
  }

  close(): void {
    this.db.close();
  }

  /** Sequence numbers never repeat; only the newest MAX_EVENTS_PER_JOB events are kept. */
  private insertEvent(id: string, event: PaperEventInput, now: number): PaperBuildEvent {
    const row = this.sql("UPDATE jobs SET last_event_seq = last_event_seq + 1 WHERE id = ? RETURNING last_event_seq AS seq")
      .get(id) as { seq: number } | undefined;
    if (!row) throw new Error(`PaperControlStore: unknown job ${id}`);
    const stored: PaperBuildEvent = {
      seq: row.seq,
      at: now,
      phase: boundedText(event.phase, MAX_PHASE_CHARS, false) || "event",
      message: boundedText(event.message, MAX_MESSAGE_CHARS),
    };
    this.sql("INSERT INTO events (job_id, seq, at, phase, message) VALUES (?, ?, ?, ?, ?)")
      .run(id, stored.seq, stored.at, stored.phase, stored.message);
    this.sql("DELETE FROM events WHERE job_id = ? AND seq <= ?").run(id, stored.seq - MAX_EVENTS_PER_JOB);
    return stored;
  }

  private required(id: string): PaperJobRecord {
    const record = this.job(id);
    if (!record) throw new Error(`PaperControlStore: unknown job ${id}`);
    return record;
  }

  private sql(source: string): Statement {
    let statement = this.statements.get(source);
    if (!statement) {
      statement = this.db.prepare(source);
      this.statements.set(source, statement);
    }
    return statement;
  }
}
