// The background read of the attestation outputs (Part 2 Section 4). A request never reads the
// ledger for the attestations: it filters the list of the last read (provenance.ts).
//
// A timer checks the tip every `refreshMs`. The Koios calls go in the background lane
// (chain/limiter.ts), after the calls of requests. A check makes these calls:
// - The tip is the same as at the last read: one call (the tip).
// - The tip is new, and no transaction touched the attestation address since 30 blocks below the tip
//   of the list: two calls (the tip, and `credential_txs` with `limit=1`, which answers `[]`). The
//   list moves to the new tip and keeps its outputs.
// - The tip is new, and a transaction touched the address: four calls for up to 999 outputs. These
//   are the tip, `credential_txs`, the limit check (`credential_utxos` with `offset=5000&limit=1`)
//   and one page of up to 1,000 outputs. Each further 1,000 outputs cost one more call. The first
//   read has no list, so it makes no `credential_txs` call: three calls.
// After a change, `credential_txs` keeps answering a row for 30 blocks, so a change makes about four
// reads at the default interval. With no change, a day at the default interval of 30 s makes at most
// 5,760 calls. A full build of the status lists makes about 2,300 calls.
//
// The limit is global, because the read takes every attestation output and anybody can make one. When
// the limit check finds a row at offset 5,000 (more than MAX_ATTESTATION_OUTPUTS outputs), the read
// fails at once and downloads nothing (1,000 rows are about 1.9 MB). The index then makes no call for
// 10 minutes (LIMIT_WAIT_MS). The list becomes 30 blocks old, and the resolver leaves out the member
// for every agent.
//
// The list keeps the tip that it was read at. A request filters the list at its own tip. The list
// serves a request only while the tip of the request is fewer than 30 blocks (CONFIRMATION_DEPTH)
// above the tip of the list. An attestation that has 30 confirmations at the tip of the request is
// in a block below the tip of the list, so the list holds it. So two resolvers at one tip show the
// same additions whenever they show the member. A revocation, a contest or a withdrawal can show up
// to 29 blocks late (at the usual rate of one block in 4 s, about 2 minutes). A failed read leaves
// the last list in place. The list then serves requests until its tip is 30 blocks behind.

import { inBackground } from "../chain/limiter.js";
import { TooManyOutputs, type ChainSource, type ChainTip, type UnspentOutput } from "../chain/types.js";
import type { VectorProvenance } from "./metadata.js";
import { attestationRows, provenanceOf, type AttestationRow, type ProvenanceSource, type ProvenanceTime } from "./provenance.js";
import { CONFIRMATION_DEPTH, type Registry } from "./settings.js";

/** The default of ATTESTATION_REFRESH_SECONDS. */
export const DEFAULT_ATTESTATION_REFRESH_MS = 30_000;
/** The range of ATTESTATION_REFRESH_SECONDS: 10 to 60 s. */
export const MIN_ATTESTATION_REFRESH_MS = 10_000;
export const MAX_ATTESTATION_REFRESH_MS = 60_000;
/** The most outputs that one read takes. Anybody can lock 5 AP3X in an attestation, so a read that has no end would have none. */
export const MAX_ATTESTATION_OUTPUTS = 5_000;
/** After a read that found more outputs than the limit, the next try waits this long. */
export const LIMIT_WAIT_MS = 600_000;
/** A failed read is logged at most this often. */
const FAILURE_LOG_INTERVAL_MS = 300_000;

/** The attestations of one read, by subject. */
interface AttestationList {
  /** The tip that the read started at. */
  readonly tip: ChainTip;
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
  /** After a read that found more outputs than the limit: the time before the next try, and the error. */
  private blocked: { readonly until: number; readonly error: TooManyOutputs } | null = null;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly chain: Pick<ChainSource, "tip" | "policyOutputs" | "policyChangedSince">,
    private readonly registry: Registry,
    options: AttestationIndexOptions = {},
  ) {
    this.refreshMs = options.refreshMs ?? DEFAULT_ATTESTATION_REFRESH_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
  }

  provenance(vectorId: string, at: ProvenanceTime): VectorProvenance | undefined {
    const list = this.list;
    // A list that is 30 or more blocks behind the tip of the request can miss an output that has 30 confirmations at that tip.
    if (list === null || at.tipHeight - list.tip.blockHeight >= CONFIRMATION_DEPTH) return undefined;
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
    if (this.blocked !== null && this.now() < this.blocked.until) throw this.blocked.error;
    const tip = await this.chain.tip();
    const list = this.list;
    if (list?.tip.blockHash === tip.blockHash) return;
    // The list stays right while no transaction touches the address. The question starts 30 blocks below the tip of
    // the list, so that a rollback of up to 30 blocks cannot hide a change.
    if (list !== null && !(await this.chain.policyChangedSince(this.registry.policyId, Math.max(0, list.tip.blockHeight - CONFIRMATION_DEPTH)))) {
      this.list = { ...list, tip };
      return;
    }
    let outputs: UnspentOutput[];
    try {
      outputs = await this.chain.policyOutputs(this.registry.policyId, MAX_ATTESTATION_OUTPUTS);
    } catch (e) {
      if (e instanceof TooManyOutputs) this.blocked = { until: this.now() + LIMIT_WAIT_MS, error: e };
      throw e;
    }
    const { rows, skipped } = attestationRows(outputs, this.registry);
    const bySubject = new Map<string, AttestationRow[]>();
    for (const row of rows) {
      const own = bySubject.get(row.datum.subject);
      if (own === undefined) bySubject.set(row.datum.subject, [row]);
      else own.push(row);
    }
    const changed = list === null || list.size !== rows.length || list.skipped !== skipped;
    this.list = { tip, bySubject, size: rows.length, skipped };
    if (changed) this.log(`identity-gateway: attestations: ${rows.length} at block ${tip.blockHeight}${skipped > 0 ? `, ${skipped} outputs that are not attestations` : ""}`);
  }
}
