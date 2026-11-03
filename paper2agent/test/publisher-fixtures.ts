/**
 * Shared fixtures of the publisher tests: a reviewed package, wallet slots, a
 * fake runtime image store, a local stand-in for the supplier child, and the
 * publisher service with its management app. Call cleanup() after each test.
 */
import { expect, vi, type Mock } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tar from "tar-stream";
import { MockChainProvider, type ChainProvider } from "@marketplace/shared/chain";
import { encodeAdvertDatum, encodeIdentityAdvertDatum } from "@marketplace/shared/cbor";
import { isIdentityAdvertDatum, loadBlueprint } from "@marketplace/shared/tx";
import { PAPER2AGENT_CAPABILITY_ID, paper2AgentManifestHash, paper2AgentModel, parsePaper2AgentManifest,
  type Paper2AgentManifest } from "@marketplace/shared/paper2agent";
import type { PaperPackageArtifact, PaperPublishTerms } from "@marketplace/shared/paper2agent/workflow";
import { encodeTxBody, sha256Hex } from "../../packages/shared/src/tx/internal/testTxBody.js";
import { deriveSupplierKey } from "../../supplier/src/paper2agent/identity.js";
import { PublisherTarget, type PaperPublisherConfig } from "../src/publisher-config.js";
import { PaperPublisherService, createPaperPublisherApp, type PaperPublisherDeps, type RuntimeImages,
  type SupplierLauncher } from "../src/publisher.js";
import { IDENTITY } from "../../tests/fixtures/supplier-side/identity.js";

export const TOKEN = "publisher-token-".repeat(3);
export const TOOL_TOKEN = "tool-call-token-".repeat(3);
export const BASE_IMAGE = `sha256:${"b".repeat(64)}`;
export const RUNTIME_IMAGE = `sha256:${"c".repeat(64)}`;
export const PUBLIC_URL = "https://publisher.example";
export const KEY_A = "11".repeat(32);
export const KEY_B = "22".repeat(32);
export const AUTH = { Authorization: `Bearer ${TOKEN}` };
export const JOB_ID = "0b4b7c2e-3f5d-4a8e-9c1d-2e3f4a5b6c7d";
const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

const directories: string[] = [];
const services: PaperPublisherService[] = [];
const servers: Server[] = [];

export async function cleanup(): Promise<void> {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const server of servers.splice(0)) server.closeAllConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
}

export function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "p2a-publisher-"));
  directories.push(directory);
  return directory;
}

export async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Bounded event-loop polling: no timers, no real sleeps. */
export async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20_000 && !condition(); turn++) await tick();
  expect(condition()).toBe(true);
}

export async function reviewedPackage(): Promise<{ archive: Buffer; artifact: PaperPackageArtifact; manifest: Paper2AgentManifest }> {
  const files: Record<string, string> = { "server.py": "print('reviewed wrapper')\n", "source/model.py": "SCALE = 2\n" };
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: unknown) => { if (Buffer.isBuffer(chunk)) chunks.push(chunk); });
  const ended = new Promise<void>((resolve, reject) => { pack.on("end", resolve); pack.on("error", reject); });
  for (const [name, content] of Object.entries(files)) pack.entry({ name, mode: 0o644 }, content);
  pack.finalize();
  await ended;
  const archive = Buffer.concat(chunks);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const manifest = parsePaper2AgentManifest({ schema_version: 1, name: "echo_record", description: "Test tool", package_sha256: sha256,
    input_schema: schema, output_schema: schema, limits: { max_input_bytes: 4096, max_output_bytes: 4096, max_runtime_ms: 10_000 } });
  const artifact: PaperPackageArtifact = {
    sha256, manifest_hash: paper2AgentManifestHash(manifest), manifest, paper_sha256: createHash("sha256").update("Paper: line fitting, section 2.").digest("hex"), runtime_image: BASE_IMAGE,
    files: Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex") })).sort((a, b) => a.path.localeCompare(b.path)),
    verification: { builder_run_id: "build-1", verifier_run_id: "verify-1", paper_references: ["Section 2: line fitting"], checks: [], test_source: "",
      test_stdout: "", cases: [], model_calls: 1, input_tokens: null, output_tokens: null },
  };
  return { archive, artifact, manifest };
}

export function terms(artifact: PaperPackageArtifact, targetId = "slot-a", price = "2000000"): PaperPublishTerms {
  return { target_id: targetId, artifact_sha256: artifact.sha256, price_lovelace: price, buyer_bond_lovelace: "1000000",
    supplier_bond_lovelace: "1000000" };
}

export function preparation(pkg: { archive: Buffer; artifact: PaperPackageArtifact }, publicationTerms: PaperPublishTerms, id = JOB_ID) {
  return { job_id: id, terms: publicationTerms, artifact: pkg.artifact, archive_base64: pkg.archive.toString("base64") };
}

/**
 * The mock chain builds synthetic transactions at the NETWORK_ID 0 advert address, so service tests
 * construct slots directly. Configuration loading rejects live testnet slots (tested below).
 */
export function target(id: string, key: string, live = true, extra: Record<string, string> = {}): PublisherTarget {
  return new PublisherTarget(id, `Slot ${id}`,
    { SUPPLIER_PRIV_KEY_HEX: key, NETWORK_ID: "0", OGMIOS_URL: "http://127.0.0.1:1337", LIVE_CHAIN: live ? "1" : "0", ...extra }, PUBLIC_URL);
}

export function fakeImages(failedBuilds = 0): RuntimeImages & { build: Mock } {
  const images = new Map([[BASE_IMAGE, { id: BASE_IMAGE, layers: ["sha256:base"] }]]);
  let failures = failedBuilds;
  return {
    inspect: async (reference: string) => images.get(reference) ?? null,
    build: vi.fn(async () => {
      if (failures-- > 0) throw new Error("pip install failed");
      images.set(RUNTIME_IMAGE, { id: RUNTIME_IMAGE, layers: ["sha256:base", "sha256:bundle"] });
      return RUNTIME_IMAGE;
    }),
  };
}

export interface Launch {
  targetId: string;
  env: Record<string, string>;
  signals: string[];
  statusPolls: number;
  admissions: number;
  activeSessions: number;
  /** Unpaid calls the child received, with the headers the proxy sent. */
  calls: Array<{ headers: Record<string, string | string[] | undefined>; body: string }>;
  /** While set, the child holds each unpaid call until it resolves. */
  callGate?: Promise<void>;
  /** The child process exits on its own, as after an OOM kill. */
  crash(): void;
}

/** A local stand-in for the supplier child that answers from its trusted launch environment. */
export function supplierLauncher(launches: Launch[], price: string): SupplierLauncher {
  return ({ targetId, port, env }) => {
    const launch: Launch = { targetId, env, signals: [], statusPolls: 0, admissions: 0, activeSessions: 0, calls: [], crash: () => undefined };
    launches.push(launch);
    const key = deriveSupplierKey(env.SUPPLIER_PRIV_KEY_HEX, env.NETWORK_ID === "1" ? 1 : 0);
    const manifest = JSON.parse(readFileSync(env.PAPER2AGENT_MANIFEST, "utf8")) as Paper2AgentManifest;
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/healthz") res.end(JSON.stringify({ ok: true }));
      else if (req.url === "/capability") {
        res.end(JSON.stringify({ capability_id: PAPER2AGENT_CAPABILITY_ID, model: paper2AgentModel(manifest), advert_ref: env.ADVERT_REF,
          supplier_pkh: key.pubKeyHash, pub_key_hex: key.pubKeyHex, price_lovelace: price,
          ...(env.AGENT_ID === undefined ? {} : { agent_id: env.AGENT_ID }),
          paper2agent: { manifest, manifest_hash: paper2AgentManifestHash(manifest) } }));
      } else if (req.url === "/status") {
        launch.statusPolls++;
        res.end(JSON.stringify({ status: "free", active_sessions: launch.activeSessions }));
      } else if (req.method === "POST" && req.url === "/v1/paper2agent/run") {
        launch.admissions++;
        res.statusCode = 202;
        res.end(JSON.stringify({ job_id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", status: "accepted" }));
      } else if (req.method === "POST" && req.url === "/v1/paper2agent/call") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        req.on("end", () => {
          launch.calls.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
          void (launch.callGate ?? Promise.resolve()).then(() => {
            res.end(JSON.stringify({ manifest_hash: paper2AgentManifestHash(manifest), result: { value: "x" }, wallclock_ms: 5 }));
          });
        });
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    servers.push(server);
    server.listen(port, "127.0.0.1");
    let exitCode: number | null = null;
    let exit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    launch.crash = () => {
      server.close();
      server.closeAllConnections();
      exitCode = 1;
      exit();
    };
    return {
      get exitCode() { return exitCode; },
      exited,
      kill(signal) {
        launch.signals.push(signal);
        server.close();
        server.closeAllConnections();
        exitCode = 0;
        exit();
      },
      output: () => "",
    };
  };
}

export async function publisher(options: { dataDir?: string; targets?: PublisherTarget[]; chain?: ChainProvider; images?: RuntimeImages;
  postAdvert?: PaperPublisherDeps["postAdvert"]; retireAdvert?: PaperPublisherDeps["retireAdvert"]; price?: string;
  toolCallToken?: string; identityController?: PaperPublisherConfig["identityController"]; registrar?: PaperPublisherDeps["registrar"];
  identity?: PaperPublisherDeps["identity"] } = {}) {
  const dataDir = options.dataDir ?? temporary();
  const chain = options.chain ?? new MockChainProvider();
  const images = options.images ?? fakeImages();
  const launches: Launch[] = [];
  const publisherConfig: PaperPublisherConfig = { dataDir, port: 8096, host: "127.0.0.1", token: TOKEN,
    toolCallToken: options.toolCallToken ?? null, publicUrl: PUBLIC_URL,
    runtimeImage: BASE_IMAGE, dockerPath: "/usr/bin/docker", dockerHost: null, repoRoot: process.cwd(),
    supplierEntry: join(process.cwd(), "supplier/src/index.ts"), targets: options.targets ?? [target("slot-a", KEY_A)],
    identityController: options.identityController ?? null };
  const service = await PaperPublisherService.open(publisherConfig, {
    chain: () => chain, images, launchSupplier: supplierLauncher(launches, options.price ?? "2000000"), postAdvert: options.postAdvert,
    retireAdvert: options.retireAdvert, sleep: tick, log: () => undefined, registrar: options.registrar, identity: options.identity,
  });
  services.push(service);
  return { service, app: createPaperPublisherApp(service), chain, images, launches, dataDir };
}

/**
 * The shared builder contract with real wallet movements: sign, run beforeSubmit, then broadcast. Either
 * advert layout. With validForMs, the transaction is valid until the mock tip plus that time.
 */
export function walletFundedAdvert(walletInput: { txHash: string; index: number }, change: bigint,
  validForMs?: number): PaperPublisherDeps["postAdvert"] {
  return async (params) => {
    const { advertDatum } = params;
    const upperBoundMs = validForMs === undefined ? undefined : (await params.chain.tip()) * 1000 + validForMs;
    const txCborHex = encodeTxBody({
      type: "post-advert", inputs: [walletInput], requiredSigners: [params.walletKey.pubKeyHash],
      outputs: [
        isIdentityAdvertDatum(advertDatum)
          ? { ref: { txHash: "$self", index: 0 }, address: IDENTITY.advertScriptAddress(0), lovelace: advertDatum.supplier_bond_lovelace,
            datumHex: encodeIdentityAdvertDatum(advertDatum) }
          : { ref: { txHash: "$self", index: 0 }, address: loadBlueprint().advertScriptAddress(0),
            lovelace: advertDatum.supplier_bond_lovelace, datumHex: encodeAdvertDatum(advertDatum) },
        { ref: { txHash: "$self", index: 1 }, address: params.walletKey.address, lovelace: change },
      ],
      ...(upperBoundMs === undefined ? {} : { validityRange: { lowerBoundMs: null, upperBoundMs } }),
    });
    const expectedTxHash = sha256Hex(txCborHex);
    const built = { txCborHex, expectedTxHash, advertOutputRef: { txHash: expectedTxHash, index: 0 } };
    await params.beforeSubmit?.(built);
    await params.chain.submitTx(txCborHex);
    await params.chain.awaitTx(expectedTxHash, 1_000);
    return { txHash: expectedTxHash, advertRef: built.advertOutputRef, formattedRef: `${expectedTxHash}#0` };
  };
}

export function fundWallet(chain: MockChainProvider, key: string, lovelace: bigint): { txHash: string; index: number } {
  const ref = { txHash: "dd".repeat(32), index: 0 };
  chain.seed({ ref, address: deriveSupplierKey(key, 0).address, lovelace, assets: {}, datumHex: null, scriptRef: null });
  return ref;
}
