// One limit for every Koios call of the process. The Koios of Vector answers HTTP 429 (a text/html
// page, without Retry-After) when it gets about 300 requests in 10 s, and it keeps refusing while
// the requests go on. Other clients get the same refusals at that time, so a client that goes over
// the limit stops more than its own work.
// - Rate: a token bucket, `ratePerSecond` calls per second on average and `burst` at once; at most
//   `maxConcurrent` calls at the same time.
// - Lanes: calls for a request (the default) start before background calls (`inBackground`: the
//   scan and the status-list builds). In each lane, calls start in call order.
// - HTTP 429: no call starts until the pause ends: the Retry-After of the answer when it has one,
//   else `backoffMs`, doubled after each further 429 up to `maxBackoffMs`. Then the refused call is
//   made again, at most `maxAttempts` times in all, and calls run one at a time until one succeeds:
//   a Koios that still refuses gets one request, not a burst. A request-lane call fails at once
//   when it would wait longer than `maxRequestWaitMs` for the end of a pause.

import { AsyncLocalStorage } from "node:async_hooks";

export type KoiosLane = "request" | "background";

const lanes = new AsyncLocalStorage<KoiosLane>();

/** Runs `work`; its Koios calls (also those of promises that it starts) go in the background lane. */
export function inBackground<T>(work: () => Promise<T>): Promise<T> {
  return lanes.run("background", work);
}

/** The lane of the calls that the current code makes. */
export const currentLane = (): KoiosLane => lanes.getStore() ?? "request";

/** An HTTP 429 answer. `retryAfterMs`: its Retry-After, null when it has none. */
export class RateLimited extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "RateLimited";
  }
}

/** Retry-After (RFC 9110 Section 10.2.3): delay-seconds or an HTTP date. Null when absent or not valid. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export interface KoiosLimits {
  readonly ratePerSecond: number;
  readonly burst: number;
  readonly maxConcurrent: number;
  /** The pause after an HTTP 429 without Retry-After; doubled after each further 429. */
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
  /** A request-lane call fails instead of waiting longer than this for the end of a pause. */
  readonly maxRequestWaitMs: number;
  /** Attempts of one call: the first one and the repetitions after HTTP 429. */
  readonly maxAttempts: number;
}

/** A third of the measured limit (about 300 requests in 10 s), so the gateway leaves room for other clients. */
export const DEFAULT_KOIOS_LIMITS: KoiosLimits = {
  ratePerSecond: 10,
  burst: 20,
  maxConcurrent: 4,
  backoffMs: 10_000,
  maxBackoffMs: 60_000,
  maxRequestWaitMs: 15_000,
  maxAttempts: 5,
};

/** A call that waits for its turn: `start` lets it go, `fail` ends it without a call. */
interface Waiter {
  /** The call's place in call order; a repeated call keeps it. */
  readonly order: number;
  readonly start: () => void;
  readonly fail: (error: Error) => void;
}

export class KoiosLimiter {
  readonly limits: KoiosLimits;
  private readonly queues: Record<KoiosLane, Waiter[]> = { request: [], background: [] };
  private tokens: number;
  private refilledAt: number;
  private running = 0;
  private calls = 0;
  private pausedUntil = 0;
  /** When the current pause began; a 429 of a call that started before it belongs to the same pause. */
  private pausedAt = -Infinity;
  /** Pauses in a row, without a successful call in between. */
  private strikes = 0;
  private lastRefusal: RateLimited | null = null;
  private timer: NodeJS.Timeout | undefined;
  private timerAt = Infinity;

  constructor(limits: Partial<KoiosLimits> = {}) {
    this.limits = { ...DEFAULT_KOIOS_LIMITS, ...limits };
    const { ratePerSecond, burst, maxConcurrent, maxAttempts } = this.limits;
    if (!(ratePerSecond > 0) || !(burst >= 1) || !(maxConcurrent >= 1) || !(maxAttempts >= 1)) throw new Error("Koios limits must be positive");
    this.tokens = burst;
    this.refilledAt = Date.now();
  }

  /**
   * Runs `call` when the limits let it start; `call` throws `RateLimited` for an HTTP 429 answer.
   * The lane is the caller's (`inBackground`) unless given.
   */
  async run<T>(call: () => Promise<T>, lane: KoiosLane = currentLane()): Promise<T> {
    const order = this.calls++;
    for (let attempt = 1; ; attempt++) {
      await this.turn(lane, order);
      const startedAt = Date.now();
      try {
        const result = await call();
        this.strikes = 0;
        return result;
      } catch (e) {
        if (!(e instanceof RateLimited)) throw e;
        this.refused(e, startedAt);
        if (attempt >= this.limits.maxAttempts) throw e;
      } finally {
        this.running--;
        this.pump();
      }
    }
  }

  /** Resolves when this call may start (and counts it as running). Node 20 has no Promise.withResolvers. */
  private turn(lane: KoiosLane, order: number): Promise<void> {
    return new Promise<void>((start, fail) => {
      const queue = this.queues[lane];
      let at = queue.length;
      while (at > 0 && queue[at - 1]!.order > order) at--;
      queue.splice(at, 0, { order, start, fail });
      this.pump();
    });
  }

  private refused(e: RateLimited, startedAt: number): void {
    const now = Date.now();
    this.lastRefusal = e;
    // A call that was running when the current pause began was refused for the same reason: the
    // pause stays, unless the answer asks for a longer one.
    if (startedAt <= this.pausedAt && now < this.pausedUntil) {
      if (e.retryAfterMs !== null) this.pausedUntil = Math.max(this.pausedUntil, now + e.retryAfterMs);
      return;
    }
    this.strikes++;
    this.pausedAt = now;
    const backoff = Math.min(this.limits.maxBackoffMs, this.limits.backoffMs * 2 ** (this.strikes - 1));
    this.pausedUntil = Math.max(this.pausedUntil, now + (e.retryAfterMs ?? backoff));
  }

  private pump(): void {
    for (;;) {
      const now = Date.now();
      const paused = now < this.pausedUntil;
      if (paused) this.failLongRequestWaits(now);
      const queue = this.queues.request.length > 0 ? this.queues.request : this.queues.background;
      const concurrent = this.strikes > 0 ? 1 : this.limits.maxConcurrent;
      if (queue.length === 0 || this.running >= concurrent) return;
      if (paused) return this.wakeAt(this.pausedUntil);
      this.refill(now);
      if (this.tokens < 1) return this.wakeAt(now + Math.ceil(((1 - this.tokens) * 1000) / this.limits.ratePerSecond));
      this.tokens -= 1;
      this.running++;
      queue.shift()!.start();
    }
  }

  /** Request-lane calls do not wait out a long pause: they fail with the refusal that started it. */
  private failLongRequestWaits(now: number): void {
    if (this.pausedUntil - now <= this.limits.maxRequestWaitMs || this.queues.request.length === 0) return;
    const error = this.lastRefusal ?? new RateLimited("Koios answered HTTP 429", null);
    for (const waiter of this.queues.request.splice(0)) waiter.fail(error);
  }

  private refill(now: number): void {
    const { ratePerSecond, burst } = this.limits;
    this.tokens = Math.min(burst, this.tokens + ((now - this.refilledAt) * ratePerSecond) / 1000);
    this.refilledAt = now;
  }

  private wakeAt(at: number): void {
    if (this.timer !== undefined && this.timerAt <= at) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, Math.max(0, at - Date.now()));
    this.timer.unref();
  }
}
