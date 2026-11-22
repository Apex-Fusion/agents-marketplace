/**
 * Supplier routes with the new escrow (Part 2 §6.1–§6.3, §9.6): the agent
 * check before Claim, the record as a reference input of Claim and Submit,
 * the 9-field receipt with agent_did, and GET /capability's agent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { decodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import type { IdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import type { Receipt, SignedReceipt } from "../../packages/shared/src/receipt/index.js";
import { verifyEscrowReceipt } from "../../packages/shared/src/receipt/verify.js";
import {
  AGENT_ID, IDENTITY, OTHER_AGENT_ID, identityAdvertUtxo, identityEscrowUtxo, identitySupplierKey, recordSubmissions,
  recordUtxo, supplierAgentRecord, testIdentity, withAgent,
} from "../fixtures/supplier-side/identity.js";
import { ESCROW_SCRIPT_ADDRESS } from "../fixtures/supplier-side/sample-escrow-state.js";
import {
  ADVERT_REF, advertOf, advertUtxoOf, escrowOf, routeOf, serve, stubUpstreams, type RouteKind,
} from "../fixtures/supplier-side/route-kinds.js";

const supplier = identitySupplierKey();
const ESCROW_REF = { txHash: "e5".repeat(32), index: 0 };
const ESCROW_HEADER = `${ESCROW_REF.txHash}#0`;
const RECORD_REF = { txHash: "7e".repeat(32), index: 0 };

function setup(kind: RouteKind, options: { agentId?: string; advert?: "legacy" | "identity"; record?: boolean;
  recordCapabilities?: string[]; escrow?: Partial<IdentityEscrowDatum> } = {}) {
  const cap = routeOf(kind);
  const chain = new MockChainProvider();
  chain.advanceSlot(1_000);
  if (options.advert === "identity") {
    chain.seed(identityAdvertUtxo({ ...advertOf(cap), agent_id: AGENT_ID } satisfies IdentityAdvertDatum, ADVERT_REF));
  } else {
    chain.seed(advertUtxoOf(cap));
  }
  if (options.record !== false) {
    chain.seed(recordUtxo(supplierAgentRecord(supplier, options.recordCapabilities ?? [cap.capability])));
  }
  const escrow = withAgent(escrowOf(cap), options.escrow);
  chain.seed(identityEscrowUtxo(escrow, ESCROW_REF));
  const bodies = recordSubmissions(chain);
  const agentId = "agentId" in options ? options.agentId : AGENT_ID;
  const { app, state, jobs, chatSessions } = serve(cap, chain, { agentId, identity: testIdentity(chain) });
  return { cap, chain, app, jobs, state, bodies, escrow, chatSessions };
}

beforeEach(() => stubUpstreams());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("new escrow of the supplier's own agent", () => {
  it.each(["chat", "tts", "ocr"] as const)("%s: Claim and Submit read the record, and the receipt has agent_did", async (kind) => {
    const { cap, app, jobs, bodies, state } = setup(kind);
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(202);
    const jobId = response.body.job_id as string;
    await vi.waitFor(() => expect(jobs.get(jobId)?.status).toBe("done"));

    const [claim, submit] = bodies;
    expect(claim).toMatchObject({ type: "claim", inputs: [ESCROW_REF], referenceInputs: [RECORD_REF],
      requiredSigners: [supplier.pubKeyHash], meta: { script_hash: IDENTITY.escrowScriptHash } });
    expect(decodeIdentityEscrowDatum(claim!.outputs[0]!.datumHex!)).toMatchObject({ state: "Claimed", agent_id: AGENT_ID });
    expect(submit).toMatchObject({ type: "submit", referenceInputs: [RECORD_REF] });

    const payload = jobs.get(jobId)!.responsePayload as unknown as { receipt: Receipt; receipt_signature: string };
    expect(payload.receipt.agent_did).toBe(`did:vector:${AGENT_ID}`);
    expect(Object.keys(payload.receipt)).toHaveLength(9);
    const signed: SignedReceipt = { receipt: payload.receipt, signature: payload.receipt_signature };
    expect(verifyEscrowReceipt(signed, supplier.pubKeyHex,
      { escrow_ref: ESCROW_HEADER, supplier_pkh: supplier.pubKeyHash, agent_id: AGENT_ID })).toBe(true);
    expect(decodeIdentityEscrowDatum(submit!.outputs[0]!.datumHex!)).toMatchObject({ state: "Submitted", agent_id: AGENT_ID });
    expect(state.snapshot().status).toBe("free");
  });

  it("chat-session: start Claims with the record, end Submits a 9-field receipt", async () => {
    const { cap, app, bodies } = setup("chat-session");
    const start = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(start.status).toBe(200);
    expect(bodies[0]).toMatchObject({ type: "claim", referenceInputs: [RECORD_REF] });
    const end = await request(app).post("/v1/chat/end").set("X-Escrow-Ref", ESCROW_HEADER).send({});
    expect(end.status).toBe(200);
    expect(end.body.receipt.agent_did).toBe(`did:vector:${AGENT_ID}`);
    expect(bodies[1]).toMatchObject({ type: "submit", referenceInputs: [RECORD_REF] });
  });

  it("takes the agent from the configured new advert when AGENT_ID is unset", async () => {
    const { cap, app, jobs } = setup("chat", { agentId: undefined, advert: "identity" });
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(response.body.job_id)?.status).toBe("done"));
  });
});

describe("refusals before Claim", () => {
  it.each(["chat", "tts", "ocr", "chat-session"] as const)("%s: refuses an escrow of another agent", async (kind) => {
    const { cap, app, bodies, state } = setup(kind, { escrow: { agent_id: OTHER_AGENT_ID } });
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(403);
    expect(response.body.reason).toBe("wrong_agent");
    expect(bodies).toHaveLength(0);
    expect(state.snapshot().status).toBe("free");
  });

  it("refuses a new escrow when the supplier has no agent", async () => {
    const { cap, app, bodies } = setup("chat", { agentId: undefined });
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("agent_not_configured");
    expect(bodies).toHaveLength(0);
  });

  it("refuses a new escrow above the value cap", async () => {
    const { cap, app, bodies } = setup("chat", { escrow: { payment_lovelace: 10_000_000_000n } });
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(409);
    expect(response.body.reason).toBe("escrow_not_claimable");
    expect(bodies).toHaveLength(0);
  });

  it("answers agent_not_eligible when the record lacks the capability, and frees the slot", async () => {
    const { cap, app, bodies, state } = setup("chat", { recordCapabilities: ["audio.synthesize.piper.v1"] });
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("agent_not_eligible");
    expect(response.body.message).toMatch(/capability not listed/);
    expect(bodies).toHaveLength(0);
    expect(state.snapshot().status).toBe("free");
  });

  it("answers agent_not_eligible when the agent has no record", async () => {
    const { cap, app, bodies } = setup("tts", { record: false });
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("agent_not_eligible");
    expect(bodies).toHaveLength(0);
  });

  it("keeps the legacy escrow path: no agent, an 8-field receipt", async () => {
    const { cap, app, chain, jobs, bodies } = setup("chat", { agentId: undefined });
    chain.seed({ ref: ESCROW_REF, address: ESCROW_SCRIPT_ADDRESS, lovelace: 4_000_000n, assets: {},
      datumHex: encodeEscrowDatum(escrowOf(cap)), scriptRef: null });
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(response.body.job_id)?.status).toBe("done"));
    const payload = jobs.get(response.body.job_id)!.responsePayload as unknown as { receipt: Record<string, unknown> };
    expect(Object.keys(payload.receipt)).toHaveLength(8);
    expect(bodies[0]?.referenceInputs).toBeUndefined();
  });
});

describe("GET /capability agent", () => {
  it("shows AGENT_ID and its DID with a legacy advert", async () => {
    const { app } = setup("chat");
    const response = await request(app).get("/capability");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ agent_id: AGENT_ID, agent_did: `did:vector:${AGENT_ID}`, supplier_pkh: supplier.pubKeyHash,
      pub_key_hex: supplier.pubKeyHex });
  });

  it("shows the new advert's agent, and null for a legacy-only supplier", async () => {
    expect((await request(setup("chat", { agentId: undefined, advert: "identity" }).app).get("/capability")).body)
      .toMatchObject({ agent_id: AGENT_ID, agent_did: `did:vector:${AGENT_ID}` });
    expect((await request(setup("chat", { agentId: undefined }).app).get("/capability")).body)
      .toMatchObject({ agent_id: null, agent_did: null });
  });

  it("refuses to serve when AGENT_ID and the new advert name different agents", async () => {
    const { app, cap } = setup("chat", { agentId: OTHER_AGENT_ID, advert: "identity" });
    const capabilityResponse = await request(app).get("/capability");
    expect(capabilityResponse.status).toBe(503);
    expect(capabilityResponse.body.reason).toBe("agent_mismatch");
    const response = await request(app).post(cap.path).set("X-Escrow-Ref", ESCROW_HEADER).send(cap.body);
    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("agent_mismatch");
  });
});
