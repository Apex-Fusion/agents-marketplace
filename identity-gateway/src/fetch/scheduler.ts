// The background jobs of Part 2 Section 8.5: a periodic scan reads the current record (the view
// without options) of every identifier, and starts a check for each record whose effective status
// is Active when it has no facts yet, after each record change, and when its last check is due again.
// A check detects the endpoint's protocol and verifies the record's domains. It is due again a day
// after it ended, and sooner when its detection found no protocol (`recheckDelayMs`): the endpoint
// can go live at any moment, and the ledger does not say when. Requests never start a check; they
// read the facts store. A scan is one pass over the records (one tip; resolver.ts), and its Koios
// reads go in the background lane (chain/limiter.ts), after the reads of requests.

import { inBackground } from "../chain/limiter.js";
import type { RecordList } from "../resolve/records.js";
import { PassFailed, type CurrentLookup, type CurrentRecord } from "../resolve/resolver.js";
import type { Clock } from "./clock.js";
import { detectProtocol } from "./detect.js";
import { FactsStore, changeKey, factInputs, type FactInputs, type RecordFacts } from "./facts.js";
import type { SafeFetcher } from "./fetcher.js";
import { checkDomain, type DomainCheck, type TxtLookup } from "./linkage.js";

/** The resolver calls that the scan needs (VectorResolver implements them). */
export interface RecordSource {
  listRecords(): Promise<RecordList>;
  /** With `at`: as of the tip of that list, in one pass over its records. */
  currentRecord(vectorId: string, at?: RecordList): Promise<CurrentLookup>;
}

export interface CheckDeps {
  readonly fetcher: SafeFetcher;
  readonly txt: TxtLookup;
  readonly clock: Clock;
}

/**
 * One background check of a record: protocol detection, then each domain in order. Never throws.
 * `previous` is the facts of the record before this check: the failed checks in a row count only for
 * one state of the record.
 */
export async function checkRecord(deps: CheckDeps, record: CurrentRecord, inputs: FactInputs, previous?: RecordFacts): Promise<RecordFacts> {
  const checkedAt = deps.clock.now();
  const detection = inputs.endpoint === null ? null : await detectProtocol(deps.fetcher, inputs.endpoint, checkedAt);
  const domains: DomainCheck[] = [];
  for (const domain of inputs.domains) domains.push(await checkDomain(deps, domain, inputs.subject, deps.clock.now()));
  const key = changeKey(record);
  const failedChecks = detection !== null && detection.protocol === null ? (previous?.changeKey === key ? previous.failedChecks : 0) + 1 : 0;
  return { vectorId: record.vectorId, changeKey: key, checkedAt, endedAt: deps.clock.now(), failedChecks, detection, domains };
}

export interface ListingSnapshot {
  /** End of the scan that read the records (POSIX ms); null before the first scan. */
  readonly scannedAt: number | null;
  /** The current record of every identifier that resolves, in ledger order of its first mint. */
  readonly records: readonly CurrentRecord[];
}

export interface SchedulerOptions {
  /** Default 600 s. */
  readonly scanIntervalMs?: number;
  /** The wait after a check that found a protocol, and the longest wait after one that found none. Default one day (Part 2 Section 8.5). */
  readonly recheckMs?: number;
  /** Records read at the same time during a scan. Default 4. */
  readonly scanConcurrency?: number;
  readonly log?: (message: string) => void;
}

export const DAY_MS = 86_400_000;

/** The wait before the first repeat of a check whose detection found no protocol. */
export const FIRST_RETRY_MS = 600_000;

/**
 * How long after a check ended the next check is due. After a check that found a protocol, or had no
 * endpoint to check, it is `recheckMs`. After a check whose detection found no protocol it is shorter:
 * FIRST_RETRY_MS after the first such check, then twice as long after each further one in a row, and
 * never more than `recheckMs`. Without this, an endpoint that goes live just after a check (a card
 * published a few minutes late, a host that was down for a moment) stays unlisted for a day.
 */
export function recheckDelayMs(facts: Pick<RecordFacts, "detection" | "failedChecks">, recheckMs: number): number {
  if (facts.detection === null || facts.detection.protocol !== null) return recheckMs;
  return Math.min(recheckMs, FIRST_RETRY_MS * 2 ** (Math.max(1, facts.failedChecks) - 1));
}

export class FetchScheduler {
  private readonly scanIntervalMs: number;
  private readonly recheckMs: number;
  private readonly scanConcurrency: number;
  private readonly log: (message: string) => void;
  private readonly jobs = new Map<string, Promise<void>>();
  private last: ListingSnapshot = { scannedAt: null, records: [] };
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly source: RecordSource,
    private readonly store: FactsStore,
    private readonly deps: CheckDeps & { readonly legacyPolicyId: string },
    options: SchedulerOptions = {},
  ) {
    this.scanIntervalMs = options.scanIntervalMs ?? 600_000;
    this.recheckMs = options.recheckMs ?? DAY_MS;
    this.scanConcurrency = options.scanConcurrency ?? 4;
    this.log = options.log ?? ((message) => console.error(message));
  }

  /** The records of the last scan, for the catalogs. */
  get snapshot(): ListingSnapshot {
    return this.last;
  }

  /** Records whose check runs now. */
  get checking(): readonly string[] {
    return [...this.jobs.keys()];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          await inBackground(() => this.scan());
        } catch (e) {
          this.log(`identity-gateway: background scan failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (this.running) await this.deps.clock.sleep(this.scanIntervalMs);
      }
    })();
  }

  /** Stops the scans after the current one. Running checks end on their own. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** Resolves when no check runs (for tests and orderly shutdown). */
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.all(this.jobs.values());
  }

  /**
   * One scan: reads every current record and starts the checks that are due. When the pass itself
   * fails (PassFailed), the scan fails and the records of the last scan stay.
   */
  async scan(): Promise<{ readonly records: number; readonly started: readonly string[] }> {
    const list = await this.source.listRecords();
    const { entries } = list;
    const found: Array<CurrentRecord | null> = new Array<CurrentRecord | null>(entries.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < entries.length; i = next++) {
        try {
          const lookup = await this.source.currentRecord(entries[i]!.vectorId, list);
          if (lookup.found) found[i] = lookup.record;
        } catch (e) {
          if (e instanceof PassFailed) throw e;
          this.log(`identity-gateway: background scan could not read a record: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.scanConcurrency, entries.length) }, worker));
    const records = found.filter((r): r is CurrentRecord => r !== null);
    const now = this.deps.clock.now();
    this.last = { scannedAt: now, records };

    const present = new Set(entries.map((e) => e.vectorId));
    for (const id of this.store.ids()) if (!present.has(id)) this.store.delete(id);

    const started: string[] = [];
    for (const record of records) {
      if (record.effective.status !== "active" || this.jobs.has(record.vectorId)) continue;
      const facts = this.store.get(record.vectorId);
      if (facts && facts.changeKey === changeKey(record) && now < facts.endedAt + recheckDelayMs(facts, this.recheckMs)) continue;
      started.push(record.vectorId);
      const job = checkRecord(this.deps, record, factInputs(record, this.deps.legacyPolicyId), facts)
        .then((result) => {
          this.store.set(result);
          this.logNoProtocol(result);
        })
        .catch((e: unknown) => this.log(`identity-gateway: background check failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => this.jobs.delete(record.vectorId));
      this.jobs.set(record.vectorId, job);
    }
    return { records: records.length, started };
  }

  /**
   * One log line for a check whose detection found no protocol, so that an operator can see why an agent
   * is not listed. It names the host and the failure, never a DID. The failure text can come from the
   * network, so the line keeps printable ASCII only.
   */
  private logNoProtocol(facts: RecordFacts): void {
    const { detection } = facts;
    if (detection === null || detection.protocol !== null) return;
    let host: string;
    try {
      host = new URL(detection.endpoint).host;
    } catch {
      host = "an endpoint that is not a URL";
    }
    const reason = (detection.failure ?? "no check succeeded").replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
    const minutes = Math.round(recheckDelayMs(facts, this.recheckMs) / 60_000);
    this.log(`identity-gateway: background check found no protocol at ${host} (${reason}); the next check is in ${minutes} minutes`);
  }
}
