import { describe, expect, it, vi } from "vitest";
import { SurplusClient } from "../../supplier/src/surplus/client.js";

const SELLER_KEY = "si_seller_test_only";
const PROVIDER_KEY = "sk-or-v1-test-only";

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function discoveryRow(model: string, providerModelId: string): string {
  return JSON.stringify({
    model,
    supported: true,
    pricing: {
      input_per_1m: 0.07952,
      output_per_1m: 0.15904,
      price_unit: "M",
      price_variable: false,
    },
    metadata: {
      provider_model_id: providerModelId,
      model_type: "text",
      availability_status: "available",
    },
  });
}

describe("SurplusClient", () => {
  it("authenticates and parses fragmented NDJSON discovery", async () => {
    const first = discoveryRow("alpha", "vendor/alpha");
    const second = discoveryRow("beta", "vendor/beta");
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${SELLER_KEY}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        api_key: PROVIDER_KEY,
        base_url: "https://openrouter.ai/api/v1",
      });
      return ndjsonResponse([
        first.slice(0, 25),
        `${first.slice(25)}\r\n\r\n${second.slice(0, 11)}`,
        second.slice(11),
      ]);
    });
    const client = new SurplusClient({
      apiBaseUrl: "https://api.surplusintelligence.ai",
      sellerApiKey: SELLER_KEY,
      timeoutMs: 1_000,
      fetchFn,
    });

    const result = await client.discoverModels(
      PROVIDER_KEY,
      "https://openrouter.ai/api/v1",
    );

    expect(result.map((model) => [model.model, model.providerModelId])).toEqual([
      ["alpha", "vendor/alpha"],
      ["beta", "vendor/beta"],
    ]);
  });

  it("rejects one malformed discovery line without returning a partial catalog", async () => {
    const client = new SurplusClient({
      apiBaseUrl: "https://api.surplusintelligence.ai",
      sellerApiKey: SELLER_KEY,
      timeoutMs: 1_000,
      fetchFn: async () => ndjsonResponse([
        `${discoveryRow("alpha", "vendor/alpha")}\n`,
        '{"model":"truncated"',
      ]),
    });

    await expect(client.discoverModels(PROVIDER_KEY, "https://openrouter.ai/api/v1"))
      .rejects.toThrow("line 2 was not complete JSON");
  });

  it("follows every seller-offer page and normalizes micro-USD prices", async () => {
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      requested.push(value);
      if (value.includes("next_token=page-2")) {
        return Response.json({
          items: [{
            offer_id: "offer-2",
            model: "beta",
            seller_base_url: "https://openrouter.ai/api/v1",
            status: "inactive",
            cap_daily_usd: 1,
            price_input_per_1m: 4_100,
            price_output_per_1m: 8_200,
          }],
          next_token: null,
        });
      }
      return Response.json({
        items: [{
          id: "offer-1",
          model: "alpha",
          seller_base_url: "https://openrouter.ai/api/v1",
          status: "active",
          cap_daily_usd: 1,
          price_input_per_1m: 3_972,
          price_output_per_1m: 7_944,
        }],
        next_token: "page-2",
      });
    });
    const client = new SurplusClient({
      apiBaseUrl: "https://api.surplusintelligence.ai",
      sellerApiKey: SELLER_KEY,
      timeoutMs: 1_000,
      fetchFn,
    });

    const result = await client.listAllOffers();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "offer-1",
      status: "active",
      inputMicroUsdPer1m: 3_972,
      outputMicroUsdPer1m: 7_944,
    });
    expect(requested[1]).toContain("next_token=page-2");
  });

  it("fails closed when offer pagination repeats a token", async () => {
    const client = new SurplusClient({
      apiBaseUrl: "https://api.surplusintelligence.ai",
      sellerApiKey: SELLER_KEY,
      timeoutMs: 1_000,
      fetchFn: async () => Response.json({ items: [], next_token: "same" }),
    });

    await expect(client.listAllOffers()).rejects.toThrow("repeated a next_token");
  });

  it("normalizes live market envelopes and effective micro-USD fields", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/markets")) {
        return Response.json({ markets: [{
          model: "alpha:model",
          requests_24h: 100,
          volume_24h: 1_000,
          best_input_per_1m: 3_976,
          best_output_per_1m: 7_952,
          healthy_seller_count: 2,
        }] });
      }
      return Response.json({
        model: "alpha:model",
        offers: [{
          id: "external",
          seller: "0x2222222222222222222222222222222222222222",
          seller_base_url: "https://openrouter.ai/api/v1",
          effective_input_per_1m: 3_976,
          effective_output_per_1m: 7_952,
          available: true,
          healthy: true,
          trusted: true,
          trades_24h: 7,
        }],
      });
    });
    const client = new SurplusClient({
      apiBaseUrl: "https://api.surplusintelligence.ai",
      sellerApiKey: SELLER_KEY,
      timeoutMs: 1_000,
      fetchFn,
    });

    expect(await client.getMarkets()).toEqual([expect.objectContaining({
      model: "alpha:model",
      bestInputMicroUsdPer1m: 3_976,
    })]);
    expect(await client.getOrderBook("alpha:model")).toEqual({
      model: "alpha:model",
      offers: [expect.objectContaining({ id: "external", trades24h: 7 })],
    });
    expect(String(fetchFn.mock.calls[1][0])).toContain("alpha%3Amodel");
  });

  it("sends one absolute PATCH with plain USD prices and the cap", async () => {
    let request: RequestInit | undefined;
    const client = new SurplusClient({
      apiBaseUrl: "https://api.surplusintelligence.ai",
      sellerApiKey: SELLER_KEY,
      timeoutMs: 1_000,
      fetchFn: async (_url, init) => {
        request = init;
        return Response.json({ ok: true });
      },
    });

    await client.updateOffer("offer/one", {
      inputUsdPer1m: 0.003972,
      outputUsdPer1m: 0.007944,
      dailyCapUsd: 1,
      idempotencyKey: "mutation-1",
    });

    expect(request?.method).toBe("PATCH");
    expect(JSON.parse(String(request?.body))).toEqual({
      pricing_mode: "per_token",
      price_input_per_1m: 0.003972,
      price_output_per_1m: 0.007944,
      cap_daily_usd: 1,
    });
    const headers = new Headers(request?.headers);
    expect(headers.get("idempotency-key")).toBe("mutation-1");
  });
});
