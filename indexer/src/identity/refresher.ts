/**
 * indexer/src/identity/refresher.ts — keeps the identity facts of new adverts current.
 *
 * For each agent_id that an Active new advert names (with a creating
 * transaction signed by the supplier and a live record output at the identity
 * address), the refresher asks the identity gateway (gateway.ts) and stores
 * the answer in `identity_facts`. The listing rule reads only stored answers.
 *
 * Schedule:
 *   - an answer is asked again after `refreshMs` (default 60 s): confirmations,
 *     holds and party periods change the effective status over time;
 *   - a record change that the follower sees invalidates the stored answer at
 *     once (the worker writes `invalidated_at`), and the refresher asks again
 *     after SETTLE_MS, so that the gateway has read the block too;
 *   - when the gateway does not answer, the refresher asks again after
 *     RETRY_MS. The last answer counts for at most 10 minutes from its
 *     request (listing/rule.ts); then the adverts are not listed. Both events
 *     are logged once per outage.
 */

import type { SqliteCache } from "../db/cache.js";
import { IDENTITY_RESULT_MAX_AGE_MS, type IdentityFacts } from "../listing/rule.js";
import type { GatewayOutcome, ResolveIdentity } from "./gateway.js";

export const DEFAULT_REFRESH_MS = 60_000;
/** Delay after a record change before the gateway is asked (about one block). */
export const SETTLE_MS = 20_000;
/** Delay before the next request after the gateway did not answer. */
export const RETRY_MS = 15_000;
const TICK_MS = 5_000;
const CONCURRENCY = 4;

export type RefresherLog = (level: "warn" | "info", message: string) => void;

export interface IdentityRefresherOpts {
  cache: Pick<SqliteCache, "listIdentityAgentsToResolve" | "getIdentityFacts" | "saveIdentityFacts">;
  resolve: ResolveIdentity;
  refreshMs?: number;
  now?: () => number;
  log?: RefresherLog;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class IdentityRefresher {
  private readonly cache: IdentityRefresherOpts["cache"];
  private readonly resolve: ResolveIdentity;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly log: RefresherLog;
  /** Earliest time of the next request, after a failure or a record change. */
  private readonly nextAttempt = new Map<string, number>();
  /** Start of the current outage, per agent. */
  private readonly failingSince = new Map<string, number>();
  private readonly expiryLogged = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(opts: IdentityRefresherOpts) {
    this.cache = opts.cache;
    this.resolve = opts.resolve;
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((level, message) => console[level](message));
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tickOnce();
    this.timer = setInterval(() => void this.tickOnce(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The follower saw these records change: ask the gateway again after SETTLE_MS. */
  invalidate(agentIds: readonly string[]): void {
    const at = this.now() + SETTLE_MS;
    for (const id of agentIds) this.nextAttempt.set(id, at);
  }

  /** One pass over the agents that are due. A pass that is still running is joined, not repeated. */
  tickOnce(): Promise<void> {
    if (this.running === null) {
      this.running = this.runPass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runPass(): Promise<void> {
    const now = this.now();
    const agents = this.cache.listIdentityAgentsToResolve();
    const facts = this.cache.getIdentityFacts(agents);
    const due = agents.filter((id) => {
      const next = this.nextAttempt.get(id);
      if (next !== undefined) return now >= next;
      const f = facts.get(id);
      return f === undefined || f.invalidated_at !== null || now - f.resolved_at >= this.refreshMs;
    });
    let cursor = 0;
    const lane = async (): Promise<void> => {
      while (cursor < due.length) {
        const id = due[cursor++]!;
        await this.resolveOne(id, facts.get(id) ?? null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, lane));
  }

  private async resolveOne(agentId: string, previous: IdentityFacts | null): Promise<void> {
    const startedAt = this.now();
    const scheduled = this.nextAttempt.get(agentId);
    let outcome: GatewayOutcome;
    try {
      outcome = await this.resolve(agentId);
    } catch (err) {
      outcome = { kind: "unavailable", error: (err as Error).message };
    }
    if (outcome.kind === "unavailable") {
      this.onFailure(agentId, previous, outcome.error);
      return;
    }
    this.cache.saveIdentityFacts(
      outcome.kind === "found"
        ? {
            agent_id: agentId,
            found: 1,
            effective: outcome.identity.effective,
            independent: outcome.identity.independent ? 1 : 0,
            origin: outcome.identity.origin,
            transaction_keys: JSON.stringify(outcome.identity.transactionKeys),
            capabilities: JSON.stringify(outcome.identity.capabilities),
            detail: null,
            resolved_at: startedAt,
          }
        : {
            agent_id: agentId,
            found: 0,
            effective: null,
            independent: 0,
            origin: null,
            transaction_keys: "[]",
            capabilities: "[]",
            detail: outcome.detail,
            resolved_at: startedAt,
          },
    );
    // A record change seen during the request keeps its own, later re-check.
    if (this.nextAttempt.get(agentId) === scheduled) this.nextAttempt.delete(agentId);
    if (this.failingSince.delete(agentId)) {
      this.log("info", `[identity] the identity gateway answers again for did:vector:${agentId}`);
    }
    this.expiryLogged.delete(agentId);
  }

  private onFailure(agentId: string, previous: IdentityFacts | null, error: string): void {
    const now = this.now();
    this.nextAttempt.set(agentId, now + RETRY_MS);
    const usable = previous !== null && previous.invalidated_at === null;
    if (!this.failingSince.has(agentId)) {
      this.failingSince.set(agentId, now);
      this.log(
        "warn",
        usable
          ? `[identity] the identity gateway did not answer for did:vector:${agentId} (${error}); ` +
              `the answer from ${iso(previous.resolved_at)} counts until ${iso(previous.resolved_at + IDENTITY_RESULT_MAX_AGE_MS)}`
          : `[identity] the identity gateway did not answer for did:vector:${agentId} (${error}); ` +
              `its adverts are not listed until it answers`,
      );
    }
    if (usable && now - previous.resolved_at > IDENTITY_RESULT_MAX_AGE_MS && !this.expiryLogged.has(agentId)) {
      this.expiryLogged.add(agentId);
      this.log(
        "warn",
        `[identity] the identity gateway has not answered for did:vector:${agentId} since ${iso(this.failingSince.get(agentId)!)}; ` +
          `the last answer (${iso(previous.resolved_at)}) is older than 10 minutes, so its adverts are not listed`,
      );
    }
  }
}
