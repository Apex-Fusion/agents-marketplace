// Time for the background jobs. Tests inject a clock whose sleep advances time at once.

import { setTimeout as delay } from "node:timers/promises";

export interface Clock {
  /** POSIX milliseconds. */
  now(): number;
  /** Resolves after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => delay(ms),
};
