import { requestDeadline } from "./deadline.js";
/**
 * Paper2Agent control service: durable build orchestration, the bounded
 * authenticated control API, operator review, and publisher integration.
 *
 * Model credentials live only in the injected builder; this service holds no
 * wallet keys. A submission starts its first build. Builds have no call, token,
 * or time limit: a build pauses while the wallet cannot pay for its next model
 * call and continues when the call succeeds.
 * Retries, publication preparation, and a live publish need explicit operator
 * requests. Interrupted builds and live publish requests are never retried.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, sep } from "node:path";
import express from "express";
import type { Express, NextFunction, Request as ExpressRequest, RequestHandler, Response as ExpressResponse } from "express";
import { paper2AgentManifestHash, parsePaper2AgentManifest, type JsonObject } from "@marketplace/shared/paper2agent";
import type {
  PaperAcceptanceCase,
  PaperBuildEvent,
  PaperBuildJob,
  PaperBuildJobSummary,
  PaperBuildPause,
  PaperBuildState,
  PaperPackageArtifact,
  PaperPackageFile,
  PaperPublication,
  PaperPublicationState,
  PaperPublishApproval,
  PaperPublishTarget,
  PaperPublishTerms,
  PaperReview,
  PaperVerification,
  PaperWorkflowReadiness,
} from "@marketplace/shared/paper2agent/workflow";
import { MAX_PACKAGE_BYTES, packageRelativePath, packageZip, verifyPackageFiles } from "./archive.js";
import type { FundsShortfall } from "./agent.js";
import type { PaperBuildResult, PaperPackageBuilder } from "./build.js";
import type { PaperControlConfig } from "./control-config.js";
import { isPublicAddress } from "./sources.js";
import { boundedText, type PaperControlStore, type PaperJobGuard, type PaperJobRecord, type PaperSubmissionView } from "./store.js";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const PKH = /^[0-9a-f]{56}$/;
const ADDRESS = /^addr(?:_test)?1[02-9ac-hj-np-z]{20,200}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOVELACE = /^(?:0|[1-9][0-9]{0,16})$/;
const ADVERT_REF = /^[0-9a-f]{64}#[0-9]{1,5}$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const CURSOR = /^(?:0|[1-9][0-9]{0,14})$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const MAX_LOVELACE = 45_000_000_000_000_000n;
const MAX_LISTED_JOBS = 100;
const MAX_EVENTS_PER_PAGE = 100;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PAPER_TEXT_CHARS = 100_000;
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_ARTIFACT_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_FILES = 10_000;
const SUBMISSION_BODY_LIMIT = 8 * 1024 * 1024;
const CONTROL_BODY_LIMIT = 64 * 1024;
const READINESS_TIMEOUT_MS = 10_000;
const PUBLISHER_READ_TIMEOUT_MS = 15_000;
/** The publisher builds the runtime image during preparation (up to five minutes). */
const PUBLISHER_PREPARE_TIMEOUT_MS = 330_000;
const PUBLISHER_PUBLISH_TIMEOUT_MS = 300_000;
const PUBLISHER_RESPONSE_BYTES = 1024 * 1024;
const PUBLISHER_UNCONFIGURED = "Publishing is not configured. Set PAPER2AGENT_PUBLISHER_URL and PAPER2AGENT_PUBLISHER_TOKEN on the control service.";

const BUILDABLE: Partial<Record<PaperBuildState, true>> = {
  submitted: true, failed: true, interrupted: true, cancelled: true, rejected: true,
};
const CANCELLABLE: Partial<Record<PaperBuildState, true>> = { queued: true, building: true, verifying: true };
const PUBLICATION_STATES: Record<PaperPublicationState, true> = {
  prepared: true, publishing: true, confirmation_pending: true, published: true, failed: true,
};

class ControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** `definite`: the publisher answered with a refusal, so this request left no unknown outcome. */
class PublisherFailure extends ControlError {
  constructor(status: number, code: string, message: string, readonly definite: boolean) {
    super(status, code, message);
  }
}

/** Host artifact files no longer match the recorded digests. */
class ArtifactDrift extends Error {}

class BuildStop extends Error {
  constructor(readonly kind: "cancelled" | "shutdown") {
    super(`Build ${kind}`);
  }
}

function invalid(message: string): ControlError {
  return new ControlError(400, "invalid_request", message);
}

function conflict(): ControlError {
  return new ControlError(409, "conflict", "The job changed while this request was running. Reload it and try again.");
}

function noArtifact(): ControlError {
  return new ControlError(404, "no_artifact", "This job has no built package.");
}

function invalidReply(subject: string): PublisherFailure {
  return new PublisherFailure(502, "publisher_invalid_response", `The publisher returned an invalid ${subject}.`, false);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A shallow copy of a non-array object's own enumerable properties, or null. */
function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function fields(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const input = plainObject(value);
  if (!input) throw invalid(`${label} must be a JSON object.`);
  const extra = Object.keys(input).find((key) => !required.includes(key) && !optional.includes(key));
  if (extra !== undefined) throw invalid(`${label} has an unknown field: ${extra.slice(0, 64)}.`);
  const missing = required.find((key) => !Object.hasOwn(input, key));
  if (missing !== undefined) throw invalid(`${label} is missing ${missing}.`);
  return input;
}

function text(value: unknown, label: string, maximum: number, options: { multiline: boolean; required: boolean }): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string.`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (options.required && normalized === "") throw invalid(`${label} is required.`);
  if (normalized.length > maximum) throw invalid(`${label} must be at most ${maximum} characters.`);
  if ((options.multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(normalized)) {
    throw invalid(`${label} contains control characters.`);
  }
  return normalized;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw invalid(`${label} must be 64 lowercase hex characters.`);
  return value;
}

function lovelace(value: unknown, label: string, positive: boolean): string {
  if (typeof value !== "string" || !LOVELACE.test(value) || BigInt(value) > MAX_LOVELACE || (positive && value === "0")) {
    throw invalid(`${label} must be a decimal string of whole lovelace${positive ? " above zero" : ""}.`);
  }
  return value;
}

function sameTerms(actual: unknown, expected: PaperPublishTerms): boolean {
  if (actual === null || typeof actual !== "object") return false;
  const wanted: Record<string, string> = { ...expected };
  const entries = Object.entries(actual);
  return entries.length === Object.keys(wanted).length &&
    entries.every(([key, value]) => Object.hasOwn(wanted, key) && wanted[key] === value);
}

interface ParsedSubmission {
  submission: PaperSubmissionView;
  pdf: Buffer | null;
}

function parseSubmission(value: unknown): ParsedSubmission {
  const input = fields(value, "Submission", [], ["title", "paper_url", "paper_text", "paper_pdf_base64"]);
  const rawText = input.paper_text;
  if (rawText !== undefined && (typeof rawText !== "string" || rawText.length > MAX_PAPER_TEXT_CHARS)) {
    throw invalid(`paper_text must be a string of at most ${MAX_PAPER_TEXT_CHARS} characters.`);
  }
  if (typeof rawText === "string" && /[\x00-\x08\x0b-\x1f\x7f]/.test(rawText)) {
    throw invalid("paper_text contains control characters.");
  }
  const paperText = typeof rawText === "string" && rawText.trim() !== "" ? rawText : undefined;
  const rawPdf = input.paper_pdf_base64;
  let pdf: Buffer | null = null;
  if (rawPdf !== undefined && rawPdf !== "") {
    const failure = invalid("paper_pdf_base64 must be standard base64 of a PDF of at most 5 MiB.");
    if (typeof rawPdf !== "string" || rawPdf.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 || rawPdf.length % 4 !== 0 || !BASE64.test(rawPdf)) {
      throw failure;
    }
    pdf = Buffer.from(rawPdf, "base64");
    if (pdf.length === 0 || pdf.length > MAX_PDF_BYTES || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw failure;
  }
  const url = paperUrl(input.paper_url === undefined ? "" : input.paper_url, paperText !== undefined || pdf !== null);
  if (Number(paperText !== undefined) + Number(pdf !== null) + Number(url !== "") !== 1) {
    throw invalid("Supply exactly one paper source: paper_url, paper_text, or paper_pdf_base64.");
  }
  const title = input.title === undefined ? "" : text(input.title, "title", 200, { multiline: false, required: false });
  return {
    submission: {
      title: title || submissionTitle(url, paperText),
      paper_url: url,
      ...(paperText === undefined ? {} : { paper_text: paperText }),
    },
    pdf,
  };
}

/** Empty only when the user supplies the paper itself; the builder never downloads it. */
function paperUrl(value: unknown, paperSupplied: boolean): string {
  if (typeof value !== "string") throw invalid("paper_url must be a string.");
  const trimmed = value.trim();
  if (trimmed === "") {
    if (!paperSupplied) throw invalid("Provide paper_url, paper_text, or paper_pdf_base64.");
    return "";
  }
  const failure = invalid("paper_url must be a public HTTPS URL without credentials or a custom port.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw failure;
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (trimmed.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.port !== "" ||
      host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && !isPublicAddress(host))) {
    throw failure;
  }
  return url.href;
}

function submissionTitle(url: string, paperText: string | undefined): string {
  if (paperText) return boundedText(paperText.split(/\r?\n/, 1)[0], 200, false) || "Research paper";
  if (url) {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (filename) {
      let decoded = filename;
      try { decoded = decodeURIComponent(filename); } catch { /* Keep malformed escapes as text. */ }
      return boundedText(decoded.replace(/\.pdf$/i, ""), 200, false) || parsed.hostname;
    }
    return parsed.hostname;
  }
  return "Research paper";
}

function parseBuildRequest(value: unknown): void {
  const input = fields(value, "Build request", ["confirm"]);
  if (input.confirm !== true) throw invalid("Set confirm to true to approve model spending from the wallet for this attempt.");
}

interface ReviewDecision extends Omit<PaperReview, "reviewed_at"> {
  decision: "approve" | "reject";
}

function parseReview(value: unknown): ReviewDecision {
  const input = fields(value, "Review", ["decision", "artifact_sha256", "code_reviewed", "license_reviewed", "results_reviewed", "notes"]);
  const { decision, code_reviewed: code, license_reviewed: license, results_reviewed: results } = input;
  if (decision !== "approve" && decision !== "reject") throw invalid("decision must be approve or reject.");
  if (typeof code !== "boolean" || typeof license !== "boolean" || typeof results !== "boolean") {
    throw invalid("code_reviewed, license_reviewed, and results_reviewed must be booleans.");
  }
  return {
    decision,
    artifact_sha256: digest(input.artifact_sha256, "artifact_sha256"),
    code_reviewed: code,
    license_reviewed: license,
    results_reviewed: results,
    notes: text(input.notes, "notes", 4000, { multiline: true, required: false }),
  };
}

function parseTerms(value: unknown): PaperPublishTerms {
  const input = fields(value, "Publication terms", ["target_id", "artifact_sha256", "price_lovelace", "buyer_bond_lovelace", "supplier_bond_lovelace"]);
  if (typeof input.target_id !== "string" || !TARGET_ID.test(input.target_id)) throw invalid("target_id is not a valid publisher target ID.");
  return {
    target_id: input.target_id,
    artifact_sha256: digest(input.artifact_sha256, "artifact_sha256"),
    price_lovelace: lovelace(input.price_lovelace, "price_lovelace", true),
    buyer_bond_lovelace: lovelace(input.buyer_bond_lovelace, "buyer_bond_lovelace", false),
    supplier_bond_lovelace: lovelace(input.supplier_bond_lovelace, "supplier_bond_lovelace", false),
  };
}

function parseApproval(value: unknown): PaperPublishApproval {
  const input = fields(value, "Publish approval", ["artifact_sha256", "confirm", "max_debit_lovelace"]);
  if (input.confirm !== true) throw invalid("Set confirm to true to approve the live wallet debit.");
  return {
    artifact_sha256: digest(input.artifact_sha256, "artifact_sha256"),
    confirm: true,
    max_debit_lovelace: lovelace(input.max_debit_lovelace, "max_debit_lovelace", true),
  };
}

/** The approved, reviewed artifact a publication step may use. */
function reviewedArtifact(job: PaperBuildJob, sha256: string): PaperPackageArtifact {
  if (job.state !== "approved" || !job.artifact || !job.review) {
    throw new ControlError(409, "not_approved", "Only an approved artifact can be published.");
  }
  if (job.review.artifact_sha256 !== job.artifact.sha256 || sha256 !== job.artifact.sha256) {
    throw new ControlError(409, "artifact_mismatch", "The SHA-256 does not match the reviewed artifact.");
  }
  return job.artifact;
}

/** A JSON round-trip copy of a plain object, so stored evidence is exactly what was checked. */
function jsonObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const copy: unknown = JSON.parse(JSON.stringify(value));
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) return null;
  const object: JsonObject = Object.fromEntries(Object.entries(copy));
  return object;
}

function textList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some((item) => typeof item !== "string")) {
    throw new Error(`Verification ${label} must be a list of at most 1000 strings`);
  }
  return [...value];
}

function tokenCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Verification ${label} must be null or a non-negative integer`);
  }
  return value;
}

function checkFiles(value: unknown): PaperPackageFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PACKAGE_FILES) {
    throw new Error(`Artifact files must list 1 to ${MAX_PACKAGE_FILES} files`);
  }
  const seen = new Set<string>();
  let total = 0;
  return value.map((item) => {
    const file = plainObject(item);
    const path = file?.path;
    const bytes = file?.bytes;
    const sha256 = file?.sha256;
    if (typeof path !== "string" || packageRelativePath(path) !== path || seen.has(path)) {
      throw new Error("Artifact files contain an unsafe or duplicate path");
    }
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || (total += bytes) > MAX_PACKAGE_BYTES) {
      throw new Error("Artifact file sizes are invalid or exceed the package limit");
    }
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new Error("Artifact file digests must be 64 lowercase hex characters");
    seen.add(path);
    return { path, bytes, sha256 };
  });
}

function checkCases(value: unknown): PaperAcceptanceCase[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Verification cases must be a list of at most 1000 cases");
  return value.map((item) => {
    const entry = plainObject(item);
    const name = entry?.name;
    const input = jsonObject(entry?.input);
    const expected = jsonObject(entry?.expected);
    if (typeof name !== "string" || name === "" || name.length > 200 || !input || !expected) {
      throw new Error("Each verification case needs a name and JSON input and expected objects");
    }
    return { name, input, expected };
  });
}

function checkVerification(value: unknown): PaperVerification {
  const evidence = fields(value, "Artifact verification",
    ["builder_run_id", "verifier_run_id", "paper_references", "checks", "test_source", "test_stdout", "cases", "model_calls", "input_tokens", "output_tokens"]);
  const { builder_run_id: builder, verifier_run_id: verifier, test_source: source, test_stdout: stdout, model_calls: calls } = evidence;
  if (typeof builder !== "string" || typeof verifier !== "string" || builder === "" || verifier === "" ||
      builder.length > 200 || verifier.length > 200 || builder === verifier) {
    throw new Error("Verification evidence needs distinct builder and verifier run IDs");
  }
  if (typeof source !== "string" || source === "" || typeof stdout !== "string") {
    throw new Error("Verification evidence needs the independent test program and its output");
  }
  if (typeof calls !== "number" || !Number.isSafeInteger(calls) || calls < 0) {
    throw new Error(`Verification reports ${String(calls)} model calls; expected a non-negative integer`);
  }
  const references = textList(evidence.paper_references, "paper_references");
  if (references.length === 0 || references.some((reference) => reference.trim() === "")) {
    throw new Error("Verification paper_references must contain concrete paper references");
  }
  return {
    builder_run_id: builder,
    verifier_run_id: verifier,
    paper_references: references,
    checks: textList(evidence.checks, "checks"),
    test_source: source,
    test_stdout: stdout,
    cases: checkCases(evidence.cases),
    model_calls: calls,
    input_tokens: tokenCount(evidence.input_tokens, "input_tokens"),
    output_tokens: tokenCount(evidence.output_tokens, "output_tokens"),
  };
}

/** A clean copy of the builder's artifact; the manifest must bind the archive digest. */
function checkArtifact(value: unknown): PaperPackageArtifact {
  const artifact = fields(value, "Artifact",
    ["sha256", "manifest_hash", "manifest", "paper_sha256", "runtime_image", "files", "verification"]);
  const { sha256, paper_sha256: paperHash, runtime_image: image } = artifact;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new Error("Artifact sha256 must be 64 lowercase hex characters");
  const manifest = parsePaper2AgentManifest(artifact.manifest);
  if (manifest.package_sha256 !== sha256) throw new Error("Manifest package_sha256 must equal the archive SHA-256");
  const manifestHash = paper2AgentManifestHash(manifest);
  if (artifact.manifest_hash !== manifestHash) throw new Error("Artifact manifest_hash does not match its manifest");
  if (typeof paperHash !== "string" || !SHA256.test(paperHash)) throw new Error("Artifact paper_sha256 must be 64 lowercase hex characters");
  if (typeof image !== "string" || !IMAGE_ID.test(image)) throw new Error("Artifact runtime_image must be an exact sha256 image ID");
  const checked: PaperPackageArtifact = {
    sha256,
    manifest_hash: manifestHash,
    manifest,
    paper_sha256: paperHash,
    runtime_image: image,
    files: checkFiles(artifact.files),
    verification: checkVerification(artifact.verification),
  };
  if (Buffer.byteLength(JSON.stringify(checked)) > MAX_ARTIFACT_JSON_BYTES) throw new Error("Artifact metadata exceeds 4 MiB");
  return checked;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Missing or link-replaced host files are artifact drift; other I/O errors stay internal errors. */
function driftOnMissing(error: unknown, subject: string): unknown {
  if (error instanceof ArtifactDrift) return error;
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return new ArtifactDrift(`${subject} is missing or was replaced by a link`);
  return error;
}

/** The whole archive, only while it is still the regular file with the recorded digest. */
async function readArchive(path: string, sha256: string): Promise<Buffer> {
  try {
    if (await realpath(path) !== path) throw new ArtifactDrift("the package archive now resolves through a link");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new ArtifactDrift("the package archive is not a bounded regular file");
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const { bytesRead: extra } = await handle.read(Buffer.alloc(1), 0, 1, offset);
      if (offset !== data.length || extra !== 0 || createHash("sha256").update(data).digest("hex") !== sha256) {
        throw new ArtifactDrift("the package archive does not match its recorded SHA-256");
      }
      return data;
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw driftOnMissing(error, "the package archive");
  }
}

/** The first MAX_PREVIEW_BYTES of a reviewed file, after checking the whole file's type, size, and digest. */
async function verifiedPrefix(filesDir: string, file: PaperPackageFile): Promise<Buffer> {
  const target = join(filesDir, ...file.path.split("/"));
  try {
    if (await realpath(filesDir) !== filesDir || await realpath(target) !== target) {
      throw new ArtifactDrift(`${file.path} now resolves through a link`);
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.bytes) throw new ArtifactDrift(`${file.path} is no longer the reviewed regular file`);
      const prefix = Buffer.alloc(Math.min(file.bytes, MAX_PREVIEW_BYTES));
      const chunk = Buffer.alloc(1024 * 1024);
      const hash = createHash("sha256");
      let total = 0;
      while (total <= file.bytes) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) break;
        if (total < prefix.length) chunk.copy(prefix, total, 0, Math.min(bytesRead, prefix.length - total));
        hash.update(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total !== file.bytes || hash.digest("hex") !== file.sha256) {
        throw new ArtifactDrift(`${file.path} no longer matches its recorded SHA-256`);
      }
      return prefix;
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw driftOnMissing(error, file.path);
  }
}

async function boundedBody(response: Response, maximum: number): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > maximum) {
    await response.body?.cancel();
    throw new Error(`the response exceeds ${maximum} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error(`the response exceeds ${maximum} bytes`);
    }
    chunks.push(value);
  }
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isPublicationState(value: unknown): value is PaperPublicationState {
  return typeof value === "string" && Object.hasOwn(PUBLICATION_STATES, value);
}

function isNullableMatch(value: unknown, pattern: RegExp): value is string | null {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function checkTarget(value: unknown): PaperPublishTarget {
  const target = plainObject(value);
  if (!target) throw invalidReply("target");
  const { id, label, network_id: network, supplier_pkh: pkh, deposit_address: address, endpoint_url: endpoint, available, live_chain: live } = target;
  const networkId = network === 0 ? 0 : network === 1 ? 1 : null;
  if (typeof id !== "string" || !TARGET_ID.test(id) || typeof label !== "string" || label.length > 200 || networkId === null ||
      typeof pkh !== "string" || !PKH.test(pkh) || typeof address !== "string" || !ADDRESS.test(address) ||
      !isHttpUrl(endpoint) || typeof available !== "boolean" || typeof live !== "boolean") {
    throw invalidReply("target");
  }
  return {
    id, label, network_id: networkId, supplier_pkh: pkh, deposit_address: address, endpoint_url: endpoint, available, live_chain: live,
  };
}

/** The publisher's record must be for this job and exactly these terms. */
function checkPublication(value: unknown, id: string, terms: PaperPublishTerms): PaperPublication {
  const publication = plainObject(value);
  if (!publication || publication.id !== id) throw invalidReply("publication");
  if (!sameTerms(publication.terms, terms)) {
    throw new PublisherFailure(502, "publication_terms_mismatch", "The publisher holds this publication with different terms than this job recorded.", false);
  }
  const {
    state, supplier_pkh: pkh, deposit_address: address, endpoint_url: endpoint,
    advert_ref: advert, tx_hash: tx, actual_debit_lovelace: debit, error,
  } = publication;
  if (!isPublicationState(state) || typeof pkh !== "string" || !PKH.test(pkh) || typeof address !== "string" ||
      !ADDRESS.test(address) || !isHttpUrl(endpoint) || !isNullableMatch(advert, ADVERT_REF) ||
      !isNullableMatch(tx, SHA256) || !isNullableMatch(debit, LOVELACE) || (error !== null && typeof error !== "string")) {
    throw invalidReply("publication");
  }
  return {
    id,
    state,
    terms: { ...terms },
    supplier_pkh: pkh,
    deposit_address: address,
    endpoint_url: endpoint,
    advert_ref: advert,
    tx_hash: tx,
    actual_debit_lovelace: debit,
    error: error === null ? null : boundedText(error, 2000),
  };
}

interface PreparePublicationRequest {
  job_id: string;
  terms: PaperPublishTerms;
  artifact: PaperPackageArtifact;
  archive_base64: string;
}

/** Fixed management routes on the configured publisher. Never retries. */
class PublisherClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly shutdown: AbortSignal,
  ) {}

  async targets(timeoutMs: number): Promise<PaperPublishTarget[]> {
    const targets = plainObject(await this.request("GET", "/targets", undefined, timeoutMs))?.targets;
    if (!Array.isArray(targets) || targets.length > 256) throw invalidReply("target list");
    return targets.map(checkTarget);
  }

  async prepare(request: PreparePublicationRequest): Promise<PaperPublication> {
    const reply = await this.request("POST", "/publications", JSON.stringify(request), PUBLISHER_PREPARE_TIMEOUT_MS);
    return checkPublication(reply, request.job_id, request.terms);
  }

  async publish(id: string, approval: PaperPublishApproval, terms: PaperPublishTerms): Promise<PaperPublication> {
    const reply = await this.request("POST", `/publications/${encodeURIComponent(id)}/publish`, JSON.stringify(approval), PUBLISHER_PUBLISH_TIMEOUT_MS);
    return checkPublication(reply, id, terms);
  }

  /** Read-only: the publisher never builds a transaction for this route. */
  async publication(id: string, terms: PaperPublishTerms): Promise<PaperPublication> {
    const reply = await this.request("GET", `/publications/${encodeURIComponent(id)}`, undefined, PUBLISHER_READ_TIMEOUT_MS);
    return checkPublication(reply, id, terms);
  }

  private async request(method: "GET" | "POST", path: string, body: string | undefined, timeoutMs: number): Promise<unknown> {
    const deadline = requestDeadline(timeoutMs, this.shutdown);
    try { return await this.requestWithDeadline(method, path, body, timeoutMs, deadline.signal); }
    finally { deadline.dispose(); }
  }

  private async requestWithDeadline(method: "GET" | "POST", path: string, body: string | undefined,
    timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        body,
        redirect: "error",
        signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      });
    } catch (error) {
      throw this.unanswered(error, signal, timeoutMs);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await boundedBody(response, PUBLISHER_RESPONSE_BYTES));
    } catch (error) {
      if (signal.aborted) throw this.unanswered(error, signal, timeoutMs);
      payload = undefined;
    }
    if (response.status === 401 || response.status === 403) {
      throw new PublisherFailure(502, "publisher_auth_failed", "The publisher rejected the control service token. Check PAPER2AGENT_PUBLISHER_TOKEN on both services.", true);
    }
    if (!response.ok) {
      const reply = plainObject(payload);
      const remoteCode = reply?.error;
      const remoteMessage = reply?.message;
      const code = typeof remoteCode === "string" && ERROR_CODE.test(remoteCode) ? remoteCode : "publisher_error";
      const detail = typeof remoteMessage === "string" ? boundedText(remoteMessage, 500) : `HTTP ${response.status}`;
      if (response.status < 500) throw new PublisherFailure(response.status, code, `The publisher refused the request: ${detail}`, true);
      throw new PublisherFailure(502, code, `The publisher failed (HTTP ${response.status}): ${detail}`, false);
    }
    if (payload === undefined) throw invalidReply("response");
    return payload;
  }

  private unanswered(error: unknown, signal: AbortSignal, timeoutMs: number): PublisherFailure {
    if (this.shutdown.aborted) {
      return new PublisherFailure(503, "service_closing", "The control service is shutting down; the publisher request was abandoned.", false);
    }
    if (signal.aborted) {
      return new PublisherFailure(504, "publisher_timeout", `The publisher did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, false);
    }
    return new PublisherFailure(502, "publisher_unreachable", `The publisher could not be reached: ${boundedText(message(error), 300)}`, false);
  }
}

export interface PaperControlServiceOptions {
  config: PaperControlConfig;
  store: PaperControlStore;
  builder: PaperPackageBuilder;
  /** Publisher transport; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface PaperEventPage {
  events: PaperBuildEvent[];
  /** Pass back as `after` to read the following events. */
  next_seq: number;
}

export interface PaperPackageDownload {
  filename: string;
  data: Buffer;
}

export interface PaperFilePreview {
  path: string;
  content: string;
  truncated: boolean;
}

interface ActiveBuild {
  jobId: string;
  attempt: number;
  controller: AbortController;
  done: Promise<void>;
}

interface Readiness {
  ready: boolean;
  error: string | null;
}

/**
 * Lifecycle: construct (marks builds interrupted by a restart), `await start()`
 * before serving requests, close() to stop admission, interrupt the running
 * build, and abandon publisher calls. The caller closes the store after close()
 * resolves.
 */
export class PaperControlService {
  private readonly config: PaperControlConfig;
  private readonly store: PaperControlStore;
  private readonly builder: PaperPackageBuilder;
  private readonly publisher: PublisherClient | null;
  private readonly shutdown = new AbortController();
  /** Jobs with a review or publication step in flight. */
  private readonly busy = new Set<string>();
  private readonly operations = new Set<Promise<unknown>>();
  private active: ActiveBuild | null = null;
  private started = false;
  private starting: Promise<void> | null = null;
  private preparing = false;
  /** Set when a builder reports sandbox cleanup still pending; no build starts again before a restart recovers it. */
  private halted: string | null = null;
  private closed: Promise<void> | null = null;

  constructor(options: PaperControlServiceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.builder = options.builder;
    const { publisherUrl, publisherToken } = options.config;
    this.publisher = publisherUrl && publisherToken
      ? new PublisherClient(publisherUrl, publisherToken, options.fetch ?? globalThis.fetch, this.shutdown.signal)
      : null;
    this.recover();
  }

  /**
   * Lets the builder release the resources of builder calls that never settled
   * (a crashed process) or settled with cleanup still pending, then runs queued
   * builds, including builds queued before a restart. If that cleanup fails,
   * rejects without dequeuing anything; the markers stay, so the next start
   * retries it.
   */
  start(): Promise<void> {
    this.starting ??= (async () => {
      const unsettled = this.store.unsettledBuilds();
      if (unsettled.length > 0) {
        await this.builder.recoverInterrupted?.(unsettled.map(({ id, attempt }) => this.attemptDir(id, attempt)));
        for (const { id, attempt } of unsettled) this.store.builderSettled(id, attempt);
      }
      this.started = true;
      this.pump();
    })();
    return this.starting;
  }

  /** Resolves once no build is running, including builds the queue starts meanwhile. */
  async whenIdle(): Promise<void> {
    while (this.active) await this.active.done;
  }

  close(): Promise<void> {
    this.closed ??= (async () => {
      this.shutdown.abort();
      this.active?.controller.abort(new BuildStop("shutdown"));
      await Promise.allSettled([this.starting]);
      await this.whenIdle();
      await Promise.allSettled([...this.operations]);
    })();
    return this.closed;
  }

  async readiness(): Promise<PaperWorkflowReadiness> {
    const [build, publisher] = await Promise.all([this.buildReadiness(), this.publisherReadiness()]);
    return {
      build_ready: build.ready,
      build_error: build.error,
      publisher_ready: publisher.ready,
      publisher_error: publisher.error,
    };
  }

  listJobs(): PaperBuildJobSummary[] {
    return this.store.summaries(MAX_LISTED_JOBS);
  }

  job(id: string): PaperBuildJob {
    return this.record(id).job;
  }

  /** A submission durably queues its first build. */
  async createJob(value: unknown): Promise<PaperBuildJob> {
    this.assertOpen();
    const { submission, pdf } = parseSubmission(value);
    const readiness = await this.buildReadiness();
    this.assertOpen();
    if (!readiness.ready || this.halted) {
      throw new ControlError(503, "builder_unavailable", this.halted ?? readiness.error ?? "The builder is not ready.");
    }
    this.assertQueueCapacity();
    const { job } = this.store.create(randomUUID(), submission, pdf, Date.now(), {
      phase: "queued",
      message: "Build attempt 1 queued. It has no call, token, or time limit and pauses while the wallet cannot pay " +
        "for the next model call. Publication still requires operator approval.",
    });
    this.pump();
    return this.record(job.id).job;
  }

  /** Explicit operator retry; it approves model spending from the wallet for one more attempt. */
  requestBuild(id: string, value: unknown): PaperBuildJob {
    this.assertOpen();
    parseBuildRequest(value);
    const { job, publicationTerms } = this.record(id);
    if (job.publication || publicationTerms) {
      throw new ControlError(409, "publication_prepared", "Publication preparation has started for this artifact, so this job cannot be rebuilt.");
    }
    if (!BUILDABLE[job.state]) {
      throw new ControlError(409, "invalid_state", job.state === "awaiting_review"
        ? "Reject the current artifact before starting another build."
        : `A build cannot start while the job is ${job.state}.`);
    }
    this.assertQueueCapacity();
    const attempt = job.attempt + 1;
    const now = Date.now();
    const queued = this.store.transition(id, { states: [job.state], attempt: job.attempt }, {
      state: "queued", attempt, pause: null, artifact: null, archivePath: null, filesDir: null, review: null, error: null, queuedAt: now,
    }, {
      phase: "queued",
      message: `Build attempt ${attempt} queued by an operator retry. It pauses while the wallet cannot pay for the next model call.`,
    }, now);
    if (!queued) throw conflict();
    this.pump();
    return this.record(id).job;
  }

  cancel(id: string): PaperBuildJob {
    this.assertOpen();
    const { job } = this.record(id);
    if (!CANCELLABLE[job.state]) {
      throw new ControlError(409, "invalid_state", `Only queued or running builds can be cancelled; this job is ${job.state}.`);
    }
    const cancelled = this.store.transition(id, { states: [job.state], attempt: job.attempt }, { state: "cancelled", pause: null, queuedAt: null }, {
      phase: "cancelled",
      message: `Build attempt ${job.attempt} cancelled by the operator.`,
    }, Date.now());
    if (!cancelled) throw conflict();
    if (this.active?.jobId === id && this.active.attempt === job.attempt) this.active.controller.abort(new BuildStop("cancelled"));
    return cancelled.job;
  }

  events(id: string, after: unknown): PaperEventPage {
    this.record(id);
    if (after !== undefined && (typeof after !== "string" || !CURSOR.test(after))) throw invalid("after must be a non-negative integer.");
    const cursor = after === undefined ? 0 : Number(after);
    const events = this.store.events(id, cursor, MAX_EVENTS_PER_PAGE);
    return { events, next_seq: events.length > 0 ? events[events.length - 1].seq : cursor };
  }

  async packageArchive(id: string): Promise<PaperPackageDownload> {
    const { job, archivePath } = this.record(id);
    if (!job.artifact || !archivePath) throw noArtifact();
    const { sha256 } = job.artifact;
    const archive = await this.guardDrift(id, () => readArchive(archivePath, sha256));
    return { filename: `paper2agent-${id}.zip`, data: await packageZip(archive) };
  }

  async packageFile(id: string, path: unknown): Promise<PaperFilePreview> {
    if (typeof path !== "string" || path === "") throw invalid("The path query parameter is required.");
    const { job, filesDir } = this.record(id);
    if (!job.artifact || !filesDir) throw noArtifact();
    const file = job.artifact.files.find((entry) => entry.path === path);
    if (!file) throw new ControlError(404, "file_not_found", "That path is not in the artifact file inventory.");
    const prefix = await this.guardDrift(id, () => verifiedPrefix(filesDir, file));
    const truncated = file.bytes > prefix.length;
    let content: string | null = null;
    if (!prefix.includes(0)) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: truncated });
      } catch {
        content = null;
      }
    }
    if (content === null) throw new ControlError(415, "binary_file", "This file is not UTF-8 text. Download the package to inspect it.");
    return { path: file.path, content, truncated };
  }

  /** Records an attested decision about the exact current artifact. Never publishes or spends. */
  async review(id: string, value: unknown): Promise<PaperBuildJob> {
    const decision = parseReview(value);
    return this.exclusive(id, async () => {
      const { job, archivePath, filesDir } = this.record(id);
      if (job.state !== "awaiting_review" || !job.artifact) {
        throw new ControlError(409, "invalid_state", `Only an artifact awaiting review can be reviewed; this job is ${job.state}.`);
      }
      if (decision.artifact_sha256 !== job.artifact.sha256) {
        throw new ControlError(409, "artifact_mismatch", "The reviewed SHA-256 is not the current artifact. Reload the job and review the current artifact.");
      }
      const approve = decision.decision === "approve";
      if (approve && !(decision.code_reviewed && decision.license_reviewed && decision.results_reviewed)) {
        throw invalid("Approval requires the code, license, and results review attestations.");
      }
      if (!approve && decision.notes === "") throw invalid("Rejection requires a reason in notes.");
      if (approve) {
        if (!archivePath || !filesDir) throw noArtifact();
        const { sha256, files } = job.artifact;
        await this.guardDrift(id, async () => {
          await readArchive(archivePath, sha256);
          try {
            await verifyPackageFiles(filesDir, files);
          } catch (error) {
            throw new ArtifactDrift(`the package files no longer match the inventory (${message(error)})`);
          }
        });
      }
      const review: PaperReview = {
        artifact_sha256: decision.artifact_sha256,
        code_reviewed: decision.code_reviewed,
        license_reviewed: decision.license_reviewed,
        results_reviewed: decision.results_reviewed,
        notes: decision.notes,
        reviewed_at: Date.now(),
      };
      const reviewed = this.store.transition(id, { states: ["awaiting_review"], attempt: job.attempt }, {
        state: approve ? "approved" : "rejected",
        review,
      }, {
        phase: "review",
        message: approve
          ? `Artifact ${review.artifact_sha256} approved by the operator. Approval does not publish or spend.`
          : `Artifact ${review.artifact_sha256} rejected: ${review.notes}`,
      }, review.reviewed_at);
      if (!reviewed) throw conflict();
      return reviewed.job;
    });
  }

  async targets(): Promise<PaperPublishTarget[]> {
    return this.requirePublisher().targets(PUBLISHER_READ_TIMEOUT_MS);
  }

  /**
   * Sends the verified reviewed bundle to the publisher, which builds the
   * runtime image. No chain transaction. Freezes the artifact and review first.
   */
  async preparePublication(id: string, value: unknown): Promise<PaperBuildJob> {
    const publisher = this.requirePublisher();
    const terms = parseTerms(value);
    return this.exclusive(id, async () => {
      const { job, archivePath } = this.record(id);
      const artifact = reviewedArtifact(job, terms.artifact_sha256);
      const previous = job.publication;
      // A preparation that failed before any transaction may be retried; anything else is idempotent.
      if (previous && !(previous.state === "failed" && previous.tx_hash === null)) {
        if (sameTerms(previous.terms, terms)) return job;
        throw new ControlError(409, "publication_conflict", "This job already has a publication with different terms.");
      }
      if (!archivePath) throw noArtifact();
      if (this.preparing) throw new ControlError(429, "publisher_busy", "Another publication is being prepared. Try again when it finishes.");
      this.preparing = true;
      try {
        const archive = await this.guardDrift(id, () => readArchive(archivePath, artifact.sha256));
        const guard: PaperJobGuard = { states: ["approved"], attempt: job.attempt };
        const frozen = this.store.transition(id, guard, { publicationTerms: terms }, {
          phase: "publication",
          message: `Sending reviewed artifact ${artifact.sha256} to the publisher for target ${terms.target_id}. ` +
            "This step builds the runtime image and makes no chain transaction.",
        }, Date.now());
        if (!frozen) throw conflict();
        let publication: PaperPublication;
        try {
          publication = await publisher.prepare({ job_id: id, terms, artifact, archive_base64: archive.toString("base64") });
        } catch (error) {
          const reason = `Publication preparation failed: ${message(error)}`;
          this.store.transition(id, guard, { error: reason }, { phase: "publication", message: reason }, Date.now());
          throw error;
        }
        const prepared = this.store.transition(id, guard, { publication, error: null }, {
          phase: "publication",
          message: `The publisher reports publication state ${publication.state} for target ${terms.target_id}. ` +
            `Fund deposit address ${publication.deposit_address} manually before publishing.`,
        }, Date.now());
        if (!prepared) throw conflict();
        return prepared.job;
      } finally {
        this.preparing = false;
      }
    });
  }

  /**
   * Live publish with an explicit maximum wallet debit. Sent once; an unknown
   * outcome becomes confirmation_pending and needs a refresh, never a retry.
   */
  async publish(id: string, value: unknown): Promise<PaperBuildJob> {
    const publisher = this.requirePublisher();
    const approval = parseApproval(value);
    return this.exclusive(id, async () => {
      const { job, archivePath } = this.record(id);
      const artifact = reviewedArtifact(job, approval.artifact_sha256);
      const current = job.publication;
      if (!current) throw new ControlError(409, "not_prepared", "Prepare the publication before publishing.");
      if (current.terms.artifact_sha256 !== artifact.sha256) {
        throw new ControlError(409, "artifact_mismatch", "The prepared publication is for a different artifact.");
      }
      if (current.state !== "prepared" && current.state !== "failed") {
        throw new ControlError(409, "publication_state", `The publication is ${current.state}. Refresh it instead of publishing again.`);
      }
      if (!archivePath) throw noArtifact();
      await this.guardDrift(id, () => readArchive(archivePath, artifact.sha256));
      const guard: PaperJobGuard = { states: ["approved"], attempt: job.attempt };
      const marked = this.store.transition(id, guard, { publication: { ...current, state: "publishing", error: null }, error: null }, {
        phase: "publishing",
        message: `Live publish approved for target ${current.terms.target_id} with a maximum wallet debit of ` +
          `${approval.max_debit_lovelace} lovelace. This request is never retried automatically.`,
      }, Date.now());
      if (!marked) throw conflict();
      let outcome: PaperPublication;
      try {
        outcome = await publisher.publish(id, approval, current.terms);
      } catch (error) {
        let after: PaperPublication = {
          ...current,
          state: "confirmation_pending",
          error: `Publish outcome unknown: ${message(error)} Refresh the publication; do not publish again until it shows prepared or failed.`,
        };
        // A refusal is definite, so one read-only refresh records the publisher's actual state.
        if (error instanceof PublisherFailure && error.definite) {
          after = await publisher.publication(id, current.terms).catch(() => after);
        }
        this.recordPublication(id, guard, after, `Publish request failed: ${message(error)}`);
        throw error;
      }
      return this.recordPublication(id, guard, outcome, null);
    });
  }

  /** Reads the publisher's current record. Never creates a transaction or runs the tool. */
  async refreshPublication(id: string): Promise<PaperBuildJob> {
    const publisher = this.requirePublisher();
    return this.exclusive(id, async () => {
      const { job, publicationTerms } = this.record(id);
      const terms = job.publication?.terms ?? publicationTerms;
      if (job.state !== "approved" || !terms) throw new ControlError(409, "not_prepared", "No publication has been prepared for this job.");
      let publication: PaperPublication;
      try {
        publication = await publisher.publication(id, terms);
      } catch (error) {
        if (error instanceof PublisherFailure && error.status === 404) {
          throw job.publication
            ? new ControlError(502, "publisher_record_missing", "The publisher has no record of this prepared publication. Check the publisher data before any further action.")
            : new ControlError(409, "publication_missing", "The publisher has no record of this publication. Prepare it again.");
        }
        throw error;
      }
      if (JSON.stringify(publication) === JSON.stringify(job.publication)) return job;
      return this.recordPublication(id, { states: ["approved"], attempt: job.attempt }, publication, null);
    });
  }

  private record(id: string): PaperJobRecord {
    const record = JOB_ID.test(id) ? this.store.job(id) : undefined;
    if (!record) throw new ControlError(404, "not_found", "Paper build job not found.");
    return record;
  }

  private assertOpen(): void {
    if (this.closed) throw new ControlError(503, "service_closing", "The control service is shutting down.");
  }

  private assertQueueCapacity(): void {
    if (this.store.queuedCount() >= this.config.maxQueuedBuilds) {
      throw new ControlError(429, "queue_full", `The build queue is full (${this.config.maxQueuedBuilds} waiting builds). Try again after a build finishes.`);
    }
  }

  private requirePublisher(): PublisherClient {
    if (!this.publisher) throw new ControlError(503, "publisher_unavailable", PUBLISHER_UNCONFIGURED);
    return this.publisher;
  }

  /** One review or publication step per job at a time, tracked so close() can wait for it. */
  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.busy.has(id)) {
      throw new ControlError(409, "operation_in_progress", "Another review or publication step for this job is still running.");
    }
    this.busy.add(id);
    const operation = work().finally(() => this.busy.delete(id));
    this.operations.add(operation);
    void operation.catch(() => undefined).finally(() => this.operations.delete(operation));
    return operation;
  }

  /** Integrity failures become an audit event and a fail-closed 409. */
  private async guardDrift<T>(id: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ArtifactDrift)) throw error;
      this.store.appendEvent(id, { phase: "integrity", message: `Artifact integrity check failed: ${error.message}.` }, Date.now());
      throw new ControlError(409, "artifact_drift",
        `The stored artifact failed its integrity check: ${error.message}. It cannot be reviewed, downloaded, or published.`);
    }
  }

  private recordPublication(id: string, guard: PaperJobGuard, publication: PaperPublication, error: string | null): PaperBuildJob {
    const recorded = this.store.transition(id, guard, { publication, error }, {
      phase: "publication",
      message: `Publication state: ${publication.state}.` +
        (publication.tx_hash ? ` Transaction ${publication.tx_hash}.` : "") +
        (publication.error ? ` ${publication.error}` : ""),
    }, Date.now());
    if (!recorded) throw conflict();
    return recorded.job;
  }

  private async buildReadiness(): Promise<Readiness> {
    if (this.halted) return { ready: false, error: this.halted };
    const deadline = AbortSignal.timeout(READINESS_TIMEOUT_MS);
    try {
      const state = await Promise.race([
        this.builder.readiness(),
        new Promise<never>((_, reject) => {
          deadline.addEventListener("abort", () => reject(new Error(`no answer within ${READINESS_TIMEOUT_MS / 1000} seconds`)), { once: true });
        }),
      ]);
      return state.ready
        ? { ready: true, error: null }
        : { ready: false, error: boundedText(state.error ?? "The builder is not ready.", 1000) };
    } catch (error) {
      return { ready: false, error: boundedText(`Builder readiness check failed: ${message(error)}`, 1000) };
    }
  }

  private async publisherReadiness(): Promise<Readiness> {
    if (!this.publisher) return { ready: false, error: PUBLISHER_UNCONFIGURED };
    try {
      await this.publisher.targets(READINESS_TIMEOUT_MS);
      return { ready: true, error: null };
    } catch (error) {
      return { ready: false, error: message(error) };
    }
  }

  /** Restart recovery. Never resumes model spending or a publish request. */
  private recover(): void {
    const now = Date.now();
    for (const { job } of this.store.jobsInStates(["building", "verifying"])) {
      const reason = `Build attempt ${job.attempt} was interrupted by a control service restart. ` +
        "Model spending is never restarted automatically; start a new build to retry.";
      this.store.transition(job.id, { states: [job.state], attempt: job.attempt }, { state: "interrupted", pause: null, error: reason }, {
        phase: "interrupted",
        message: reason,
      }, now);
    }
    for (const { job } of this.store.jobsInStates(["approved"])) {
      if (job.publication?.state !== "publishing") continue;
      const reason = "The control service restarted while a live publish request was in flight. " +
        "The outcome is unknown; refresh the publication before any further action.";
      this.store.transition(job.id, { states: ["approved"], attempt: job.attempt }, {
        publication: { ...job.publication, state: "confirmation_pending", error: reason },
      }, { phase: "publishing", message: reason }, now);
    }
  }

  /** At most one running build, and none while a sandbox cleanup is pending. */
  private pump(): void {
    if (!this.started || this.closed || this.active || this.halted) return;
    try {
      const next = this.store.nextQueued();
      if (!next) return;
      const { id, attempt } = next.job;
      const building = this.store.transition(id, { states: ["queued"], attempt }, { state: "building", queuedAt: null, builderAttempt: attempt }, {
        phase: "building",
        message: `Build attempt ${attempt} started.`,
      }, Date.now());
      if (!building) return;
      const controller = new AbortController();
      const done = this.run(building, controller)
        .catch((error: unknown) => console.error(`[paper2agent-control] build ${id} could not record its outcome:`, error))
        .finally(() => {
          this.active = null;
          this.pump();
        });
      this.active = { jobId: id, attempt, controller, done };
    } catch (error) {
      console.error("[paper2agent-control] could not start the next queued build:", error);
    }
  }

  private async run(record: PaperJobRecord, controller: AbortController): Promise<void> {
    const { id, attempt, submission } = record.job;
    let cleanupPending = false;
    try {
      const workDir = await this.workDir(id, attempt);
      const pdf = this.store.paperPdf(id);
      const result = await this.builder.build({
        jobId: id,
        attempt,
        submission: pdf ? { ...submission, paper_pdf_base64: pdf.toString("base64") } : submission,
        onFundsShortfall: (shortfall) => this.fundsShortfall(id, attempt, shortfall),
        onFundsRestored: () => this.fundsRestored(id, attempt),
        workDir,
        signal: controller.signal,
        log: (phase, detail) => this.builderLog(id, attempt, phase, detail),
      });
      controller.signal.throwIfAborted();
      const output = await this.checkOutput(result, workDir);
      controller.signal.throwIfAborted();
      this.store.transition(id, { states: ["building", "verifying"], attempt }, {
        state: "awaiting_review",
        pause: null,
        artifact: output.artifact,
        archivePath: output.archivePath,
        filesDir: output.filesDir,
        error: null,
      }, {
        phase: "awaiting_review",
        message: `Artifact ${output.artifact.sha256} passed integrity checks and awaits operator review. Nothing is published without review.`,
      }, Date.now());
    } catch (error) {
      cleanupPending = error instanceof Error && "cleanupPending" in error && error.cleanupPending === true;
      if (cleanupPending) {
        this.halted = boundedText(`Build sandbox cleanup failed: ${message(error)} New builds are paused until the control service ` +
          "restarts and removes the leftover sandbox resources.", 1000);
        this.store.appendEvent(id, { phase: "cleanup", message: this.halted }, Date.now());
      }
      const stop = controller.signal.reason instanceof BuildStop ? controller.signal.reason.kind : null;
      // A cancelled job already has its final state.
      if (stop === "cancelled") return;
      const state: PaperBuildState = stop === "shutdown" ? "interrupted" : "failed";
      const reason = stop === "shutdown"
        ? `Build attempt ${attempt} was interrupted because the control service stopped. Model spending is never restarted automatically; start a new build to retry.`
        : `Build attempt ${attempt} failed: ${message(error)}`;
      this.store.transition(id, { states: ["building", "verifying"], attempt }, { state, pause: null, error: reason }, { phase: state, message: reason }, Date.now());
    } finally {
      // A settled builder call has released its sandbox resources unless it reports cleanup still pending.
      // Then the marker stays, so the next start() recovers them before any further build.
      if (!cleanupPending) this.store.builderSettled(id, attempt);
    }
  }

  /** Progress from the current attempt only; phase "verifying" moves the job to verifying. */
  private builderLog(id: string, attempt: number, phase: string, detail: string): void {
    const current = this.store.buildState(id);
    if (!current || current.attempt !== attempt || (current.state !== "building" && current.state !== "verifying")) return;
    if (phase === "verifying" && current.state === "building") {
      this.store.transition(id, { states: ["building"], attempt }, { state: "verifying" }, { phase, message: detail }, Date.now());
    } else {
      this.store.appendEvent(id, { phase, message: detail }, Date.now());
    }
  }

  /** Records the first refusal as an event; later refusals of the same call only refresh the pause. */
  private fundsShortfall(id: string, attempt: number, shortfall: FundsShortfall): void {
    const current = this.store.job(id)?.job;
    if (!current || current.attempt !== attempt || (current.state !== "building" && current.state !== "verifying")) return;
    const now = Date.now();
    const pause: PaperBuildPause = {
      since: current.pause?.since ?? now,
      checked_at: now,
      message: boundedText(shortfall.message, 500),
      required_lovelace: shortfall.requiredLovelace,
      available_lovelace: shortfall.availableLovelace,
      deposit_address: shortfall.depositAddress,
    };
    const event = current.pause ? null : {
      phase: "paused",
      message: `Paused: the wallet cannot pay for the next model call (${pause.message}). ` +
        "The build retries the same call and continues when the wallet has enough funds.",
    };
    this.store.transition(id, { states: [current.state], attempt }, { pause }, event, now);
  }

  private fundsRestored(id: string, attempt: number): void {
    const current = this.store.buildState(id);
    if (!current || current.attempt !== attempt || (current.state !== "building" && current.state !== "verifying")) return;
    this.store.transition(id, { states: [current.state], attempt }, { pause: null }, {
      phase: "resumed",
      message: "The wallet paid for the waiting model call. The build continues.",
    }, Date.now());
  }

  /** A fresh server-named directory per attempt. Files of superseded attempts are removed. */
  private async workDir(id: string, attempt: number): Promise<string> {
    const workDir = this.attemptDir(id, attempt);
    const jobDir = dirname(workDir);
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(jobDir)) {
      if (!/^[0-9]+$/.test(name) || Number(name) >= attempt) continue;
      try {
        await rm(join(jobDir, name), { recursive: true, force: true });
      } catch (error) {
        this.store.appendEvent(id, { phase: "cleanup", message: `Files of attempt ${name} could not be removed (${errorCode(error) ?? "unknown error"}).` }, Date.now());
      }
    }
    try {
      await mkdir(workDir, { mode: 0o700 });
    } catch (error) {
      throw new Error(`The work directory for attempt ${attempt} could not be created fresh (${errorCode(error) ?? "unknown error"})`);
    }
    return workDir;
  }

  /** The per-attempt work directory layout; the builder's crash recovery matches its resources by this path. */
  private attemptDir(id: string, attempt: number): string {
    return join(this.config.dataDir, "jobs", id, String(attempt));
  }

  /** Builder output must stay inside the attempt directory and match its declared digests. */
  private async checkOutput(result: PaperBuildResult, workDir: string): Promise<{ artifact: PaperPackageArtifact; archivePath: string; filesDir: string }> {
    const artifact = checkArtifact(result.artifact);
    const root = await realpath(workDir);
    const inside = async (path: unknown): Promise<string> => {
      const actual = typeof path === "string" && isAbsolute(path) ? await realpath(path).catch(() => "") : "";
      if (!actual.startsWith(root + sep)) throw new Error("Builder output must be an existing path inside the attempt work directory");
      return actual;
    };
    const archivePath = await inside(result.archivePath);
    const filesDir = await inside(result.filesDir);
    await readArchive(archivePath, artifact.sha256);
    try {
      await verifyPackageFiles(filesDir, artifact.files);
    } catch (error) {
      throw new Error(`The package files do not match the artifact inventory: ${message(error)}`);
    }
    return { artifact, archivePath, filesDir };
  }
}

export interface PaperControlAppOptions {
  service: PaperControlService;
  /** Bearer token the buyer proxy sends; at least 32 characters. */
  token: string;
}

function sendError(res: ExpressResponse, status: number, code: string, detail: string): void {
  res.status(status).json({ error: code, message: detail });
}

function route(handler: (req: ExpressRequest<Record<string, string>>, res: ExpressResponse) => unknown): RequestHandler<Record<string, string>> {
  return (req, res, next) => {
    Promise.resolve().then(() => handler(req, res)).catch(next);
  };
}

/** The control API. Every route, including downloads, requires the bearer token before any body is read. */
export function createPaperControlApp(options: PaperControlAppOptions): Express {
  const { service } = options;
  if (options.token.length < 32) throw new Error("createPaperControlApp: the token must be at least 32 characters");
  const expected = createHash("sha256").update(options.token).digest();
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("query parser", "simple");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const supplied = /^Bearer (\S+)$/.exec(req.header("authorization") ?? "")?.[1] ?? "";
    if (!timingSafeEqual(createHash("sha256").update(supplied).digest(), expected)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendError(res, 401, "unauthorized", "A valid control service bearer token is required.");
      return;
    }
    next();
  });
  const small = express.json({ limit: CONTROL_BODY_LIMIT, strict: true, inflate: false });
  const submission = express.json({ limit: SUBMISSION_BODY_LIMIT, strict: true, inflate: false });

  app.get("/status", route(async (_req, res) => {
    res.json(await service.readiness());
  }));
  app.get("/jobs", route((_req, res) => {
    res.json({ jobs: service.listJobs() });
  }));
  app.post("/jobs", submission, route(async (req, res) => {
    res.status(202).json(await service.createJob(req.body));
  }));
  app.get("/jobs/:id", route((req, res) => {
    res.json(service.job(req.params.id));
  }));
  app.post("/jobs/:id/build", small, route((req, res) => {
    res.status(202).json(service.requestBuild(req.params.id, req.body));
  }));
  app.post("/jobs/:id/cancel", small, route((req, res) => {
    res.json(service.cancel(req.params.id));
  }));
  app.get("/jobs/:id/events", route((req, res) => {
    res.json(service.events(req.params.id, req.query.after));
  }));
  app.get("/jobs/:id/package", route(async (req, res) => {
    const archive = await service.packageArchive(req.params.id);
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${archive.filename}"`);
    res.setHeader("Content-Length", String(archive.data.length));
    res.end(archive.data);
  }));
  app.get("/jobs/:id/files", route(async (req, res) => {
    res.json(await service.packageFile(req.params.id, req.query.path));
  }));
  app.post("/jobs/:id/review", small, route(async (req, res) => {
    res.json(await service.review(req.params.id, req.body));
  }));
  app.get("/targets", route(async (_req, res) => {
    res.json({ targets: await service.targets() });
  }));
  app.post("/jobs/:id/prepare-publication", small, route(async (req, res) => {
    res.json(await service.preparePublication(req.params.id, req.body));
  }));
  app.post("/jobs/:id/publish", small, route(async (req, res) => {
    res.json(await service.publish(req.params.id, req.body));
  }));
  app.get("/jobs/:id/publication", route(async (req, res) => {
    res.json(await service.refreshPublication(req.params.id));
  }));
  app.use((_req, res) => {
    sendError(res, 404, "not_found", "Unknown control service route.");
  });
  app.use((error: unknown, _req: ExpressRequest, res: ExpressResponse, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof ControlError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500;
    if (status === 413) {
      sendError(res, 413, "body_too_large", "The request body is too large.");
    } else if (status >= 400 && status < 500) {
      const type = error instanceof Error && "type" in error ? error.type : undefined;
      sendError(res, status, "invalid_request", type === "entity.parse.failed" ? "The request body is not valid JSON." : "The request body could not be read.");
    } else {
      console.error("[paper2agent-control] request failed:", error);
      sendError(res, 500, "internal_error", "The control service could not complete the request.");
    }
  });
  return app;
}
