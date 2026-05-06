/**
 * buyer-server-synth-speech.test.ts — coverage for the PiperTTS proxy
 * endpoint (POST /v1/synth-speech) added under the path-B multi-capability
 * story.
 *
 * The endpoint forwards to an injected `fetchImpl` so we never hit the
 * real openedai-speech-min host in tests. We assert:
 *   - 503 when ttsPiperBaseUrl is not configured
 *   - validation 400s for missing/oversized text, bad voice, bad format,
 *     and out-of-range speed
 *   - 200 with audio bytes + correct Content-Type when upstream succeeds
 *   - 502 when upstream returns non-2xx OR throws
 *   - request body forwarded to upstream as OpenAI-shape JSON (model,
 *     input, voice, response_format, speed)
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../../buyer/src/server.js";

const baseUrl = "http://tts-piper.fake/";

/** Build a fetchImpl that records calls + returns a configurable response. */
function makeStubFetch(opts: {
  status?: number;
  body?: ArrayBuffer | string;
  contentType?: string;
  throwError?: Error;
}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (opts.throwError) throw opts.throwError;
    const status = opts.status ?? 200;
    const body = opts.body ?? new ArrayBuffer(0);
    const contentType = opts.contentType ?? "audio/mpeg";
    return new Response(body, {
      status,
      headers: { "Content-Type": contentType },
    });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe("POST /v1/synth-speech", () => {
  it("returns 503 when ttsPiperBaseUrl is not configured", async () => {
    const app = createApp({});
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech").send({
      text: "hi", voice: "nova", format: "mp3", speed: 1.0,
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("service_unavailable");
  });

  it("rejects empty text with 400 text_required", async () => {
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl: makeStubFetch({}).fetchImpl });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech").send({ text: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text_required");
  });

  it("rejects oversized text with 400 text_too_long", async () => {
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl: makeStubFetch({}).fetchImpl });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech").send({ text: "x".repeat(4001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text_too_long");
  });

  it("rejects unknown voice with 400 voice_invalid", async () => {
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl: makeStubFetch({}).fetchImpl });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech")
      .send({ text: "hi", voice: "not-a-voice" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("voice_invalid");
  });

  it("rejects unknown format with 400 format_invalid", async () => {
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl: makeStubFetch({}).fetchImpl });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech")
      .send({ text: "hi", voice: "nova", format: "ogg" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("format_invalid");
  });

  it("rejects speed below 0.5 / above 1.5 with 400 speed_out_of_range", async () => {
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl: makeStubFetch({}).fetchImpl });
    const { default: request } = await import("supertest");
    // NaN is not in this list because JSON.stringify({speed:NaN}) → "null",
    // which the endpoint correctly treats as "field omitted" (defaults to 1.0).
    // Out-of-range numerics + non-numeric strings are the real attack surface.
    for (const bad of [0.4, 1.6, "fast"]) {
      const res = await request(app).post("/v1/synth-speech")
        .send({ text: "hi", voice: "nova", format: "mp3", speed: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("speed_out_of_range");
    }
  });

  it("returns 200 audio bytes with upstream Content-Type on success", async () => {
    // 8 dummy bytes — supertest will deliver them as a Buffer, length verifies
    // that the proxy forwarded the body unchanged.
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0, 0, 0, 0]);
    const { fetchImpl, calls } = makeStubFetch({
      body: audio.buffer,
      contentType: "audio/mpeg",
    });
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech")
      .send({ text: "hello", voice: "nova", format: "mp3", speed: 1.0 });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.body).toBeInstanceOf(Buffer);
    expect(res.body.length).toBe(8);

    // Verify the OpenAI-shape body was forwarded exactly.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://tts-piper.fake/v1/audio/speech"); // trailing-slash stripped
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).toEqual({
      model: "tts-1",
      input: "hello",
      voice: "nova",
      response_format: "mp3",
      speed: 1.0,
    });
  });

  it("defaults voice=nova, format=mp3, speed=1.0 when fields are omitted", async () => {
    const { fetchImpl, calls } = makeStubFetch({ body: new ArrayBuffer(1) });
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech").send({ text: "hi" });
    expect(res.status).toBe(200);
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.voice).toBe("nova");
    expect(sent.response_format).toBe("mp3");
    expect(sent.speed).toBe(1.0);
  });

  it("returns 502 tts_upstream_error on non-2xx upstream", async () => {
    const { fetchImpl } = makeStubFetch({
      status: 500,
      body: "internal piper error",
      contentType: "text/plain",
    });
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech").send({ text: "hi" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("tts_upstream_error");
    expect(res.body.message).toContain("500");
  });

  it("returns 502 tts_unreachable on fetch throw", async () => {
    const { fetchImpl } = makeStubFetch({ throwError: new Error("ENOTFOUND") });
    const app = createApp({ ttsPiperBaseUrl: baseUrl, fetchImpl });
    const { default: request } = await import("supertest");
    const res = await request(app).post("/v1/synth-speech").send({ text: "hi" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("tts_unreachable");
    expect(res.body.message).toContain("ENOTFOUND");
  });
});
