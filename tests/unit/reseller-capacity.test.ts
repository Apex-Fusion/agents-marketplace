import { describe, expect, it, vi } from "vitest";
import { chatInputTokenUpperBound } from "../../packages/shared/src/tx/inputBound.js";
import { CapacityGate } from "../../supplier/src/reseller/capacityGate.js";
import type {
  CapacityProvider,
  ProviderCapacityReading,
} from "../../supplier/src/reseller/provider.js";
import { OpenRouterCapacityProvider } from "../../supplier/src/reseller/openRouterCapacity.js";

function reading(remaining: bigint): ProviderCapacityReading {
  return {
    provider: "openrouter",
    keyLimitUsdNanos: 10_000_000_000n,
    keyRemainingUsdNanos: remaining,
    limitReset: "monthly",
    checkedAtMs: 1_000,
    pricing: {
      model: "provider/model",
      promptUsdNanosPerToken: 1_000_000n,
      completionUsdNanosPerToken: 2_000_000n,
      requestUsdNanos: 0n,
      fetchedAtMs: 1_000,
    },
  };
}

describe("chatInputTokenUpperBound", () => {
  it("uses canonical UTF-8 bytes and fixed chat overhead", () => {
    expect(chatInputTokenUpperBound([])).toBe(5);
    expect(chatInputTokenUpperBound([{ role: "user", content: "a" }])).toBe(42);
    expect(chatInputTokenUpperBound([{ role: "user", content: "é" }])).toBe(43);
    expect(chatInputTokenUpperBound([{ role: "user", content: "🙂" }])).toBe(45);
  });

  it("adds each message independently", () => {
    expect(chatInputTokenUpperBound([
      { role: "system", content: "x" },
      { role: "user", content: "yz" },
    ])).toBe(83);
  });

  it("counts tool-call arguments present on direct SDK messages", () => {
    expect(chatInputTokenUpperBound([{
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "x",
        type: "function",
        function: { name: "f", arguments: "a".repeat(1000) },
      }],
    }])).toBe(1129);
  });
});

describe("CapacityGate", () => {
  it("opens only when allowance above reserve covers a worst-case job", async () => {
    let current = reading(2_000_000_000n);
    const provider: CapacityProvider = {
      id: "openrouter",
      readCapacity: vi.fn(async () => current),
    };
    const gate = new CapacityGate({
      provider,
      model: "provider/model",
      reserveUsd: "1",
      maxInputTokens: 100,
      maxOutputTokens: 10,
      staleAfterMs: 5_000,
      now: () => 1_000,
    });

    const open = await gate.refresh();
    expect(open.canServe).toBe(true);
    expect(open.worstCaseJobUsdNanos).toBe(120_000_000n);
    expect(open.sellableUsdNanos).toBe(1_000_000_000n);
    expect(open.availableJobs).toBe(8n);

    current = reading(1_100_000_000n);
    const closed = await gate.refresh();
    expect(closed.canServe).toBe(false);
    expect(closed.reason).toBe("insufficient_for_job");
  });

  it("fails closed when the provider check fails", async () => {
    const provider: CapacityProvider = {
      id: "openrouter",
      readCapacity: vi.fn(async () => {
        throw new Error("provider down");
      }),
    };
    const gate = new CapacityGate({
      provider,
      model: "provider/model",
      reserveUsd: "0",
      maxInputTokens: 10,
      maxOutputTokens: 10,
      staleAfterMs: 5_000,
    });
    const snapshot = await gate.refresh();
    expect(snapshot.canServe).toBe(false);
    expect(snapshot.reason).toBe("provider_unavailable");
  });
});

describe("OpenRouterCapacityProvider", () => {
  it("reads a capped key and rounds model prices up", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/key")) {
        return new Response(JSON.stringify({
          data: { limit: 5, limit_remaining: 4.5, limit_reset: "monthly" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: [{
          id: "provider/model",
          pricing: { prompt: "0.00000007952", completion: "0.00000015904" },
        }],
      }), { status: 200 });
    });
    const provider = new OpenRouterCapacityProvider({
      baseUrl: "https://openrouter.ai/api",
      apiKey: "secret",
      timeoutMs: 1_000,
      fetchFn: fetchFn as typeof fetch,
      now: () => 123,
    });
    const result = await provider.readCapacity("provider/model");
    expect(result.keyRemainingUsdNanos).toBe(4_499_999_999n);
    expect(result.pricing.promptUsdNanosPerToken).toBe(80n);
    expect(result.pricing.completionUsdNanosPerToken).toBe(160n);
  });

  it("rejects an uncapped inference key", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/key")) {
        return new Response(JSON.stringify({
          data: { limit: null, limit_remaining: null, limit_reset: null },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const provider = new OpenRouterCapacityProvider({
      baseUrl: "https://openrouter.ai/api",
      apiKey: "secret",
      timeoutMs: 1_000,
      fetchFn: fetchFn as typeof fetch,
    });
    await expect(provider.readCapacity("provider/model")).rejects.toThrow(/finite/);
  });
});
