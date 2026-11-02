/**
 * Paper2Agent runtime with a new advert (Part 2 §6.1–§6.3, §9.6): the advert
 * decides the escrow layout, the escrow must name the advert's agent, Claim
 * and Submit read the agent's record, and the receipt carries agent_did.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/client";
import { MockChainProvider } from "@marketplace/shared/chain";
import { encodeEscrowDatum, type IdentityAdvertDatum, type IdentityEscrowDatum } from "@marketplace/shared/cbor";
import { loadBlueprint, NETWORK_BUFFER_MS } from "@marketplace/shared/tx";
import { parsePaper2AgentManifest, paper2AgentManifestHash, paper2AgentModel, paper2AgentRequestHash,
  paper2AgentRequestSpecHash, verifyPaper2AgentReceipt, PAPER2AGENT_CAPABILITY_ID,
  PAPER2AGENT_SUPPLIER_OVERHEAD_MS } from "@marketplace/shared/paper2agent";
import { SupplierState } from "../../supplier/src/state.js";
import { createApp } from "../../supplier/src/server.js";
import { deriveSupplierKey } from "../../supplier/src/paper2agent/identity.js";
import { Paper2AgentRuntime } from "../../supplier/src/paper2agent/runtime.js";
import type { Paper2AgentConfig } from "../../supplier/src/config.js";
import type { ToolSession } from "../../supplier/src/paper2agent/local.js";
import { supplierIdentity } from "../../supplier/src/identity/agent.js";
import { buildSampleConfig } from "../fixtures/supplier-side/sample-config.js";
import {
  AGENT_ID, IDENTITY, OTHER_AGENT_ID, identityAdvertUtxo, identityEscrowUtxo, recordSubmissions, recordUtxo,
  supplierAgentRecord, testIdentity,
} from "../fixtures/supplier-side/identity.js";

const directories: string[] = [];
const runtimes: Paper2AgentRuntime[] = [];
const schema = { type: "object" as const, properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const preparedBytes = "reviewed local package";
const supplierKey = deriveSupplierKey("11".repeat(32), 0);
const advertRef = { txHash: "bb".repeat(32), index: 0 };
const escrowRef = { txHash: "cc".repeat(32), index: 0 };
const escrowText = `${escrowRef.txHash}#0`;
const recordRef = { txHash: "7e".repeat(32), index: 0 };
const manifest = parsePaper2AgentManifest({ schema_version: 1, name: "echo_record", description: "Test-only tool",
  package_sha256: createHash("sha256").update(preparedBytes).digest("hex"), input_schema: schema, output_schema: schema,
  limits: { max_input_bytes: 4096, max_output_bytes: 4096, max_runtime_ms: 1000 } });
const manifestHash = paper2AgentManifestHash(manifest);
const input = { value: "hello" };
const body = { manifest_hash: manifestHash, input };

function fixture(options: { agentId?: string; capabilities?: string[] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "supplier-p2a-identity-"));
  directories.push(directory);
  const config: Paper2AgentConfig = { executable: process.execPath, argv: [], cwd: directory,
    packagePath: join(directory, "package.bin"), manifestPath: join(directory, "manifest.json"), journalDir: join(directory, "journal") };
  writeFileSync(config.packagePath, preparedBytes);
  writeFileSync(config.manifestPath, JSON.stringify(manifest));
  const chain = new MockChainProvider();
  // Mock time is slot × 1000 ms: the record window starts 60 s before the tip.
  chain.advanceSlot(1_000);
  const now = 1_000_000;
  const state = new SupplierState();
  const advert: IdentityAdvertDatum = { supplier_pkh: supplierKey.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID,
    model: paper2AgentModel(manifest), max_output_tokens: 0,
    max_processing_ms: manifest.limits.max_runtime_ms + PAPER2AGENT_SUPPLIER_OVERHEAD_MS,
    price_lovelace: 2000000n, buyer_bond_lovelace: 1000000n, supplier_bond_lovelace: 1000000n,
    endpoint_url: "http://localhost:8080", detail_uri: "", detail_hash: manifestHash, advertised_at: 0, status: "Active",
    agent_id: AGENT_ID };
  const escrow: IdentityEscrowDatum = { buyer_pkh: "44".repeat(28), supplier_pkh: supplierKey.pubKeyHash,
    advert_ref: advertRef, capability_id: advert.capability_id, request_spec_hash: paper2AgentRequestSpecHash(manifest),
    prompt_hash: paper2AgentRequestHash(manifestHash, input), payment_lovelace: advert.price_lovelace,
    buyer_bond_lovelace: advert.buyer_bond_lovelace, supplier_bond_lovelace: advert.supplier_bond_lovelace,
    posted_at: now, deliver_by: now + advert.max_processing_ms + NETWORK_BUFFER_MS,
    submitted_at: null, result_receipt_hash: null, state: "Open", agent_id: AGENT_ID,
    refund: { address: { paymentCredential: { type: "VerificationKey", hash: "44".repeat(28) }, stakeCredential: null }, datum: null } };
  const seedAdvert = () => chain.seed(identityAdvertUtxo(advert, advertRef));
  const seedEscrow = () => chain.seed(identityEscrowUtxo(escrow, escrowRef));
  seedAdvert();
  seedEscrow();
  chain.seed(recordUtxo(supplierAgentRecord(supplierKey, options.capabilities ?? [PAPER2AGENT_CAPABILITY_ID])));
  const bodies = recordSubmissions(chain);
  const tools: Tool[] = [{ name: manifest.name, inputSchema: schema, outputSchema: schema }];
  const session = { discover: vi.fn(async () => tools), execute: vi.fn(async () => input), close: vi.fn(async () => undefined) } satisfies ToolSession;
  const factory = vi.fn(() => session);
  const deps = { chain, state, supplierKey, networkId: 0 as const, advertRef, config, sessionFactory: factory,
    identity: testIdentity(chain), agentId: options.agentId };
  const create = async () => {
    const runtime = await Paper2AgentRuntime.create(deps);
    runtimes.push(runtime);
    return runtime;
  };
  const serve = (runtime: Paper2AgentRuntime) => createApp({ ...deps, config: { ...buildSampleConfig(),
    capabilityKind: "paper2agent", advertRef, paper2agent: config, agentId: options.agentId }, paper2agent: runtime });
  return { chain, state, advert, escrow, seedAdvert, seedEscrow, session, factory, deps, create, serve, bodies };
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Paper2Agent runtime with a new advert", () => {
  it("Claims and Submits with the agent's record and signs a 9-field receipt", async () => {
    const f = fixture();
    const runtime = await f.create();
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("done"));
    expect(f.bodies[0]).toMatchObject({ type: "claim", referenceInputs: [recordRef], meta: { script_hash: IDENTITY.escrowScriptHash } });
    expect(f.bodies[1]).toMatchObject({ type: "submit", referenceInputs: [recordRef] });
    expect(job.receipt?.agent_did).toBe(`did:vector:${AGENT_ID}`);
    verifyPaper2AgentReceipt({ manifest, input, result: job.result!, receipt: job.receipt!, signature: job.receipt_signature!,
      publicKeyHex: job.pub_key_hex!, supplierPkh: supplierKey.pubKeyHash, escrowRef: escrowText, agentId: AGENT_ID });
    expect(f.state.snapshot().status).toBe("free");
  });

  it("refuses a new escrow of another agent or above the value cap before Claim", async () => {
    for (const mutation of [
      (escrow: IdentityEscrowDatum) => { escrow.agent_id = OTHER_AGENT_ID; },
      (escrow: IdentityEscrowDatum) => { escrow.payment_lovelace = 10_000_000_000n; },
    ]) {
      const f = fixture();
      mutation(f.escrow);
      f.advert.price_lovelace = f.escrow.payment_lovelace;
      f.seedAdvert();
      f.seedEscrow();
      const runtime = await f.create();
      await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ status: 409, reason: "escrow_commitment_or_economics_mismatch" });
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.bodies).toHaveLength(0);
    }
  });

  it("refuses a legacy escrow for a new advert and a new escrow at the legacy address", async () => {
    const legacy = fixture();
    const { agent_id: _agent, refund: _refund, ...legacyDatum } = legacy.escrow;
    legacy.chain.seed({ ref: escrowRef, address: loadBlueprint().escrowScriptAddress(0), lovelace: 4000000n, assets: {},
      datumHex: encodeEscrowDatum(legacyDatum), scriptRef: null });
    const runtime = await legacy.create();
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ status: 404, reason: "escrow_unavailable" });

    const misplaced = fixture();
    misplaced.chain.seed({ ...identityEscrowUtxo(misplaced.escrow, escrowRef), address: loadBlueprint().escrowScriptAddress(0) });
    const second = await misplaced.create();
    await expect(second.admit(escrowText, body)).rejects.toMatchObject({ status: 404, reason: "escrow_unavailable" });
    expect(legacy.factory).not.toHaveBeenCalled();
    expect(misplaced.factory).not.toHaveBeenCalled();
  });

  it("refuses before the journal when the record does not list the capability, and admits after the record changes", async () => {
    const f = fixture({ capabilities: ["llm.text.generate.v1"] });
    const runtime = await f.create();
    await expect(runtime.admit(escrowText, body)).rejects.toMatchObject({ status: 503, reason: "agent_not_eligible" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.bodies).toHaveLength(0);
    expect(runtime.journal.hasEscrow(escrowText)).toBe(false);
    expect(f.state.snapshot().status).toBe("free");

    // The controller updates the record: the new datum lists the capability.
    f.chain.seed(recordUtxo(supplierAgentRecord(supplierKey, [PAPER2AGENT_CAPABILITY_ID]), { ref: recordRef }));
    const job = await runtime.admit(escrowText, body);
    await vi.waitFor(() => expect(job.status).toBe("done"));
  });

  it("refuses a new advert of another agent than AGENT_ID, and a new advert without the identity hash", async () => {
    const f = fixture({ agentId: OTHER_AGENT_ID });
    await expect(f.create()).rejects.toMatchObject({ status: 503, reason: "configured_advert_mismatch" });

    const unconfigured = fixture();
    vi.stubEnv("IDENTITY_POLICY_ID", "");
    await expect(Paper2AgentRuntime.create({ ...unconfigured.deps, identity: supplierIdentity(unconfigured.chain, 0) }))
      .rejects.toMatchObject({ status: 503, reason: "advert_unavailable" });
  });

  it("shows the advert's agent on GET /capability", async () => {
    const f = fixture({ agentId: AGENT_ID });
    const runtime = await f.create();
    const response = await request(f.serve(runtime)).get("/capability");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ capability_id: PAPER2AGENT_CAPABILITY_ID, agent_id: AGENT_ID,
      agent_did: `did:vector:${AGENT_ID}`, supplier_pkh: supplierKey.pubKeyHash });
  });
});
