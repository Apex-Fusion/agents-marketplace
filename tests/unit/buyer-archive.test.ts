/**
 * buyer-archive.test.ts — coverage for the response archive (SQLite +
 * filesystem) added in M2-AUDIT.
 *
 * Two layers:
 *   1. ResponseArchive in isolation (persistChat / persistTts / list / get
 *      / readRequest / readResponse, plus filesystem layout).
 *   2. The /v1/responses* HTTP endpoints exposed by createApp when an
 *      archive is injected (and the 503 fallback when it isn't).
 *
 * Uses a per-test temp dir so tests are independent and don't pollute each
 * other's SQLite WAL. better-sqlite3 is synchronous — no flakey waits.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ResponseArchive } from "../../buyer/src/db/archive.js";
import { createApp } from "../../buyer/src/server.js";

let dir: string;
let archive: ResponseArchive;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archive-test-"));
  archive = new ResponseArchive(dir);
});

afterEach(() => {
  archive.close();
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE_REF = `${"a".repeat(64)}#0`;

function sampleReceipt() {
  return {
    prompt_hash: "b".repeat(64),
    response_hash: "c".repeat(64),
    model: "qwen2.5:0.5b",
    prompt_tokens: 12,
    completion_tokens: 48,
    wallclock_ms: 3200,
    supplier_pkh: "d".repeat(56),
    escrow_ref: SAMPLE_REF,
  };
}

// ─── ResponseArchive in isolation ────────────────────────────────────────

describe("ResponseArchive — persistChat", () => {
  it("writes request.json + response.json + DB row", () => {
    const row = archive.persistChat({
      escrow_ref: SAMPLE_REF,
      posted_at: 1_700_000_000_000,
      capability_id: "llm.text.generate.v1",
      supplier_pkh: "d".repeat(56),
      model: "qwen2.5:0.5b",
      payment_lovelace: "2000000",
      request_messages: [{ role: "user", content: "hi" }],
      response_canonical: '{"role":"assistant","content":"hello there"}',
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    });

    expect(row.escrow_ref).toBe(SAMPLE_REF);
    expect(row.response_content_type).toBe("application/json");
    expect(row.response_byte_length).toBe(44);

    // Filesystem: <dir>/<txhash>_0/{request.json,response.json}
    const recDir = join(dir, `${"a".repeat(64)}_0`);
    expect(existsSync(join(recDir, "request.json"))).toBe(true);
    expect(existsSync(join(recDir, "response.json"))).toBe(true);

    // Response file matches what we passed in (byte-exact — important for
    // sha256 verification against receipt.response_hash).
    expect(readFileSync(join(recDir, "response.json"), "utf8"))
      .toBe('{"role":"assistant","content":"hello there"}');
  });

  it("INSERT OR REPLACE on duplicate escrow_ref", () => {
    const baseParams = {
      escrow_ref: SAMPLE_REF,
      posted_at: 1_700_000_000_000,
      capability_id: "llm.text.generate.v1",
      supplier_pkh: "d".repeat(56),
      model: "qwen2.5:0.5b",
      payment_lovelace: "2000000",
      request_messages: [{ role: "user", content: "first" }],
      response_canonical: '{"role":"assistant","content":"first"}',
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    };
    archive.persistChat(baseParams);
    archive.persistChat({
      ...baseParams,
      response_canonical: '{"role":"assistant","content":"second"}',
    });
    expect(archive.list(10).length).toBe(1);
    const r = archive.readResponse(SAMPLE_REF);
    expect(r?.bytes.toString("utf8")).toBe('{"role":"assistant","content":"second"}');
  });
});

describe("ResponseArchive — persistTts", () => {
  it("writes audio bytes verbatim under response.<ext> + DB row", () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00]);
    const row = archive.persistTts({
      escrow_ref: SAMPLE_REF,
      posted_at: 1_700_000_000_000,
      capability_id: "audio.synthesize.piper.v1",
      supplier_pkh: "d".repeat(56),
      model: "piper-en-us-multi",
      payment_lovelace: "2000000",
      request_envelope: { text: "hello", voice: "nova", format: "mp3", speed: 1.0 },
      response_audio: audio,
      response_content_type: "audio/mpeg",
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    });
    expect(row.response_filename).toBe("response.mp3");
    expect(row.response_content_type).toBe("audio/mpeg");
    expect(row.response_byte_length).toBe(6);

    const r = archive.readResponse(SAMPLE_REF);
    expect(r?.bytes).toEqual(Buffer.from(audio));
    expect(r?.contentType).toBe("audio/mpeg");
    expect(r?.filename).toBe("response.mp3");
  });

  it("picks the right extension for various audio content-types", () => {
    const cases: Array<[string, string]> = [
      ["audio/mpeg", "response.mp3"],
      ["audio/wav", "response.wav"],
      ["audio/x-wav", "response.wav"],
      ["audio/opus", "response.opus"],
      ["audio/flac", "response.flac"],
      ["audio/aac", "response.aac"],
    ];
    for (const [ct, expectedFilename] of cases) {
      const ref = `${ct.replace(/\W/g, "0").padEnd(64, "0").slice(0, 64)}#0`;
      const row = archive.persistTts({
        escrow_ref: ref,
        posted_at: 0,
        capability_id: "audio.synthesize.piper.v1",
        supplier_pkh: "d".repeat(56),
        model: "x",
        payment_lovelace: "1",
        request_envelope: {},
        response_audio: new Uint8Array([1, 2, 3, 4]),
        response_content_type: ct,
        receipt: sampleReceipt(),
        receipt_signature: "f".repeat(128),
      });
      expect(row.response_filename).toBe(expectedFilename);
    }
  });
});

describe("ResponseArchive — read helpers", () => {
  it("get() returns null on miss", () => {
    expect(archive.get("not-a-real-ref")).toBeNull();
    expect(archive.readRequest("not-a-real-ref")).toBeNull();
    expect(archive.readResponse("not-a-real-ref")).toBeNull();
  });

  it("list() returns newest first", async () => {
    archive.persistChat({
      escrow_ref: `${"a".repeat(64)}#0`,
      posted_at: 0,
      capability_id: "llm.text.generate.v1",
      supplier_pkh: "d".repeat(56),
      model: "x",
      payment_lovelace: "1",
      request_messages: [],
      response_canonical: "first",
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    });
    // Force a different completed_at (better-sqlite3 + Date.now gives ms
    // resolution; sleep a tick).
    await new Promise<void>((r) => setTimeout(r, 5));
    archive.persistChat({
      escrow_ref: `${"b".repeat(64)}#0`,
      posted_at: 0,
      capability_id: "llm.text.generate.v1",
      supplier_pkh: "d".repeat(56),
      model: "x",
      payment_lovelace: "1",
      request_messages: [],
      response_canonical: "second",
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    });
    const rows = archive.list(10);
    expect(rows.length).toBe(2);
    expect(rows[0].escrow_ref.startsWith("b")).toBe(true);
    expect(rows[1].escrow_ref.startsWith("a")).toBe(true);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      archive.persistChat({
        escrow_ref: `${i.toString().repeat(64).slice(0, 64)}#0`,
        posted_at: 0,
        capability_id: "llm.text.generate.v1",
        supplier_pkh: "d".repeat(56),
        model: "x",
        payment_lovelace: "1",
        request_messages: [],
        response_canonical: "x",
        receipt: sampleReceipt(),
        receipt_signature: "f".repeat(128),
      });
    }
    expect(archive.list(3).length).toBe(3);
  });
});

// ─── HTTP endpoints (server.ts wiring) ───────────────────────────────────

describe("GET /v1/responses* — disabled (no archive injected)", () => {
  it("503 service_unavailable on list endpoint", async () => {
    const app = createApp({});
    const { default: request } = await import("supertest");
    const res = await request(app).get("/v1/responses");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("service_unavailable");
  });
  it("503 also on detail / artefact endpoints", async () => {
    const app = createApp({});
    const { default: request } = await import("supertest");
    const ref = SAMPLE_REF;
    for (const path of [
      `/v1/responses/${ref}`,
      `/v1/responses/${ref}/request`,
      `/v1/responses/${ref}/response`,
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
    }
  });
});

describe("GET /v1/responses* — happy paths", () => {
  it("list returns persisted rows newest-first with parsed receipt", async () => {
    archive.persistChat({
      escrow_ref: SAMPLE_REF,
      posted_at: 1_700_000_000_000,
      capability_id: "llm.text.generate.v1",
      supplier_pkh: "d".repeat(56),
      model: "qwen2.5:0.5b",
      payment_lovelace: "2000000",
      request_messages: [{ role: "user", content: "hi" }],
      response_canonical: '{"role":"assistant","content":"hello"}',
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    });
    const app = createApp({ archive });
    const { default: request } = await import("supertest");
    const res = await request(app).get("/v1/responses");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.responses)).toBe(true);
    expect(res.body.responses.length).toBe(1);
    const r = res.body.responses[0];
    expect(r.escrow_ref).toBe(SAMPLE_REF);
    expect(r.receipt).toMatchObject({ model: "qwen2.5:0.5b", supplier_pkh: "d".repeat(56) });
    expect(r.receipt_signature).toBe("f".repeat(128));
  });

  it("detail returns metadata + receipt for a known escrow", async () => {
    archive.persistTts({
      escrow_ref: SAMPLE_REF,
      posted_at: 1_700_000_000_000,
      capability_id: "audio.synthesize.piper.v1",
      supplier_pkh: "d".repeat(56),
      model: "piper-en-us-multi",
      payment_lovelace: "2000000",
      request_envelope: { text: "hi", voice: "nova", format: "mp3", speed: 1.0 },
      response_audio: new Uint8Array([1, 2, 3, 4]),
      response_content_type: "audio/mpeg",
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    });
    const app = createApp({ archive });
    const { default: request } = await import("supertest");
    const res = await request(app).get(`/v1/responses/${SAMPLE_REF.replace("#", "_")}`);
    expect(res.status).toBe(200);
    expect(res.body.escrow_ref).toBe(SAMPLE_REF);
    expect(res.body.response_filename).toBe("response.mp3");
    expect(res.body.response_content_type).toBe("audio/mpeg");
    expect(res.body.response_byte_length).toBe(4);
  });

  it("404 on unknown escrow_ref", async () => {
    const app = createApp({ archive });
    const { default: request } = await import("supertest");
    const ghost = `${"e".repeat(64)}#3`;
    const res = await request(app).get(`/v1/responses/${ghost.replace("#", "_")}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("/request returns the JSON envelope as application/json", async () => {
    archive.persistChat({
      escrow_ref: SAMPLE_REF,
      posted_at: 0,
      capability_id: "llm.text.generate.v1",
      supplier_pkh: "d".repeat(56),
      model: "x",
      payment_lovelace: "1",
      request_messages: [{ role: "user", content: "hello world" }],
      response_canonical: '{"role":"assistant","content":"hi"}',
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    });
    const app = createApp({ archive });
    const { default: request } = await import("supertest");
    const res = await request(app).get(`/v1/responses/${SAMPLE_REF.replace("#", "_")}/request`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(res.text).messages[0].content).toBe("hello world");
  });

  it("/response returns audio bytes with upstream Content-Type", async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00, 0x00, 0x01]);
    archive.persistTts({
      escrow_ref: SAMPLE_REF,
      posted_at: 0,
      capability_id: "audio.synthesize.piper.v1",
      supplier_pkh: "d".repeat(56),
      model: "x",
      payment_lovelace: "1",
      request_envelope: {},
      response_audio: audio,
      response_content_type: "audio/mpeg",
      receipt: sampleReceipt(),
      receipt_signature: "f".repeat(128),
    });
    const app = createApp({ archive });
    const { default: request } = await import("supertest");
    const res = await request(app).get(`/v1/responses/${SAMPLE_REF.replace("#", "_")}/response`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.body).toEqual(Buffer.from(audio));
    expect(res.headers["content-disposition"]).toContain("response.mp3");
  });
});
