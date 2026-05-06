/**
 * supplier-piper.test.ts — coverage for supplier/src/piper.ts.
 *
 * Mirrors the ollama tests: mocks global.fetch (no real PiperTTS host
 * required) and asserts request shape, success path, and the typed error
 * reasons (`piper_failure`, `piper_timeout`, `piper_malformed`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callPiper, PiperError } from "../../supplier/src/piper.js";

const PIPER_URL = "http://piper.fake";
const TEXT = "Hello from the marketplace.";
const VOICE = "nova";
const FORMAT = "mp3";
const SPEED = 1.0;
const TIMEOUT_MS = 5_000;

function makeAudioBuffer(byteLength: number): ArrayBuffer {
  const buf = new ArrayBuffer(byteLength);
  // Fill with mp3-frame-header-ish bytes so the buffer isn't all-zeros.
  const view = new Uint8Array(buf);
  for (let i = 0; i < byteLength; i++) view[i] = (i * 37) & 0xff;
  return buf;
}

function makeFetchOk(body: ArrayBuffer, contentType = "audio/mpeg") {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => body,
  });
}

function makeFetchError(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Internal Server Error",
    headers: { get: () => null },
    text: async () => "upstream piper error",
  });
}

describe("callPiper() — request shape", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchOk(makeAudioBuffer(2048)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to ${piperUrl}/v1/audio/speech with OpenAI-shape body", async () => {
    await callPiper({ piperUrl: PIPER_URL, text: TEXT, voice: VOICE, format: FORMAT, speed: SPEED, timeoutMs: TIMEOUT_MS });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://piper.fake/v1/audio/speech");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: "tts-1",
      input: TEXT,
      voice: VOICE,
      response_format: FORMAT,
      speed: SPEED,
    });
  });

  it("strips trailing slash from piperUrl", async () => {
    await callPiper({ piperUrl: "http://piper.fake////", text: "hi", voice: "nova", format: "mp3", speed: 1.0, timeoutMs: TIMEOUT_MS });
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://piper.fake/v1/audio/speech");
  });
});

describe("callPiper() — happy path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns audio bytes + content-type + measured wallclock_ms", async () => {
    const buf = makeAudioBuffer(4096);
    vi.stubGlobal("fetch", makeFetchOk(buf, "audio/mpeg"));
    const result = await callPiper({ piperUrl: PIPER_URL, text: TEXT, voice: VOICE, format: FORMAT, speed: SPEED, timeoutMs: TIMEOUT_MS });
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.audio.byteLength).toBe(4096);
    expect(result.contentType).toBe("audio/mpeg");
    expect(typeof result.wallclock_ms).toBe("number");
    expect(result.wallclock_ms).toBeGreaterThanOrEqual(0);
  });

  it("falls back to audio/<format> when upstream omits content-type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => makeAudioBuffer(128),
    }));
    const r = await callPiper({ piperUrl: PIPER_URL, text: "hi", voice: "nova", format: "wav", speed: 1.0, timeoutMs: TIMEOUT_MS });
    expect(r.contentType).toBe("audio/wav");
  });
});

describe("callPiper() — error reasons", () => {
  afterEach(() => vi.restoreAllMocks());

  it("non-2xx HTTP → PiperError piper_failure", async () => {
    vi.stubGlobal("fetch", makeFetchError(500));
    await expect(
      callPiper({ piperUrl: PIPER_URL, text: TEXT, voice: VOICE, format: FORMAT, speed: SPEED, timeoutMs: TIMEOUT_MS }),
    ).rejects.toMatchObject({ name: "PiperError", reason: "piper_failure" });
  });

  it("network throw → PiperError piper_failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(
      callPiper({ piperUrl: PIPER_URL, text: TEXT, voice: VOICE, format: FORMAT, speed: SPEED, timeoutMs: TIMEOUT_MS }),
    ).rejects.toMatchObject({ name: "PiperError", reason: "piper_failure" });
  });

  it("AbortError → PiperError piper_timeout", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    await expect(
      callPiper({ piperUrl: PIPER_URL, text: TEXT, voice: VOICE, format: FORMAT, speed: SPEED, timeoutMs: TIMEOUT_MS }),
    ).rejects.toMatchObject({ name: "PiperError", reason: "piper_timeout" });
  });

  it("body smaller than MIN_AUDIO_BYTES → PiperError piper_malformed", async () => {
    vi.stubGlobal("fetch", makeFetchOk(makeAudioBuffer(8)));
    await expect(
      callPiper({ piperUrl: PIPER_URL, text: TEXT, voice: VOICE, format: FORMAT, speed: SPEED, timeoutMs: TIMEOUT_MS }),
    ).rejects.toMatchObject({ name: "PiperError", reason: "piper_malformed" });
  });

  it("PiperError exports `reason` for switch dispatch", () => {
    const err = new PiperError("piper_timeout", "x");
    expect(err.reason).toBe("piper_timeout");
    expect(err.name).toBe("PiperError");
  });
});
