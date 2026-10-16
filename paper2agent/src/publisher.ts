/**
 * Paper2Agent publisher: operator wallet slots, hash-bound runtime images,
 * explicitly approved advert transactions with a durable journal, and supervised
 * supplier processes behind a fixed local proxy.
 *
 * The publisher holds no model credentials and never runs bundle code on the
 * host. Docker builds the runtime image with networking disabled; the existing
 * supplier node runs each tool call in a hardened, secret-free container.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { LiveOgmiosProvider, ReadOnlyOgmiosProvider, type ChainProvider, type OutputReference } from "@marketplace/shared/chain";
import { canonicalize, decodeAdvertDatum, type AdvertDatum } from "@marketplace/shared/cbor";
import { loadBlueprint, type PostAdvertBuildResult } from "@marketplace/shared/tx";
import { inspectSignedTransaction, inspectSignedTransactionFinancials } from "@marketplace/shared/tx/server";
import {
  MAX_TOOL_INPUT_BYTES, PAPER2AGENT_CAPABILITY_ID, PAPER2AGENT_DELIVERY_OVERHEAD_MS,
  paper2AgentManifestHash, paper2AgentModel, paper2AgentSupplierPkh, parsePaper2AgentManifest, type Paper2AgentManifest,
} from "@marketplace/shared/paper2agent";
import type { PaperPackageArtifact, PaperPublication, PaperPublishTarget, PaperPublishTerms } from "@marketplace/shared/paper2agent/workflow";
import { runPostAdvert, type PostAdvertFlowParams, type PostAdvertFlowResult } from "../../supplier/src/cli/postAdvertFlow.js";
import { readManifest } from "../../supplier/src/paper2agent/local.js";
import { MAX_PACKAGE_BYTES, extractPackage, fileSha256, packageRelativePath, verifyPackageFiles } from "./archive.js";
import type { PaperPublisherConfig, PublisherTarget } from "./publisher-config.js";
import { PaperPublisherStore, PublicationConflictError, type AdvertTransaction, type PublicationRecord, type WalletInput } from "./publisher-store.js";
import { dockerCommand } from "./sandbox.js";

const PUBLICATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const LOVELACE = /^(?:0|[1-9][0-9]{0,16})$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TOOL_PATH = /^\/tools\/([A-Za-z0-9][A-Za-z0-9_-]{0,31})(\/.*)$/;
const JOB_PATH = /^\/v1\/paper2agent\/run\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_PREPARE_JSON_BYTES = 90 * 1024 * 1024;
const MAX_APPROVAL_JSON_BYTES = 16 * 1024;
const MAX_PROXY_BODY_BYTES = MAX_TOOL_INPUT_BYTES + 4096;
const MAX_CHILD_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 2;
const MAX_FILES = 10_000;
const MAX_ERROR_CHARS = 2000;
const BUILD_TIMEOUT_MS = 270_000;
const ADVERT_AWAIT_MS = 120_000;
/** Below the control service's 300-second publish wait. */
const PUBLISH_REPLY_MS = 240_000;
const CHAIN_READ_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const RESTART_INTERVAL_MS = 30_000;
const DRAIN_TIMEOUT_MS = 15 * 60_000;
const DRAIN_POLL_MS = 1_000;
const STOP_TIMEOUT_MS = 10_000;
/**
 * Cardano's stability window at one-second slots. An expired transaction whose
 * inputs are still unspent this long after its validity end cannot reappear.
 */
const EXPIRY_FINALITY_SLOTS = 43_200;
/** The builder verified wrappers with a writable tmpfs working directory; mirror it. */
const RUNTIME_START = "mkdir /workspace/output && cp -R /opt/paper2agent/bundle/. /workspace/output/ && " +
  "cd /workspace/output && exec python /workspace/output/server.py";

/** Every advert field the operator approved; advertised_at is set by the shared flow. */
const ADVERT_FIELDS = ["supplier_pkh", "capability_id", "model", "max_output_tokens", "max_processing_ms", "price_lovelace",
  "supplier_bond_lovelace", "buyer_bond_lovelace", "endpoint_url", "detail_uri", "detail_hash", "status"] as const;

interface SupplierRoute {
  timeoutMs: number;
  /** A tool execution (paid or free): counted for drain and refused once shutdown starts. */
  admission: boolean;
  /** Refused during shutdown so discovery does not send new buyers. */
  refusedWhileDraining: boolean;
  /** Needs the tool-call bearer token; answers 404 when none is configured. */
  toolCall: boolean;
}

/** The public supplier protocol. Nothing else under /tools/:targetId is forwarded. */
const SUPPLIER_ROUTES: Record<string, SupplierRoute> = {
  "GET /healthz": { timeoutMs: 5_000, admission: false, refusedWhileDraining: false, toolCall: false },
  "GET /status": { timeoutMs: 5_000, admission: false, refusedWhileDraining: false, toolCall: false },
  "GET /capability": { timeoutMs: 30_000, admission: false, refusedWhileDraining: true, toolCall: false },
  "POST /v1/paper2agent/run": { timeoutMs: 300_000, admission: true, refusedWhileDraining: true, toolCall: false },
  // 15 s discovery + 120 s maximum runtime + container stop.
  "POST /v1/paper2agent/call": { timeoutMs: 180_000, admission: true, refusedWhileDraining: true, toolCall: true },
  "POST /v1/paper2agent/lookup": { timeoutMs: 30_000, admission: false, refusedWhileDraining: false, toolCall: false },
};
const JOB_ROUTE: SupplierRoute = { timeoutMs: 30_000, admission: false, refusedWhileDraining: false, toolCall: false };

export class PublisherError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function invalid(message: string): PublisherError {
  return new PublisherError(400, "invalid_request", message);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function fields(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be a JSON object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid(`${label} must have exactly these fields: ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function outputRef(text: string): OutputReference {
  const [txHash, index] = text.split("#");
  return { txHash, index: Number(index) };
}

function parseTerms(value: unknown): PaperPublishTerms {
  const terms = fields(value, "terms", ["target_id", "artifact_sha256", "price_lovelace", "buyer_bond_lovelace", "supplier_bond_lovelace"]);
  if (typeof terms.target_id !== "string" || !TARGET_ID.test(terms.target_id)) throw invalid("terms.target_id is not a valid target ID");
  if (typeof terms.artifact_sha256 !== "string" || !SHA256.test(terms.artifact_sha256)) {
    throw invalid("terms.artifact_sha256 must be 64 lowercase hex characters");
  }
  for (const name of ["price_lovelace", "buyer_bond_lovelace", "supplier_bond_lovelace"]) {
    const amount = terms[name];
    if (typeof amount !== "string" || !LOVELACE.test(amount)) throw invalid(`terms.${name} must be a non-negative integer string`);
  }
  return terms as unknown as PaperPublishTerms;
}

/** The reviewed artifact, bound to its manifest, package hash, inventory and base image. */
function parseArtifact(value: unknown, runtimeImage: string): { artifact: PaperPackageArtifact; manifest: Paper2AgentManifest } {
  const artifact = fields(value, "artifact",
    ["sha256", "manifest_hash", "manifest", "paper_sha256", "runtime_image", "files", "verification"]);
  if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256) ||
      typeof artifact.manifest_hash !== "string" || !SHA256.test(artifact.manifest_hash)) {
    throw invalid("artifact.sha256 and artifact.manifest_hash must be 64 lowercase hex characters");
  }
  let manifest: Paper2AgentManifest;
  try {
    manifest = parsePaper2AgentManifest(artifact.manifest);
  } catch (error) {
    throw invalid(`artifact.manifest is invalid: ${message(error)}`);
  }
  if (paper2AgentManifestHash(manifest) !== artifact.manifest_hash) {
    throw new PublisherError(400, "manifest_hash_mismatch", "artifact.manifest_hash does not match the manifest.");
  }
  if (manifest.package_sha256 !== artifact.sha256) {
    throw new PublisherError(400, "package_hash_mismatch", "The manifest package_sha256 does not bind the bundle archive.");
  }
  if (typeof artifact.paper_sha256 !== "string" || !SHA256.test(artifact.paper_sha256)) {
    throw invalid("artifact.paper_sha256 must be 64 lowercase hex characters");
  }
  if (typeof artifact.runtime_image !== "string" || !IMAGE_ID.test(artifact.runtime_image)) {
    throw invalid("artifact.runtime_image must be an exact image ID");
  }
  if (artifact.runtime_image !== runtimeImage) {
    throw new PublisherError(409, "runtime_image_mismatch",
      `The artifact was verified with ${artifact.runtime_image}; this publisher runs ${runtimeImage}.`);
  }
  const files = artifact.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw invalid(`artifact.files must list 1 to ${MAX_FILES} files`);
  const paths = new Set<string>();
  let total = 0;
  for (const entry of files) {
    const file = fields(entry, "artifact file", ["path", "bytes", "sha256"]);
    let path: string;
    try {
      path = packageRelativePath(String(file.path));
    } catch {
      throw invalid("artifact.files contains an unsafe path");
    }
    if (file.path !== path || paths.has(path) || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      throw invalid("artifact.files entries need unique normalized paths, byte sizes and SHA-256 digests");
    }
    paths.add(path);
    total += file.bytes;
  }
  if (total > MAX_PACKAGE_BYTES) throw invalid("artifact.files exceed the package size limit");
  if (!paths.has("server.py")) throw invalid("The bundle must contain server.py at its root");
  const verification = fields(artifact.verification, "artifact.verification",
    ["builder_run_id", "verifier_run_id", "paper_references", "checks", "test_source", "test_stdout", "cases", "model_calls", "input_tokens", "output_tokens"]);
  if (!Array.isArray(verification.paper_references) || verification.paper_references.length === 0 ||
      verification.paper_references.length > 1000 ||
      verification.paper_references.some((reference) => typeof reference !== "string" || reference.trim() === "")) {
    throw invalid("artifact.verification.paper_references must list 1 to 1000 concrete paper references");
  }
  return { artifact: artifact as unknown as PaperPackageArtifact, manifest };
}

function decodeArchive(value: unknown): Buffer {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64.test(value)) throw invalid("archive_base64 must be canonical base64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding > MAX_PACKAGE_BYTES) {
    throw new PublisherError(413, "archive_too_large", "The decoded bundle exceeds 64 MiB.");
  }
  const archive = Buffer.from(value, "base64");
  if (archive.toString("base64") !== value) throw invalid("archive_base64 must be canonical base64");
  return archive;
}

/** Private file, flushed with its directory entry before the caller continues. */
async function writePrivateFile(path: string, content: Buffer | string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** A free loopback port for the next supplier child; never exposed publicly. */
async function loopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("Cannot allocate a loopback port");
  return address.port;
}

export interface RuntimeImage {
  id: string;
  layers: string[];
}

export interface RuntimeBuild {
  /** Private attempt directory; context/bundle holds the verified extracted bundle. */
  workDir: string;
  baseImage: string;
  publicationId: string;
  packageSha256: string;
  /** requirements.lock is present: install its hashed wheels offline. */
  installLock: boolean;
  signal: AbortSignal;
}

/** Docker seam. Production uses the local daemon; tests substitute it. */
export interface RuntimeImages {
  inspect(reference: string): Promise<RuntimeImage | null>;
  build(request: RuntimeBuild): Promise<string>;
}

export class DockerRuntimeImages implements RuntimeImages {
  async inspect(reference: string): Promise<RuntimeImage | null> {
    const result = await dockerCommand(["image", "inspect", reference], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
    if (result.code !== 0) {
      if (/no such (?:image|object)/i.test(result.stderr)) return null;
      throw new Error(`docker image inspect failed: ${result.stderr.slice(0, 500)}`);
    }
    const [image] = JSON.parse(result.stdout) as Array<{ Id?: unknown; RootFS?: { Layers?: unknown } }>;
    const layers = image?.RootFS?.Layers;
    if (typeof image?.Id !== "string" || !Array.isArray(layers) || layers.some((layer) => typeof layer !== "string")) {
      throw new Error("docker image inspect returned an unexpected shape");
    }
    return { id: image.Id, layers: layers as string[] };
  }

  /**
   * Server-owned Dockerfile; the bundle never supplies build instructions. RUN
   * steps have no network. The final image must extend exactly the verified base.
   */
  async build(request: RuntimeBuild): Promise<string> {
    const context = join(request.workDir, "context");
    const baseTag = `vector-paper2agent-base:${request.baseImage.slice("sha256:".length)}`;
    const tagged = await dockerCommand(["tag", request.baseImage, baseTag], { signal: request.signal, timeoutMs: 30_000 });
    if (tagged.code !== 0) throw new Error(`Cannot tag the runtime base image: ${tagged.stderr.slice(0, 1000)}`);
    const install = ["python", "-m", "pip", "install", "--no-index", "--no-deps", "--only-binary=:all:", "--require-hashes",
      "--no-compile", "--disable-pip-version-check", "--no-cache-dir", "--target", "/opt/paper2agent/deps",
      "--find-links", "/opt/paper2agent/bundle/wheels", "-r", "/opt/paper2agent/bundle/requirements.lock"];
    const dockerfile = [
      `FROM ${baseTag}`,
      // The base image ends as the unprivileged user; root installs the bundle, then the final USER drops it.
      "USER 0:0",
      "COPY bundle/ /opt/paper2agent/bundle/",
      ...(request.installLock ? [`RUN ${JSON.stringify(install)}`] : []),
      // Extraction leaves private 0600 files; the unprivileged runtime user must read them.
      `RUN ${JSON.stringify(["chmod", "-R", "a+rX,go-w", "/opt/paper2agent"])}`,
      "WORKDIR /workspace",
      "ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 " +
        "PYTHONPATH=/opt/paper2agent/deps:/workspace/output",
      "USER 65532:65532",
      `ENTRYPOINT ${JSON.stringify(["/bin/sh", "-c", RUNTIME_START])}`,
      "",
    ].join("\n");
    await writeFile(join(context, "Dockerfile"), dockerfile, { mode: 0o600 });
    const iidFile = join(request.workDir, "image-id");
    await rm(iidFile, { force: true });
    const built = await dockerCommand(["build", "--quiet", "--network", "none", "--iidfile", iidFile,
      "--label", `vector.paper2agent.publication=${request.publicationId}`,
      "--label", `vector.paper2agent.package-sha256=${request.packageSha256}`,
      "--tag", `vector-paper2agent-runtime:${request.publicationId}`,
      "--file", join(context, "Dockerfile"), context],
    { signal: request.signal, timeoutMs: BUILD_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
    if (built.code !== 0) throw new Error(`Runtime image build failed: ${(built.stderr || built.stdout).slice(-1500)}`);
    const imageId = (await readFile(iidFile, "utf8")).trim();
    if (!IMAGE_ID.test(imageId)) throw new Error("Docker returned an invalid runtime image ID");
    const [base, image] = await Promise.all([this.inspect(request.baseImage), this.inspect(imageId)]);
    if (!base || !image || base.id !== request.baseImage || image.id !== imageId ||
        image.layers.length <= base.layers.length || base.layers.some((layer, index) => image.layers[index] !== layer)) {
      throw new Error("The runtime image does not extend the verified base image");
    }
    return imageId;
  }
}

export interface SupplierLaunch {
  targetId: string;
  port: number;
  env: Record<string, string>;
}

export interface SupplierProcess {
  /** Null while running. */
  readonly exitCode: number | null;
  readonly exited: Promise<void>;
  kill(signal: NodeJS.Signals): void;
  /** Recent bounded output for operator diagnostics. */
  output(): string;
}

/** Process seam. Production runs the existing supplier node; tests substitute it. */
export type SupplierLauncher = (launch: SupplierLaunch) => SupplierProcess;

/** The existing supplier node. Secrets travel only in the environment, never argv. */
function spawnSupplier(config: PaperPublisherConfig, log: (line: string) => void): SupplierLauncher {
  return (launch) => {
    const child = spawn(process.execPath, ["--import", "tsx", config.supplierEntry], {
      cwd: config.repoRoot, env: launch.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let recent = "";
    let exitCode: number | null = null;
    const record = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      recent = (recent + text).slice(-4000);
      for (const line of text.split("\n")) if (line.trim()) log(`[${launch.targetId}] ${line.slice(0, 2000)}`);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const exited = new Promise<void>((resolve) => {
      child.once("exit", (code) => { exitCode = code ?? 1; resolve(); });
      child.once("error", (error) => { recent += `\n${error.message}`; exitCode ??= 1; resolve(); });
    });
    return {
      get exitCode() { return exitCode; },
      exited,
      kill: (signal) => { child.kill(signal); },
      output: () => recent,
    };
  };
}

interface SupervisedSupplier {
  publicationId: string;
  port: number;
  process: SupplierProcess;
  ready: boolean;
  /** Proxied admissions (paid or free) still in flight. */
  admissions: number;
}

export interface ChildReply {
  status: number;
  body: Buffer;
}

export interface ChildRequest {
  body?: Buffer;
  contentType?: string;
  escrowRef?: string;
  /** The caller's Authorization header. forward() checks it; it is never sent to the child. */
  authorization?: string;
}

export interface PaperPublisherDeps {
  /** Chain access per slot. Default: Ogmios, read-only unless LIVE_CHAIN=1. */
  chain?: (target: PublisherTarget) => ChainProvider;
  images?: RuntimeImages;
  launchSupplier?: SupplierLauncher;
  /** The shared PostAdvert flow (supplier runPostAdvert). It must run beforeSubmit before any broadcast. */
  postAdvert?: (params: PostAdvertFlowParams) => Promise<PostAdvertFlowResult>;
  now?: () => number;
  /** Poll interval wait for supplier readiness and drain. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class PaperPublisherService {
  private readonly chainFor: (target: PublisherTarget) => ChainProvider;
  private readonly images: RuntimeImages;
  private readonly launchSupplier: SupplierLauncher;
  private readonly postAdvert: (params: PostAdvertFlowParams) => Promise<PostAdvertFlowResult>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly chains = new Map<string, ChainProvider>();
  private readonly children = new Map<string, SupervisedSupplier>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly operations = new Set<Promise<void>>();
  private readonly activations = new Map<string, Promise<void>>();
  private readonly preparations = new Set<AbortController>();
  private readonly restartAttempts = new Map<string, number>();
  private readonly toolCallDigest: Buffer | null;
  private closing = false;
  private closed?: Promise<void>;

  private constructor(readonly config: PaperPublisherConfig, private readonly store: PaperPublisherStore, deps: PaperPublisherDeps) {
    this.chainFor = deps.chain ?? ((target) => target.liveChain
      ? new LiveOgmiosProvider({ ogmiosUrl: target.ogmiosUrl })
      : new ReadOnlyOgmiosProvider({ ogmiosUrl: target.ogmiosUrl }));
    this.images = deps.images ?? new DockerRuntimeImages();
    this.log = deps.log ?? ((line) => { process.stderr.write(`[paper2agent-publisher] ${line}\n`); });
    this.launchSupplier = deps.launchSupplier ?? spawnSupplier(config, this.log);
    this.postAdvert = deps.postAdvert ?? runPostAdvert;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.toolCallDigest = config.toolCallToken ? createHash("sha256").update(config.toolCallToken).digest() : null;
  }

  /** Opens durable state, applies restart recovery, and restarts published suppliers in the background. */
  static async open(config: PaperPublisherConfig, deps: PaperPublisherDeps = {}): Promise<PaperPublisherService> {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const store = PaperPublisherStore.open(join(config.dataDir, "publisher.db"));
    const service = new PaperPublisherService(config, store, deps);
    store.recover(service.now());
    for (const record of store.all()) {
      if (record.phase === "published" || (record.phase === "publishing" && store.transaction(record.id)?.confirmed_at != null)) {
        void service.activate(record.id);
      }
    }
    return service;
  }

  targets(): PaperPublishTarget[] {
    const held = this.store.heldTargets();
    return this.config.targets.map((target) => ({
      id: target.id, label: target.label, network_id: target.networkId, supplier_pkh: target.supplierPkh,
      deposit_address: target.depositAddress, endpoint_url: target.endpointUrl, available: !held.has(target.id),
      live_chain: target.liveChain,
    }));
  }

  /**
   * Verify the reviewed bundle and build its runtime image. No chain transaction.
   * An exact replay returns the stored state; a failed preparation can be retried.
   */
  async prepare(body: unknown): Promise<PaperPublication> {
    this.admit();
    const input = fields(body, "request", ["job_id", "terms", "artifact", "archive_base64"]);
    const id = input.job_id;
    if (typeof id !== "string" || !PUBLICATION_ID.test(id)) throw invalid("job_id must be 1-64 letters, digits, '-' or '_'");
    const terms = parseTerms(input.terms);
    const target = this.config.targets.find((candidate) => candidate.id === terms.target_id);
    if (!target) throw new PublisherError(404, "unknown_target", `Target ${terms.target_id} is not configured.`);
    const { artifact, manifest } = parseArtifact(input.artifact, this.config.runtimeImage);
    if (terms.artifact_sha256 !== artifact.sha256) throw invalid("terms.artifact_sha256 does not match the artifact");
    const archive = decodeArchive(input.archive_base64);
    if (createHash("sha256").update(archive).digest("hex") !== artifact.sha256) {
      throw new PublisherError(400, "archive_hash_mismatch", "The bundle archive does not match the reviewed artifact SHA-256.");
    }
    const requestHash = createHash("sha256").update(canonicalize({ job_id: id, terms, artifact })).digest("hex");
    return this.exclusive(`publication:${id}`, async () => {
      this.admit();
      const existing = this.store.get(id);
      const retry = existing?.phase === "failed" && existing.tx_hash === null;
      if (existing && !retry) {
        if (existing.request_hash !== requestHash) {
          throw new PublisherError(409, "publication_conflict", "This publication already exists with different inputs.");
        }
        return this.view(existing);
      }
      const fresh = {
        id, target_id: target.id, request_hash: requestHash, terms, artifact,
        work_dir: join(this.config.dataDir, "publications", id, randomUUID()),
        supplier_pkh: target.supplierPkh, deposit_address: target.depositAddress, endpoint_url: target.endpointUrl,
      };
      let record: PublicationRecord;
      try {
        record = existing ? this.store.retry(fresh, this.now()) : this.store.create(fresh, this.now());
      } catch (error) {
        if (error instanceof PublicationConflictError) {
          throw new PublisherError(409, "target_slot_in_use", `Target ${target.id} already holds another publication.`);
        }
        throw error;
      }
      const controller = new AbortController();
      this.preparations.add(controller);
      try {
        const imageId = await this.buildRuntime(record, archive, manifest, controller.signal);
        return this.view(this.store.update(id, ["preparing"],
          { phase: "prepared", runtime_image_id: imageId, prepared_at: this.now(), error: null }, this.now()));
      } catch (error) {
        return this.view(this.store.update(id, ["preparing"],
          { phase: "failed", error: bounded(`Preparation failed: ${message(error)}`) }, this.now()));
      } finally {
        this.preparations.delete(controller);
      }
    });
  }

  /**
   * One explicitly approved advert transaction. The signed debit is checked and the
   * signed bytes are journaled before broadcast; a journaled publication is never
   * signed again.
   */
  async publish(id: string, body: unknown): Promise<PaperPublication> {
    this.admit();
    const approval = fields(body, "approval", ["artifact_sha256", "confirm", "max_debit_lovelace"]);
    if (approval.confirm !== true) throw new PublisherError(400, "confirmation_required", "confirm must be true to approve a live debit.");
    if (typeof approval.artifact_sha256 !== "string" || !SHA256.test(approval.artifact_sha256)) {
      throw invalid("artifact_sha256 must be 64 lowercase hex characters");
    }
    if (typeof approval.max_debit_lovelace !== "string" || !LOVELACE.test(approval.max_debit_lovelace) ||
        BigInt(approval.max_debit_lovelace) <= 0n) {
      throw invalid("max_debit_lovelace must be a positive integer string");
    }
    const maxDebit = BigInt(approval.max_debit_lovelace);
    const started = this.now();
    return this.exclusive(`publication:${id}`, async () => {
      this.admit();
      const record = this.record(id);
      if (record.phase !== "prepared") {
        throw new PublisherError(409, "publication_not_prepared",
          `The publication is ${record.phase}. Refresh it; a publication is broadcast at most once.`);
      }
      if (approval.artifact_sha256 !== record.artifact.sha256) {
        throw new PublisherError(409, "artifact_mismatch", "The approval is for a different artifact.");
      }
      const target = this.config.targets.find((candidate) => candidate.id === record.target_id);
      if (!target || target.supplierPkh !== record.supplier_pkh || target.endpointUrl !== record.endpoint_url) {
        throw new PublisherError(409, "target_changed", `Target ${record.target_id} no longer has the prepared wallet and endpoint.`);
      }
      if (!target.liveChain) {
        throw new PublisherError(409, "live_chain_disabled",
          `Target ${target.id} does not set LIVE_CHAIN=1. The publisher refuses instead of simulating a publication.`);
      }
      try {
        await this.verifyStoredBundle(record);
        await this.runtimeImage(record);
      } catch (error) {
        throw new PublisherError(409, "publication_not_ready", `The prepared runtime is not usable: ${message(error)}`);
      }
      const publishing = this.store.update(id, ["prepared"], { phase: "publishing", error: null }, this.now());
      return this.sendAdvert(publishing, target, maxDebit, started);
    });
  }

  /** Reads chain evidence and supervises the supplier. Never constructs a transaction. */
  async refresh(id: string): Promise<PaperPublication> {
    const record = this.record(id);
    // An active operation owns the record; report it without waiting for that operation.
    if (record.phase === "preparing" || this.locks.has(`publication:${id}`)) return this.view(record);
    return this.exclusive(`publication:${id}`, async () => {
      const current = this.record(id);
      if (current.phase === "publishing" || current.phase === "confirmation_pending") return this.view(await this.resolve(current));
      if (current.phase === "published" && !this.closing) {
        const child = this.children.get(current.target_id);
        if (!child?.ready || child.process.exitCode !== null) void this.activate(id);
      }
      return this.view(current);
    });
  }

  /** Forward one request of the fixed supplier protocol to the slot's local supplier. */
  async forward(targetId: string, method: string, path: string, request: ChildRequest): Promise<ChildReply> {
    const key = `${method} ${path}`;
    const route = Object.hasOwn(SUPPLIER_ROUTES, key) ? SUPPLIER_ROUTES[key] : method === "GET" && JOB_PATH.test(path) ? JOB_ROUTE : undefined;
    const reply = (status: number, reason: string): ChildReply => ({ status, body: Buffer.from(JSON.stringify({ reason, message: reason })) });
    if (!route || !this.config.targets.some((target) => target.id === targetId)) return reply(404, "not_found");
    if (route.toolCall) {
      if (!this.toolCallDigest) return reply(404, "not_found");
      const header = request.authorization ?? "";
      const supplied = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (supplied === "" || !timingSafeEqual(createHash("sha256").update(supplied).digest(), this.toolCallDigest)) {
        return reply(401, "unauthorized");
      }
    }
    if (this.closing && route.refusedWhileDraining) return reply(503, "supplier_draining");
    const child = this.children.get(targetId);
    if (!child?.ready || child.process.exitCode !== null) {
      this.restartSoon(targetId);
      return reply(503, "supplier_unavailable");
    }
    if (route.admission) child.admissions++;
    try {
      return await this.childRequest(child, method, path, request, route.timeoutMs);
    } catch {
      return reply(502, "supplier_unreachable");
    } finally {
      if (route.admission) child.admissions--;
    }
  }

  /** Resolves when no publisher operation is running. */
  async idle(): Promise<void> {
    while (this.operations.size > 0) await Promise.allSettled([...this.operations]);
  }

  /**
   * Stop new admissions and publisher operations, let active supplier work finish,
   * then stop the children. Bonded jobs are not killed as normal shutdown.
   */
  close(): Promise<void> {
    this.closed ??= this.shutdown();
    return this.closed;
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    for (const controller of this.preparations) controller.abort(new Error("The publisher is stopping"));
    await this.idle();
    const deadline = this.now() + DRAIN_TIMEOUT_MS;
    for (;;) {
      const busy = await this.busyTargets();
      if (busy.length === 0) break;
      if (this.now() >= deadline) {
        this.log(`drain timed out with active supplier work on ${busy.join(", ")}`);
        break;
      }
      await this.sleep(DRAIN_POLL_MS);
    }
    await Promise.all([...this.children.values()].map((child) => this.stopChild(child)));
    // Read-only management requests stay open during the drain; let them finish first.
    await this.idle();
    this.store.close();
  }

  private admit(): void {
    if (this.closing) throw new PublisherError(503, "publisher_closing", "The publisher is shutting down.");
  }

  private record(id: string): PublicationRecord {
    const record = PUBLICATION_ID.test(id) ? this.store.get(id) : undefined;
    if (!record) throw new PublisherError(404, "publication_not_found", "No publication has this ID.");
    return record;
  }

  private view(record: PublicationRecord): PaperPublication {
    if (record.phase === "preparing") {
      throw new PublisherError(409, "publication_preparing", "The runtime image for this publication is still being built.");
    }
    return {
      id: record.id, state: record.phase, terms: record.terms, supplier_pkh: record.supplier_pkh,
      deposit_address: record.deposit_address, endpoint_url: record.endpoint_url, advert_ref: record.advert_ref,
      tx_hash: record.tx_hash, actual_debit_lovelace: record.actual_debit_lovelace, error: record.error,
    };
  }

  private chain(target: PublisherTarget): ChainProvider {
    let chain = this.chains.get(target.id);
    if (!chain) {
      chain = this.chainFor(target);
      this.chains.set(target.id, chain);
    }
    return chain;
  }

  /** Serialize work per key; every operation is tracked for shutdown. */
  private exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    this.operations.add(tail);
    void tail.then(() => {
      this.operations.delete(tail);
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return result;
  }

  private async chainRead<T>(read: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("chain query timed out")), CHAIN_READ_TIMEOUT_MS);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async buildRuntime(record: PublicationRecord, archive: Buffer, manifest: Paper2AgentManifest, signal: AbortSignal): Promise<string> {
    await mkdir(record.work_dir, { recursive: true, mode: 0o700 });
    const archivePath = join(record.work_dir, "bundle.tar");
    await writePrivateFile(archivePath, archive);
    if (await fileSha256(archivePath) !== record.artifact.sha256) throw new Error("The stored bundle does not match the artifact SHA-256");
    const bundleDir = join(record.work_dir, "context", "bundle");
    await extractPackage(archivePath, bundleDir);
    await verifyPackageFiles(bundleDir, record.artifact.files);
    await writePrivateFile(join(record.work_dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const base = await this.images.inspect(this.config.runtimeImage);
    if (base?.id !== this.config.runtimeImage) throw new Error(`The runtime base image ${this.config.runtimeImage} is not available locally`);
    signal.throwIfAborted();
    return this.images.build({ workDir: record.work_dir, baseImage: this.config.runtimeImage, publicationId: record.id,
      packageSha256: record.artifact.sha256, installLock: record.artifact.files.some((file) => file.path === "requirements.lock"), signal });
  }

  private async verifyStoredBundle(record: PublicationRecord): Promise<void> {
    if (await fileSha256(join(record.work_dir, "bundle.tar")) !== record.artifact.sha256) {
      throw new Error("The stored bundle no longer matches the reviewed artifact");
    }
    if (paper2AgentManifestHash(readManifest(join(record.work_dir, "manifest.json"))) !== record.artifact.manifest_hash) {
      throw new Error("The stored manifest no longer matches the reviewed artifact");
    }
  }

  /** The pinned runtime image; a pruned image is rebuilt from the same verified bundle. */
  private async runtimeImage(record: PublicationRecord): Promise<string> {
    if (record.runtime_image_id && (await this.images.inspect(record.runtime_image_id))?.id === record.runtime_image_id) {
      return record.runtime_image_id;
    }
    await verifyPackageFiles(join(record.work_dir, "context", "bundle"), record.artifact.files);
    const base = await this.images.inspect(this.config.runtimeImage);
    if (base?.id !== this.config.runtimeImage) throw new Error(`The runtime base image ${this.config.runtimeImage} is not available locally`);
    const imageId = await this.images.build({ workDir: record.work_dir, baseImage: this.config.runtimeImage, publicationId: record.id,
      packageSha256: record.artifact.sha256, installLock: record.artifact.files.some((file) => file.path === "requirements.lock"),
      signal: AbortSignal.timeout(BUILD_TIMEOUT_MS) });
    this.store.update(record.id, [this.record(record.id).phase], { runtime_image_id: imageId }, this.now());
    return imageId;
  }

  private async sendAdvert(record: PublicationRecord, target: PublisherTarget, maxDebit: bigint, started: number): Promise<PaperPublication> {
    const manifest = parsePaper2AgentManifest(record.artifact.manifest);
    const chain = this.chain(target);
    const advert: AdvertDatum = {
      supplier_pkh: target.supplierPkh,
      capability_id: PAPER2AGENT_CAPABILITY_ID,
      model: paper2AgentModel(manifest),
      max_output_tokens: 0,
      max_processing_ms: manifest.limits.max_runtime_ms + PAPER2AGENT_DELIVERY_OVERHEAD_MS,
      price_lovelace: BigInt(record.terms.price_lovelace),
      supplier_bond_lovelace: BigInt(record.terms.supplier_bond_lovelace),
      buyer_bond_lovelace: BigInt(record.terms.buyer_bond_lovelace),
      endpoint_url: target.endpointUrl,
      detail_uri: "",
      detail_hash: paper2AgentManifestHash(manifest),
      advertised_at: 0,
      status: "Active",
    };
    try {
      await this.postAdvert({
        chain, walletKey: target.walletKey(), advertDatum: advert, awaitTimeoutMs: ADVERT_AWAIT_MS, log: () => undefined,
        beforeSubmit: async (built) => {
          const transaction = await this.checkAdvert(record, target, chain, advert, built, maxDebit);
          this.store.journal(transaction, this.now());
        },
      });
    } catch (error) {
      if (!this.store.transaction(record.id)) {
        // Nothing was journaled, so nothing was broadcast: the approval may be repeated.
        const reason = bounded(`The publish attempt stopped before any broadcast: ${message(error)}`);
        this.store.update(record.id, ["publishing"], { phase: "prepared", error: reason }, this.now());
        throw error instanceof PublisherError ? error : new PublisherError(422, "advert_not_sent", reason);
      }
      return this.view(this.store.update(record.id, ["publishing"], { phase: "confirmation_pending",
        error: bounded(`The advert transaction outcome is unknown (${message(error)}). Refresh this publication; it is never signed again.`) },
      this.now()));
    }
    this.store.confirm(record.id, this.now());
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.activate(record.id), new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(1_000, PUBLISH_REPLY_MS - (this.now() - started)));
    })]);
    clearTimeout(timer);
    return this.view(this.record(record.id));
  }

  /** Runs inside beforeSubmit: a rejection here prevents the broadcast. */
  private async checkAdvert(record: PublicationRecord, target: PublisherTarget, chain: ChainProvider, expected: AdvertDatum,
    built: PostAdvertBuildResult, maxDebit: bigint): Promise<AdvertTransaction> {
    const wallet = target.walletKey().address;
    const info = inspectSignedTransaction(built.txCborHex);
    if (info.txHash !== built.expectedTxHash.toLowerCase() || built.advertOutputRef.txHash !== built.expectedTxHash ||
        built.advertOutputRef.index !== 0) {
      throw new PublisherError(422, "advert_transaction_invalid", "The signed advert transaction hash and advert output disagree. Nothing was broadcast.");
    }
    const facts = inspectSignedTransactionFinancials(built.txCborHex);
    const advertAddress = loadBlueprint().advertScriptAddress(target.networkId);
    const [advert, ...change] = facts.outputs;
    let approved = false;
    if (advert?.datumHex && advert.address === advertAddress && advert.lovelace >= expected.supplier_bond_lovelace) {
      try {
        const datum = decodeAdvertDatum(advert.datumHex);
        approved = ADVERT_FIELDS.every((field) => datum[field] === expected[field]);
      } catch {
        approved = false;
      }
    }
    if (!approved) {
      throw new PublisherError(422, "advert_transaction_invalid",
        `The signed transaction does not create the approved advert at the NETWORK_ID ${target.networkId} advert address. Nothing was broadcast.`);
    }
    if (change.some((output) => output.address !== wallet)) {
      throw new PublisherError(422, "advert_transaction_invalid", "The signed transaction pays outside the slot wallet. Nothing was broadcast.");
    }
    const inputs: WalletInput[] = [];
    let spent = 0n;
    for (const ref of facts.inputs) {
      const utxo = await chain.queryUtxo(ref);
      if (!utxo || utxo.address !== wallet) {
        throw new PublisherError(422, "advert_transaction_invalid", "The signed transaction spends outside the slot wallet. Nothing was broadcast.");
      }
      spent += utxo.lovelace;
      inputs.push({ ref: `${ref.txHash}#${ref.index}`, lovelace: utxo.lovelace.toString() });
    }
    let pledged = 0n;
    for (const ref of facts.collateralInputs) {
      const utxo = await chain.queryUtxo(ref);
      if (!utxo || utxo.address !== wallet) {
        throw new PublisherError(422, "advert_transaction_invalid", "The signed transaction pledges collateral outside the slot wallet. Nothing was broadcast.");
      }
      pledged += utxo.lovelace;
    }
    // A failed script can take the signed total collateral, or every pledged input without one.
    const collateral = facts.collateralInputs.length === 0 ? 0n : facts.totalCollateralLovelace ?? pledged;
    const debit = spent - change.reduce((sum, output) => sum + output.lovelace, 0n);
    const exposure = debit > collateral ? debit : collateral;
    if (debit < 0n || exposure > maxDebit) {
      throw new PublisherError(409, "debit_exceeds_approval", `The signed advert transaction debits ${debit} lovelace from the slot wallet ` +
        `(worst case ${exposure}); the approved maximum is ${maxDebit}. Nothing was broadcast.`);
    }
    return {
      publication_id: record.id, target_id: target.id, tx_hash: info.txHash, tx_cbor: built.txCborHex,
      advert_ref: `${info.txHash}#0`, advert_address: advertAddress, advert_datum_hex: advert.datumHex!.toLowerCase(),
      wallet_inputs: inputs, fee_lovelace: facts.feeLovelace.toString(), wallet_debit_lovelace: debit.toString(),
      max_debit_lovelace: maxDebit.toString(), valid_until_slot: info.validUntilSlot, signed_at: this.now(), confirmed_at: null,
    };
  }

  /** Chain evidence for a journaled transaction. Read-only: nothing is signed or resubmitted. */
  private async resolve(record: PublicationRecord): Promise<PublicationRecord> {
    const transaction = this.store.transaction(record.id);
    if (!transaction) {
      return this.store.update(record.id, [record.phase],
        { phase: "prepared", error: "The previous publish attempt stopped before signing. Nothing was broadcast." }, this.now());
    }
    if (this.activations.has(record.id)) return record;
    const target = this.config.targets.find((candidate) => candidate.id === record.target_id);
    if (!target) return this.store.update(record.id, [record.phase], { error: `Target ${record.target_id} is no longer configured.` }, this.now());
    const chain = this.chain(target);
    let observation: string;
    try {
      // One bounded window for every read: the control service waits 15 seconds for this route.
      const evidence = await this.chainRead(async () => {
        const advert = await chain.queryUtxo(outputRef(transaction.advert_ref));
        if (advert || transaction.confirmed_at !== null) return { advert, inputsUnspent: false, tip: 0 };
        const inputs = await Promise.all(transaction.wallet_inputs.map((input) => chain.queryUtxo(outputRef(input.ref))));
        return { advert, inputsUnspent: inputs.every((utxo) => utxo !== null), tip: await chain.tip() };
      });
      const { advert } = evidence;
      if (advert && advert.address === transaction.advert_address && advert.datumHex?.toLowerCase() === transaction.advert_datum_hex) {
        this.store.confirm(record.id, this.now());
        const confirmed = this.store.update(record.id, [record.phase],
          { phase: "publishing", error: `Advert ${transaction.advert_ref} is confirmed; starting its supplier.` }, this.now());
        void this.activate(record.id);
        return confirmed;
      }
      if (advert) observation = `Output ${transaction.advert_ref} does not match the journaled advert.`;
      else if (transaction.confirmed_at !== null) observation = `Advert ${transaction.advert_ref} was confirmed but is no longer unspent.`;
      else if (!evidence.inputsUnspent) {
        observation = `Wallet inputs of advert transaction ${transaction.tx_hash} are spent, but the advert output is not visible. ` +
          "Check the transaction on a chain explorer.";
      } else if (transaction.valid_until_slot !== null && evidence.tip > transaction.valid_until_slot + EXPIRY_FINALITY_SLOTS) {
        return this.store.update(record.id, [record.phase], { phase: "failed", error: `Advert transaction ${transaction.tx_hash} expired at ` +
          `slot ${transaction.valid_until_slot} without confirmation. Its wallet inputs are unspent, so no funds moved. ` +
          "This target slot cannot publish again." }, this.now());
      } else {
        observation = `Advert transaction ${transaction.tx_hash} is not confirmed; its wallet inputs are unspent.` +
          (transaction.valid_until_slot === null ? "" : ` It cannot confirm after slot ${transaction.valid_until_slot}.`);
      }
    } catch (error) {
      observation = `Chain query failed: ${message(error)}`;
    }
    return this.store.update(record.id, [record.phase], { error: bounded(observation) }, this.now());
  }

  /** Background supplier start for a confirmed advert; one attempt per publication at a time. */
  private activate(id: string): Promise<void> {
    const running = this.activations.get(id);
    if (running) return running;
    const record = this.store.get(id);
    if (!record || this.closing) return Promise.resolve();
    const task = this.exclusive(`target:${record.target_id}`, () => this.startSupplier(id))
      .catch((error: unknown) => { this.log(`supplier for publication ${id} is not serving: ${message(error)}`); })
      .finally(() => { this.activations.delete(id); });
    this.activations.set(id, task);
    return task;
  }

  private restartSoon(targetId: string): void {
    const holder = this.store.slotHolder(targetId);
    const last = this.restartAttempts.get(targetId) ?? -Infinity;
    if (holder?.phase !== "published" || this.closing || this.now() - last < RESTART_INTERVAL_MS) return;
    this.restartAttempts.set(targetId, this.now());
    void this.activate(holder.id);
  }

  private async startSupplier(id: string): Promise<void> {
    const record = this.record(id);
    if (record.phase !== "published" && record.phase !== "publishing") return;
    try {
      const transaction = this.store.transaction(id);
      const target = this.config.targets.find((candidate) => candidate.id === record.target_id);
      if (this.closing) throw new Error("The publisher is stopping");
      if (!transaction) throw new Error("No advert transaction is journaled");
      if (!target || target.supplierPkh !== record.supplier_pkh) {
        throw new Error(`Target ${record.target_id} is no longer configured with this publication's wallet`);
      }
      const advert = await this.chainRead(() => this.chain(target).queryUtxo(outputRef(transaction.advert_ref)));
      if (!advert || advert.address !== transaction.advert_address || advert.datumHex?.toLowerCase() !== transaction.advert_datum_hex) {
        throw new Error(`Advert ${transaction.advert_ref} is not an unspent output on chain`);
      }
      this.store.confirm(id, this.now());
      await this.supervise(record, target, transaction);
      const current = this.record(id);
      this.store.update(id, [current.phase], current.phase === "published" ? { error: null }
        : { phase: "published", published_at: this.now(), error: null }, this.now());
    } catch (error) {
      this.store.update(id, [this.record(id).phase], { error: bounded(`The supplier is not serving: ${message(error)}`) }, this.now());
      throw error;
    }
  }

  private async supervise(record: PublicationRecord, target: PublisherTarget, transaction: AdvertTransaction): Promise<void> {
    const existing = this.children.get(target.id);
    if (existing) {
      if (existing.publicationId === record.id && existing.ready && existing.process.exitCode === null &&
          (await this.childRequest(existing, "GET", "/healthz", {}, 5_000).catch(() => undefined))?.status === 200) return;
      await this.stopChild(existing);
    }
    const imageId = await this.runtimeImage(record);
    await this.verifyStoredBundle(record);
    const targetDir = join(this.config.dataDir, "targets", target.id);
    const cwd = join(targetDir, "cwd");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const port = await loopbackPort();
    // Fixed, hardened tool command: no network, read-only image, bounded tmpfs/memory/CPU/PIDs,
    // no mounts, no host secrets. The bundle only ever runs inside this container.
    const argv = [...(this.config.dockerHost ? ["--host", this.config.dockerHost] : []),
      "run", "--rm", "-i", "--init", "--pull", "never", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65532:65532",
      "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "128",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777",
      "--tmpfs", "/workspace:rw,nosuid,nodev,size=1g,mode=1777",
      "--log-driver", "none", "--label", `vector.paper2agent.publication=${record.id}`, imageId];
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      NODE_ENV: "production",
      ...target.supplierEnv(),
      CAPABILITY_KIND: "paper2agent",
      ADVERT_REF: transaction.advert_ref,
      PORT: String(port),
      SUPPLIER_BIND_HOST: "127.0.0.1",
      // A managed slot never runs automatic consolidation spending.
      WALLET_HEALTH_INTERVAL_MS: "0",
      PAPER2AGENT_EXECUTABLE: this.config.dockerPath,
      PAPER2AGENT_ARGV_JSON: JSON.stringify(argv),
      PAPER2AGENT_CWD: cwd,
      PAPER2AGENT_PACKAGE: join(record.work_dir, "bundle.tar"),
      PAPER2AGENT_MANIFEST: join(record.work_dir, "manifest.json"),
      PAPER2AGENT_JOURNAL_DIR: join(targetDir, "journal"),
      // The child route has no authentication; forward() checks the token.
      ...(this.config.toolCallToken ? { PAPER2AGENT_FREE_CALLS: "1" } : {}),
    };
    const child: SupervisedSupplier = {
      publicationId: record.id, port, process: this.launchSupplier({ targetId: target.id, port, env }), ready: false, admissions: 0,
    };
    this.children.set(target.id, child);
    void child.process.exited.then(() => {
      child.ready = false;
      if (!this.closing) this.log(`supplier for target ${target.id} exited with code ${child.process.exitCode}`);
    });
    try {
      await this.awaitReady(child, record, target, transaction);
      child.ready = true;
    } catch (error) {
      await this.stopChild(child);
      throw error;
    }
  }

  /** /healthz, then /capability must prove the published advert, manifest and wallet. */
  private async awaitReady(child: SupervisedSupplier, record: PublicationRecord, target: PublisherTarget, transaction: AdvertTransaction): Promise<void> {
    const deadline = this.now() + READY_TIMEOUT_MS;
    let last = "no response";
    for (;;) {
      if (child.process.exitCode !== null) {
        throw new Error(`The supplier exited during startup (code ${child.process.exitCode}): ${child.process.output().slice(-800)}`);
      }
      try {
        const health = await this.childRequest(child, "GET", "/healthz", {}, 5_000);
        const capability = health.status === 200 ? await this.childRequest(child, "GET", "/capability", {}, 30_000) : undefined;
        if (capability?.status === 200) {
          const body = JSON.parse(capability.body.toString("utf8")) as Record<string, unknown>;
          const tool = body.paper2agent as Record<string, unknown> | undefined;
          let signer = "";
          try {
            signer = paper2AgentSupplierPkh(String(body.pub_key_hex));
          } catch {
            signer = "";
          }
          if (body.capability_id !== PAPER2AGENT_CAPABILITY_ID || body.advert_ref !== transaction.advert_ref ||
              body.supplier_pkh !== target.supplierPkh || signer !== target.supplierPkh ||
              body.model !== paper2AgentModel(record.artifact.manifest) || body.price_lovelace !== record.terms.price_lovelace ||
              tool?.manifest_hash !== record.artifact.manifest_hash) {
            throw new PublisherError(502, "supplier_identity_mismatch",
              "The started supplier does not serve the published advert, manifest and wallet.");
          }
          return;
        }
        last = capability ? `capability returned HTTP ${capability.status}` : `healthz returned HTTP ${health.status}`;
      } catch (error) {
        if (error instanceof PublisherError) throw error;
        last = message(error);
      }
      if (this.now() >= deadline) throw new Error(`The supplier did not become ready: ${last}`);
      await this.sleep(READY_POLL_MS);
    }
  }

  private async stopChild(child: SupervisedSupplier): Promise<void> {
    child.ready = false;
    if (child.process.exitCode === null) {
      child.process.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      const stopped = await Promise.race([child.process.exited.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS); })]);
      clearTimeout(timer);
      if (!stopped) {
        child.process.kill("SIGKILL");
        await child.process.exited;
      }
    }
    for (const [targetId, current] of this.children) if (current === child) this.children.delete(targetId);
  }

  /** Slots with an in-flight admission or an active supplier session. */
  private async busyTargets(): Promise<string[]> {
    const busy: string[] = [];
    for (const [targetId, child] of this.children) {
      if (child.process.exitCode !== null) continue;
      if (child.admissions > 0) {
        busy.push(targetId);
        continue;
      }
      try {
        const status = await this.childRequest(child, "GET", "/status", {}, 5_000);
        const body = JSON.parse(status.body.toString("utf8")) as { active_sessions?: unknown };
        if (status.status !== 200 || body.active_sessions !== 0) busy.push(targetId);
      } catch {
        busy.push(targetId);
      }
    }
    return busy;
  }

  private async childRequest(child: SupervisedSupplier, method: string, path: string, request: ChildRequest,
    timeoutMs: number): Promise<ChildReply> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (request.contentType) headers["content-type"] = request.contentType;
    if (request.escrowRef) headers["x-escrow-ref"] = request.escrowRef;
    const response = await fetch(`http://127.0.0.1:${child.port}${path}`, {
      method, headers, body: request.body?.toString("utf8"), redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (;;) {
      const chunk = reader ? await reader.read() : { done: true as const, value: undefined };
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CHILD_RESPONSE_BYTES) {
        await reader?.cancel();
        throw new Error("Supplier response exceeds the proxy limit");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return { status: response.status, body: Buffer.concat(chunks) };
  }
}

/** Management API (bearer token, checked before any body is read) and the public supplier proxy. */
export function createPaperPublisherApp(service: PaperPublisherService): Express {
  const app = express();
  app.disable("x-powered-by");
  const expected = createHash("sha256").update(service.config.token).digest();
  let uploads = 0;
  const route = (operation: (req: Request<Record<string, string>>) => Promise<unknown>) => (req: Request<Record<string, string>>, res: Response) => {
    operation(req).then((value) => { res.json(value); }, (error: unknown) => {
      if (error instanceof PublisherError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      process.stderr.write(`[paper2agent-publisher] request failed: ${message(error)}\n`);
      res.status(500).json({ error: "publisher_error", message: "The publisher request failed; refresh before any further action." });
    });
  };

  app.get("/healthz", (_req, res) => { res.set("Cache-Control", "no-store").json({ ok: true }); });

  app.all(/^\/tools\//, express.raw({ type: () => true, limit: MAX_PROXY_BODY_BYTES, inflate: false }), (req, res) => {
    const match = TOOL_PATH.exec(req.path);
    const reply = match
      ? service.forward(match[1], req.method, match[2], {
        body: Buffer.isBuffer(req.body) ? req.body : undefined,
        contentType: req.get("content-type"), escrowRef: req.get("x-escrow-ref"), authorization: req.get("authorization"),
      })
      : Promise.resolve({ status: 404, body: Buffer.from(JSON.stringify({ reason: "not_found", message: "not_found" })) });
    void reply.catch(() => ({
      status: 503, body: Buffer.from(JSON.stringify({ reason: "supplier_unavailable", message: "supplier_unavailable" })),
    })).then((result) => {
      res.status(result.status).set({ "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).send(result.body);
    });
  });

  app.use(["/targets", "/publications"], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const header = req.get("authorization") ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (supplied === "" || !timingSafeEqual(createHash("sha256").update(supplied).digest(), expected)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized", message: "A valid publisher bearer token is required." });
      return;
    }
    next();
  });
  app.get("/targets", (_req, res) => { res.json({ targets: service.targets() }); });
  app.post("/publications", (_req, res, next) => {
    if (uploads >= MAX_ACTIVE_UPLOADS) {
      res.status(429).json({ error: "publisher_busy", message: "Another bundle upload is in progress. Try again shortly." });
      return;
    }
    uploads++;
    res.once("close", () => { uploads--; });
    next();
  }, express.json({ limit: MAX_PREPARE_JSON_BYTES, strict: true, inflate: false }), route((req) => service.prepare(req.body)));
  app.post("/publications/:id/publish", express.json({ limit: MAX_APPROVAL_JSON_BYTES, strict: true, inflate: false }),
    route((req) => service.publish(req.params.id, req.body)));
  app.get("/publications/:id", route((req) => service.refresh(req.params.id)));

  app.use((req, res) => {
    if (req.path.startsWith("/tools/")) res.status(404).json({ reason: "not_found", message: "not_found" });
    else res.status(404).json({ error: "not_found", message: "No such publisher route." });
  });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
    const tool = req.path.startsWith("/tools/");
    if (status === 413) {
      res.status(413).json(tool ? { reason: "request_too_large", message: "request_too_large" }
        : { error: "payload_too_large", message: "The request body exceeds the publisher limit." });
    } else if (status >= 400 && status < 500) {
      res.status(400).json(tool ? { reason: "invalid_tool_request", message: "invalid_tool_request" }
        : { error: "invalid_json", message: "The request body must be JSON." });
    } else {
      res.status(500).json({ error: "publisher_error", message: "The publisher request failed." });
    }
  });
  return app;
}
