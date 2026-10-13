/**
 * buyer-paper2agent-proxy.test.ts — security and spend boundaries of the
 * buyer's /v1/paper2agent proxy to the Paper2Agent control service.
 */

import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../buyer/src/server.js";
import { PAPER2AGENT_MAX_DOWNLOAD_BYTES } from "@marketplace/shared/paper2agent/workflow";

const CONTROL_URL = "http://paper2agent-control.internal:8095";
const CONTROL_TOKEN = "control-token-".repeat(3);
const JOB_ID = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const ARTIFACT_SHA = "a".repeat(64);

interface ControlCall {
  url: string;
  init: RequestInit;
}

/** Fake control service that records every request the buyer sends upstream. */
function controlService(respond: () => Response) {
  const calls: ControlCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond();
  });
  return { calls, fetchImpl };
}

function proxyApp(fetchImpl: typeof globalThis.fetch) {
  return request.agent(createApp({
    paper2agentControlUrl: CONTROL_URL,
    paper2agentControlToken: CONTROL_TOKEN,
    fetchImpl,
  }));
}

describe("buyer Paper2Agent proxy", () => {
  it("requires the request header before a change reaches the control service", async () => {
    const { calls, fetchImpl } = controlService(() => Response.json({ id: JOB_ID, state: "cancelled" }));
    const agent = proxyApp(fetchImpl);

    const crossSite = await agent.post(`/v1/paper2agent/jobs/${JOB_ID}/cancel`);
    expect(crossSite.status).toBe(403);
    expect(calls).toHaveLength(0);

    const operator = await agent.post(`/v1/paper2agent/jobs/${JOB_ID}/cancel`).set("X-Paper2Agent-Request", "1");
    expect(operator.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([`${CONTROL_URL}/jobs/${JOB_ID}/cancel`]);
  });

  it("sends the server-held token only to fixed control paths", async () => {
    const readiness = {
      build_ready: false,
      build_error: "Docker is not reachable from the control service",
      publisher_ready: false,
      publisher_error: "PAPER2AGENT_PUBLISHER_URL is not configured",
    };
    const { calls, fetchImpl } = controlService(() => Response.json(readiness));
    const agent = proxyApp(fetchImpl);

    const status = await agent.get("/v1/paper2agent/status");

    expect(status.status).toBe(200);
    expect(status.body).toEqual(readiness);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.text).not.toContain(CONTROL_TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${CONTROL_URL}/status`);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${CONTROL_TOKEN}`);
    expect(calls[0].init.redirect).toBe("error");

    expect((await agent.get("/v1/paper2agent/admin/config")).status).toBe(404);
    expect((await agent.get("/v1/paper2agent/jobs/..%2Fstatus")).status).toBe(404);
    expect((await agent.get(`/v1/paper2agent/jobs/${JOB_ID}/files?path=a&path=b`)).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("reports a rejected control token as a buyer configuration fault", async () => {
    const { fetchImpl } = controlService(() =>
      Response.json({ error: "unauthorized", message: "invalid bearer token" }, { status: 401 }),
    );
    const agent = proxyApp(fetchImpl);

    const response = await agent.get("/v1/paper2agent/jobs");

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("paper2agent_control_auth_failed");
    expect(response.text).not.toContain(CONTROL_TOKEN);
  });

  it("translates a multipart paper upload into one bounded JSON submission", async () => {
    // Larger than the app-wide 1 MiB JSON limit, smaller than the 5 MiB PDF limit.
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2 * 1024 * 1024, 0x20)]);
    const { calls, fetchImpl } = controlService(() =>
      Response.json({ id: JOB_ID, state: "queued", attempt: 1 }, { status: 202 }),
    );
    const agent = proxyApp(fetchImpl);

    const upload = await agent
      .post("/v1/paper2agent/jobs")
      .set("X-Paper2Agent-Request", "1")
      .attach("paper_pdf", pdf, { filename: "Least squares.pdf", contentType: "application/pdf" });

    expect(upload.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${CONTROL_URL}/jobs`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      title: "Least squares",
      paper_pdf_base64: pdf.toString("base64"),
    });

    const notPdf = await agent
      .post("/v1/paper2agent/jobs")
      .set("X-Paper2Agent-Request", "1")
      .field("title", "Least squares")
      .attach("paper_pdf", Buffer.from("<html>not a paper</html>"), { filename: "paper.pdf" });
    expect(notPdf.status).toBe(400);
    expect(notPdf.body.error).toBe("paper_pdf_invalid");

    const json = await agent
      .post("/v1/paper2agent/jobs")
      .set("X-Paper2Agent-Request", "1")
      .send({
        paper_pdf_base64: pdf.toString("base64"),
      });
    expect(json.status).toBe(202);
    expect(calls).toHaveLength(2);
  });

  it("rejects obsolete fields and bounds uploads before sending them upstream", async () => {
    const { calls, fetchImpl } = controlService(() => Response.json({ id: JOB_ID }, { status: 202 }));
    const agent = proxyApp(fetchImpl);
    for (const name of ["repository_url", "revision", "task", "budget", "unexpected"]) {
      const json = await agent.post("/v1/paper2agent/jobs").set("X-Paper2Agent-Request", "1")
        .send({ paper_text: "Least squares equation", [name]: "obsolete" });
      expect(json.status).toBe(400);
      expect(json.body.error).toBe("unsupported_field");
      const form = await agent.post("/v1/paper2agent/jobs").set("X-Paper2Agent-Request", "1")
        .field(name, "obsolete").attach("paper_pdf", Buffer.from("%PDF-1.7\n"), "paper.pdf");
      expect(form.status).toBe(400);
    }
    const tooLarge = await agent.post("/v1/paper2agent/jobs").set("X-Paper2Agent-Request", "1")
      .attach("paper_pdf", Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(5 * 1024 * 1024)]), "paper.pdf");
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error).toBe("paper_pdf_too_large");
    const repeated = await agent.post("/v1/paper2agent/jobs").set("X-Paper2Agent-Request", "1")
      .field("paper_text", "First").field("paper_text", "Second");
    expect(repeated.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("forwards paper URL or text alone once and preserves admission failures", async () => {
    const { calls, fetchImpl } = controlService(() =>
      Response.json({ error: "queue_full", message: "The build queue is full." }, { status: 429 }));
    const agent = proxyApp(fetchImpl);
    for (const body of [{ paper_url: "https://example.com/paper.pdf" }, { paper_text: "Equation 1: y = ax + b" }]) {
      const response = await agent.post("/v1/paper2agent/jobs").set("X-Paper2Agent-Request", "1").send(body);
      expect(response.status).toBe(429);
      expect(response.body.error).toBe("queue_full");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual(body);
    }
    expect(calls).toHaveLength(2);
  });

  it("requires explicit retry and publication approval and never repeats a publish request", async () => {
    const { calls, fetchImpl } = controlService(() => {
      throw new TypeError("fetch failed");
    });
    const agent = proxyApp(fetchImpl);
    const change = (path: string, body: object) =>
      agent.post(`/v1/paper2agent/jobs/${JOB_ID}/${path}`).set("X-Paper2Agent-Request", "1").send(body);

    expect((await change("build", {})).status).toBe(400);
    expect((await change("build", { confirm: "true" })).status).toBe(400);
    expect((await change("publish", { artifact_sha256: ARTIFACT_SHA, max_debit_lovelace: "5000000" })).status).toBe(
      400,
    );
    expect(
      (await change("publish", { artifact_sha256: ARTIFACT_SHA, confirm: true, max_debit_lovelace: "0" })).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);

    const lost = await change("publish", { artifact_sha256: ARTIFACT_SHA, confirm: true, max_debit_lovelace: "5000000" });

    expect(lost.status).toBe(502);
    expect(lost.body.error).toBe("paper2agent_unreachable");
    expect(calls.map((call) => call.url)).toEqual([`${CONTROL_URL}/jobs/${JOB_ID}/publish`]);
  });

  it("sets a private ZIP attachment name instead of trusting an upstream filename", async () => {
    const archive = Buffer.from("opaque upstream payload");
    const { fetchImpl } = controlService(
      () =>
        new Response(archive, {
          headers: {
            "content-type": "application/zip",
            "content-length": String(archive.length),
            "content-disposition": 'attachment; filename="../../home/operator/source.zip"',
          },
        }),
    );
    const agent = proxyApp(fetchImpl);

    const response = await agent
      .get(`/v1/paper2agent/jobs/${JOB_ID}/package`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="paper2agent-${JOB_ID}.zip"`);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it.each([
    { type: "application/x-tar", length: "1" },
    { type: "text/html", length: "1" },
    { type: "application/zip", length: String(PAPER2AGENT_MAX_DOWNLOAD_BYTES + 1) },
  ])("rejects an invalid archive response before starting a download: $type / $length", async ({ type, length }) => {
    const { fetchImpl } = controlService(() => new Response("x", { headers: { "content-type": type, "content-length": length } }));
    const agent = proxyApp(fetchImpl);
    const response = await agent.get(`/v1/paper2agent/jobs/${JOB_ID}/package`);
    expect(response.status).toBe(502);
    expect(response.body.error).toBe("paper2agent_invalid_package");
    expect(response.headers["content-disposition"]).toBeUndefined();
  });
});
