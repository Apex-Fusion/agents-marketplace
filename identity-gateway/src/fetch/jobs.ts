// Starts the background jobs with the real DNS, HTTPS and clock.

import type { ResolverSettings } from "../resolve/settings.js";
import { systemClock } from "./clock.js";
import type { FactsStore } from "./facts.js";
import { SafeFetcher } from "./fetcher.js";
import { FetchScheduler, type RecordSource } from "./scheduler.js";
import { httpsTransport, systemLookup, systemTxtLookup } from "./transport.js";

export interface BackgroundJobsOptions {
  readonly scanIntervalMs: number;
  readonly log?: (message: string) => void;
}

export function startBackgroundJobs(source: RecordSource, facts: FactsStore, settings: ResolverSettings, options: BackgroundJobsOptions): FetchScheduler {
  const fetcher = new SafeFetcher({ lookup: systemLookup, transport: httpsTransport, clock: systemClock });
  const scheduler = new FetchScheduler(
    source,
    facts,
    { fetcher, txt: systemTxtLookup(), clock: systemClock, legacyPolicyId: settings.registries.legacy.policyId },
    { scanIntervalMs: options.scanIntervalMs, log: options.log },
  );
  scheduler.start();
  return scheduler;
}
