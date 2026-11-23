// The background read of the attestation outputs (Part 2 Section 4). A request never reads the
// ledger for the attestations: it filters the list of the last read (provenance.ts).
//
// A timer reads the tip every `refreshMs`. When the tip is a new one, it reads every unspent output
// at the attestation address that holds an attestation token, and keeps them in memory by subject.
// That read is one Koios call for each page of 1,000 outputs, and at least one. So a read costs two
// calls for up to 999 attestations (the tip, then the page), and one call when the tip is the same
// as at the last read. The calls go in the background lane (chain/limiter.ts), after the calls of
// requests. With the default interval of 30 s that is at most 5,760 calls in a day. A full build of
// the status lists makes about 2,300 calls.
//
// The list keeps the tip that it was read at. A request filters the list at its own tip, and the
// list can be one interval behind that tip. A new attestation shows after 30 confirmations
// (provenance.ts). At the usual rate of one block in 4 s that is about 2 minutes, which is more than
// the default interval, so the delay of the read does not decide when it shows. A revocation or a
// contest can show up to one interval later on one resolver than on another.
// A failed read leaves the last list in place. A list serves requests only while the block time of
// the tip of the request is at most MAX_LIST_AGE_MS after the block time of its own tip.

import { inBackground } from "../chain/limiter.js";
import type { ChainSource, ChainTip } from "../chain/types.js";
import type { VectorProvenance } from "./metadata.js";
import { attestationRows, provenanceOf, type AttestationRow, type ProvenanceSource, type ProvenanceTime } from "./provenance.js";
import type { NetworkParameters, Registry } from "./settings.js";
import { blockTimeMs } from "./time.js";

/** The default of ATTESTATION_REFRESH_SECONDS. */
export const DEFAULT_ATTESTATION_REFRESH_MS = 30_000;
/** The range of ATTESTATION_REFRESH_SECONDS: 10 to 300 s. */
export const MIN_ATTESTATION_REFRESH_MS = 10_000;
export const MAX_ATTESTATION_REFRESH_MS = 300_000;
/** The most outputs that one read takes. Anybody can lock 5 AP3X in an attestation, so a read that has no end would have none. */
export const MAX_ATTESTATION_OUTPUTS = 5_000;
/** A list serves requests while the block time of their tip is at most this long (1 hour, as a status list) after the block time of its own tip. */
export const MAX_LIST_AGE_MS = 3_600_000;
/** A failed read is logged at most this often. */
const FAILURE_LOG_INTERVAL_MS = 300_000;

/** The attestations of one read, by subject. */
interface AttestationList {
  /** The tip that the read started at. */
  readonly tip: ChainTip;
  /** The block time of that tip (POSIX ms). */
  readonly timeMs: number;
  readonly bySubject: ReadonlyMap<string, readonly AttestationRow[]>;
  readonly size: number;
  /** Outputs that hold the token and are not attestations. */
  readonly skipped: number;
}

export interface AttestationIndexOptions {
  /** Time between reads; default DEFAULT_ATTESTATION_REFRESH_MS. */
  readonly refreshMs?: number;
  /** POSIX milliseconds; default Date.now. */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export class AttestationIndex implements ProvenanceSource {
  private list: AttestationList | null = null;
  private reading: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private failing = false;
  private failureLoggedAt = -Infinity;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly chain: Pick<ChainSource, "tip" | "policyOutputs">,
    private readonly registry: Registry,
    private readonly network: NetworkParameters,
    options: AttestationIndexOptions = {},
  ) {
    this.refreshMs = options.refreshMs ?? DEFAULT_ATTESTATION_REFRESH_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
  }

  provenance(vectorId: string, at: ProvenanceTime): VectorProvenance | undefined {
    const list = this.list;
    if (list === null || at.timeMs - list.timeMs > MAX_LIST_AGE_MS) return undefined;
    return provenanceOf(list.bySubject.get(vectorId) ?? [], at);
  }

  /**
   * Reads the outputs now when the tip is a new one, or joins the read that runs. A failed read
   * throws and leaves the last list in place.
   */
  refresh(): Promise<void> {
    this.reading ??= inBackground(() => this.read()).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  /** Starts the first read at once, and then one every interval. The timer does not keep the process alive. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.refreshMs);
    this.timer.unref();
    this.log(`identity-gateway: attestations: the background read checks the tip every ${this.refreshMs / 1000} s`);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    try {
      await this.refresh();
      if (this.failing) this.log("identity-gateway: attestations: the background read works again");
      this.failing = false;
    } catch (e) {
      this.failing = true;
      const now = this.now();
      if (now - this.failureLoggedAt >= FAILURE_LOG_INTERVAL_MS) {
        this.failureLoggedAt = now;
        this.log(`identity-gateway: attestations: the background read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async read(): Promise<void> {
    const tip = await this.chain.tip();
    if (this.list?.tip.blockHash === tip.blockHash) return;
    const outputs = await this.chain.policyOutputs(this.registry.policyId, MAX_ATTESTATION_OUTPUTS);
    const { rows, skipped } = attestationRows(outputs, this.registry);
    const bySubject = new Map<string, AttestationRow[]>();
    for (const row of rows) {
      const own = bySubject.get(row.datum.subject);
      if (own === undefined) bySubject.set(row.datum.subject, [row]);
      else own.push(row);
    }
    const changed = this.list === null || this.list.size !== rows.length || this.list.skipped !== skipped;
    this.list = { tip, timeMs: blockTimeMs(tip.slot, this.network), bySubject, size: rows.length, skipped };
    if (changed) this.log(`identity-gateway: attestations: ${rows.length} at block ${tip.blockHeight}${skipped > 0 ? `, ${skipped} outputs that are not attestations` : ""}`);
  }
}
