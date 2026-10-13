import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Express } from "express";
import { unzipSync } from "fflate";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { paper2AgentManifestHash, type Paper2AgentManifest } from "@marketplace/shared/paper2agent";
import type { PaperBuildJob, PaperPackageArtifact, PaperPublication, PaperPublishTarget, PaperPublishTerms } from "@marketplace/shared/paper2agent/workflow";
import { createPackage } from "../src/archive.js";
import type { PaperBuildContext, PaperBuildResult, PaperPackageBuilder } from "../src/build.js";
import { createPaperControlApp, PaperControlService } from "../src/control.js";
import { loadPaperControlConfig } from "../src/control-config.js";
import { PaperControlStore } from "../src/store.js";

const TOKEN = "control-token-0123456789-abcdefghijklmnop";
const PUBLISHER_TOKEN = "publisher-token-0123456789-abcdefghijklm";
const AUTH = `Bearer ${TOKEN}`;
const TARGET: PaperPublishTarget = {
  id: "slot-a",
  label: "Slot A",
  network_id: 0,
  supplier_pkh: "ab".repeat(28),
  deposit_address: `addr_test1${"q".repeat(53)}`,
  endpoint_url: "https://publisher.test/tools/slot-a",
  available: true,
  live_chain: true,
};
const SUBMISSION = {
  title: "Least squares line fit",
  paper_url: "",
  paper_text: "We fit y = ax + b by least squares.",
};
const FILES: Record<string, string> = { "server.py": "print('fit')\n", "source/fit.py": "def fit(x):\n    return 1\n" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface BuildCall {
  context: PaperBuildContext;
  result: Deferred<PaperBuildResult>;
}

/** Each build waits for the test. An abort rejects it unless honorAbort is off. */
class FakeBuilder implements PaperPackageBuilder {
  honorAbort = true;
  readinessError: string | null = null;
  recoveryError: Error | null = null;
  readonly recovered: string[][] = [];
  readonly calls: BuildCall[] = [];
  private readonly arrivals: Deferred<BuildCall>[] = [];

  async readiness(): Promise<{ ready: boolean; error: string | null }> {
    return { ready: this.readinessError === null, error: this.readinessError };
  }

  async recoverInterrupted(workDirs: string[]): Promise<void> {
    this.recovered.push(workDirs);
    if (this.recoveryError) throw this.recoveryError;
  }

  build(context: PaperBuildContext): Promise<PaperBuildResult> {
    const call: BuildCall = { context, result: deferred<PaperBuildResult>() };
    if (this.honorAbort) {
      context.signal.addEventListener("abort", () => call.result.reject(context.signal.reason), { once: true });
    }
    this.calls.push(call);
    this.arrival(this.calls.length - 1).resolve(call);
    return call.result.promise;
  }

  /** Resolves once the build with this zero-based index has started. */
  call(index: number): Promise<BuildCall> {
    return this.arrival(index).promise;
  }

  private arrival(index: number): Deferred<BuildCall> {
    this.arrivals[index] ??= deferred<BuildCall>();
    return this.arrivals[index];
  }
}

interface PublisherRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

interface PrepareBody {
  job_id: string;
  terms: PaperPublishTerms;
  artifact: PaperPackageArtifact;
  archive_base64: string;
}

function reply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** The publisher management API, in memory. */
class FakePublisher {
  readonly requests: PublisherRequest[] = [];
  readonly prepared: PrepareBody[] = [];
  publishFailure: Error | null = null;
  /** When set, the publish request never answers (a lost response); resolved when it arrives. */
  publishArrived: Deferred<void> | null = null;
  private stored: PaperPublication | null = null;

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const { pathname } = new URL(String(input));
    const method = init.method ?? "GET";
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: pathname, authorization: new Headers(init.headers).get("authorization"), body });
    if (method === "GET" && pathname === "/targets") return reply({ targets: [TARGET] });
    if (method === "POST" && pathname === "/publications") {
      // Built by the control service under test; the assertions check its content.
      const prepared = body as PrepareBody;
      this.prepared.push(prepared);
      this.stored = {
        id: prepared.job_id, state: "prepared", terms: prepared.terms, supplier_pkh: TARGET.supplier_pkh,
        deposit_address: TARGET.deposit_address, endpoint_url: TARGET.endpoint_url,
        advert_ref: null, tx_hash: null, actual_debit_lovelace: null, error: null,
      };
      return reply(this.stored);
    }
    if (method === "POST" && pathname.endsWith("/publish")) {
      if (this.publishArrived) {
        this.publishArrived.resolve();
        return new Promise<Response>((_, fail) => {
          init.signal?.addEventListener("abort", () => fail(init.signal?.reason), { once: true });
        });
      }
      if (this.publishFailure) throw this.publishFailure;
    }
    if (method === "GET" && this.stored && pathname === `/publications/${this.stored.id}`) return reply(this.stored);
    return reply({ error: "not_found", message: "Unknown publication." }, 404);
  };
}

interface Harness {
  store: PaperControlStore;
  service: PaperControlService;
  app: Express;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "p2a-control-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Opening a second harness on the same directory is a process restart. */
function openControl(dataDir: string, builder: PaperPackageBuilder, publisher: FakePublisher | null, maxQueuedBuilds = 20): Harness {
  const config = loadPaperControlConfig({
    PAPER2AGENT_CONTROL_TOKEN: TOKEN,
    PAPER2AGENT_CONTROL_DATA_DIR: dataDir,
    ...(publisher ? { PAPER2AGENT_PUBLISHER_URL: "http://publisher.test", PAPER2AGENT_PUBLISHER_TOKEN: PUBLISHER_TOKEN } : {}),
  });
  const store = new PaperControlStore(dataDir);
  const service = new PaperControlService({
    config: { ...config, maxQueuedBuilds },
    store,
    builder,
    ...(publisher ? { fetch: publisher.fetch } : {}),
  });
  cleanups.push(async () => {
    await service.close();
    store.close();
  });
  return { store, service, app: createPaperControlApp({ service, token: TOKEN }) };
}

async function createJob(app: Express, submission: object = SUBMISSION): Promise<PaperBuildJob> {
  const response = await request(app).post("/jobs").set("authorization", AUTH).send(submission).expect(202);
  return response.body;
}

function startBuild(app: Express, id: string): request.Test {
  return request(app).post(`/jobs/${id}/build`).set("authorization", AUTH).send({ confirm: true });
}

/** A real bundle.tar, written by the shared archive helper inside the attempt directory. */
async function writePackage(context: PaperBuildContext): Promise<PaperBuildResult> {
  const filesDir = join(context.workDir, "bundle");
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(filesDir, path)), { recursive: true });
    await writeFile(join(filesDir, path), content);
  }
  const archivePath = join(context.workDir, "bundle.tar");
  const files = await createPackage(filesDir, archivePath);
  const sha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  const manifest: Paper2AgentManifest = {
    schema_version: 1,
    name: "fit_line",
    description: "Fits a straight line to points.",
    package_sha256: sha256,
    input_schema: { type: "object", properties: { x: { type: "array", items: { type: "number" } } }, required: ["x"], additionalProperties: false },
    output_schema: { type: "object", properties: { slope: { type: "number" } }, required: ["slope"], additionalProperties: false },
    limits: { max_input_bytes: 1024, max_output_bytes: 1024, max_runtime_ms: 1000 },
  };
  return {
    archivePath,
    filesDir,
    artifact: {
      sha256,
      manifest_hash: paper2AgentManifestHash(manifest),
      manifest,
      paper_sha256: createHash("sha256").update(context.submission.paper_pdf_base64
        ? Buffer.from(context.submission.paper_pdf_base64, "base64") : context.submission.paper_text ?? "").digest("hex"),
      runtime_image: `sha256:${"d".repeat(64)}`,
      files,
      verification: {
        builder_run_id: `build-${context.attempt}`,
        verifier_run_id: `verify-${context.attempt}`,
        paper_references: ["Least squares objective, equation y = ax + b"],
        checks: ["independent test passed"],
        test_source: "assert fit([1, 2]) == 1\n",
        test_stdout: "1 passed\n",
        cases: [{ name: "line", input: { x: [1, 2] }, expected: { slope: 1 } }],
        model_calls: 4,
        input_tokens: 1200,
        output_tokens: 300,
      },
    },
  };
}

function approval(job: PaperBuildJob, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: "approve", artifact_sha256: job.artifact?.sha256, code_reviewed: true, license_reviewed: true,
    results_reviewed: true, notes: "", ...overrides,
  };
}

function terms(job: PaperBuildJob, overrides: Partial<PaperPublishTerms> = {}): PaperPublishTerms {
  return {
    target_id: TARGET.id, artifact_sha256: job.artifact?.sha256 ?? "", price_lovelace: "2000000",
    buyer_bond_lovelace: "1000000", supplier_bond_lovelace: "1000000", ...overrides,
  };
}

async function approvedJob({ app, service }: Harness, builder: FakeBuilder, index: number): Promise<PaperBuildJob> {
  const job = await createJob(app);
  const call = await builder.call(index);
  call.result.resolve(await writePackage(call.context));
  await service.whenIdle();
  const response = await request(app).post(`/jobs/${job.id}/review`).set("authorization", AUTH)
    .send(approval(service.job(job.id))).expect(200);
  return response.body;
}

/** The pre-paper-only schema, including private bytes that migration must retain. */
function seedLegacyStore(dataDir: string, records: Array<{
  id: string; state: string; artifact?: unknown; publication?: PaperPublication; pdf?: Buffer; submissionJson?: string;
}>): Array<Record<string, unknown>> {
  const db = new Database(join(dataDir, "control.db"));
  try {
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        state TEXT NOT NULL, attempt INTEGER NOT NULL, title TEXT NOT NULL,
        repository_url TEXT NOT NULL, revision TEXT NOT NULL, submission_json TEXT NOT NULL,
        paper_pdf BLOB, budget_json TEXT, artifact_json TEXT, archive_path TEXT, files_dir TEXT,
        review_json TEXT, publication_terms_json TEXT, publication_json TEXT, error TEXT,
        queued_at INTEGER, builder_attempt INTEGER, last_event_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE events (
        job_id TEXT NOT NULL REFERENCES jobs(id), seq INTEGER NOT NULL, at INTEGER NOT NULL,
        phase TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(job_id, seq)
      ) WITHOUT ROWID;
    `);
    for (const record of records) {
      const submission = record.submissionJson ?? JSON.stringify({
        ...SUBMISSION, paper_text: record.pdf ? undefined : SUBMISSION.paper_text,
        repository_url: "https://github.com/example/old-code", revision: "v1", task: "Original operator task",
      });
      db.prepare(`INSERT INTO jobs (
        id, created_at, updated_at, state, attempt, title, repository_url, revision, submission_json,
        paper_pdf, budget_json, artifact_json, archive_path, files_dir, review_json,
        publication_terms_json, publication_json, queued_at, last_event_seq
      ) VALUES (?, 1, 2, ?, 1, ?, ?, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
        record.id, record.state, SUBMISSION.title, "https://github.com/example/old-code", submission,
        record.pdf ?? null, JSON.stringify({ max_model_calls: 8, max_output_tokens: 2048, timeout_ms: 600_000 }),
        record.artifact ? JSON.stringify(record.artifact) : null,
        record.artifact ? "/private/original/bundle.tar" : null, record.artifact ? "/private/original/bundle" : null,
        record.artifact ? JSON.stringify({ original_review: "Retain this record exactly." }) : null,
        record.publication ? JSON.stringify(record.publication.terms) : null,
        record.publication ? JSON.stringify(record.publication) : null, record.state === "queued" ? 2 : null,
      );
      db.prepare("INSERT INTO events VALUES (?, 1, 1, 'submitted', 'Original event')").run(record.id);
    }
    return db.prepare("SELECT * FROM jobs ORDER BY id").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("Paper2Agent control service", () => {
  it("bounds concurrent submissions and releases a cancelled queue slot", async () => {
    const builder = new FakeBuilder();
    const { app, service, store } = openControl(tempDir(), builder, null, 1);
    const responses = await Promise.all([
      request(app).post("/jobs").set("authorization", AUTH).send({ paper_text: "Paper one" }),
      request(app).post("/jobs").set("authorization", AUTH).send({ paper_text: "Paper two" }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([202, 429]);
    expect(service.listJobs()).toHaveLength(1);
    expect(store.queuedCount()).toBe(1);
    const accepted = responses.find(({ status }) => status === 202);
    expect(accepted?.body).toMatchObject({ state: "queued", attempt: 1, pause: null });
    await request(app).post(`/jobs/${accepted?.body.id}/cancel`).set("authorization", AUTH).send({}).expect(200);
    const next = await createJob(app);
    expect(next.state).toBe("queued");
    expect(store.queuedCount()).toBe(1);
    expect(builder.calls).toHaveLength(0);
  });

  it.each([
    ["missing paper hash", (artifact: PaperPackageArtifact) => { Reflect.deleteProperty(artifact, "paper_sha256"); }],
    ["invalid paper hash", (artifact: PaperPackageArtifact) => { artifact.paper_sha256 = "a".repeat(40); }],
    ["missing paper references", (artifact: PaperPackageArtifact) => { artifact.verification.paper_references = []; }],
    ["blank paper references", (artifact: PaperPackageArtifact) => { artifact.verification.paper_references = [" "]; }],
    ["obsolete artifact field", (artifact: PaperPackageArtifact) => { Object.assign(artifact, { repository_commit: "a".repeat(40) }); }],
    ["obsolete verification field", (artifact: PaperPackageArtifact) => { Object.assign(artifact.verification, { source_bindings: ["old.py:run"] }); }],
  ] as const)("rejects an artifact with %s without an automatic paid retry", async (_label, mutate) => {
    const builder = new FakeBuilder();
    const { app, service } = openControl(tempDir(), builder, null);
    await service.start();
    const job = await createJob(app);
    const call = await builder.call(0);
    const output = await writePackage(call.context);
    mutate(output.artifact);
    call.result.resolve(output);
    await service.whenIdle();
    expect(service.job(job.id)).toMatchObject({ state: "failed", attempt: 1, artifact: null });
    expect(builder.calls).toHaveLength(1);
  });

  it("refuses submissions when the builder is unavailable without storing runnable work", async () => {
    const builder = new FakeBuilder();
    builder.readinessError = "The model endpoint is not configured.";
    const { app, service } = openControl(tempDir(), builder, null);
    await service.start();
    const unavailable = await request(app).post("/jobs").set("authorization", AUTH).send({ paper_text: "A paper" }).expect(503);
    expect(unavailable.body).toMatchObject({ error: "builder_unavailable", message: builder.readinessError });
    builder.readiness = async () => { throw new Error("Cannot contact the build host."); };
    await request(app).post("/jobs").set("authorization", AUTH).send({ paper_text: "A paper" }).expect(503);
    expect(service.listJobs()).toEqual([]);
    expect(builder.calls).toHaveLength(0);
  });

  it("derives source titles and keeps uploaded PDF bytes out of job responses", async () => {
    const builder = new FakeBuilder();
    const { app, service, store } = openControl(tempDir(), builder, null);
    const url = await createJob(app, { paper_url: "https://example.com/papers/Line%20fit.pdf" });
    expect(url).toMatchObject({
      state: "queued", attempt: 1, pause: null,
      submission: { title: "Line fit", paper_url: "https://example.com/papers/Line%20fit.pdf" },
    });
    const pdf = Buffer.from("%PDF-1.7\nprivate-paper-data");
    const uploaded = await createJob(app, { paper_pdf_base64: pdf.toString("base64") });
    expect(uploaded.submission).toEqual({ title: "Research paper", paper_url: "" });
    expect(store.paperPdf(uploaded.id)).toEqual(pdf);
    expect(JSON.stringify(service.listJobs())).not.toContain(pdf.toString("base64"));
    expect(JSON.stringify(uploaded)).not.toContain(pdf.toString("base64"));
    expect(builder.calls).toHaveLength(0);
  });

  it("recovers a durably queued first attempt without a second submission or spending approval", async () => {
    const dir = tempDir();
    const first = openControl(dir, new FakeBuilder(), null);
    const job = await createJob(first.app);
    expect(job).toMatchObject({ state: "queued", attempt: 1, pause: null });
    const builder = new FakeBuilder();
    const second = openControl(dir, builder, null);
    await second.service.start();
    const call = await builder.call(0);
    expect(call.context).toMatchObject({ jobId: job.id, attempt: 1 });
    call.result.reject(new Error("The paper omits the required dataset."));
    await second.service.whenIdle();
    expect(second.service.job(job.id)).toMatchObject({ state: "failed", attempt: 1, artifact: null });
    expect(builder.calls).toHaveLength(1);
  });

  it("archives legacy bytes, stops legacy queued work, and retains read-only publication recovery", async () => {
    const dir = tempDir();
    const queuedId = randomUUID();
    const reviewedId = randomUUID();
    const publicationId = randomUUID();
    const oldArtifact = { sha256: "a".repeat(64), repository_commit: "b".repeat(40), verification: { source_bindings: ["old.py:run"] } };
    const publication: PaperPublication = {
      id: publicationId, state: "publishing",
      terms: { target_id: TARGET.id, artifact_sha256: oldArtifact.sha256, price_lovelace: "2000000", buyer_bond_lovelace: "1000000", supplier_bond_lovelace: "1000000" },
      supplier_pkh: TARGET.supplier_pkh, deposit_address: TARGET.deposit_address, endpoint_url: TARGET.endpoint_url,
      advert_ref: null, tx_hash: null, actual_debit_lovelace: null, error: null,
    };
    const pdf = Buffer.from("%PDF-1.7\noriginal bytes");
    const original = seedLegacyStore(dir, [
      { id: queuedId, state: "queued", pdf },
      { id: reviewedId, state: "awaiting_review", artifact: oldArtifact },
      { id: publicationId, state: "approved", artifact: oldArtifact, publication },
    ]);
    const publisher = new FakePublisher();
    await publisher.fetch("http://publisher.test/publications", {
      method: "POST", body: JSON.stringify({ job_id: publicationId, terms: publication.terms, artifact: oldArtifact }),
    });
    const builder = new FakeBuilder();
    const { app, service, store } = openControl(dir, builder, publisher);
    await service.start();
    expect(builder.calls).toHaveLength(0);
    expect(store.paperPdf(queuedId)).toEqual(pdf);
    for (const id of [queuedId, reviewedId]) {
      expect(service.job(id)).toMatchObject({ state: "interrupted", artifact: null, review: null, error: expect.stringContaining("legacy archive") });
      expect(service.job(id).submission).not.toHaveProperty("repository_url");
      expect(service.job(id).submission).not.toHaveProperty("revision");
      expect(service.job(id).submission).not.toHaveProperty("task");
    }
    expect(service.job(publicationId)).toMatchObject({ state: "approved", artifact: null, publication: { state: "confirmation_pending" } });
    expect(store.events(queuedId, 0, 10)).toMatchObject([{ message: "Original event" }, { phase: "migration" }]);
    const db = new Database(join(dir, "control.db"));
    try {
      expect(db.prepare("SELECT * FROM legacy_jobs ORDER BY id").all()).toEqual(original);
      const columns = db.pragma("table_info(jobs)") as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).not.toContain("repository_url");
      expect(columns.map(({ name }) => name)).not.toContain("revision");
    } finally {
      db.close();
    }
    const sent = publisher.requests.length;
    const refreshed = await request(app).get(`/jobs/${publicationId}/publication`).set("authorization", AUTH).expect(200);
    expect(refreshed.body).toMatchObject({ artifact: null, publication: { state: "prepared" } });
    await request(app).post(`/jobs/${publicationId}/publish`).set("authorization", AUTH)
      .send({ artifact_sha256: oldArtifact.sha256, confirm: true, max_debit_lovelace: "5000000" }).expect(409);
    await request(app).post(`/jobs/${publicationId}/prepare-publication`).set("authorization", AUTH).send(publication.terms).expect(409);
    await startBuild(app, publicationId).expect(409);
    expect(publisher.requests.slice(sent).map(({ method }) => method)).toEqual(["GET"]);
    const reopened = openControl(dir, new FakeBuilder(), publisher);
    expect(reopened.service.job(reviewedId).artifact).toBeNull();
    expect(reopened.store.events(queuedId, 0, 10)).toHaveLength(2);
    const retried = await startBuild(app, queuedId).expect(202);
    expect(retried.body.attempt).toBe(2);
    expect((await builder.call(0)).context.submission.paper_pdf_base64).toBe(pdf.toString("base64"));
  });

  it("rolls back a legacy migration rather than losing malformed saved input", () => {
    const dir = tempDir();
    const original = seedLegacyStore(dir, [{ id: randomUUID(), state: "queued", submissionJson: "{broken original bytes" }]);
    expect(() => new PaperControlStore(dir)).toThrow();
    const db = new Database(join(dir, "control.db"));
    try {
      expect(db.prepare("SELECT * FROM jobs ORDER BY id").all()).toEqual(original);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_jobs'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("requires the bearer token before reading any body and reports an unconfigured publisher explicitly", async () => {
    const { app, service } = openControl(tempDir(), new FakeBuilder(), null);
    await request(app).post("/jobs").set("authorization", "Bearer wrong-token-0123456789-abcdefghijklmnop")
      .set("content-type", "application/json").send("{not json").expect(401);
    await request(app).get("/jobs").expect(401);
    await request(app).get(`/jobs/${randomUUID()}/package`).set("authorization", `${AUTH}x`).expect(401);
    expect(service.listJobs()).toEqual([]);

    const targets = await request(app).get("/targets").set("authorization", AUTH).expect(503);
    expect(targets.body.error).toBe("publisher_unavailable");
    const status = await request(app).get("/status").set("authorization", AUTH).expect(200);
    expect(status.body).toMatchObject({ build_ready: true, publisher_ready: false, publisher_error: expect.stringContaining("PAPER2AGENT_PUBLISHER_URL") });

    expect(() => loadPaperControlConfig({ PAPER2AGENT_CONTROL_TOKEN: "short" })).toThrow(/PAPER2AGENT_CONTROL_TOKEN/);
    expect(() => loadPaperControlConfig({ PAPER2AGENT_CONTROL_TOKEN: TOKEN, PAPER2AGENT_PUBLISHER_URL: "http://publisher.test" }))
      .toThrow(/together/);
    expect(() => createPaperControlApp({ service, token: "" })).toThrow();
  });

  it("fails to open rather than falling back to memory", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "control.db"));
    expect(() => new PaperControlStore(dir)).toThrow();
  });

  it("queues paper-only input automatically without build limits and keeps retry approval explicit", async () => {
    const dir = tempDir();
    const builder = new FakeBuilder();
    const { app, service, store } = openControl(dir, builder, null);
    await service.start();
    for (const body of [
      {}, { title: "No paper" }, { paper_text: " \n\t " }, { paper_url: null }, { paper_text: "\u0000" },
      { ...SUBMISSION, repository_url: "https://github.com/example/fit-line" },
      { ...SUBMISSION, revision: "main" }, { ...SUBMISSION, task: "Fit a line" },
      { ...SUBMISSION, budget: { max_model_calls: 8 } }, { ...SUBMISSION, paper_text: undefined },
      { paper_url: "http://example.com/paper.pdf" }, { paper_url: "https://127.0.0.1/paper.pdf" },
      { paper_url: "https://user:secret@example.com/paper.pdf" },
      { paper_url: "https://example.com:8443/paper.pdf" },
      { ...SUBMISSION, paper_url: "https://example.com/paper.pdf" },
      { ...SUBMISSION, paper_pdf_base64: Buffer.from("%PDF-1.7\n").toString("base64") },
      { paper_text: "x".repeat(100_001) },
      { paper_pdf_base64: Buffer.from("not a PDF").toString("base64") },
      { paper_pdf_base64: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(5 * 1024 * 1024)]).toString("base64") },
    ]) {
      await request(app).post("/jobs").set("authorization", AUTH).send(body).expect(400);
    }
    expect(service.listJobs()).toEqual([]);
    expect(builder.calls).toHaveLength(0);
    const paper = "  Least squares line fit\nWe fit y = ax + b by least squares.\n";
    const job = await createJob(app, { paper_text: paper });
    expect(job).toMatchObject({
      state: "building", attempt: 1, pause: null,
      submission: { title: "Least squares line fit", paper_url: "", paper_text: paper },
    });
    expect(store.events(job.id, 0, 10)[0]).toMatchObject({ phase: "queued" });
    const list = await request(app).get("/jobs").set("authorization", AUTH).expect(200);
    expect(list.body.jobs).toEqual([{
      id: job.id, title: "Least squares line fit", paper_url: "",
      state: "building", publication_state: null, paused: false, created_at: job.created_at, updated_at: job.updated_at,
    }]);
    expect(JSON.stringify(list.body)).not.toContain(paper);
    const { context, result } = await builder.call(0);
    expect(context).toMatchObject({ jobId: job.id, attempt: 1, submission: { paper_text: paper } });
    expect(context.workDir).toBe(join(dir, "jobs", job.id, "1"));
    result.reject(new Error("The paper does not supply required data."));
    await service.whenIdle();
    expect(service.job(job.id)).toMatchObject({ state: "failed", attempt: 1, artifact: null, error: expect.stringContaining("required data") });
    expect(builder.calls).toHaveLength(1);
    for (const body of [
      {},
      { confirm: false },
      { confirm: "true" },
      { confirm: true, budget: { max_model_calls: 8, max_output_tokens: 1024, timeout_ms: 600_000 } },
      { confirm: true, extra: true },
    ]) {
      await request(app).post(`/jobs/${job.id}/build`).set("authorization", AUTH).send(body).expect(400);
    }
    expect(builder.calls).toHaveLength(1);
    const retried = await startBuild(app, job.id).expect(202);
    expect(retried.body).toMatchObject({ state: "building", attempt: 2, pause: null });
    expect((await builder.call(1)).context).toMatchObject({ jobId: job.id, attempt: 2 });
  });

  it("runs one build at a time, bounds the queue, and never restarts interrupted model spend", async () => {
    const dir = tempDir();
    const builder = new FakeBuilder();
    const first = openControl(dir, builder, null, 1);
    await first.service.start();
    const running = await createJob(first.app);
    const waiting = await createJob(first.app);
    await builder.call(0);
    const refused = await request(first.app).post("/jobs").set("authorization", AUTH).send(SUBMISSION).expect(429);
    expect(refused.body.error).toBe("queue_full");
    expect(first.service.listJobs()).toHaveLength(2);
    expect(builder.calls).toHaveLength(1);
    expect(first.service.job(waiting.id).state).toBe("queued");

    // Restart while the first build's sandbox may still exist. Cleanup must succeed before more spending.
    const unavailable = new FakeBuilder();
    unavailable.recoveryError = new Error("docker unavailable");
    const second = openControl(dir, unavailable, null);
    expect(second.service.job(running.id)).toMatchObject({ state: "interrupted", error: expect.stringContaining("never restarted automatically") });
    await expect(second.service.start()).rejects.toThrow("docker unavailable");
    expect(unavailable.calls).toHaveLength(0);
    expect(second.service.job(waiting.id).state).toBe("queued");

    const restarted = new FakeBuilder();
    const third = openControl(dir, restarted, null);
    await third.service.start();
    expect(restarted.recovered).toEqual([[join(dir, "jobs", running.id, "1")]]);
    const resumed = await restarted.call(0);
    expect(resumed.context.jobId).toBe(waiting.id);
    expect(restarted.calls.map((call) => call.context.jobId)).toEqual([waiting.id]);
    expect(third.service.job(running.id).state).toBe("interrupted");
  });

  it("starts no further build after a sandbox cleanup failure until a restart recovers it", async () => {
    const dir = tempDir();
    const builder = new FakeBuilder();
    const first = openControl(dir, builder, null);
    await first.service.start();
    const failed = await createJob(first.app);
    const waiting = await createJob(first.app);
    const call = await builder.call(0);
    call.result.reject(Object.assign(new Error("docker rm failed"), { cleanupPending: true }));
    await first.service.whenIdle();
    expect(first.service.job(failed.id).state).toBe("failed");
    expect(first.service.job(waiting.id).state).toBe("queued");
    expect(builder.calls).toHaveLength(1);
    const status = await request(first.app).get("/status").set("authorization", AUTH).expect(200);
    expect(status.body).toMatchObject({ build_ready: false, build_error: expect.stringContaining("docker rm failed") });
    await request(first.app).post("/jobs").set("authorization", AUTH).send(SUBMISSION).expect(503);
    expect(first.service.listJobs()).toHaveLength(2);

    const restarted = new FakeBuilder();
    const second = openControl(dir, restarted, null);
    await second.service.start();
    expect(restarted.recovered).toEqual([[join(dir, "jobs", failed.id, "1")]]);
    expect((await restarted.call(0)).context.jobId).toBe(waiting.id);
  });

  it("cancels a running build by aborting it and discards its late result", async () => {
    const builder = new FakeBuilder();
    builder.honorAbort = false;
    const { app, service } = openControl(tempDir(), builder, null);
    await service.start();
    const job = await createJob(app);
    const call = await builder.call(0);
    const cancelled = await request(app).post(`/jobs/${job.id}/cancel`).set("authorization", AUTH).send({}).expect(200);
    expect(cancelled.body.state).toBe("cancelled");
    expect(call.context.signal.aborted).toBe(true);

    call.result.resolve(await writePackage(call.context));
    await service.whenIdle();
    expect(service.job(job.id)).toMatchObject({ state: "cancelled", artifact: null });
    await request(app).post(`/jobs/${job.id}/cancel`).set("authorization", AUTH).send({}).expect(409);

    builder.honorAbort = true;
    expect((await startBuild(app, job.id).expect(202)).body.attempt).toBe(2);
    const retry = await builder.call(1);
    expect(retry.context.workDir).not.toBe(call.context.workDir);
  });

  it("pauses a running build while the wallet cannot pay and resumes it after the paid call", async () => {
    const builder = new FakeBuilder();
    const { app, service } = openControl(tempDir(), builder, null);
    await service.start();
    const job = await createJob(app);
    const call = await builder.call(0);
    const shortfall = {
      message: "insufficient balance for this request", requiredLovelace: "9200000",
      availableLovelace: "1000000", depositAddress: TARGET.deposit_address,
    };
    call.context.onFundsShortfall(shortfall);
    const paused = service.job(job.id);
    expect(paused).toMatchObject({ state: "building", pause: {
      message: shortfall.message, required_lovelace: "9200000", available_lovelace: "1000000",
      deposit_address: TARGET.deposit_address,
    } });
    expect(service.listJobs()[0]).toMatchObject({ id: job.id, paused: true });

    // Each retry refreshes the pause; only the first refusal is an event.
    call.context.onFundsShortfall({ ...shortfall, availableLovelace: "5000000" });
    expect(service.job(job.id).pause).toMatchObject({ since: paused.pause?.since, available_lovelace: "5000000" });
    const phases = () => service.events(job.id, undefined).events.map(({ phase }) => phase);
    expect(phases().filter((phase) => phase === "paused")).toHaveLength(1);

    call.context.onFundsRestored();
    expect(service.job(job.id)).toMatchObject({ state: "building", pause: null });
    expect(service.listJobs()[0]).toMatchObject({ paused: false });
    expect(phases()).toContain("resumed");
    call.result.resolve(await writePackage(call.context));
    await service.whenIdle();
    expect(service.job(job.id)).toMatchObject({ state: "awaiting_review", pause: null });
  });

  it("clears the pause when a paused build is cancelled or interrupted by a restart", async () => {
    const dir = tempDir();
    const builder = new FakeBuilder();
    const first = openControl(dir, builder, null);
    await first.service.start();
    const shortfall = { message: "insufficient balance for this request", requiredLovelace: null, availableLovelace: null, depositAddress: null };
    const cancelledJob = await createJob(first.app);
    const cancelledCall = await builder.call(0);
    cancelledCall.context.onFundsShortfall(shortfall);
    await request(first.app).post(`/jobs/${cancelledJob.id}/cancel`).set("authorization", AUTH).send({}).expect(200);
    expect(cancelledCall.context.signal.aborted).toBe(true);
    // A late refusal from the stopped attempt changes nothing.
    cancelledCall.context.onFundsShortfall(shortfall);
    expect(first.service.job(cancelledJob.id)).toMatchObject({ state: "cancelled", pause: null });

    const interruptedJob = await createJob(first.app);
    (await builder.call(1)).context.onFundsShortfall(shortfall);
    expect(first.service.job(interruptedJob.id).pause).not.toBeNull();
    const restarted = openControl(dir, new FakeBuilder(), null);
    expect(restarted.service.job(interruptedJob.id)).toMatchObject({ state: "interrupted", pause: null });
  });

  it("fails closed on artifact drift and accepts one attested approval of the exact current artifact", async () => {
    const builder = new FakeBuilder();
    const { app, service } = openControl(tempDir(), builder, null);
    await service.start();
    const job = await createJob(app);
    const review = (body: Record<string, unknown>) => request(app).post(`/jobs/${job.id}/review`).set("authorization", AUTH).send(body);
    const call = await builder.call(0);
    await review({ ...approval(job), artifact_sha256: "0".repeat(64) }).expect(409);
    call.context.log("verifying", "Independent verifier started.");
    expect(service.job(job.id).state).toBe("verifying");
    for (let index = 0; index < 120; index += 1) call.context.log("verifying", `check ${index}`);
    const output = await writePackage(call.context);
    call.result.resolve(output);
    await service.whenIdle();
    const built = service.job(job.id);
    expect(built).toMatchObject({ state: "awaiting_review", artifact: { sha256: output.artifact.sha256 } });
    expect(JSON.stringify(built)).not.toContain(call.context.workDir);

    const page = await request(app).get(`/jobs/${job.id}/events`).query({ after: "0" }).set("authorization", AUTH).expect(200);
    expect(page.body.events).toHaveLength(100);
    expect(page.body.next_seq).toBe(page.body.events[99].seq);
    const rest = await request(app).get(`/jobs/${job.id}/events`).query({ after: String(page.body.next_seq) }).set("authorization", AUTH).expect(200);
    expect(rest.body.events[0].seq).toBe(page.body.next_seq + 1);

    const preview = await request(app).get(`/jobs/${job.id}/files`).query({ path: "server.py" }).set("authorization", AUTH).expect(200);
    expect(preview.body).toEqual({ path: "server.py", content: FILES["server.py"], truncated: false });
    await request(app).get(`/jobs/${job.id}/files`).query({ path: "../control.db" }).set("authorization", AUTH).expect(404);

    await review(approval(built, { artifact_sha256: "0".repeat(64) })).expect(409);
    await review(approval(built, { license_reviewed: false })).expect(400);
    await review(approval(built, { decision: "reject", notes: "  " })).expect(400);

    const original = await readFile(output.archivePath);
    await appendFile(output.archivePath, "x");
    expect((await review(approval(built)).expect(409)).body.error).toBe("artifact_drift");
    await request(app).get(`/jobs/${job.id}/package`).set("authorization", AUTH).expect(409);
    await writeFile(output.archivePath, original);

    const server = join(output.filesDir, "server.py");
    await rm(server);
    await symlink(join(output.filesDir, "source", "fit.py"), server);
    await request(app).get(`/jobs/${job.id}/files`).query({ path: "server.py" }).set("authorization", AUTH).expect(409);
    await review(approval(built)).expect(409);
    await rm(server);
    await writeFile(server, FILES["server.py"]);
    expect(service.job(job.id).state).toBe("awaiting_review");

    await writeFile(server, "unreviewed preview replacement");

    const download = await request(app).get(`/jobs/${job.id}/package`).set("authorization", AUTH)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(download.headers["content-type"]).toBe("application/zip");
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="paper2agent-${job.id}.zip"`);
    const downloadedFiles = unzipSync(download.body);
    expect(Object.keys(downloadedFiles).sort()).toEqual(Object.keys(FILES).sort());
    for (const [path, content] of Object.entries(FILES)) {
      expect(Buffer.from(downloadedFiles[path])).toEqual(Buffer.from(content));
    }
    await writeFile(server, FILES["server.py"]);

    const approved = await review(approval(built, { notes: "Code, license, and results checked." })).expect(200);
    expect(approved.body).toMatchObject({
      state: "approved",
      review: { artifact_sha256: output.artifact.sha256, code_reviewed: true, license_reviewed: true, results_reviewed: true },
    });
    expect(approved.body.review.reviewed_at).toEqual(expect.any(Number));
    await review(approval(built)).expect(409);
    await review(approval(built, { decision: "reject", notes: "Second thoughts." })).expect(409);
    await startBuild(app, job.id).expect(409);
  });

  it("prepares exactly the reviewed bundle once and never resends a live publish", async () => {
    const builder = new FakeBuilder();
    const publisher = new FakePublisher();
    const harness = openControl(tempDir(), builder, publisher);
    const { app, service } = harness;
    await service.start();
    const job = await approvedJob(harness, builder, 0);
    const sha256 = job.artifact?.sha256;
    const live = { artifact_sha256: sha256, confirm: true, max_debit_lovelace: "5000000" };
    const prepare = (body: unknown) => request(app).post(`/jobs/${job.id}/prepare-publication`).set("authorization", AUTH).send(body);
    const publish = (body: unknown) => request(app).post(`/jobs/${job.id}/publish`).set("authorization", AUTH).send(body);

    expect((await request(app).get("/targets").set("authorization", AUTH).expect(200)).body.targets).toEqual([TARGET]);
    await publish(live).expect(409);
    await prepare(terms(job, { artifact_sha256: "0".repeat(64) })).expect(409);
    const prepared = await prepare(terms(job)).expect(200);
    expect(prepared.body.publication).toMatchObject({ id: job.id, state: "prepared", terms: terms(job) });
    expect(publisher.prepared).toHaveLength(1);
    const [sent] = publisher.prepared;
    expect(sent).toMatchObject({ job_id: job.id, terms: terms(job), artifact: job.artifact });
    expect(createHash("sha256").update(Buffer.from(sent.archive_base64, "base64")).digest("hex")).toBe(sha256);
    expect(publisher.requests.find((entry) => entry.path === "/publications")?.authorization).toBe(`Bearer ${PUBLISHER_TOKEN}`);

    await prepare(terms(job)).expect(200);
    await prepare(terms(job, { price_lovelace: "3000000" })).expect(409);
    expect(publisher.prepared).toHaveLength(1);
    await startBuild(app, job.id).expect(409);

    await publish({ artifact_sha256: sha256, max_debit_lovelace: "5000000" }).expect(400);
    await publish({ ...live, max_debit_lovelace: "0" }).expect(400);
    await publish({ ...live, artifact_sha256: "0".repeat(64) }).expect(409);

    publisher.publishFailure = new TypeError("socket hang up");
    expect((await publish(live).expect(502)).body.error).toBe("publisher_unreachable");
    expect(service.job(job.id).publication?.state).toBe("confirmation_pending");
    await publish(live).expect(409);
    const attempts = publisher.requests.filter((entry) => entry.path.endsWith("/publish"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].body).toEqual(live);
    expect(publisher.requests.some((entry) => entry.method === "GET" && entry.path.startsWith("/publications/"))).toBe(false);

    const refreshed = await request(app).get(`/jobs/${job.id}/publication`).set("authorization", AUTH).expect(200);
    expect(refreshed.body.publication.state).toBe("prepared");
    expect(publisher.requests.filter((entry) => entry.path.endsWith("/publish"))).toHaveLength(1);
  });

  it("leaves a publish interrupted by a restart unresolved and never resends it", async () => {
    const dir = tempDir();
    const builder = new FakeBuilder();
    const publisher = new FakePublisher();
    const first = openControl(dir, builder, publisher);
    await first.service.start();
    const job = await approvedJob(first, builder, 0);
    await request(first.app).post(`/jobs/${job.id}/prepare-publication`).set("authorization", AUTH).send(terms(job)).expect(200);
    const live = { artifact_sha256: job.artifact?.sha256, confirm: true, max_debit_lovelace: "5000000" };
    publisher.publishArrived = deferred<void>();
    void first.service.publish(job.id, live).catch(() => undefined);
    await publisher.publishArrived.promise;
    expect(first.service.job(job.id).publication?.state).toBe("publishing");

    const sent = publisher.requests.length;
    const second = openControl(dir, new FakeBuilder(), publisher);
    await second.service.start();
    expect(second.service.job(job.id).publication).toMatchObject({
      state: "confirmation_pending",
      error: expect.stringContaining("outcome is unknown"),
    });
    await request(second.app).post(`/jobs/${job.id}/publish`).set("authorization", AUTH).send(live).expect(409);
    expect(publisher.requests).toHaveLength(sent);
  });
});
