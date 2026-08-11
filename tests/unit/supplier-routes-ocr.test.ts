/**
 * supplier-routes-ocr.test.ts — coverage for the model-scoped OCR supplier
 * route (`ocr.page.extract.<model-slug>.v1`).
 *
 * Focus (mirrors supplier-routes-tts.test.ts): the NEW validation logic in
 * `makeOcrHandler` plus capability-routed mounting and the enlarged body
 * limit. The shared lifecycle pieces (lock, claim tx, runner spawn) reuse
 * the chat-handler implementation and are covered by the chat route tests.
 *
 * End-to-end happy-path (escrow seed → claim → run → submit) is exercised
 * by the post-deploy smoke against the real testnet, not here.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import type { Application } from "express";

import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { createApp } from "../../supplier/src/server.js";
import type { SupplierConfig } from "../../supplier/src/config.js";
import {
  buildSampleConfig,
  buildSampleOcrConfig,
} from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ESCROW_REF_HEADER = `${"f".repeat(64)}#0`;
const IMG = Buffer.from("page image bytes").toString("base64");

function makeApp(config?: SupplierConfig): Application {
  return createApp({
    chain: new MockChainProvider(),
    state: new SupplierState(),
    config: config ?? buildSampleOcrConfig(),
    supplierKey: buildSupplierWalletKey(),
    jobs: new JobStore(),
  });
}

function validBody() {
  return { image_b64: IMG, mime: "image/png", output_format: "markdown" };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Capability-routed mounting", () => {
  it("ocr supplier exposes /v1/ocr/extract and NOT the chat/tts routes", async () => {
    const app = makeApp();
    const ocr = await request(app).post("/v1/ocr/extract")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER).send(validBody());
    expect(ocr.status).not.toBe(404);

    const chat = await request(app).post("/v1/chat/completions")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER)
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(chat.status).toBe(404);

    const tts = await request(app).post("/v1/audio/synthesize")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER)
      .send({ text: "x", voice: "nova", format: "mp3", speed: 1 });
    expect(tts.status).toBe(404);
  });

  it("chat supplier does NOT expose /v1/ocr/extract", async () => {
    const app = makeApp(buildSampleConfig());
    const res = await request(app).post("/v1/ocr/extract")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER).send(validBody());
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/ocr/extract — header + body validation", () => {
  it("400 escrow_ref_required when X-Escrow-Ref header missing", async () => {
    const res = await request(makeApp()).post("/v1/ocr/extract").send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("escrow_ref_required");
  });

  it("400 escrow_ref_malformed when header is not <64hex>#<int>", async () => {
    const res = await request(makeApp()).post("/v1/ocr/extract")
      .set("X-Escrow-Ref", "not-a-ref").send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("escrow_ref_malformed");
  });

  it("400 image_required when image_b64 missing or empty", async () => {
    const app = makeApp();
    for (const body of [{}, { image_b64: "" }, { mime: "image/png", output_format: "markdown" }]) {
      const res = await request(app).post("/v1/ocr/extract")
        .set("X-Escrow-Ref", ESCROW_REF_HEADER).send(body);
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("image_required");
    }
  });

  it("400 image_not_base64 for data-URL or whitespace payloads", async () => {
    const app = makeApp();
    for (const image_b64 of [`data:image/png;base64,${IMG}`, `${IMG} `, "has space"]) {
      const res = await request(app).post("/v1/ocr/extract")
        .set("X-Escrow-Ref", ESCROW_REF_HEADER)
        .send({ ...validBody(), image_b64 });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("image_not_base64");
    }
  });

  it("400 mime_invalid for unsupported mime", async () => {
    const res = await request(makeApp()).post("/v1/ocr/extract")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER)
      .send({ ...validBody(), mime: "image/tiff" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("mime_invalid");
  });

  it("400 output_format_invalid for unsupported format", async () => {
    const res = await request(makeApp()).post("/v1/ocr/extract")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER)
      .send({ ...validBody(), output_format: "yaml" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("output_format_invalid");
  });

  it("accepts a 2MB body (over the 1mb global limit — OCR route has its own parser)", async () => {
    // 2M chars of base64 ≈ 1.5 MB binary; global express.json would 413 this.
    const big = "A".repeat(2_000_000);
    const res = await request(makeApp()).post("/v1/ocr/extract")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER)
      .send({ ...validBody(), image_b64: big });
    // Passes body parsing + validation, then fails on the unseeded chain
    // (advert_unavailable 503) — anything but 413 proves the parser took it.
    expect(res.status).not.toBe(413);
    expect([403, 404, 503]).toContain(res.status);
  });
});

describe("POST /v1/ocr/extract — revision-probe gate", () => {
  it("503 advert_unavailable — chain validation runs before the revision probe fires", async () => {
    // Advert/escrow would resolve AFTER the probe? No — probe runs at step
    // 7.5, after chain checks. Seeding a full escrow in the mock provider is
    // the chat-route suite's job; here we assert the config gate wiring by
    // hitting the earlier chain-side failure with probing configured — the
    // probe must NOT fire before chain validation (unseeded chain 503s
    // first), keeping probe cost off the hot invalid path.
    vi.stubGlobal("fetch", async () => { throw new Error("probe must not be called yet"); });
    const config: SupplierConfig = {
      ...buildSampleOcrConfig(),
      revisionProbeUrl: "http://vllm.fake:8000/info",
      revisionProbeMode: "per_job",
      hfModelRevision: "a".repeat(40),
    };
    const res = await request(makeApp(config)).post("/v1/ocr/extract")
      .set("X-Escrow-Ref", ESCROW_REF_HEADER).send(validBody());
    // Unseeded chain → advert_unavailable (503) BEFORE any probe fetch.
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("advert_unavailable");
  });
});

describe("GET /v1/ocr/extract/:jobId", () => {
  it("400 invalid_job_id for non-UUID", async () => {
    const res = await request(makeApp()).get("/v1/ocr/extract/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("invalid_job_id");
  });

  it("404 job_not_found for unknown UUID", async () => {
    const res = await request(makeApp())
      .get("/v1/ocr/extract/123e4567-e89b-42d3-a456-426614174000");
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("job_not_found");
  });
});
