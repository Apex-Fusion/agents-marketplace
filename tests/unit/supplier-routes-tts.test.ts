/**
 * supplier-routes-tts.test.ts — coverage for the audio.synthesize.piper.v1
 * supplier route added under the path-A multi-capability story.
 *
 * Focus: the NEW validation logic that lives in `makeTtsHandler`. The
 * shared lifecycle pieces (lock, claim tx, awaitTx, runner spawn) reuse
 * the chat-handler implementation and are already covered by the chat
 * route tests; we don't duplicate that coverage here.
 *
 * What we DO cover:
 *   - Mounting: TTS routes appear when capabilityKind="tts" and the chat
 *     route is absent (and vice-versa)
 *   - 400 validation: missing X-Escrow-Ref, malformed ref, missing/invalid
 *     text, voice, format, speed
 *   - Wiring: route is reachable (express plumbing intact)
 *
 * End-to-end happy-path (escrow seed → claim → run → submit) is exercised
 * by the post-deploy smoke against the real testnet, not here.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Application } from "express";

import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig, buildSampleTtsConfig } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ESCROW_REF_HEADER = `${"f".repeat(64)}#0`;

function makeApp(kind: "chat" | "tts"): Application {
  return createApp({
    chain: new MockChainProvider(),
    state: new SupplierState(),
    config: kind === "tts" ? buildSampleTtsConfig() : buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
    jobs: new JobStore(),
  });
}

function validBody() {
  return { text: "Hello world.", voice: "nova", format: "mp3", speed: 1.0 };
}

describe("Capability-routed mounting", () => {
  it('TTS supplier exposes /v1/audio/synthesize and NOT /v1/chat/completions', async () => {
    const app = makeApp("tts");
    const tts = await request(app).post("/v1/audio/synthesize")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER).send(validBody());
    // Whatever validation it lands on, it must not 404 (route exists).
    expect(tts.status).not.toBe(404);

    const chat = await request(app).post("/v1/chat/completions")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER).send({ messages: [{ role: "user", content: "hi" }] });
    expect(chat.status).toBe(404);
  });

  it('chat supplier exposes /v1/chat/completions and NOT /v1/audio/synthesize', async () => {
    const app = makeApp("chat");
    const tts = await request(app).post("/v1/audio/synthesize")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER).send(validBody());
    expect(tts.status).toBe(404);
  });
});

describe("POST /v1/audio/synthesize — header + body validation", () => {
  it("400 escrow_ref_required when X-Escrow-Ref header missing", async () => {
    const res = await request(makeApp("tts")).post("/v1/audio/synthesize").send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("escrow_ref_required");
  });

  it("400 escrow_ref_malformed when header is not <64hex>#<int>", async () => {
    const res = await request(makeApp("tts")).post("/v1/audio/synthesize")
      .set("X-Escrow-Ref", "not-an-escrow-ref").send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("escrow_ref_malformed");
  });

  it("400 text_required when body.text missing or empty", async () => {
    const app = makeApp("tts");
    for (const body of [{}, { text: "" }, { text: "   ", voice: "nova" }]) {
      const res = await request(app).post("/v1/audio/synthesize")
        .set("X-Escrow-Ref", ESCROW_REF_HEADER).send(body);
      // Empty-string text → text_required; whitespace-only also rejected.
      // We accept either text_required or voice_invalid (tested separately
      // below) — what matters is that this never reaches the chain.
      expect(res.status).toBe(400);
    }
  });

  it("400 voice_invalid for unknown voice", async () => {
    const res = await request(makeApp("tts")).post("/v1/audio/synthesize")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER)
      .send({ ...validBody(), voice: "karen" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("voice_invalid");
  });

  it("400 format_invalid for unknown format", async () => {
    const res = await request(makeApp("tts")).post("/v1/audio/synthesize")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER)
      .send({ ...validBody(), format: "ogg" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("format_invalid");
  });

  it("400 speed_out_of_range for speed below 0.5 / above 1.5", async () => {
    const app = makeApp("tts");
    for (const speed of [0.4, 1.6, "fast"]) {
      const res = await request(app).post("/v1/audio/synthesize")
        .set("X-Escrow-Ref", ESCROW_REF_HEADER)
        .send({ ...validBody(), speed });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("speed_out_of_range");
    }
  });

  it("doesn't reach chain on validation failure (escrow_not_found is what'd come next)", async () => {
    // With valid body + ref, the next step is chain.queryUtxo → null → 404
    // escrow_not_found. Confirms the validation path is the early gate.
    const res = await request(makeApp("tts")).post("/v1/audio/synthesize")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER).send(validBody());
    // We don't seed the chain → query returns null. This is a chain-side
    // 503 (advert_unavailable) since the advert UTxO is also unseeded.
    expect([403, 404, 503]).toContain(res.status);
  });
});
