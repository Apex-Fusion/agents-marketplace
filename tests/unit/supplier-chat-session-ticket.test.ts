/**
 * supplier-chat-session-ticket.test.ts — entry-ticket settle mode + N slots.
 *
 * Ticket mode (CHAT_SETTLE_MODE=ticket): /v1/chat/start verifies the Open
 * escrow but never Claims (zero chain txs), arms no hard-cap timer, and
 * /v1/chat/end returns a receipt-less {status:"ended"}. A used escrow ref can
 * never open a second session (records are retained). MAX_CHAT_SESSIONS
 * admits N concurrent sessions and the N+1th start gets 409 supplier_busy.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { createHash } from "crypto";
import type { Application } from "express";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { chatSessionPromptHash } from "../../packages/shared/src/tx/escrow/postChatEscrow.js";
import type { SupplierConfig } from "../../supplier/src/config.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { ChatSessionStore } from "../../supplier/src/chatSession.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig, SAMPLE_ADVERT_TX_HASH, SAMPLE_ADVERT_INDEX } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey, SUPPLIER_PKH } from "../fixtures/supplier-side/wallet-keys.js";

const MODEL = "kimi";
const MAX_TOKENS = 512;
const CAPABILITY = "llm.chat.v1";
const NONCE = "nonce-abc";
const POSTED_AT = 1_745_500_000_000;
const DELIVER_BY = POSTED_AT + 90_000;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function advertDatum(): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER_PKH,
    capability_id: CAPABILITY,
    model: MODEL,
    max_output_tokens: MAX_TOKENS,
    max_processing_ms: 1_800_000,
    price_lovelace: 200_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "http://supplier.example:8080",
    detail_uri: "ipfs://QmTest",
    detail_hash: "a".repeat(64),
    advertised_at: POSTED_AT,
    status: "Active",
  };
}

function escrowDatum(nonce: string): EscrowDatum {
  return {
    buyer_pkh: "1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    supplier_pkh: SUPPLIER_PKH,
    advert_ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
    capability_id: CAPABILITY,
    request_spec_hash: sha256Hex(canonicalize({ capability_id: CAPABILITY, max_output_tokens: MAX_TOKENS, model: MODEL })),
    prompt_hash: chatSessionPromptHash({ session_nonce: nonce }),
    payment_lovelace: 200_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: DELIVER_BY,
    posted_at: POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };
}

interface Harness {
  app: Application;
  chain: MockChainProvider;
  state: SupplierState;
  chatSessions: ChatSessionStore;
  seedEscrow: (txHashChar: string, nonce?: string) => string;
}

function makeHarness(overrides?: Partial<SupplierConfig>): Harness {
  const chain = new MockChainProvider();
  chain.seed({
    ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
    address: "addr_test1wfakeadvertaddress",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(advertDatum()),
    scriptRef: null,
  });
  const config: SupplierConfig = {
    ...buildSampleConfig(),
    capabilityKind: "chat-session",
    llmBackend: "openai",
    ollamaUrl: "",
    openaiBaseUrl: "http://up",
    openaiApiKey: "",
    openaiTimeoutMs: 5_000,
    openaiMaxTokens: 0,
    openaiReasoningDisabled: false,
    chatIdleTimeoutMs: 60_000,
    chatSettleMode: "ticket",
    maxChatSessions: 1,
    ...overrides,
  } as SupplierConfig;
  const state = new SupplierState(config.maxChatSessions);
  const chatSessions = new ChatSessionStore();
  const app = createApp({
    chain,
    state,
    config,
    supplierKey: buildSupplierWalletKey(),
    jobs: new JobStore(),
    chatSessions,
  });
  const seedEscrow = (txHashChar: string, nonce = NONCE): string => {
    const txHash = txHashChar.repeat(64);
    chain.seed({
      ref: { txHash, index: 0 },
      address: "addr_test1wfakeescrowaddress",
      lovelace: 2_200_000n,
      assets: {},
      datumHex: encodeEscrowDatum(escrowDatum(nonce)),
      scriptRef: null,
    });
    return `${txHash}#0`;
  };
  return { app, chain, state, chatSessions, seedEscrow };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat-session ticket mode — /v1/chat/start", () => {
  it("verifies the escrow, skips Claim, and arms no hard-cap timer", async () => {
    const h = makeHarness();
    const submitSpy = vi.spyOn(h.chain, "submitTx");
    const ref = h.seedEscrow("e");

    const res = await request(h.app)
      .post("/v1/chat/start")
      .set("X-Escrow-Ref", ref)
      .send({ session_nonce: NONCE });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ticket", escrow_ref: ref, settle_mode: "ticket" });
    expect(submitSpy).not.toHaveBeenCalled(); // zero chain txs

    const record = h.chatSessions.get(ref)!;
    expect(record.settleMode).toBe("ticket");
    expect(record.claimedRef).toBeUndefined();
    expect(record.idleTimer).toBeDefined();
    expect(record.hardCapTimer).toBeUndefined();
    expect(h.state.snapshot().activeSessions).toBe(1);
  });

  it("still rejects a foreign-supplier escrow", async () => {
    const h = makeHarness();
    const txHash = "c".repeat(64);
    h.chain.seed({
      ref: { txHash, index: 0 },
      address: "addr_test1wfakeescrowaddress",
      lovelace: 2_200_000n,
      assets: {},
      datumHex: encodeEscrowDatum({ ...escrowDatum(NONCE), supplier_pkh: "9".repeat(56) }),
      scriptRef: null,
    });
    const res = await request(h.app)
      .post("/v1/chat/start")
      .set("X-Escrow-Ref", `${txHash}#0`)
      .send({ session_nonce: NONCE });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("wrong_supplier");
  });

  it("rejects reusing an escrow ref while the session is active AND after it ended", async () => {
    const h = makeHarness();
    const ref = h.seedEscrow("e");

    const first = await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", ref).send({ session_nonce: NONCE });
    expect(first.status).toBe(200);

    const whileActive = await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", ref).send({ session_nonce: NONCE });
    expect(whileActive.status).toBe(409);
    expect(whileActive.body.reason).toBe("session_exists");

    await request(h.app).post("/v1/chat/end").set("X-Escrow-Ref", ref).send({});
    // The escrow is still Open on-chain (never Claimed) — the retained record
    // is the only thing standing between a used ticket and a free session.
    const afterEnd = await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", ref).send({ session_nonce: NONCE });
    expect(afterEnd.status).toBe(409);
    expect(afterEnd.body.reason).toBe("session_exists");
  });
});

describe("chat-session ticket mode — /v1/chat/end", () => {
  it("ends without a receipt, frees the slot, and is idempotent", async () => {
    const h = makeHarness();
    const submitSpy = vi.spyOn(h.chain, "submitTx");
    const ref = h.seedEscrow("e");
    await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", ref).send({ session_nonce: NONCE });

    const end = await request(h.app).post("/v1/chat/end").set("X-Escrow-Ref", ref).send({});
    expect(end.status).toBe(200);
    expect(end.body).toEqual({ status: "ended", escrow_ref: ref, settle_mode: "ticket" });
    expect(end.body.receipt).toBeUndefined();
    expect(submitSpy).not.toHaveBeenCalled();
    expect(h.state.snapshot().activeSessions).toBe(0);

    const again = await request(h.app).post("/v1/chat/end").set("X-Escrow-Ref", ref).send({});
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("ended");
  });
});

describe("chat-session slots — MAX_CHAT_SESSIONS", () => {
  it("admits N concurrent sessions and 409s the N+1th", async () => {
    const h = makeHarness({ maxChatSessions: 2 });
    // NB: "b".repeat(64) is the advert tx hash — do not reuse it for escrows.
    const refA = h.seedEscrow("d");
    const refB = h.seedEscrow("e");
    const refC = h.seedEscrow("f");

    const a = await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", refA).send({ session_nonce: NONCE });
    const b = await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", refB).send({ session_nonce: NONCE });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const status = await request(h.app).get("/status");
    expect(status.body.status).toBe("working");
    expect(status.body.active_sessions).toBe(2);
    expect(status.body.max_sessions).toBe(2);

    const c = await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", refC).send({ session_nonce: NONCE });
    expect(c.status).toBe(409);
    expect(c.body.reason).toBe("supplier_busy");

    // Ending one session readmits the third.
    await request(h.app).post("/v1/chat/end").set("X-Escrow-Ref", refA).send({});
    const retry = await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", refC).send({ session_nonce: NONCE });
    expect(retry.status).toBe(200);
  });

  it("serves concurrent message turns on distinct sessions", async () => {
    const h = makeHarness({ maxChatSessions: 2 });
    const refA = h.seedEscrow("d");
    const refB = h.seedEscrow("e");
    await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", refA).send({ session_nonce: NONCE });
    await request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", refB).send({ session_nonce: NONCE });

    const stream = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })),
    );

    const [ta, tb] = await Promise.all([
      request(h.app).post("/v1/chat/message").set("X-Escrow-Ref", refA).send({ messages: [{ role: "user", content: "hi" }] }),
      request(h.app).post("/v1/chat/message").set("X-Escrow-Ref", refB).send({ messages: [{ role: "user", content: "yo" }] }),
    ]);
    expect(ta.text).toContain('"type":"done"');
    expect(tb.text).toContain('"type":"done"');
    expect(h.chatSessions.get(refA)!.transcript).toHaveLength(2);
    expect(h.chatSessions.get(refB)!.transcript).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
