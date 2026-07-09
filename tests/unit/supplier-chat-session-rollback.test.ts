/**
 * supplier-chat-session-rollback.test.ts — failed-turn transcript rollback.
 *
 * The chat-session message handler appends the incoming delta BEFORE calling
 * the LLM backend; the gateway mirror only appends after a successful turn.
 * On backend failure the supplier must truncate the delta back out, so a
 * retried turn doesn't duplicate messages and both transcripts stay
 * hash-identical for the receipt.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import type { SupplierConfig } from "../../supplier/src/config.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { ChatSessionStore } from "../../supplier/src/chatSession.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ESCROW_REF = `${"e".repeat(64)}#0`;

function chatSessionConfig(): SupplierConfig {
  return {
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
  } as SupplierConfig;
}

function makeAppWithSession() {
  const chatSessions = new ChatSessionStore();
  const record = chatSessions.create({
    escrowRef: ESCROW_REF,
    claimedRef: { txHash: "c".repeat(64), index: 0 },
    advert: { model: "kimi" } as AdvertDatum,
    escrowDatum: {} as EscrowDatum,
  });
  const app = createApp({
    chain: new MockChainProvider(),
    state: new SupplierState(),
    config: chatSessionConfig(),
    supplierKey: buildSupplierWalletKey(),
    jobs: new JobStore(),
    chatSessions,
  });
  return { app, chatSessions, record };
}

function sseBody(frames: unknown[]): string {
  return frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
}

const OK_STREAM = sseBody([
  { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  "[DONE]",
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatSessionStore.truncateTranscript", () => {
  it("rolls an appended delta back and no-ops on stale targets", () => {
    const store = new ChatSessionStore();
    store.create({
      escrowRef: ESCROW_REF,
      claimedRef: { txHash: "c".repeat(64), index: 0 },
      advert: { model: "kimi" } as AdvertDatum,
      escrowDatum: {} as EscrowDatum,
    });
    store.appendMessages(ESCROW_REF, [{ role: "user", content: "hi" }]);
    store.truncateTranscript(ESCROW_REF, 0);
    expect(store.get(ESCROW_REF)!.transcript).toEqual([]);

    store.appendMessages(ESCROW_REF, [{ role: "user", content: "hi" }]);
    store.truncateTranscript(ESCROW_REF, 5); // target beyond current length
    store.truncateTranscript(ESCROW_REF, -1); // nonsense target
    store.truncateTranscript("missing", 0); // unknown session
    expect(store.get(ESCROW_REF)!.transcript).toHaveLength(1);
  });
});

describe("POST /v1/chat/message — failed-turn rollback", () => {
  it("truncates the delta on backend failure, then a retry appends exactly once", async () => {
    const { app, record } = makeAppWithSession();
    const delta = [{ role: "user", content: "hi" }];

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const failed = await request(app)
      .post("/v1/chat/message")
      .set("X-Escrow-Ref", ESCROW_REF)
      .send({ messages: delta });
    expect(failed.text).toContain('"type":"error"');
    // The failed delta was rolled back — nothing to duplicate on retry.
    expect(record.transcript).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(OK_STREAM, { status: 200, headers: { "content-type": "text/event-stream" } })),
    );
    const ok = await request(app)
      .post("/v1/chat/message")
      .set("X-Escrow-Ref", ESCROW_REF)
      .send({ messages: delta });
    expect(ok.text).toContain('"type":"done"');
    expect(record.transcript).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });
});
