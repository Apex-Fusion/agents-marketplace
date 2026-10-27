import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/client";
import { MockChainProvider } from "@marketplace/shared/chain";
import { encodeAdvertDatum, encodeEscrowDatum, type AdvertDatum, type EscrowDatum } from "@marketplace/shared/cbor";
import { loadBlueprint, NETWORK_BUFFER_MS } from "@marketplace/shared/tx";
import { parsePaper2AgentManifest, paper2AgentManifestHash, paper2AgentModel,
  paper2AgentRequestHash, paper2AgentRequestSpecHash, verifyPaper2AgentReceipt,
  PAPER2AGENT_CAPABILITY_ID, PAPER2AGENT_DELIVERY_OVERHEAD_MS, PAPER2AGENT_SUPPLIER_OVERHEAD_MS,
  MAX_TOOL_INPUT_BYTES } from "@marketplace/shared/paper2agent";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { createApp } from "../../supplier/src/server.js";
import { deriveSupplierKey, checkSupplierKey } from "../../supplier/src/paper2agent/identity.js";
import { Paper2AgentRuntime } from "../../supplier/src/paper2agent/runtime.js";
import { ToolJournal } from "../../supplier/src/paper2agent/journal.js";
import { loadConfig, type Paper2AgentConfig } from "../../supplier/src/config.js";
import type { ToolSession } from "../../supplier/src/paper2agent/local.js";
import { parseCliArgs } from "../../supplier/src/cli/post-advert.js";
import { registerPaper2Agent } from "../../supplier/src/cli/register-paper2agent.js";
import { buildSampleConfig, buildSampleEnv } from "../fixtures/supplier-side/sample-config.js";

const directories: string[] = [];
const runtimes: Paper2AgentRuntime[] = [];
const schema = { type: "object" as const, properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const preparedBytes = "reviewed local package";
const supplierKey = deriveSupplierKey("11".repeat(32), 0);
const advertRef = { txHash: "bb".repeat(32), index: 0 };
const escrowRef = { txHash: "cc".repeat(32), index: 0 };
const escrowText = `${escrowRef.txHash}#0`;
const manifest = parsePaper2AgentManifest({ schema_version: 1, name: "echo_record", description: "Test-only tool",
  package_sha256: createHash("sha256").update(preparedBytes).digest("hex"), input_schema: schema, output_schema: schema,
  limits: { max_input_bytes: 4096, max_output_bytes: 4096, max_runtime_ms: 1000 } });
const manifestHash = paper2AgentManifestHash(manifest);
const input = { value: "hello" };
const body = { manifest_hash: manifestHash, input };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "supplier-p2a-"));
  directories.push(directory);
  const config: Paper2AgentConfig = { executable: process.execPath, argv: [], cwd: directory,
    packagePath: join(directory, "package.bin"), manifestPath: join(directory, "manifest.json"), journalDir: join(directory, "journal") };
  writeFileSync(config.packagePath, preparedBytes);
  writeFileSync(config.manifestPath, JSON.stringify(manifest));
  const chain = new MockChainProvider();
  const state = new SupplierState();
  const advert: AdvertDatum = { supplier_pkh: supplierKey.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID,
    model: paper2AgentModel(manifest), max_output_tokens: 0,
    max_processing_ms: manifest.limits.max_runtime_ms + PAPER2AGENT_SUPPLIER_OVERHEAD_MS,
    price_lovelace: 2000000n, buyer_bond_lovelace: 1000000n, supplier_bond_lovelace: 1000000n,
    endpoint_url: "http://localhost:8080", detail_uri: "", detail_hash: manifestHash, advertised_at: 0, status: "Active" };
  const escrow: EscrowDatum = { buyer_pkh: "44".repeat(28), supplier_pkh: supplierKey.pubKeyHash,
    advert_ref: advertRef, capability_id: advert.capability_id, request_spec_hash: paper2AgentRequestSpecHash(manifest),
    prompt_hash: paper2AgentRequestHash(manifestHash, input), payment_lovelace: advert.price_lovelace,
    buyer_bond_lovelace: advert.buyer_bond_lovelace, supplier_bond_lovelace: advert.supplier_bond_lovelace,
    posted_at: 0, deliver_by: advert.max_processing_ms + NETWORK_BUFFER_MS,
    submitted_at: null, result_receipt_hash: null, state: "Open" };
  const seedAdvert = () => chain.seed({ ref: advertRef, address: loadBlueprint().advertScriptAddress(0), lovelace: 2000000n,
    assets: {}, datumHex: encodeAdvertDatum(advert), scriptRef: null });
  seedAdvert();
  const seedEscrow = () => chain.seed({ ref: escrowRef, address: loadBlueprint().escrowScriptAddress(0), lovelace: 4000000n,
    assets: {}, datumHex: encodeEscrowDatum(escrow), scriptRef: null });
  seedEscrow();
  const tools: Tool[] = [{ name: manifest.name, inputSchema: schema, outputSchema: schema }];
  const session = { discover: vi.fn(async () => tools), execute: vi.fn(async () => input), close: vi.fn(async () => undefined) } satisfies ToolSession;
  const factory = vi.fn(() => session);
  const deps = { chain, state, supplierKey, networkId: 0 as const, advertRef, config, sessionFactory: factory };
  const create = async () => {
    const runtime = await Paper2AgentRuntime.create(deps);
    runtimes.push(runtime);
    return runtime;
  };
  const serve = (runtime: Paper2AgentRuntime) => createApp({ ...deps, config: { ...buildSampleConfig(),
    capabilityKind: "paper2agent", advertRef, paper2agent: config }, paper2agent: runtime });
  return { directory, config, chain, state, advert, escrow, seedAdvert, seedEscrow, session, factory, deps, create, serve };
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("supplier Paper2Agent admission and identity", () => {
  it("derives the receipt identity and rejects each false identity component", () => {
    expect(() => checkSupplierKey(supplierKey, 0)).not.toThrow();
    for (const field of ["pubKeyHex", "pubKeyHash", "address"] as const) {
      expect(() => checkSupplierKey({ ...supplierKey, [field]: "bad" }, 0)).toThrow(/identity/);
    }
    expect(() => checkSupplierKey(supplierKey, 1)).toThrow(/identity/);
  });

  it.each([
    { ...body, command: "run-me" }, { ...body, name: manifest.name }, { ...body, manifest_hash: "00".repeat(32) },
    { ...body, input: { value: 1 } }, { ...body, server: "https://example.com" },
  ])("rejects uncommitted request fields and invalid schema before spawning or Claim", async (invalid) => {
    const f = fixture();
    const runtime = await f.create();
    const submit = vi.spyOn(f.chain, "submitTx");
    await expect(runtime.admit(escrowText, invalid)).rejects.toMatchObject({ status: 400 });
    expect(f.factory).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["payment_lovelace", "buyer_bond_lovelace", "supplier_bond_lovelace"] as const)(
    "rejects a changed %s before Claim", async (field) => {
      const f = fixture();
      f.escrow[field] += 1n;
      f.seedEscrow();
      const runtime = await f.create();
      await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ status: 409 });
      expect(f.factory).not.toHaveBeenCalled();
    });

  it("rejects a different original advert, commitment, or shortened deadline", async () => {
    for (const mutation of [
      (escrow: EscrowDatum) => { escrow.advert_ref = { ...advertRef, index: 1 }; },
      (escrow: EscrowDatum) => { escrow.prompt_hash = "00".repeat(32); },
      (escrow: EscrowDatum) => { escrow.request_spec_hash = "00".repeat(32); },
      (escrow: EscrowDatum) => { escrow.deliver_by -= 1; },
    ]) {
      const f = fixture();
      mutation(f.escrow); f.seedEscrow();
      const runtime = await f.create();
      await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ status: 409 });
      expect(f.factory).not.toHaveBeenCalled();
    }
  });

  it("keeps the supplier reserve after the buyer's full Post confirmation wait under the default SLA", async () => {
    const f = fixture();
    f.advert.max_processing_ms = parseCliArgs([], { NETWORK_ID: "0", CAPABILITY_KIND: "paper2agent",
      PAPER2AGENT_MANIFEST: f.config.manifestPath, SUPPLIER_PRIV_KEY_HEX: supplierKey.privateKeyHex,
      ADVERT_PRICE_LOVELACE: "2000000", ADVERT_ENDPOINT_URL: "http://localhost:8080" }).maxProcessingMs;
    f.escrow.deliver_by = f.escrow.posted_at + f.advert.max_processing_ms + NETWORK_BUFFER_MS;
    f.seedAdvert();
    f.seedEscrow();
    // Mock slots are seconds. Admission arrives after the whole confirmation allowance.
    f.chain.advanceSlot((PAPER2AGENT_DELIVERY_OVERHEAD_MS - PAPER2AGENT_SUPPLIER_OVERHEAD_MS) / 1000);
    const runtime = await f.create();
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("done"));
  });

  it("checks the real package hash at boot and again before Claim", async () => {
    const f = fixture();
    const runtime = await f.create();
    writeFileSync(f.config.packagePath, "changed package");
    await expect(Paper2AgentRuntime.create(f.deps)).rejects.toThrow(/SHA-256/);
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ reason: "tool_preflight_failed" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.state.snapshot().status).toBe("free");
  });

  it("checks tool schemas before Claim and closes the process on mismatch", async () => {
    const f = fixture();
    f.session.discover.mockResolvedValue([{ name: manifest.name, inputSchema: { type: "object" }, outputSchema: schema }]);
    const runtime = await f.create();
    const submit = vi.spyOn(f.chain, "submitTx");
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ reason: "tool_preflight_failed" });
    expect(submit).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalled();
    expect(f.state.snapshot().status).toBe("free");
  });
});

describe("supplier Paper2Agent execution and financial evidence", () => {
  it("runs only after confirmed Claim, closes before Submit, and returns a genuine receipt", async () => {
    const f = fixture();
    const runtime = await f.create();
    const awaitTx = vi.spyOn(f.chain, "awaitTx");
    f.session.execute.mockImplementation(async () => {
      expect(awaitTx).toHaveBeenCalledTimes(1);
      expect(f.state.snapshot().status).toBe("working");
      return input;
    });
    const submit = f.chain.submitTx.bind(f.chain);
    let broadcasts = 0;
    vi.spyOn(f.chain, "submitTx").mockImplementation(async (cbor) => {
      if (++broadcasts === 2) expect(f.session.close).toHaveBeenCalled();
      return submit(cbor);
    });
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("done"));
    expect(f.session.execute).toHaveBeenCalledWith(manifest.name, input, manifest.limits.max_runtime_ms);
    verifyPaper2AgentReceipt({ manifest, input, result: job.result!, receipt: job.receipt!, signature: job.receipt_signature!,
      publicKeyHex: job.pub_key_hex!, supplierPkh: supplierKey.pubKeyHash, escrowRef: escrowText });
    expect(f.state.snapshot().status).toBe("free");
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ reason: "escrow_already_admitted" });
  });

  it("never executes after ambiguous Claim confirmation and keeps the candidate reference", async () => {
    const f = fixture();
    const runtime = await f.create();
    vi.spyOn(f.chain, "awaitTx").mockRejectedValue(new Error("confirmation timeout"));
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({
      job: { claimed_ref: expect.stringMatching(/^[0-9a-f]{64}#0$/), reason: "claim_financial_status_unknown" },
    });
    expect(f.session.execute).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalled();
  });

  it("keeps the candidate Claim reference when its broadcast response is lost", async () => {
    const f = fixture();
    const runtime = await f.create();
    const submit = f.chain.submitTx.bind(f.chain);
    vi.spyOn(f.chain, "submitTx").mockImplementation(async (cbor) => {
      await submit(cbor);
      throw new Error("Claim broadcast response lost");
    });
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({
      job: { phase: "claiming", claimed_ref: expect.stringMatching(/^[0-9a-f]{64}#0$/),
        reason: "claim_financial_status_unknown" },
    });
    expect(f.session.execute).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalled();
  });

  it("journals signed output and candidate Submit before broadcast and keeps both after ambiguity and restart", async () => {
    const f = fixture();
    const runtime = await f.create();
    const submit = f.chain.submitTx.bind(f.chain);
    let broadcasts = 0;
    vi.spyOn(f.chain, "submitTx").mockImplementation(async (cbor) => {
      if (++broadcasts === 2) {
        const filename = readdirSync(f.config.journalDir).find((name) => name.endsWith(".json"))!;
        const persisted = JSON.parse(readFileSync(join(f.config.journalDir, filename), "utf8"));
        expect(persisted.phase).toBe("submitting");
        expect(persisted.submitted_ref).toMatch(/^[0-9a-f]{64}#0$/);
        expect(persisted.receipt_signature).toMatch(/^[0-9a-f]{128}$/);
        await submit(cbor);
        throw new Error("network reply lost after broadcast");
      }
      return submit(cbor);
    });
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("failed"));
    expect(job.reason).toBe("submit_financial_status_unknown");
    const restored = new ToolJournal(f.config.journalDir).get(job.job_id)!;
    expect(restored.result).toEqual(input);
    expect(restored.receipt_signature).toBe(job.receipt_signature);
    expect(restored.claimed_ref).toBeTruthy();
    expect(restored.submitted_ref).toBe(job.submitted_ref);
    const app = f.serve(runtime);
    const polled = await request(app).get(`/v1/paper2agent/run/${job.job_id}`);
    expect(polled.status).toBe(502);
    expect(polled.body.result).toEqual(input);
    expect(polled.body.receipt_signature).toBe(restored.receipt_signature);
    expect(polled.body.submitted_ref).toBe(restored.submitted_ref);
    expect(polled.body.financial_status).toBe("unknown");
  });

  it("does not Submit a failed tool call and keeps the slot until cleanup finishes", async () => {
    const f = fixture();
    const runtime = await f.create();
    let finishCleanup!: () => void;
    f.session.close.mockImplementation(() => new Promise<void>((resolve) => { finishCleanup = resolve; }));
    f.session.execute.mockRejectedValue(new Error("tool failed"));
    const submit = vi.spyOn(f.chain, "submitTx");
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(f.session.close).toHaveBeenCalled());
    expect(job.status).toBe("failed");
    expect(f.state.snapshot().status).toBe("working");
    expect(submit).toHaveBeenCalledTimes(1);
    finishCleanup();
    f.session.close.mockResolvedValue(undefined);
    await vi.waitFor(() => expect(f.state.snapshot().status).toBe("free"));
  });

  it("rejects schema-invalid output before signing or Submit", async () => {
    const f = fixture();
    f.session.execute.mockImplementation(async () => ({ value: "hello", extra: true }));
    const runtime = await f.create();
    const submit = vi.spyOn(f.chain, "submitTx");
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("failed"));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(job.receipt_signature).toBeUndefined();
  });

  it("never signs or Submits a result measured over the manifest runtime", async () => {
    const f = fixture();
    f.session.execute.mockImplementation(async () => {
      const late = performance.now() + manifest.limits.max_runtime_ms + 1;
      vi.spyOn(performance, "now").mockReturnValue(late);
      return input;
    });
    const runtime = await f.create();
    const submit = vi.spyOn(f.chain, "submitTx");
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("failed"));
    expect(job.receipt_signature).toBeUndefined();
    // Only the Claim: the buyer can Reclaim after deliver_by.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(job.claimed_ref).toMatch(/^[0-9a-f]{64}#0$/);
  });

  it("executes and signs normalized values, not the caller's original strings", async () => {
    const f = fixture();
    const normalized = { value: "\u00e9" };
    const original = { value: "e\u0301" };
    f.escrow.prompt_hash = paper2AgentRequestHash(manifestHash, normalized);
    f.seedEscrow();
    f.session.execute.mockResolvedValue(original);
    const runtime = await f.create();
    const job = await runtime.admit(escrowText, { ...body, input: original });
    await vi.waitFor(() => expect(job.status).toBe("done"));
    expect(f.session.execute).toHaveBeenCalledWith(manifest.name, normalized, manifest.limits.max_runtime_ms);
    expect(job.result).toEqual(normalized);
    verifyPaper2AgentReceipt({ manifest, input: normalized, result: job.result!, receipt: job.receipt!,
      signature: job.receipt_signature!, publicKeyHex: job.pub_key_hex!,
      supplierPkh: supplierKey.pubKeyHash, escrowRef: escrowText });
  });

  it("takes the supplier offline if process cleanup fails", async () => {
    const f = fixture();
    f.session.execute.mockRejectedValue(new Error("runtime failure"));
    f.session.close.mockRejectedValue(new Error("process termination unknown"));
    const runtime = await f.create();
    await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(f.state.snapshot().status).toBe("offline"));
  });

  it("isolates tool polling from legacy job stores and exposes the bound manifest and key", async () => {
    const f = fixture();
    const runtime = await f.create();
    const jobs = new JobStore();
    const legacyJobId = jobs.create(escrowText);
    const app = createApp({ ...f.deps, config: { ...buildSampleConfig(), capabilityKind: "paper2agent", advertRef,
      paper2agent: f.config }, jobs, paper2agent: runtime });
    expect((await request(app).get(`/v1/paper2agent/run/${legacyJobId}`)).status).toBe(404);
    expect((await request(app).get(`/v1/responses/${legacyJobId}`)).status).toBe(404);
    const capability = await request(app).get("/capability");
    expect(capability.status).toBe(200);
    expect(capability.body.paper2agent.manifest_hash).toBe(manifestHash);
    expect(capability.body.pub_key_hex).toBe(supplierKey.pubKeyHex);
  });
});

describe("supplier Paper2Agent read-only recovery and durable records", () => {
  it("finds a lost admission by its request preimage without admission, execution, signing, or Submit", async () => {
    const f = fixture();
    const runtime = await f.create();
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("done"));
    const acquire = vi.spyOn(f.state, "tryAcquire");
    const submit = vi.spyOn(f.chain, "submitTx");
    const app = f.serve(runtime);
    const lookup = (ref: string, payload: unknown) =>
      request(app).post("/v1/paper2agent/lookup").set("X-Escrow-Ref", ref).send(payload as object);
    const found = await lookup(escrowText, body);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ job_id: job.job_id, escrow_ref: escrowText, manifest_hash: manifestHash, status: "done" });
    // A wrong preimage and an unknown escrow get the same answer.
    for (const miss of [await lookup(escrowText, { ...body, input: { value: "other" } }),
      await lookup(`${"dd".repeat(32)}#0`, body)]) {
      expect(miss.status).toBe(404);
      expect(miss.body).toEqual({ reason: "job_not_found" });
    }
    expect((await lookup(escrowText, { ...body, extra: true })).status).toBe(400);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.session.execute).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("finds an earlier manifest version's job after restart without the current tool schema", async () => {
    const f = fixture();
    const earlier = parsePaper2AgentManifest({ ...manifest, input_schema: { type: "object",
      properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } });
    const earlierHash = paper2AgentManifestHash(earlier);
    const earlierInput = { count: 3 };
    const earlierEscrow = `${"dd".repeat(32)}#1`;
    // Interrupted before restart; the current schema rejects this input.
    const stored = new ToolJournal(f.config.journalDir).create(earlierEscrow, earlierHash, earlierInput);
    const runtime = await f.create();
    const submit = vi.spyOn(f.chain, "submitTx");
    const found = await request(f.serve(runtime)).post("/v1/paper2agent/lookup").set("X-Escrow-Ref", earlierEscrow)
      .send({ manifest_hash: earlierHash, input: earlierInput });
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ job_id: stored.job_id, escrow_ref: earlierEscrow, manifest_hash: earlierHash,
      status: "failed" });
    await expect(runtime.admit(earlierEscrow, body)).rejects.toMatchObject({ reason: "escrow_already_admitted" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("reads completed payloads from their durable record and fails closed when it changes", async () => {
    const f = fixture();
    const runtime = await f.create();
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("done"));
    const app = f.serve(runtime);
    expect((await request(app).get(`/v1/paper2agent/run/${job.job_id}`)).body.result).toEqual(input);
    const path = join(f.config.journalDir, `${job.job_id}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), escrow_ref: `${"dd".repeat(32)}#0` }));
    const polled = await request(app).get(`/v1/paper2agent/run/${job.job_id}`);
    expect(polled.status).toBe(503);
    expect(polled.body.result).toBeUndefined();
    expect((await request(app).post("/v1/paper2agent/lookup").set("X-Escrow-Ref", escrowText).send(body)).status).toBe(503);
  });
});

describe("supplier Paper2Agent unpaid calls", () => {
  /** The next tool call waits until the test releases it. */
  function heldExecution(execute: { mockImplementationOnce(implementation: () => Promise<typeof input>): unknown }): () => void {
    let finish!: () => void;
    execute.mockImplementationOnce(() => new Promise<typeof input>((resolve) => { finish = () => resolve(input); }));
    return () => finish();
  }

  it("runs one call and writes no journal entry, chain transaction, or receipt", async () => {
    const f = fixture();
    f.config.freeCalls = true;
    const runtime = await f.create();
    const submit = vi.spyOn(f.chain, "submitTx");
    const awaitTx = vi.spyOn(f.chain, "awaitTx");
    const reply = await request(f.serve(runtime)).post("/v1/paper2agent/call").send(body);
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.body).toEqual({ manifest_hash: manifestHash, result: input, wallclock_ms: expect.any(Number) });
    expect(Number.isSafeInteger(reply.body.wallclock_ms)).toBe(true);
    expect(f.session.execute).toHaveBeenCalledWith(manifest.name, input, manifest.limits.max_runtime_ms);
    expect(f.session.close).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(awaitTx).not.toHaveBeenCalled();
    expect(readdirSync(f.config.journalDir)).toEqual([]);
    expect(f.state.snapshot().status).toBe("free");
  });

  it("answers 404 before reading the body when the operator did not enable it", async () => {
    const f = fixture();
    const runtime = await f.create();
    const app = f.serve(runtime);
    for (const payload of [JSON.stringify(body), "{not json"]) {
      const reply = await request(app).post("/v1/paper2agent/call").set("Content-Type", "application/json").send(payload);
      expect([reply.status, reply.body]).toEqual([404, { reason: "not_found", message: "not_found" }]);
    }
    await expect(runtime.call(body)).rejects.toMatchObject({ status: 404, reason: "not_found" });
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("rejects invalid, oversized, and unadvertised calls before taking the slot or starting a process", async () => {
    const f = fixture();
    f.config.freeCalls = true;
    const runtime = await f.create();
    const acquire = vi.spyOn(f.state, "tryAcquire");
    const app = f.serve(runtime);
    const call = (payload: string | object) => request(app).post("/v1/paper2agent/call").set("Content-Type", "application/json").send(payload);
    for (const invalid of [{ ...body, command: "run-me" }, { ...body, manifest_hash: "00".repeat(32) },
      { ...body, input: { value: 1 } }, { input }, "{not json"]) {
      const reply = await call(invalid);
      expect([reply.status, reply.body]).toEqual([400, { reason: "invalid_tool_request", message: "invalid_tool_request" }]);
    }
    const large = await call({ ...body, input: { value: "x".repeat(MAX_TOOL_INPUT_BYTES + 512) } });
    expect([large.status, large.body]).toEqual([413, { reason: "request_too_large", message: "request_too_large" }]);
    f.advert.status = "Retired";
    f.seedAdvert();
    const retired = await call(body);
    expect([retired.status, retired.body]).toEqual([503, { reason: "supplier_unavailable", message: "supplier_unavailable" }]);
    expect(acquire).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("shares the single slot with paid admission in both directions", async () => {
    const f = fixture();
    f.config.freeCalls = true;
    const runtime = await f.create();
    const app = f.serve(runtime);

    // A free call holds the slot.
    const finishFree = heldExecution(f.session.execute);
    const inFlight = runtime.call(body);
    await vi.waitFor(() => expect(f.session.execute).toHaveBeenCalledTimes(1));
    expect(f.state.snapshot().status).toBe("working");
    await expect(runtime.call(body)).rejects.toMatchObject({ status: 409, reason: "supplier_busy" });
    const submit = vi.spyOn(f.chain, "submitTx");
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ status: 409, reason: "supplier_busy" });
    expect(runtime.journal.hasEscrow(escrowText)).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(f.factory).toHaveBeenCalledTimes(1);
    finishFree();
    await expect(inFlight).resolves.toMatchObject({ manifest_hash: manifestHash, result: input });
    expect(f.state.snapshot().status).toBe("free");

    // A paid job holds the slot. The escrow refused above is still admissible.
    const finishPaid = heldExecution(f.session.execute);
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(f.session.execute).toHaveBeenCalledTimes(2));
    const busy = await request(app).post("/v1/paper2agent/call").send(body);
    expect([busy.status, busy.body]).toEqual([409, { reason: "supplier_busy", message: "supplier_busy" }]);
    expect(f.factory).toHaveBeenCalledTimes(2);
    finishPaid();
    await vi.waitFor(() => expect(job.status).toBe("done"));
    await vi.waitFor(() => expect(f.state.snapshot().status).toBe("free"));
  });

  it("returns 502 for a failed, schema-invalid, or late tool call without a transaction", async () => {
    const f = fixture();
    f.config.freeCalls = true;
    const runtime = await f.create();
    const submit = vi.spyOn(f.chain, "submitTx");
    const app = f.serve(runtime);
    f.session.execute.mockRejectedValueOnce(new Error("tool failed"));
    f.session.execute.mockImplementationOnce(async () => ({ value: "hello", extra: true }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await request(app).post("/v1/paper2agent/call").send(body);
      expect([reply.status, reply.body]).toEqual([502, { reason: "tool_execution_failed", message: "tool_execution_failed" }]);
      expect(f.state.snapshot().status).toBe("free");
    }
    f.session.execute.mockImplementationOnce(async () => {
      const late = performance.now() + manifest.limits.max_runtime_ms + 1;
      vi.spyOn(performance, "now").mockReturnValue(late);
      return input;
    });
    await expect(runtime.call(body)).rejects.toMatchObject({ status: 502, reason: "tool_execution_failed" });
    expect(f.session.close).toHaveBeenCalledTimes(3);
    expect(f.state.snapshot().status).toBe("free");
    expect(submit).not.toHaveBeenCalled();
    expect(readdirSync(f.config.journalDir)).toEqual([]);
  });

  it("keeps the slot until process cleanup finishes and goes offline if cleanup fails", async () => {
    const f = fixture();
    f.config.freeCalls = true;
    const runtime = await f.create();
    let finishCleanup!: () => void;
    f.session.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCleanup = resolve; }));
    f.session.execute.mockRejectedValueOnce(new Error("tool failed"));
    const pending = runtime.call(body);
    await vi.waitFor(() => expect(f.session.close).toHaveBeenCalled());
    expect(f.state.snapshot().status).toBe("working");
    finishCleanup();
    await expect(pending).rejects.toMatchObject({ status: 502, reason: "tool_execution_failed" });
    expect(f.state.snapshot().status).toBe("free");

    f.session.close.mockRejectedValue(new Error("process termination unknown"));
    await expect(runtime.call(body)).rejects.toMatchObject({ status: 502, reason: "tool_execution_failed" });
    expect(f.state.snapshot().status).toBe("offline");
    await expect(runtime.call(body)).rejects.toMatchObject({ status: 503, reason: "supplier_draining" });
  });

  it("refuses new calls while draining and close waits for an in-flight call", async () => {
    const f = fixture();
    f.config.freeCalls = true;
    const runtime = await f.create();
    const finish = heldExecution(f.session.execute);
    const inFlight = runtime.call(body);
    await vi.waitFor(() => expect(f.session.execute).toHaveBeenCalled());
    let stopped = false;
    const stopping = runtime.close().then(() => { stopped = true; });
    const refused = await request(f.serve(runtime)).post("/v1/paper2agent/call").send(body);
    expect([refused.status, refused.body]).toEqual([503, { reason: "supplier_draining", message: "supplier_draining" }]);
    await vi.waitFor(() => expect(f.session.close).toHaveBeenCalled());
    expect(stopped).toBe(false);
    finish();
    await stopping;
    await expect(inFlight).resolves.toMatchObject({ result: input });
    expect(f.state.snapshot().status).toBe("free");
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
});

describe("unpaid registration and publication", () => {
  it("writes discovered schemas and actual package hash with explicit limits", async () => {
    const f = fixture();
    const output = { ...f.config, manifestPath: join(f.directory, "registered.json") };
    const registered = await registerPaper2Agent({ config: output, name: manifest.name, limits: manifest.limits,
      sessionFactory: () => f.session });
    expect(registered.package_sha256).toBe(manifest.package_sha256);
    expect(registered.input_schema).toEqual(manifest.input_schema);
    expect(f.session.execute).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalled();
    const env = { NETWORK_ID: "0", CAPABILITY_KIND: "paper2agent", PAPER2AGENT_MANIFEST: output.manifestPath,
      SUPPLIER_PRIV_KEY_HEX: supplierKey.privateKeyHex, ADVERT_PRICE_LOVELACE: "2000000", ADVERT_ENDPOINT_URL: "http://localhost:8080" };
    const advert = parseCliArgs([], env);
    expect(advert.capabilityId).toBe(PAPER2AGENT_CAPABILITY_ID);
    expect(advert.model).toBe(paper2AgentModel(registered));
    expect(advert.maxOutputTokens).toBe(0);
    expect(advert.maxProcessingMs).toBe(manifest.limits.max_runtime_ms + PAPER2AGENT_DELIVERY_OVERHEAD_MS);
    expect(() => parseCliArgs(["--model", "buyer-selected-version"], env)).toThrow(/manifest/);
  });

  it("loads a tool supplier without any LLM or TTS backend and refuses command strings", () => {
    const f = fixture();
    const env = { ...buildSampleEnv(), OLLAMA_URL: undefined, CAPABILITY_KIND: "paper2agent",
      PAPER2AGENT_EXECUTABLE: f.config.executable, PAPER2AGENT_ARGV_JSON: "[]", PAPER2AGENT_CWD: f.config.cwd,
      PAPER2AGENT_PACKAGE: f.config.packagePath, PAPER2AGENT_MANIFEST: f.config.manifestPath,
      PAPER2AGENT_JOURNAL_DIR: f.config.journalDir };
    expect(loadConfig(env).paper2agent).toEqual({ ...f.config, freeCalls: false });
    expect(loadConfig({ ...env, PAPER2AGENT_FREE_CALLS: "1" }).paper2agent?.freeCalls).toBe(true);
    expect(loadConfig({ ...env, PAPER2AGENT_FREE_CALLS: "true" }).paper2agent?.freeCalls).toBe(false);
    expect(() => loadConfig({ ...env, PAPER2AGENT_ARGV_JSON: '"shell command"' })).toThrow(/ARGV/);
  });
});

describe("supplier Paper2Agent one acceptable job per buyer", () => {
  const seedEarlier = (f: ReturnType<typeof fixture>) => f.chain.seed({ ref: { txHash: "dd".repeat(32), index: 0 },
    address: loadBlueprint().escrowScriptAddress(0), lovelace: 4000000n, assets: {},
    datumHex: encodeEscrowDatum({ ...f.escrow, state: "Submitted", submitted_at: 0, result_receipt_hash: "ee".repeat(32) }),
    scriptRef: null });

  it("refuses before Claim and before the journal entry while the buyer's earlier job can be accepted", async () => {
    const f = fixture();
    seedEarlier(f);
    const runtime = await f.create();
    const submit = vi.spyOn(f.chain, "submitTx");
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ status: 409, reason: "supplier_busy" });
    expect(submit).not.toHaveBeenCalled();
    expect(f.state.snapshot().activeSessions).toBe(0);
    // No journal entry: the buyer can send the same escrow again later.
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ status: 409, reason: "supplier_busy" });
  });

  it("admits an exempt buyer", async () => {
    const f = fixture();
    seedEarlier(f);
    const runtime = await Paper2AgentRuntime.create({ ...f.deps, buyerGuardExemptPkhs: [f.escrow.buyer_pkh] });
    runtimes.push(runtime);
    await expect(runtime.admit(escrowText, body)).resolves.toMatchObject({ claimed_ref: expect.any(String) });
  });
});
