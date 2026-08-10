/**
 * supplier-datalab-ocr.test.ts — coverage for the Datalab hosted-API OCR
 * upstream (OCR_UPSTREAM="datalab").
 *
 * Pins the wire contract verified against documentation.datalab.to
 * (2026-08-06): multipart POST /api/v1/convert with X-API-Key, then poll
 * GET /api/v1/convert/{id} until status "complete"; result field named by
 * output_format. Plus the error taxonomy and the health probe.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  callDatalabOcr,
  probeDatalabHealth,
  DatalabError,
} from "../../supplier/src/datalabOcr.js";
import { loadConfig } from "../../supplier/src/config.js";
import { buildSampleEnv } from "../fixtures/supplier-side/sample-config.js";

const IMG = Buffer.from("page bytes").toString("base64");

function validParams(overrides?: Partial<Parameters<typeof callDatalabOcr>[0]>) {
  return {
    baseUrl: "https://dl.fake",
    apiKey: "dl-key",
    request: { image_b64: IMG, mime: "image/png", output_format: "markdown" },
    timeoutMs: 5_000,
    mode: "accurate",
    pollIntervalMs: 5,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callDatalabOcr — happy path + wire shape", () => {
  it("submits multipart with X-API-Key, polls, returns the markdown content", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/api/v1/convert")) {
        return new Response(JSON.stringify({
          success: true, error: null, request_id: "req-1",
          request_check_url: "https://dl.fake/api/v1/convert/req-1",
        }), { status: 200 });
      }
      polls += 1;
      if (polls < 2) {
        return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "complete", markdown: "# Registry page", page_count: 1, error: null,
      }), { status: 200 });
    });

    const result = await callDatalabOcr(validParams());
    expect(result.content).toBe("# Registry page");
    expect(result.prompt_tokens).toBe(0);
    expect(result.completion_tokens).toBe(0);
    expect(result.wallclock_ms).toBeGreaterThanOrEqual(0);

    const submit = calls[0];
    expect(submit.url).toBe("https://dl.fake/api/v1/convert");
    expect((submit.init.headers as Record<string, string>)["X-API-Key"]).toBe("dl-key");
    const form = submit.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("output_format")).toBe("markdown");
    expect(form.get("mode")).toBe("accurate");
    const file = form.get("file") as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe("image/png");

    // Poll used the check URL with the key.
    const poll = calls[1];
    expect(poll.url).toBe("https://dl.fake/api/v1/convert/req-1");
    expect((poll.init.headers as Record<string, string>)["X-API-Key"]).toBe("dl-key");
  });

  it("stringifies an object result for output_format=json", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/api/v1/convert")) {
        return new Response(JSON.stringify({ success: true, request_id: "r2", request_check_url: "https://dl.fake/api/v1/convert/r2" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "complete", json: { blocks: [{ type: "Table" }] },
      }), { status: 200 });
    });
    const result = await callDatalabOcr(validParams({
      request: { image_b64: IMG, mime: "image/png", output_format: "json" },
    }));
    expect(result.content).toBe(JSON.stringify({ blocks: [{ type: "Table" }] }));
  });
});

describe("callDatalabOcr — error taxonomy", () => {
  it("datalab_failure on submit HTTP error", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
    await expect(callDatalabOcr(validParams())).rejects.toMatchObject({
      name: "DatalabError", reason: "datalab_failure",
    });
  });

  it("datalab_failure on success:false", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ success: false, error: "no credits" }), { status: 200 }));
    await expect(callDatalabOcr(validParams())).rejects.toThrow(/no credits/);
  });

  it("datalab_malformed when request_id missing", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(callDatalabOcr(validParams())).rejects.toMatchObject({
      reason: "datalab_malformed",
    });
  });

  it("datalab_failure when the job reports failed status", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/api/v1/convert")) {
        return new Response(JSON.stringify({ success: true, request_id: "r3", request_check_url: "https://dl.fake/api/v1/convert/r3" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "failed", error: "unreadable file" }), { status: 200 });
    });
    await expect(callDatalabOcr(validParams())).rejects.toThrow(/unreadable file/);
  });

  it("datalab_malformed when the completed result lacks the requested format field", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/api/v1/convert")) {
        return new Response(JSON.stringify({ success: true, request_id: "r4", request_check_url: "https://dl.fake/api/v1/convert/r4" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "complete", html: "<p>x</p>" }), { status: 200 });
    });
    await expect(callDatalabOcr(validParams())).rejects.toMatchObject({
      reason: "datalab_malformed",
    });
  });

  it("datalab_timeout when polling never completes within the budget", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/api/v1/convert")) {
        return new Response(JSON.stringify({ success: true, request_id: "r5", request_check_url: "https://dl.fake/api/v1/convert/r5" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    });
    await expect(callDatalabOcr(validParams({ timeoutMs: 60, pollIntervalMs: 10 })))
      .rejects.toMatchObject({ reason: "datalab_timeout" });
  });

  it("exports the error class for instanceof checks", async () => {
    vi.stubGlobal("fetch", async () => new Response("x", { status: 502 }));
    try {
      await callDatalabOcr(validParams());
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DatalabError);
    }
  });
});

describe("probeDatalabHealth", () => {
  it("ok on 200 from /api/v1/health with the key header", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      captured = { url, init: init ?? {} };
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });
    const result = await probeDatalabHealth({ baseUrl: "https://dl.fake", apiKey: "dl-key", timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(captured!.url).toBe("https://dl.fake/api/v1/health");
    expect((captured!.init.headers as Record<string, string>)["X-API-Key"]).toBe("dl-key");
  });

  it("not ok on HTTP error or network failure", async () => {
    vi.stubGlobal("fetch", async () => new Response("x", { status: 503 }));
    expect((await probeDatalabHealth({ baseUrl: "https://dl.fake", apiKey: "k", timeoutMs: 1000 })).ok).toBe(false);
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    expect((await probeDatalabHealth({ baseUrl: "https://dl.fake", apiKey: "k", timeoutMs: 1000 })).ok).toBe(false);
  });
});

describe("loadConfig — datalab upstream validation", () => {
  function ocrEnv(extra: Record<string, string>): Record<string, string> {
    const env = buildSampleEnv();
    delete (env as Record<string, string | undefined>).OLLAMA_URL;
    return { ...env, CAPABILITY_KIND: "ocr", ...extra };
  }

  it("requires DATALAB_API_KEY when OCR_UPSTREAM=datalab", () => {
    expect(() => loadConfig(ocrEnv({ OCR_UPSTREAM: "datalab" })))
      .toThrow(/DATALAB_API_KEY/);
  });

  it("datalab upstream boots without OPENAI_BASE_URL and probes per_job by default", () => {
    const config = loadConfig(ocrEnv({ OCR_UPSTREAM: "datalab", DATALAB_API_KEY: "dl-k" }));
    expect(config.ocrUpstream).toBe("datalab");
    expect(config.openaiBaseUrl).toBe("");
    expect(config.revisionProbeMode).toBe("per_job");
    expect(config.datalabBaseUrl).toBe("https://www.datalab.to");
    expect(config.datalabMode).toBe("accurate");
  });

  it("openai-vision upstream still requires OPENAI_BASE_URL", () => {
    expect(() => loadConfig(ocrEnv({})))
      .toThrow(/OPENAI_BASE_URL/);
  });

  it("rejects an invalid DATALAB_MODE", () => {
    expect(() => loadConfig(ocrEnv({
      OCR_UPSTREAM: "datalab", DATALAB_API_KEY: "dl-k", DATALAB_MODE: "turbo",
    }))).toThrow(/DATALAB_MODE/);
  });
});
