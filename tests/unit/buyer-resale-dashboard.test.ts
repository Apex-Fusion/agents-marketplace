import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../buyer/src/server.js";

describe("buyer resale dashboard proxy", () => {
  it("serves the private supplier snapshot from a same-origin buyer route", async () => {
    const payload = {
      generatedAt: "2026-08-28T12:00:00.000Z",
      controller: { ok: true, phase: "active" },
      surplus: { earnings: { requests: 1_333 } },
      vector: { status: "retired" },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.redirect).toBe("error");
      return Response.json(payload);
    });
    const app = createApp({
      resaleDashboardUrl:
        "http://marketplace-mainnet-surplus-seller:8080/internal/resale-dashboard/",
      fetchImpl,
    });

    const response = await request(app).get("/v1/resale-dashboard");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(payload);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://marketplace-mainnet-surplus-seller:8080/internal/resale-dashboard",
      expect.any(Object),
    );
  });

  it("fails without exposing an upstream error body", async () => {
    const app = createApp({
      resaleDashboardUrl: "http://seller/internal/resale-dashboard",
      fetchImpl: async () => new Response("secret upstream detail", { status: 500 }),
    });

    const response = await request(app).get("/v1/resale-dashboard");

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("dashboard_upstream_error");
    expect(JSON.stringify(response.body)).not.toContain("secret upstream detail");
  });

  it("returns a bounded feature-disabled response when unconfigured", async () => {
    const fetchImpl = vi.fn();
    const app = createApp({ fetchImpl });

    const response = await request(app).get("/v1/resale-dashboard");

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("service_unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
