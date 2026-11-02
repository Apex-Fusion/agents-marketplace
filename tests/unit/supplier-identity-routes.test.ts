/**
 * Supplier routes with the new escrow (Part 2 §6.1–§6.3, §9.6): the agent
 * check before Claim, the record as a reference input of Claim and Submit,
 * the 9-field receipt with agent_did, and GET /capability's agent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import type { PlutusAddress } from "../../packages/shared/src/cbor/address.js";
import { decodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import type { IdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { verifyEscrowReceipt } from "../../packages/shared/src/receipt/verify.js";
import { chatSessionPromptHash } from "../../packages/shared/src/tx/escrow/postChatEscrow.js";
import { ocrPromptHash } from "../../packages/shared/src/tx/escrow/postOcrEscrow.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { ChatSessionStore } from "../../supplier/src/chatSession.js";
import { createApp } from "../../supplier/src/server.js";
import type { SupplierConfig } from "../../supplier/src/config.js";
import {
  buildSampleConfig, buildSampleOcrConfig, buildSampleTtsConfig, SAMPLE_ADVERT_INDEX, SAMPLE_ADVERT_TX_HASH,
} from "../fixtures/supplier-side/sample-config.js";
import {
  BUYER_PKH, POSTED_AT, PROMPT_HASH, REQUEST_SPEC_HASH, TEST_MAX_OUTPUT_TOKENS, TEST_MODEL, TEST_RESPONSE_INPUT,
} from "../fixtures/supplier-side/sample-escrow-state.js";
import {
  AGENT_ID, IDENTITY, OTHER_AGENT_ID, identityAdvertUtxo, identityEscrowUtxo, identitySupplierKey, recordSubmissions,
  recordUtxo, supplierAgentRecord, testIdentity,
} from "../fixtures/supplier-side/identity.js";

const supplier = identitySupplierKey();
const ADVERT_REF = { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX };
const ESCROW_REF = { txHash: "e5".repeat(32), index: 0 };
const ESCROW_HEADER = `${ESCROW_REF.txHash}#0`;
const RECORD_REF = { txHash: "7e".repeat(32), index: 0 };
const REFUND_ADDRESS: PlutusAddress = { paymentCredential: { type: "VerificationKey", hash: BUYER_PKH }, stakeCredential: null };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

type Kind = "chat" | "tts" | "ocr" | "chat-session";

interface Capability {
  config: SupplierConfig;
  capability: string;
  model: string;
  maxOutputTokens: number;
  path: string;
  body: Record<string, unknown>;
  promptHash: string;
}

const TTS_BODY = { text: "Hello world.", voice: "nova", format: "mp3", speed: 1 };
const OCR_BODY = { image_b64: "aGVsbG8=", mime: "image/png", output_format: "markdown" };

function capability(kind: Kind): Capability {
  switch (kind) {
    case "chat":
      return { config: buildSampleConfig(), capability: "llm.text.generate.v1", model: TEST_MODEL,
        maxOutputTokens: TEST_MAX_OUTPUT_TOKENS, path: "/v1/responses",
        body: { model: TEST_MODEL, input: TEST_RESPONSE_INPUT, max_output_tokens: TEST_MAX_OUTPUT_TOKENS }, promptHash: PROMPT_HASH };
    case "tts":
      return { config: buildSampleTtsConfig(), capability: "audio.synthesize.piper.v1", model: "en_US-lessac-medium",
        maxOutputTokens: 0, path: "/v1/audio/synthesize", body: TTS_BODY, promptHash: sha256(canonicalize(TTS_BODY)) };
    case "ocr":
      return { config: buildSampleOcrConfig(), capability: "ocr.page.extract.chandra-ocr-2.v1", model: "datalab-to/chandra-ocr-2",
        maxOutputTokens: 4096, path: "/v1/ocr/extract", body: OCR_BODY, promptHash: ocrPromptHash(OCR_BODY) };
    case "chat-session":
      return { config: { ...buildSampleConfig(), capabilityKind: "chat-session", llmBackend: "openai", ollamaUrl: "",
        openaiBaseUrl: "http://openai.fake" }, capability: "llm.chat.v1", model: "gpt-test", maxOutputTokens: 1024,
        path: "/v1/chat/start", body: { session_nonce: "nonce-1" }, promptHash: chatSessionPromptHash({ session_nonce: "nonce-1" }) };
  }
}

function legacyAdvert(cap: Capability): AdvertDatum {
  return {
    supplier_pkh: supplier.pubKeyHash, capability_id: cap.capability, model: cap.model, max_output_tokens: cap.maxOutputTokens,
    max_processing_ms: 60_000, price_lovelace: 2_000_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example", detail_uri: "", detail_hash: "a".repeat(64), advertised_at: POSTED_AT, status: "Active",
  };
}

function newEscrow(cap: Capability, changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
  return {
    buyer_pkh: BUYER_PKH, supplier_pkh: supplier.pubKeyHash, advert_ref: ADVERT_REF, capability_id: cap.capability,
    request_spec_hash: sha256(canonicalize({ capability_id: cap.capability, max_output_tokens: cap.maxOutputTokens, model: cap.model })),
    prompt_hash: cap.promptHash, payment_lovelace: 2_000_000n, buyer_bond_lovelace: 1_000_000n, supplier_bond_lovelace: 1_000_000n,
    deliver_by: POSTED_AT + 90_000, posted_at: POSTED_AT, submitted_at: null, result_receipt_hash: null, state: "Open",
    agent_id: AGENT_ID, refund: { address: REFUND_ADDRESS, datum: null }, ...changes,
  };
}

function setup(kind: Kind, options: { agentId?: string; advert?: "legacy" | "identity"; record?: boolean;
  recordCapabilities?: string[]; escrow?: Partial<IdentityEscrowDatum> } = {}) {
  const cap = capability(kind);
  const chain = new MockChainProvider();
  chain.advanceSlot(1_000);
  const advert = legacyAdvert(cap);
  if (options.advert === "identity") {
    chain.seed(identityAdvertUtxo({ ...advert, agent_id: AGENT_ID } satisfies IdentityAdvertDatum, ADVERT_REF));
  } else {
    chain.seed({ ref: ADVERT_REF, address: "addr_test1wfakeadvertaddress", lovelace: 2_000_000n, assets: {},
      datumHex: encodeAdvertDatum(advert), scriptRef: null });
  }
  if (options.record !== false) {
    chain.seed(recordUtxo(supplierAgentRecord(supplier, options.recordCapabilities ?? [cap.capability])));
  }
  const escrow = newEscrow(cap, options.escrow);
  chain.seed(identityEscrowUtxo(escrow, ESCROW_REF));
  const bodies = recordSubmissions(chain);
  const jobs = new JobStore();
  const state = new SupplierState();
  const chatSessions = new ChatSessionStore();
  const config: SupplierConfig = { ...cap.config, advertRef: ADVERT_REF,
    agentId: "agentId" in options ? options.agentId : AGENT_ID };
  const app = createApp({ chain, state, config, supplierKey: supplier, jobs, chatSessions, identity: testIdentity(chain) });
  return { cap, chain, app, jobs, state, bodies, escrow, chatSessions };
}

function stubUpstreams(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const target = String(url);
    if (target.includes("/api/chat")) {
      return new Response(JSON.stringify({ message: { role: "assistant", content: "I am a test supplier." }, done: true,
        done_reason: "stop", prompt_eval_count: 12, eval_count: 7, total_duration: 1_000_000 }), { status: 200 });
    }
    if (target.includes("/v1/audio/speech")) {
      return new Response(new Uint8Array(256).fill(7), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    if (target.includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "# page" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected upstream ${target}`);
  }));
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

    const payload = jobs.get(jobId)!.responsePayload as unknown as { receipt: Record<string, unknown>; receipt_signature: string };
    expect(payload.receipt.agent_did).toBe(`did:vector:${AGENT_ID}`);
    expect(Object.keys(payload.receipt)).toHaveLength(9);
    const signed = { receipt: payload.receipt, signature: payload.receipt_signature } as Parameters<typeof verifyEscrowReceipt>[0];
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
    const legacy = { ...newEscrow(cap) } as Partial<IdentityEscrowDatum>;
    delete legacy.agent_id;
    delete legacy.refund;
    chain.seed({ ref: ESCROW_REF, address: "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6",
      lovelace: 4_000_000n, assets: {}, datumHex: encodeEscrowDatum(legacy as IdentityEscrowDatum), scriptRef: null });
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
