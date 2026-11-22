/**
 * tests/unit/indexer-server-spa-catchall.test.ts — createApp with `uiDistDir` (M1-F-5): the dashboard files are served, index.html answers each
 * other path, and the JSON routes and the event stream keep priority. A real temp folder holds the dashboard files.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Application } from "express";
import http from "http";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createApp } from "../../indexer/src/server.js";
import { makeIndexerDeps } from "./__helpers__/fakeIndexerDeps.js";

// ─── Temp dist directory ─────────────────────────────────────────────────────
// Created once for all cases; holds a minimal index.html and a fake JS file.

let distDir: string;
let app: Application;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), "indexer-ui-dist-"));
  writeFileSync(join(distDir, "index.html"), "<!DOCTYPE html><html><body>IndexerUI</body></html>");
  writeFileSync(join(distDir, "app.js"), "// fake bundle");
  app = createApp(makeIndexerDeps(), { uiDistDir: distDir });
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

// ─── JSON route priority preserved ───────────────────────────────────────────
// /healthz is the first JSON route that createApp mounts and /events the last: both stay ahead of the catch-all.

describe("SPA catch-all — JSON route priority preserved", () => {
  it("GET /healthz still returns JSON 200 when uiDistDir is set", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("GET /events?stream=1 still returns text/event-stream when uiDistDir is set", async () => {
    // supertest waits for the end of the response, and a long-lived stream never ends it: read the headers with http.get.
    const contentType = await new Promise<string>((resolve, reject) => {
      // Start a server on a random port, make one request, grab the header, destroy.
      const server = http.createServer(app).listen(0, () => {
        const { port } = server.address() as { port: number };
        const req = http.get(`http://127.0.0.1:${port}/events?stream=1`, (res) => {
          resolve(res.headers["content-type"] ?? "");
          req.destroy();
          server.close();
        });
        req.on("error", (err) => {
          // Ignore "socket hang up" that results from req.destroy()
          if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
          reject(err);
        });
      });
      server.on("error", reject);
    });

    expect(contentType).toMatch(/event-stream/);
  }, 10_000);
});

// ─── SPA catch-all behaviour ─────────────────────────────────────────────────

describe("SPA catch-all — index.html served", () => {
  it("GET / returns text/html (index.html) when uiDistDir is set", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("IndexerUI");
  });

  it("GET /some-spa-route returns the same index.html (SPA catch-all)", async () => {
    const res = await request(app).get("/some-spa-route");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("IndexerUI");
  });

  it("GET /app.js returns the static JS file from dist", async () => {
    const res = await request(app).get("/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("fake bundle");
  });
});
