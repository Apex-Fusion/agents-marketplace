import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import tar from "tar-stream";
import { MockChainProvider } from "@marketplace/shared/chain";
import { encodeAdvertDatum } from "@marketplace/shared/cbor";
import { loadBlueprint } from "@marketplace/shared/tx";
import { PAPER2AGENT_CAPABILITY_ID, paper2AgentManifestHash, paper2AgentModel, parsePaper2AgentManifest,
  type Paper2AgentManifest } from "@marketplace/shared/paper2agent";
import type { PaperPackageArtifact, PaperPublishTerms } from "@marketplace/shared/paper2agent/workflow";
import { encodeTxBody, sha256Hex } from "../../packages/shared/src/tx/internal/testTxBody.js";
import { deriveSupplierKey } from "../../supplier/src/paper2agent/identity.js";
import { PublisherTarget, loadPaperPublisherConfig, type PaperPublisherConfig } from "../src/publisher-config.js";
import { PaperPublisherService, createPaperPublisherApp, type PaperPublisherDeps, type RuntimeImages,
  type SupplierLauncher } from "../src/publisher.js";
import { PaperPublisherStore, type AdvertTransaction } from "../src/publisher-store.js";

const TOKEN = "publisher-token-".repeat(3);
const TOOL_TOKEN = "tool-call-token-".repeat(3);
const BASE_IMAGE = `sha256:${"b".repeat(64)}`;
const RUNTIME_IMAGE = `sha256:${"c".repeat(64)}`;
const PUBLIC_URL = "https://publisher.example";
const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JOB_ID = "0b4b7c2e-3f5d-4a8e-9c1d-2e3f4a5b6c7d";
const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

const directories: string[] = [];
const services: PaperPublisherService[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const server of servers.splice(0)) server.closeAllConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "p2a-publisher-"));
  directories.push(directory);
  return directory;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Bounded event-loop polling: no timers, no real sleeps. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20_000 && !condition(); turn++) await tick();
  expect(condition()).toBe(true);
}

async function reviewedPackage(): Promise<{ archive: Buffer; artifact: PaperPackageArtifact; manifest: Paper2AgentManifest }> {
  const files: Record<string, string> = { "server.py": "print('reviewed wrapper')\n", "source/model.py": "SCALE = 2\n" };
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
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

function terms(artifact: PaperPackageArtifact, targetId = "slot-a", price = "2000000"): PaperPublishTerms {
  return { target_id: targetId, artifact_sha256: artifact.sha256, price_lovelace: price, buyer_bond_lovelace: "1000000",
    supplier_bond_lovelace: "1000000" };
}

function preparation(pkg: { archive: Buffer; artifact: PaperPackageArtifact }, publicationTerms: PaperPublishTerms, id = JOB_ID) {
  return { job_id: id, terms: publicationTerms, artifact: pkg.artifact, archive_base64: pkg.archive.toString("base64") };
}

/**
 * The mock chain builds synthetic transactions at the NETWORK_ID 0 advert address, so service tests
 * construct slots directly. Configuration loading rejects live testnet slots (tested below).
 */
function target(id: string, key: string, live = true): PublisherTarget {
  return new PublisherTarget(id, `Slot ${id}`,
    { SUPPLIER_PRIV_KEY_HEX: key, NETWORK_ID: "0", OGMIOS_URL: "http://127.0.0.1:1337", LIVE_CHAIN: live ? "1" : "0" }, PUBLIC_URL);
}

function fakeImages(failedBuilds = 0): RuntimeImages & { build: Mock } {
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

interface Launch {
  env: Record<string, string>;
  signals: string[];
  statusPolls: number;
  admissions: number;
  activeSessions: number;
  /** Unpaid calls the child received, with the headers the proxy sent. */
  calls: Array<{ headers: Record<string, string | string[] | undefined>; body: string }>;
  /** While set, the child holds each unpaid call until it resolves. */
  callGate?: Promise<void>;
}

/** A local stand-in for the supplier child that answers from its trusted launch environment. */
function supplierLauncher(launches: Launch[], price: string): SupplierLauncher {
  return ({ port, env }) => {
    const launch: Launch = { env, signals: [], statusPolls: 0, admissions: 0, activeSessions: 0, calls: [] };
    launches.push(launch);
    const key = deriveSupplierKey(env.SUPPLIER_PRIV_KEY_HEX, env.NETWORK_ID === "1" ? 1 : 0);
    const manifest = JSON.parse(readFileSync(env.PAPER2AGENT_MANIFEST, "utf8")) as Paper2AgentManifest;
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/healthz") res.end(JSON.stringify({ ok: true }));
      else if (req.url === "/capability") {
        res.end(JSON.stringify({ capability_id: PAPER2AGENT_CAPABILITY_ID, model: paper2AgentModel(manifest), advert_ref: env.ADVERT_REF,
          supplier_pkh: key.pubKeyHash, pub_key_hex: key.pubKeyHex, price_lovelace: price,
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

async function publisher(options: { dataDir?: string; targets?: PublisherTarget[]; chain?: MockChainProvider; images?: RuntimeImages;
  postAdvert?: PaperPublisherDeps["postAdvert"]; price?: string; toolCallToken?: string } = {}) {
  const dataDir = options.dataDir ?? temporary();
  const chain = options.chain ?? new MockChainProvider();
  const images = options.images ?? fakeImages();
  const launches: Launch[] = [];
  const publisherConfig: PaperPublisherConfig = { dataDir, port: 8096, host: "127.0.0.1", token: TOKEN,
    toolCallToken: options.toolCallToken ?? null, publicUrl: PUBLIC_URL,
    runtimeImage: BASE_IMAGE, dockerPath: "/usr/bin/docker", dockerHost: null, repoRoot: process.cwd(),
    supplierEntry: join(process.cwd(), "supplier/src/index.ts"), targets: options.targets ?? [target("slot-a", KEY_A)] };
  const service = await PaperPublisherService.open(publisherConfig, {
    chain: () => chain, images, launchSupplier: supplierLauncher(launches, options.price ?? "2000000"), postAdvert: options.postAdvert,
    sleep: tick, log: () => undefined,
  });
  services.push(service);
  return { service, app: createPaperPublisherApp(service), chain, images, launches, dataDir };
}

/** The shared builder contract with real wallet movements: sign, run beforeSubmit, then broadcast. */
function walletFundedAdvert(walletInput: { txHash: string; index: number }, change: bigint, validUntilMs?: number): PaperPublisherDeps["postAdvert"] {
  return async (params) => {
    const txCborHex = encodeTxBody({
      type: "post-advert", inputs: [walletInput], requiredSigners: [params.walletKey.pubKeyHash],
      outputs: [
        { ref: { txHash: "$self", index: 0 }, address: loadBlueprint().advertScriptAddress(0),
          lovelace: params.advertDatum.supplier_bond_lovelace, datumHex: encodeAdvertDatum(params.advertDatum) },
        { ref: { txHash: "$self", index: 1 }, address: params.walletKey.address, lovelace: change },
      ],
      ...(validUntilMs === undefined ? {} : { validityRange: { lowerBoundMs: null, upperBoundMs: validUntilMs } }),
    });
    const expectedTxHash = sha256Hex(txCborHex);
    const built = { txCborHex, expectedTxHash, advertOutputRef: { txHash: expectedTxHash, index: 0 } };
    await params.beforeSubmit?.(built);
    await params.chain.submitTx(txCborHex);
    await params.chain.awaitTx(expectedTxHash, 1_000);
    return { txHash: expectedTxHash, advertRef: built.advertOutputRef, formattedRef: `${expectedTxHash}#0` };
  };
}

function fundWallet(chain: MockChainProvider, key: string, lovelace: bigint): { txHash: string; index: number } {
  const ref = { txHash: "dd".repeat(32), index: 0 };
  chain.seed({ ref, address: deriveSupplierKey(key, 0).address, lovelace, assets: {}, datumHex: null, scriptRef: null });
  return ref;
}

describe("publisher management boundary", () => {
  it("checks the bearer token before reading a body and never returns wallet keys", async () => {
    const { app } = await publisher();
    const unauthenticated = await request(app).post("/publications").set("Content-Type", "application/json").send("{not json");
    expect(unauthenticated.status).toBe(401);
    expect((await request(app).get("/targets").set("Authorization", `Bearer ${"x".repeat(48)}`)).status).toBe(401);
    expect((await request(app).get("/healthz")).status).toBe(200);

    const listed = await request(app).get("/targets").set(AUTH);
    expect(listed.status).toBe(200);
    expect(listed.body.targets).toEqual([{ id: "slot-a", label: "Slot slot-a", network_id: 0,
      supplier_pkh: deriveSupplierKey(KEY_A, 0).pubKeyHash, deposit_address: deriveSupplierKey(KEY_A, 0).address,
      endpoint_url: `${PUBLIC_URL}/tools/slot-a`, available: true, live_chain: true }]);
    expect(listed.text).not.toContain(KEY_A);
  });
});

describe("publication preparation", () => {
  it("rejects an archive that differs from the reviewed artifact before storing or building anything", async () => {
    const { app, images } = await publisher();
    const pkg = await reviewedPackage();
    const tampered = { ...pkg, archive: Buffer.concat([pkg.archive, Buffer.alloc(512)]) };
    const response = await request(app).post("/publications").set(AUTH).send(preparation(tampered, terms(pkg.artifact)));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("archive_hash_mismatch");
    expect(images.build).not.toHaveBeenCalled();
    expect((await request(app).get(`/publications/${JOB_ID}`).set(AUTH)).status).toBe(404);
  });

  it("builds once per exact request, conflicts on changed inputs, and holds the wallet slot", async () => {
    const { app, images } = await publisher();
    const pkg = await reviewedPackage();
    const first = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: JOB_ID, state: "prepared", tx_hash: null, advert_ref: null,
      deposit_address: deriveSupplierKey(KEY_A, 0).address, endpoint_url: `${PUBLIC_URL}/tools/slot-a` });

    const replay = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    expect(replay.body).toEqual(first.body);
    expect(images.build).toHaveBeenCalledTimes(1);

    const changed = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact, "slot-a", "3000000")));
    expect([changed.status, changed.body.error]).toEqual([409, "publication_conflict"]);
    const second = await request(app).post("/publications").set(AUTH)
      .send(preparation(pkg, terms(pkg.artifact), "7d6c5b4a-3e2f-4a1b-8c9d-0e1f2a3b4c5d"));
    expect([second.status, second.body.error]).toEqual([409, "target_slot_in_use"]);
    expect((await request(app).get("/targets").set(AUTH)).body.targets[0].available).toBe(false);
  });

  it("releases the slot after a failed image build and rebuilds on an exact retry", async () => {
    const { app, images } = await publisher({ images: fakeImages(1) });
    const pkg = await reviewedPackage();
    const failed = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ state: "failed", tx_hash: null });
    expect(failed.body.error).toContain("pip install failed");
    expect((await request(app).get("/targets").set(AUTH)).body.targets[0].available).toBe(true);

    const retried = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    expect(retried.body).toMatchObject({ state: "prepared", error: null });
    expect(images.build).toHaveBeenCalledTimes(2);
  });
});

describe("live advert publication", () => {
  it("refuses a slot without LIVE_CHAIN=1 instead of simulating a transaction", async () => {
    const { app, chain } = await publisher({ targets: [target("slot-a", KEY_A, false)] });
    const submit = vi.spyOn(chain, "submitTx");
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const refused = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect([refused.status, refused.body.error]).toEqual([409, "live_chain_disabled"]);
    expect(submit).not.toHaveBeenCalled();
    expect((await request(app).get(`/publications/${JOB_ID}`).set(AUTH)).body.state).toBe("prepared");
  });

  it("never broadcasts a signed advert whose exact wallet debit exceeds the approval", async () => {
    const chain = new MockChainProvider();
    const input = fundWallet(chain, KEY_A, 10_000_000n);
    const { app } = await publisher({ chain, postAdvert: walletFundedAdvert(input, 7_000_000n) });
    const submit = vi.spyOn(chain, "submitTx");
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));

    const refused = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "2999999" });
    expect([refused.status, refused.body.error]).toEqual([409, "debit_exceeds_approval"]);
    expect(submit).not.toHaveBeenCalled();
    const unchanged = await request(app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(unchanged.body).toMatchObject({ state: "prepared", tx_hash: null });
    expect(unchanged.body.error).toContain("debits 3000000 lovelace");

    const published = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "3000000" });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ state: "published", actual_debit_lovelace: "3000000", error: null });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("journals before broadcast and recovers an unknown outcome from chain evidence without signing again", async () => {
    const dataDir = temporary();
    const first = await publisher({ dataDir });
    const pkg = await reviewedPackage();
    await request(first.app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const broadcast = first.chain.submitTx.bind(first.chain);
    const journaledAtBroadcast: Array<string | null> = [];
    const submit = vi.spyOn(first.chain, "submitTx").mockImplementation(async (cbor) => {
      journaledAtBroadcast.push((await first.service.refresh(JOB_ID)).tx_hash);
      return broadcast(cbor);
    });
    vi.spyOn(first.chain, "awaitTx").mockRejectedValue(new Error("awaitTx_timeout: not observed"));

    const pending = await request(first.app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect(pending.status).toBe(200);
    expect(pending.body.state).toBe("confirmation_pending");
    expect(journaledAtBroadcast).toEqual([pending.body.tx_hash]);
    const again = await request(first.app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect([again.status, again.body.error]).toEqual([409, "publication_not_prepared"]);
    expect(submit).toHaveBeenCalledTimes(1);
    const advert = await first.chain.queryUtxo({ txHash: pending.body.tx_hash, index: 0 });
    await first.service.close();

    // Restart: the advert is now visible. Recovery reads it and starts the supplier only.
    const chain = new MockChainProvider();
    chain.seed(advert!);
    const postAdvert = vi.fn();
    const second = await publisher({ dataDir, chain, postAdvert, images: first.images });
    const resubmit = vi.spyOn(chain, "submitTx");
    const recovering = await request(second.app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(recovering.body.state).toBe("publishing");
    await second.service.idle();
    const recovered = await request(second.app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(recovered.body).toMatchObject({ state: "published", tx_hash: pending.body.tx_hash, advert_ref: `${pending.body.tx_hash}#0`, error: null });
    expect(postAdvert).not.toHaveBeenCalled();
    expect(resubmit).not.toHaveBeenCalled();

    const env = second.launches[0].env;
    expect(env).toMatchObject({ CAPABILITY_KIND: "paper2agent", ADVERT_REF: `${pending.body.tx_hash}#0`,
      SUPPLIER_BIND_HOST: "127.0.0.1", WALLET_HEALTH_INTERVAL_MS: "0" });
    expect(JSON.parse(env.PAPER2AGENT_ARGV_JSON)).toEqual(expect.arrayContaining(["--network", "none", "--read-only", RUNTIME_IMAGE]));
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it("marks an expired, unspent advert transaction failed only after the finality margin and keeps the slot", async () => {
    const chain = new MockChainProvider();
    const input = fundWallet(chain, KEY_A, 10_000_000n);
    const { app } = await publisher({ chain, postAdvert: walletFundedAdvert(input, 7_000_000n, 600_000) });
    vi.spyOn(chain, "submitTx").mockRejectedValue(new Error("socket hang up"));
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const pending = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect(pending.body.state).toBe("confirmation_pending");

    chain.advanceSlot(600 + 43_200);
    const withinMargin = await request(app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(withinMargin.body.state).toBe("confirmation_pending");
    expect(withinMargin.body.error).toContain("cannot confirm after slot 600");

    chain.advanceSlot(1);
    const expired = await request(app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(expired.body).toMatchObject({ state: "failed", tx_hash: pending.body.tx_hash });
    expect((await request(app).get("/targets").set(AUTH)).body.targets[0].available).toBe(false);
  });
});

describe("supplier supervision", () => {
  it("proxies only the fixed supplier protocol and drains active work before stopping the child", async () => {
    const { app, service, launches } = await publisher();
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const published = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect(published.body.state).toBe("published");

    expect((await request(app).get("/tools/slot-a/capability")).body.capability_id).toBe(PAPER2AGENT_CAPABILITY_ID);
    expect((await request(app).get("/tools/slot-a/admin")).status).toBe(404);
    expect((await request(app).get("/tools/slot-b/capability")).status).toBe(404);
    // Without a configured tool-call token the unpaid route does not exist.
    expect(launches[0].env.PAPER2AGENT_FREE_CALLS).toBeUndefined();
    const unconfigured = await request(app).post("/tools/slot-a/v1/paper2agent/call").set(AUTH)
      .send({ manifest_hash: pkg.artifact.manifest_hash, input: { value: "x" } });
    expect([unconfigured.status, unconfigured.body]).toEqual([404, { reason: "not_found", message: "not_found" }]);
    expect(launches[0].calls).toEqual([]);
    const admitted = await request(app).post("/tools/slot-a/v1/paper2agent/run")
      .set("X-Escrow-Ref", `${"e".repeat(64)}#0`).send({ manifest_hash: pkg.artifact.manifest_hash, input: { value: "x" } });
    expect(admitted.status).toBe(202);
    expect(launches[0].admissions).toBe(1);

    launches[0].activeSessions = 1;
    const closing = service.close();
    await until(() => launches[0].statusPolls >= 2);
    const refused = await request(app).post("/tools/slot-a/v1/paper2agent/run")
      .set("X-Escrow-Ref", `${"f".repeat(64)}#0`).send({ manifest_hash: pkg.artifact.manifest_hash, input: { value: "y" } });
    expect([refused.status, refused.body.reason]).toEqual([503, "supplier_draining"]);
    expect((await request(app).get("/tools/slot-a/status")).status).toBe(200);
    expect(launches[0].signals).toEqual([]);

    launches[0].activeSessions = 0;
    await closing;
    expect(launches[0].signals).toEqual(["SIGTERM"]);
    expect(launches[0].admissions).toBe(1);
  });

  it("forwards unpaid tool calls only with the tool-call token and drains them like admissions", async () => {
    const { app, service, launches } = await publisher({ toolCallToken: TOOL_TOKEN });
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const published = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect(published.body.state).toBe("published");
    expect(launches[0].env.PAPER2AGENT_FREE_CALLS).toBe("1");
    const payload = { manifest_hash: pkg.artifact.manifest_hash, input: { value: "x" } };
    const call = (authorization?: string, targetId = "slot-a") => {
      const pending = request(app).post(`/tools/${targetId}/v1/paper2agent/call`);
      return (authorization === undefined ? pending : pending.set("Authorization", authorization)).send(payload);
    };

    for (const authorization of [undefined, "", "Bearer ", TOOL_TOKEN, `Basic ${TOOL_TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOOL_TOKEN}x`]) {
      const refused = await call(authorization);
      expect([refused.status, refused.body]).toEqual([401, { reason: "unauthorized", message: "unauthorized" }]);
    }
    expect((await call(`Bearer ${TOOL_TOKEN}`, "slot-b")).status).toBe(404);
    expect(launches[0].calls).toEqual([]);

    const timeout = vi.spyOn(AbortSignal, "timeout");
    const answered = await call(`Bearer ${TOOL_TOKEN}`);
    expect(answered.status).toBe(200);
    expect(answered.headers["cache-control"]).toBe("no-store");
    expect(answered.body).toEqual({ manifest_hash: pkg.artifact.manifest_hash, result: { value: "x" }, wallclock_ms: 5 });
    expect(timeout).toHaveBeenCalledWith(180_000);
    expect(launches[0].calls).toHaveLength(1);
    expect(launches[0].calls[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(launches[0].calls[0].body)).toEqual(payload);

    // The child reports no session, but the in-flight call still holds the drain.
    let release!: () => void;
    launches[0].callGate = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = call(`Bearer ${TOOL_TOKEN}`).then((reply) => reply);
    await until(() => launches[0].calls.length === 2);
    const closing = service.close();
    const draining = await call(`Bearer ${TOOL_TOKEN}`);
    expect([draining.status, draining.body.reason]).toEqual([503, "supplier_draining"]);
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(401);
    for (let turn = 0; turn < 100; turn++) await tick();
    expect(launches[0].signals).toEqual([]);

    release();
    expect((await inFlight).status).toBe(200);
    await closing;
    expect(launches[0].signals).toEqual(["SIGTERM"]);
    expect(launches[0].calls).toHaveLength(2);
    expect(launches[0].calls[1].headers.authorization).toBeUndefined();
  });
});

describe("publisher journal invariants", () => {
  it("recovers interrupted phases and never lets a signed publication become publishable again", () => {
    const store = PaperPublisherStore.open(join(temporary(), "publisher.db"));
    const record = (id: string, targetId: string) => ({ id, target_id: targetId, request_hash: "0".repeat(64),
      terms: {} as PaperPublishTerms, artifact: {} as PaperPackageArtifact, work_dir: `/data/${id}`, supplier_pkh: "aa".repeat(28),
      deposit_address: "addr_test1", endpoint_url: `${PUBLIC_URL}/tools/${targetId}` });
    const transaction = (id: string, targetId: string, hash: string): AdvertTransaction => ({ publication_id: id, target_id: targetId,
      tx_hash: hash, tx_cbor: "00", advert_ref: `${hash}#0`, advert_address: "addr_test1", advert_datum_hex: "00", wallet_inputs: [],
      fee_lovelace: "0", wallet_debit_lovelace: "0", max_debit_lovelace: "1", valid_until_slot: null, signed_at: 1, confirmed_at: null });
    for (const [id, targetId] of [["unsigned", "slot-a"], ["signed", "slot-b"]]) {
      store.create(record(id, targetId), 1);
      store.update(id, ["preparing"], { phase: "prepared" }, 2);
      store.update(id, ["prepared"], { phase: "publishing" }, 3);
    }
    store.journal(transaction("signed", "slot-b", "ab".repeat(32)), 4);
    store.create(record("building", "slot-c"), 5);
    expect(() => store.create(record("second", "slot-b"), 6)).toThrow("target_slot_in_use");

    store.recover(7);
    expect(["unsigned", "signed", "building"].map((id) => store.get(id)?.phase)).toEqual(["prepared", "confirmation_pending", "failed"]);
    expect(() => store.update("signed", ["confirmation_pending"], { phase: "prepared" }, 8)).toThrow(/cannot be reset/);
    expect(() => store.journal(transaction("unsigned", "slot-b", "cd".repeat(32)), 9)).toThrow();
    expect(store.heldTargets()).toEqual(new Set(["slot-a", "slot-b"]));
    store.close();
  });
});

describe("publisher configuration", () => {
  it("loads private wallet slots only from an operator-private file with supported chain settings", () => {
    const directory = temporary();
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin", "docker"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(directory, "bin", "docker"), 0o755);
    const file = join(directory, "targets.json");
    const zeroTime = "1752057484000";
    const slot = (id: string, key: string, extra: Record<string, string> = {}) => ({ id, label: `Slot ${id}`,
      env: { SUPPLIER_PRIV_KEY_HEX: key, NETWORK_ID: "1", OGMIOS_URL: "https://ogmios.example", LIVE_CHAIN: "1",
        VECTOR_ZERO_TIME_MS: zeroTime, ...extra } });
    const load = (targets: unknown[], extra: Record<string, string> = {}) => {
      writeFileSync(file, JSON.stringify(targets));
      return loadPaperPublisherConfig({ PATH: join(directory, "bin"), PAPER2AGENT_PUBLISHER_TOKEN: TOKEN,
        PAPER2AGENT_PUBLISHER_TARGETS_FILE: file, PAPER2AGENT_PUBLISHER_PUBLIC_URL: PUBLIC_URL, VECTOR_ZERO_TIME_MS: zeroTime,
        PAPER2AGENT_RUNTIME_IMAGE: BASE_IMAGE, PAPER2AGENT_PUBLISHER_DATA_DIR: join(directory, "data"), ...extra });
    };

    writeFileSync(file, "[]");
    chmodSync(file, 0o644);
    expect(() => load([slot("slot-a", KEY_A)])).toThrow(/chmod 600/);
    chmodSync(file, 0o600);
    expect(() => load([slot("slot-a", KEY_A, { NODE_OPTIONS: "--inspect" })])).toThrow(/NODE_OPTIONS is not a supported/);
    expect(() => load([slot("slot-a", KEY_A), slot("slot-b", KEY_A)])).toThrow(/own key/);
    expect(() => load([slot("slot-a", KEY_A, { NETWORK_ID: "0" })])).toThrow(/requires NETWORK_ID=1/);
    expect(() => load([slot("slot-a", KEY_A, { VECTOR_ZERO_TIME_MS: "1" })])).toThrow(/VECTOR_ZERO_TIME_MS/);

    const loaded = load([slot("slot-a", KEY_A), slot("slot-b", KEY_B)]);
    expect(loaded.targets.map((entry) => entry.endpointUrl)).toEqual([`${PUBLIC_URL}/tools/slot-a`, `${PUBLIC_URL}/tools/slot-b`]);
    expect(loaded.dockerPath).toBe(join(directory, "bin", "docker"));
    expect(loaded.toolCallToken).toBeNull();
    expect(load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: "" }).toolCallToken).toBeNull();
    expect(load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: TOOL_TOKEN }).toolCallToken).toBe(TOOL_TOKEN);
    expect(() => load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: "short" })).toThrow(/PAPER2AGENT_TOOL_CALL_TOKEN must be/);
    expect(() => load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: `${"t".repeat(32)} x` })).toThrow(/without whitespace/);
    expect(() => load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: TOKEN })).toThrow(/must differ/);
    for (const text of [JSON.stringify(loaded.targets), inspect(loaded.targets)]) {
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(KEY_B);
    }
  });
});
