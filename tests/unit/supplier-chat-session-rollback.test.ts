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

function makeAppWithSession(configOverrides?: Partial<SupplierConfig>) {
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
    config: { ...chatSessionConfig(), ...configOverrides } as SupplierConfig,
    supplierKey: buildSupplierWalletKey(),
    jobs: new JobStore(),
    chatSessions,
  });
  return { app, chatSessions, record };
}

function sseBody(frames: Array<Record<string, unknown>>): string {
  return frames
    .map((frame) => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");
}

const ASSISTANT_OUTPUT = [{
  type: "message" as const,
  id: "msg_1",
  role: "assistant" as const,
  status: "completed",
  content: [{ type: "output_text" as const, text: "Hello", annotations: [] }],
}];

const OK_RESPONSE = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "kimi",
  status: "completed",
  output: ASSISTANT_OUTPUT,
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  error: null,
  incomplete_details: null,
};

const OK_STREAM = sseBody([
  { type: "response.output_text.delta", sequence_number: 1, delta: "Hello" },
  { type: "response.completed", sequence_number: 2, response: OK_RESPONSE },
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
    store.appendInput(ESCROW_REF, [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    }]);
    store.truncateTranscript(ESCROW_REF, 0);
    expect(store.get(ESCROW_REF)!.transcript).toEqual([]);

    store.appendInput(ESCROW_REF, [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    }]);
    store.truncateTranscript(ESCROW_REF, 5); // target beyond current length
    store.truncateTranscript(ESCROW_REF, -1); // nonsense target
    store.truncateTranscript("missing", 0); // unknown session
    expect(store.get(ESCROW_REF)!.transcript).toHaveLength(1);
  });
});

describe("POST /v1/chat/message — stateful upstream mode (OPENAI_SESSION_PASSTHROUGH)", () => {
  it("sends delta-only messages + user=escrowRef + overridden model; transcript still accumulates fully", async () => {
    const { app, record } = makeAppWithSession({
      openaiSessionPassthrough: true,
      openaiModelOverride: "openclaw",
    });
    const okFetch = () =>
      vi.fn().mockResolvedValue(new Response(OK_STREAM, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const fetch1 = okFetch();
    vi.stubGlobal("fetch", fetch1);
    await request(app).post("/v1/chat/message").set("X-Escrow-Ref", ESCROW_REF).send({
      input: [{ role: "user", content: "first" }],
    });

    const fetch2 = okFetch();
    vi.stubGlobal("fetch", fetch2);
    await request(app).post("/v1/chat/message").set("X-Escrow-Ref", ESCROW_REF).send({
      input: [{ role: "user", content: "second" }],
    });

    // Turn 2 upstream call: only the new delta, keyed to the escrow ref, with
    // the fixed upstream model — NOT the accumulated transcript / advert model.
    const body2 = JSON.parse(fetch2.mock.calls[0][1].body as string);
    expect(body2.input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "second" }],
    }]);
    expect(body2.user).toBe(ESCROW_REF);
    expect(body2.model).toBe("openclaw");

    // The local transcript (receipt source of truth) still has every turn.
    expect(record.transcript).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first" }],
      },
      ...ASSISTANT_OUTPUT,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "second" }],
      },
      ...ASSISTANT_OUTPUT,
    ]);
  });

  it("keeps full-transcript + advert-model behavior when passthrough is off", async () => {
    const { app } = makeAppWithSession();
    const fetch1 = vi
      .fn()
      .mockResolvedValue(new Response(OK_STREAM, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch1);
    await request(app).post("/v1/chat/message").set("X-Escrow-Ref", ESCROW_REF).send({
      input: [{ role: "user", content: "first" }],
    });

    const body = JSON.parse(fetch1.mock.calls[0][1].body as string);
    expect(body.input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "first" }],
    }]);
    expect("user" in body).toBe(false);
    expect(body.model).toBe("kimi");
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
      .send({ input: delta });
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
      .send({ input: delta });
    expect(ok.text).toContain('"type":"response.completed"');
    expect(record.transcript).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      ...ASSISTANT_OUTPUT,
    ]);
  });
});

describe("POST /v1/chat/message — reasoning policy", () => {
  it("rejects a conflicting native turn before appending or executing it", async () => {
    const { app, record } = makeAppWithSession({ openaiReasoningDisabled: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await request(app)
      .post("/v1/chat/message")
      .set("X-Escrow-Ref", ESCROW_REF)
      .send({
        input: [{ role: "user", content: "think hard" }],
        reasoning: { effort: "high" },
      });

    expect(response.status).toBe(400);
    expect(response.body.reason).toBe("reasoning_disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(record.transcript).toEqual([]);
  });
});

describe("POST /v1/chat/message — typed tool continuation", () => {
  it("retains reasoning, encrypted replay data, calls, and outputs in order", async () => {
    const { app, record } = makeAppWithSession();
    const toolOutput = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Need weather" }],
        encrypted_content: "opaque-ciphertext",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "weather",
        arguments: "{\"city\":\"Paris\"}",
        status: "completed",
      },
    ];
    const toolResponse = {
      ...OK_RESPONSE,
      id: "resp_tools",
      output: toolOutput,
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    };
    const firstStream = sseBody([
      { type: "response.completed", sequence_number: 1, response: toolResponse },
    ]);
    const secondStream = sseBody([
      { type: "response.completed", sequence_number: 1, response: OK_RESPONSE },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(firstStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }))
      .mockResolvedValueOnce(new Response(secondStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await request(app)
      .post("/v1/chat/message")
      .set("X-Escrow-Ref", ESCROW_REF)
      .send({ input: [{ role: "user", content: "Weather?" }] });
    await request(app)
      .post("/v1/chat/message")
      .set("X-Escrow-Ref", ESCROW_REF)
      .send({
        input: [{
          type: "function_call_output",
          call_id: "call_1",
          output: "{\"temperature\":18}",
        }],
      });

    const secondRequest = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondRequest.input.slice(1, 4)).toEqual([
      ...toolOutput,
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "{\"temperature\":18}",
      },
    ]);
    expect(record.transcript).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Weather?" }],
      },
      ...toolOutput,
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "{\"temperature\":18}",
      },
      ...ASSISTANT_OUTPUT,
    ]);
  });
});
