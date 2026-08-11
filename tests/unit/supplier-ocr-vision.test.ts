/**
 * supplier-ocr-vision.test.ts — coverage for the OpenAI-compatible VISION
 * upstream client used by the `ocr` capability kind.
 *
 * Mirrors supplier-openai.test.ts: stub global fetch, pin the outbound wire
 * shape (vision content parts, data-URL image), and the error taxonomy
 * (ocr_failure / ocr_timeout / ocr_malformed).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  callOcrVision,
  probeRevision,
  defaultOcrInstruction,
  OcrVisionError,
} from "../../supplier/src/ocrVision.js";

const IMG = Buffer.from("some page bytes").toString("base64");

function validParams() {
  return {
    baseUrl: "http://vllm.fake:8000",
    model: "datalab-to/chandra-ocr-2",
    request: { image_b64: IMG, mime: "image/png", output_format: "markdown" },
    timeoutMs: 5_000,
  };
}

function okBody(content = "# Page\ntext") {
  return {
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callOcrVision — happy path + wire shape", () => {
  it("POSTs vision content parts with a data-URL image and returns the normalised result", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify(okBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await callOcrVision(validParams());

    expect(result.content).toBe("# Page\ntext");
    expect(result.prompt_tokens).toBe(900);
    expect(result.completion_tokens).toBe(120);
    expect(result.wallclock_ms).toBeGreaterThanOrEqual(0);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://vllm.fake:8000/v1/chat/completions");
    const sent = JSON.parse(String(captured!.init.body));
    expect(sent.model).toBe("datalab-to/chandra-ocr-2");
    expect(sent.stream).toBe(false);
    expect(Array.isArray(sent.messages)).toBe(true);
    const content = sent.messages[0].content;
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url.url).toBe(`data:image/png;base64,${IMG}`);
    expect(content[1].type).toBe("text");
    expect(content[1].text).toBe(defaultOcrInstruction("markdown"));
  });

  it("uses promptOverride verbatim when provided", async () => {
    let sentText = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sentText = JSON.parse(String(init.body)).messages[0].content[1].text;
      return new Response(JSON.stringify(okBody()), { status: 200 });
    });
    await callOcrVision({ ...validParams(), promptOverride: "OCR EXACTLY AS CHANDRA WANTS" });
    expect(sentText).toBe("OCR EXACTLY AS CHANDRA WANTS");
  });

  it("forwards max_tokens when positive and the bearer key when set", async () => {
    let sent: Record<string, unknown> = {};
    let auth = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      auth = (init.headers as Record<string, string>).authorization ?? "";
      return new Response(JSON.stringify(okBody()), { status: 200 });
    });
    await callOcrVision({ ...validParams(), maxTokens: 4096, apiKey: "sk-test" });
    expect(sent.max_tokens).toBe(4096);
    expect(auth).toBe("Bearer sk-test");
  });
});

describe("callOcrVision — error taxonomy", () => {
  it("ocr_failure on non-2xx", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    await expect(callOcrVision(validParams())).rejects.toMatchObject({
      name: "OcrVisionError",
      reason: "ocr_failure",
    });
  });

  it("ocr_malformed on missing content", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }), { status: 200 }));
    await expect(callOcrVision(validParams())).rejects.toMatchObject({
      reason: "ocr_malformed",
    });
  });

  it("ocr_timeout when the upstream exceeds timeoutMs", async () => {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }));
    await expect(callOcrVision({ ...validParams(), timeoutMs: 30 })).rejects.toMatchObject({
      reason: "ocr_timeout",
    });
  });

  it("exports the error class for instanceof checks", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 502 }));
    try {
      await callOcrVision(validParams());
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OcrVisionError);
    }
  });
});

describe("probeRevision — served-checkpoint probe", () => {
  it("extracts a 40-hex sha from known runtime fields", async () => {
    const sha = "a".repeat(40);
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ model_sha: sha }), { status: 200 }));
    const result = await probeRevision({ probeUrl: "http://vllm.fake:8000/info", timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(result.servedSha).toBe(sha);
  });

  it("ok with empty sha when the runtime reports no revision field", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ served_model: "chandra" }), { status: 200 }));
    const result = await probeRevision({ probeUrl: "http://x/info", timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(result.servedSha).toBe("");
  });

  it("not ok on HTTP error / network failure", async () => {
    vi.stubGlobal("fetch", async () => new Response("x", { status: 503 }));
    expect((await probeRevision({ probeUrl: "http://x/info", timeoutMs: 1000 })).ok).toBe(false);

    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    expect((await probeRevision({ probeUrl: "http://x/info", timeoutMs: 1000 })).ok).toBe(false);
  });
});
