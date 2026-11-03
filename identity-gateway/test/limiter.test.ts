// The Koios limiter (chain/limiter.ts): one rate, one concurrency limit and one pause after HTTP
// 429 for every Koios call of the process; calls for requests start before background calls.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KoiosClient } from "../src/chain/koios.js";
import { KoiosLimiter, RateLimited, inBackground, retryAfterMs } from "../src/chain/limiter.js";

const T0 = Date.UTC(2026, 10, 3, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const since = (): number => Date.now() - T0;
const tooMany = (retryAfter: number | null = null): RateLimited => new RateLimited("Koios GET tip answered HTTP 429", retryAfter);

describe("rate and concurrency", () => {
  test("after a burst, calls start at the average rate", async () => {
    const limiter = new KoiosLimiter({ ratePerSecond: 2, burst: 2, maxConcurrent: 10 });
    const starts: number[] = [];
    const calls = Array.from({ length: 6 }, () => limiter.run(async () => void starts.push(since())));
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(calls);
    expect(starts).toEqual([0, 0, 500, 1_000, 1_500, 2_000]);
  });

  test("at most maxConcurrent calls run at the same time", async () => {
    const limiter = new KoiosLimiter({ ratePerSecond: 100, burst: 100, maxConcurrent: 2 });
    let running = 0;
    let most = 0;
    const calls = Array.from({ length: 6 }, () =>
      limiter.run(async () => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 100));
        running--;
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(calls);
    expect(most).toBe(2);
  });

  test("a call for a request starts before the background calls that wait", async () => {
    const limiter = new KoiosLimiter({ ratePerSecond: 1, burst: 1 });
    const order: string[] = [];
    const background = inBackground(() => Promise.all(["b1", "b2", "b3"].map((name) => limiter.run(async () => void order.push(name)))));
    const request = limiter.run(async () => void order.push("request"));
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([background, request]);
    expect(order).toEqual(["b1", "request", "b2", "b3"]);
  });
});

describe("HTTP 429", () => {
  test("without Retry-After, no call starts for 10 s; then the refused call goes alone, and a further 429 doubles the pause", async () => {
    const limiter = new KoiosLimiter({ ratePerSecond: 100, burst: 100 });
    const events: string[] = [];
    let refusals = 2;
    const first = limiter.run(async () => {
      events.push(`a ${since()}`);
      if (refusals-- > 0) throw tooMany();
      return "a";
    }, "background");
    await vi.advanceTimersByTimeAsync(0);
    const second = limiter.run(async () => {
      events.push(`b ${since()}`);
      return "b";
    }, "background");
    await vi.advanceTimersByTimeAsync(40_000);
    expect([await first, await second]).toEqual(["a", "b"]);
    expect(events).toEqual(["a 0", "a 10000", "a 30000", "b 30000"]);
  });

  test("calls that were running when the pause began do not make it longer", async () => {
    const limiter = new KoiosLimiter({ ratePerSecond: 100, burst: 100 });
    const starts: number[] = [];
    const refused = new Set<number>();
    const calls = [0, 1, 2, 3].map((i) =>
      limiter.run(async () => {
        starts.push(since());
        await new Promise((resolve) => setTimeout(resolve, 10 * i + 5));
        if (!refused.has(i)) {
          refused.add(i);
          throw tooMany();
        }
      }, "background"),
    );
    await vi.advanceTimersByTimeAsync(11_000);
    await Promise.all(calls);
    // Refusals at 5, 15, 25 and 35 ms make one 10 s pause from the first one (not 10 + 20 + 40 +
    // 60 s). Then the first call goes alone, and the others follow its success.
    expect(starts).toEqual([0, 0, 0, 0, 10_005, 10_010, 10_010, 10_010]);
  });

  test("Retry-After sets the pause: delta-seconds or an HTTP date", async () => {
    expect(retryAfterMs("120", T0)).toBe(120_000);
    expect(retryAfterMs(new Date(T0 + 5_000).toUTCString(), T0)).toBe(5_000);
    expect(retryAfterMs(new Date(T0 - 5_000).toUTCString(), T0)).toBe(0);
    expect(retryAfterMs("soon", T0)).toBeNull();
    expect(retryAfterMs(null, T0)).toBeNull();

    const limiter = new KoiosLimiter({ ratePerSecond: 100, burst: 100 });
    const starts: number[] = [];
    const call = limiter.run(async () => {
      starts.push(since());
      if (starts.length === 1) throw tooMany(3_000);
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await call;
    expect(starts).toEqual([0, 3_000]);
  });

  test("a request waits out a short pause and fails at once in a long one; background calls wait out both", async () => {
    const limiter = new KoiosLimiter({ ratePerSecond: 100, burst: 100, maxRequestWaitMs: 15_000 });
    // A 429 without Retry-After: a 10 s pause, which a request waits out.
    let refused = false;
    const background = limiter.run(async () => {
      if (!refused) {
        refused = true;
        throw tooMany();
      }
      return since();
    }, "background");
    await vi.advanceTimersByTimeAsync(0);
    const request = limiter.run(async () => since(), "request");
    await vi.advanceTimersByTimeAsync(10_000);
    expect([await request, await background]).toEqual([10_000, 10_000]);

    // A Retry-After of 120 s: a request fails at once with the refusal.
    const refusal = tooMany(120_000);
    let again = false;
    const waiting = limiter.run(async () => {
      if (!again) {
        again = true;
        throw refusal;
      }
      return since();
    }, "background");
    await vi.advanceTimersByTimeAsync(0);
    await expect(limiter.run(async () => "not run", "request")).rejects.toBe(refusal);
    expect(since()).toBe(10_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await waiting).toBe(130_000);
  });

  test("a call refused maxAttempts times fails with the refusal", async () => {
    const limiter = new KoiosLimiter({ ratePerSecond: 100, burst: 100, maxAttempts: 3, backoffMs: 1_000 });
    let attempts = 0;
    const outcome = limiter
      .run(async () => {
        attempts++;
        throw tooMany();
      }, "background")
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBeInstanceOf(RateLimited);
    expect(attempts).toBe(3);
  });
});

describe("KoiosClient", () => {
  const tipRow = { hash: "aa".repeat(32), abs_slot: 37_146_463, block_height: 9_162_036 };

  test("an HTTP 429 page without Retry-After pauses the client's calls, and the call is made again", async () => {
    const answers = [
      () => new Response("<html><body><h1>429 Too Many Requests</h1></body></html>", { status: 429, headers: { "content-type": "text/html" } }),
      () => Response.json([tipRow]),
      () => Response.json([tipRow]),
    ];
    const asked: number[] = [];
    const client = new KoiosClient({
      baseUrl: "https://koios.test/api/v1",
      fetch: (async () => {
        asked.push(since());
        return answers.shift()!();
      }) as typeof fetch,
      limiter: new KoiosLimiter(),
    });
    const first = client.get("tip");
    await vi.advanceTimersByTimeAsync(0);
    const second = client.get("tip");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(asked).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect([await first, await second]).toEqual([[tipRow], [tipRow]]);
    expect(asked).toEqual([0, 10_000, 10_000]);
  });

  test("the last refusal names the endpoint, as other HTTP errors do", async () => {
    const client = new KoiosClient({
      baseUrl: "https://koios.test/api/v1",
      fetch: (async () => new Response("", { status: 429, headers: { "retry-after": "1" } })) as typeof fetch,
      limiter: new KoiosLimiter({ maxAttempts: 2 }),
    });
    const outcome = client.post("asset_txs?x=1", { _asset_name: "secret" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as Error).message).toBe("Koios POST asset_txs answered HTTP 429");
  });
});
