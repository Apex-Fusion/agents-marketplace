// The background jobs of Part 2 Section 8.5: a periodic scan reads the current record (the view
// without options) of every identifier, and starts a check for each record whose effective status
// is Active when it has no facts yet, after each record change, and when its facts are a day old.
// A check detects the endpoint's protocol and verifies the record's domains. Requests never start a
// check; they read the facts store. A scan is one pass over the records (one tip; resolver.ts), and
// its Koios reads go in the background lane (chain/limiter.ts), after the reads of requests.

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

/** One background check of a record: protocol detection, then each domain in order. Never throws. */
export async function checkRecord(deps: CheckDeps, record: CurrentRecord, inputs: FactInputs): Promise<RecordFacts> {
  const checkedAt = deps.clock.now();
  const detection = inputs.endpoint === null ? null : await detectProtocol(deps.fetcher, inputs.endpoint, checkedAt);
  const domains: DomainCheck[] = [];
  for (const domain of inputs.domains) domains.push(await checkDomain(deps, domain, inputs.subject, deps.clock.now()));
  return { vectorId: record.vectorId, changeKey: changeKey(record), checkedAt, detection, domains };
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
  /** Facts older than this are checked again. Default one day (Part 2 Section 8.5). */
  readonly recheckMs?: number;
  /** Records read at the same time during a scan. Default 4. */
  readonly scanConcurrency?: number;
  readonly log?: (message: string) => void;
}

export const DAY_MS = 86_400_000;

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
      if (facts && facts.changeKey === changeKey(record) && now - facts.checkedAt < this.recheckMs) continue;
      started.push(record.vectorId);
      const job = checkRecord(this.deps, record, factInputs(record, this.deps.legacyPolicyId))
        .then((result) => this.store.set(result))
        .catch((e: unknown) => this.log(`identity-gateway: background check failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => this.jobs.delete(record.vectorId));
      this.jobs.set(record.vectorId, job);
    }
    return { records: records.length, started };
  }
}
