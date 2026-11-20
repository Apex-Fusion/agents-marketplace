// Status lists (Part 2 Sections 8.4 and 8.6). Each list has 131,072 entries: status-list index i is
// in list n = floor(i / 131,072) at position p = i mod 131,072. The index comes from the resolver
// core's `listRecords()`, and the status from the effective status of the view without options
// (`currentStatus`, which needs no legacy key search):
// - Revoked or Retired: revocation (Part 1 gives that status only after 30 confirmations, and the
//   bit is never cleared);
// - Suspended, also `deactivationPending`: suspension;
// - Active: neither.
// In the Token Status List, the entry of an agent also reads SUSPENDED while an access token whose
// status claim names it was revoked by a status change and can still be accepted (TokenRegistry
// `heldEntries`): else a revoked token would be valid again once a hold ends.
// The ledger point. The bits of the lists are the statuses as of one ledger tip: the tip that
// `listRecords()` read. `iat` and `validFrom` are the block time of that tip. They are not the time
// when the work ended. A list is valid for LIST_VALIDITY_MS after its ledger point (`exp`,
// `validUntil`). A request never gets a list after that time.
// Two things make the bits. Both read the ledger in the background lane (chain/limiter.ts), after
// the reads of requests.
// - A follow step. The lists follow the chain. The timer ticks every REFRESH_TICK_MS, and every
//   STATUS_LIST_FOLLOW_SECONDS it runs a step. A step is a pass (resolver.ts). It reads the new tip
//   and the list of records. Then it reads the effective status of each record that is not final and
//   of each record that has a new index.
//   A record is final when its status is Revoked or Retired. The identity contract allows only
//   Reclaim and SetSuccessor on an ended record. The history of a legacy record ends with the burn
//   of its token. So a step does not read a final record.
//   The status comes from `currentStatus`, as in a build. So the lists apply the rules of the
//   resolver itself. The end of a record and the lift of a hold wait for 30 confirmations. The end
//   of a hold depends on the block time of the tip. A subagent takes the status of its parent.
//   A pass keeps its ledger reads. So a step asks Koios again about a record only in three cases:
//   its tokens moved, its newest transaction has fewer than 30 confirmations, or no output holds its
//   tokens.
//   At most one step runs at a time. A step that fails leaves the lists as they are.
// - A full build. It is one pass over every record (one tip, kept ledger reads). It makes the first
//   lists, and it repairs the lists when the steps cannot. At most one build runs at a time. At most
//   one starts in each refresh interval (STATUS_LIST_REFRESH_SECONDS), also after a failed build. The
//   first build starts with the services. Three things start a build later:
//   the timer, when the last build ended as long ago as the background interval
//   (STATUS_LIST_BACKGROUND_REFRESH_SECONDS), also when no request comes; a request that finds
//   lists that no step and no build has read from the chain for longer than the refresh interval (or
//   two follow intervals, when that is longer), which means that the steps fail; and a step that finds
//   that the records do not fit the lists, which means that an index changed or a record left. A
//   failed build leaves the last lists in place. The timer goes on.
// The newest state is the one of the last build or step. A build replaces it when it ends. A step
// that started from an older state ends without effect. Readers get the lists of the newest state,
// unless its ledger point is older than the ledger point of their lists. So a build that ends after
// newer steps does not take them back, and the next step goes on from the build. Until a build ends,
// requests get the previous lists. Without valid lists, a request waits up to 10 s for a running
// build.
// Timing rule. A build ends with lists that are as old as the build plus the age of the tip that it
// read first. The timer starts the next build when the last one ended as long ago as the background
// interval, at most one tick late. The old lists are still valid when the new ones are there, and no
// reader waits, when
//   background interval + REFRESH_TICK_MS + time of the build + age of the bits at the end <= LIST_VALIDITY_MS.
// BUILD_ALLOWANCE_MS is the time that the rule allows for the last three terms together. So each
// interval is at most LIST_VALIDITY_MS - BUILD_ALLOWANCE_MS. `checkTiming` refuses a longer interval
// when the services start, and the log has a line for a build that is longer than the rule allows
// for. While the steps work, each step gives new lists, and the rule matters only when they fail.
// Two formats, both signed with ES256 by the gateway's P-256 key:
// - W3C Bitstring Status List v1.0 (W3C Recommendation, 15 May 2025,
//   https://www.w3.org/TR/2025/REC-vc-bitstring-status-list-20250515/): one list with both purposes
//   (Section 2.2 allows several `statusPurpose` values in one list; Appendix A.4). Its bitstring has
//   2 × 131,072 bits: bit p is the revocation bit and bit 131,072 + p the suspension bit of position
//   p. Index 0 is the left-most bit (Section 2.2). GZIP (RFC 1952), then multibase base64url ("u").
//   The credential is secured with JOSE as `application/vc+jwt` (Securing Verifiable Credentials
//   using JOSE and COSE, W3C Recommendation, https://www.w3.org/TR/vc-jose-cose/, Section 3.1.1).
// - IETF Token Status List (draft-ietf-oauth-status-list-21,
//   https://www.ietf.org/archive/id/draft-ietf-oauth-status-list-21.txt): 2 bits per entry, packed
//   from the least significant bit (Section 4.1); values 0 VALID, 1 INVALID, 2 SUSPENDED (Section
//   7.1); DEFLATE with the ZLIB format, base64url; a `statuslist+jwt` token (Section 5.1).

import { deflateSync, gzipSync } from "node:zlib";
import { inBackground } from "../chain/limiter.js";
import type { ChainTip, GenesisParameters } from "../chain/types.js";
import type { RecordList } from "../resolve/records.js";
import type { EffectiveStatus } from "../resolve/status.js";
import { blockTimeMs, formatTime } from "../resolve/time.js";
import { gatewayDid, type M4Context, type RecordSource } from "./context.js";
import { b64url, signJws } from "./jose.js";

export const LIST_SIZE = 131_072;

/** Token Status List values (draft-ietf-oauth-status-list-21 Section 7.1). */
export const STATUS = { valid: 0, invalid: 1, suspended: 2 } as const;
export type StatusValue = (typeof STATUS)[keyof typeof STATUS];

export const statusValue = (effective: EffectiveStatus): StatusValue =>
  effective === "active" ? STATUS.valid : effective === "suspended" ? STATUS.suspended : STATUS.invalid;

/** Where an index is: list n, position p. */
export const listPosition = (index: number): { n: number; p: number } => ({ n: Math.floor(index / LIST_SIZE), p: index % LIST_SIZE });

/** The uncompressed Token Status List byte array: 2 bits per entry, entry 0 in the least significant bits of byte 0. */
export function tokenStatusBytes(values: Uint8Array): Buffer {
  const bytes = Buffer.alloc((LIST_SIZE * 2) / 8);
  values.forEach((v, p) => {
    if (v !== 0) bytes[p >> 2]! |= (v & 0b11) << ((p & 3) * 2);
  });
  return bytes;
}

/** The uncompressed Bitstring Status List: revocation bits, then suspension bits; index 0 is the most significant bit of byte 0. */
export function bitstring(values: Uint8Array): Buffer {
  const bits = Buffer.alloc((2 * LIST_SIZE) / 8);
  const set = (i: number): void => {
    bits[i >> 3]! |= 0x80 >> (i & 7);
  };
  values.forEach((v, p) => {
    if (v === STATUS.invalid) set(p);
    else if (v === STATUS.suspended) set(LIST_SIZE + p);
  });
  return bits;
}

/** The BSL `statusListIndex` values of position p. */
export const bitstringIndex = (purpose: "revocation" | "suspension", p: number): number => (purpose === "revocation" ? p : LIST_SIZE + p);

interface IndexCache {
  readonly builtAt: number;
  readonly indices: ReadonlyMap<string, number>;
  /** The list of the index: a build reads the statuses as of its tip. */
  readonly list: RecordList;
}

/** The statuses of the records as of one ledger tip. A state never changes: a step copies what it changes. */
interface ListState {
  /** The tip that the statuses describe. */
  readonly tip: ChainTip;
  /** The block time of that tip (POSIX ms): the ledger point of the lists. */
  readonly asOf: number;
  /** The status-list index of each indexed record. */
  readonly indices: ReadonlyMap<string, number>;
  /** Status values of each list, by n. */
  readonly values: readonly Uint8Array[];
}

/** The lists that readers get: one state, its Token Status List values and the signed lists. */
interface Lists {
  readonly state: ListState;
  /** When the lists stop being valid (POSIX ms): `exp` and `validUntil`. */
  readonly expiresAt: number;
  /** The Token Status List values: the values of the state with the held entries of revoked tokens. */
  readonly tokenValues: readonly Uint8Array[];
  readonly signed: Map<string, string>;
}

/** Only one ledger read at a time builds the index or the lists; concurrent callers share it. */
const MIN_INDEX_REBUILD_MS = 10_000;
const BUILD_CONCURRENCY = 8;
/** Signed lists are valid for one hour after their ledger point (TSL `exp`, BSL `validUntil`). */
export const LIST_VALIDITY_MS = 3_600_000;
/** How long a request without valid lists waits for a running build. */
export const BUILD_WAIT_MS = 10_000;
/** The timer checks the age of the lists this often. */
export const REFRESH_TICK_MS = 10_000;
/** The time that the timing rule allows for the check of the timer, for one build and for the age of its bits, together. */
export const BUILD_ALLOWANCE_MS = 900_000;
/** The longest interval of both settings: the validity of a list less the allowance. */
export const MAX_REFRESH_MS = LIST_VALIDITY_MS - BUILD_ALLOWANCE_MS;
/** The shortest background interval: a build takes minutes, so a shorter interval is a loop of builds. */
export const MIN_BACKGROUND_REFRESH_MS = 60_000;
/** The default of STATUS_LIST_BACKGROUND_REFRESH_SECONDS: 10 minutes. */
export const DEFAULT_BACKGROUND_REFRESH_MS = 600_000;
/** The default and the shortest STATUS_LIST_FOLLOW_SECONDS (not 0): one tick of the timer. */
export const DEFAULT_FOLLOW_MS = REFRESH_TICK_MS;
/** The longest STATUS_LIST_FOLLOW_SECONDS. */
export const MAX_FOLLOW_MS = 300_000;

const TIMING_RULE = `A list is valid for ${LIST_VALIDITY_MS / 1000} s. An interval and ${BUILD_ALLOWANCE_MS / 1000} s for the check of the timer and for a build must fit in that time.`;

/**
 * Refuses intervals that break the timing rule (see the head of this file). The messages name the
 * settings of the environment, which `loadM4Config` reads. `followMs` is 0 (no follow steps) or a
 * multiple of the timer tick.
 */
export function checkTiming(refreshMs: number, backgroundMs: number, followMs: number = DEFAULT_FOLLOW_MS): void {
  const check = (name: string, minMs: number, ms: number): void => {
    if (!(ms >= minMs && ms <= MAX_REFRESH_MS)) {
      throw new Error(`${name} must be from ${minMs / 1000} to ${MAX_REFRESH_MS / 1000} s, got ${ms / 1000}. ${TIMING_RULE}`);
    }
  };
  check("STATUS_LIST_REFRESH_SECONDS", 1_000, refreshMs);
  check("STATUS_LIST_BACKGROUND_REFRESH_SECONDS", MIN_BACKGROUND_REFRESH_MS, backgroundMs);
  if (backgroundMs < refreshMs) throw new Error("STATUS_LIST_BACKGROUND_REFRESH_SECONDS must not be shorter than STATUS_LIST_REFRESH_SECONDS");
  if (followMs !== 0 && !(followMs >= DEFAULT_FOLLOW_MS && followMs <= MAX_FOLLOW_MS && followMs % REFRESH_TICK_MS === 0)) {
    throw new Error(
      `STATUS_LIST_FOLLOW_SECONDS must be 0 (the lists do not follow the chain) or a multiple of ${REFRESH_TICK_MS / 1000} s from ${DEFAULT_FOLLOW_MS / 1000} to ${MAX_FOLLOW_MS / 1000} s, got ${followMs / 1000}.`,
    );
  }
}

/** What starts a build, for the log: the start of the services, the timer, a request, a follow step that finds the lists wrong, or a call of `refresh`. */
type BuildReason = "start" | "timer" | "request" | "repair" | "call";

/** Milliseconds as seconds with one decimal, for the log. */
const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** The value of `promise`; an error when it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // Node 20 has no Promise.withResolvers.
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} takes longer than ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the effective status of each entry in the pass of `list` and gives `use` the index and the
 * value of each. A few reads run at the same time.
 */
async function readStatuses(
  records: RecordSource,
  list: RecordList,
  entries: ReadonlyArray<readonly [string, number]>,
  use: (index: number, value: StatusValue) => void,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    try {
      while (next < entries.length && !failed) {
        const [vectorId, index] = entries[next++]!;
        const lookup = await records.currentStatus(vectorId, list);
        // An indexed identifier always resolves; if it does not, suspension is the reversible answer.
        use(index, lookup.found ? statusValue(lookup.effective.status) : STATUS.suspended);
      }
    } catch (e) {
      // The pass fails with the first error. The other workers start no further read: a failed pass
      // leaves no work behind for the pass that follows it.
      failed = true;
      throw e;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BUILD_CONCURRENCY, entries.length) }, worker));
}

/** What a follow step reads for a list of records, and why the list may not fit the state. */
interface FollowPlan {
  /** The records with an index that are not final: their status can change with the tip. */
  readonly again: Array<[string, number]>;
  /** The records that have an index now and had none. */
  readonly added: Array<[string, number]>;
  /** Why the list does not fit the state; null when it fits. */
  readonly mismatch: string | null;
}

/**
 * A record with the status Revoked or Retired is final and is not read again. The indices of the
 * records that the state knows must be the indices that the list gives: an index never moves, and a
 * record does not leave the list.
 */
function planFollow(state: ListState, list: RecordList): FollowPlan {
  const again: Array<[string, number]> = [];
  const added: Array<[string, number]> = [];
  let known = 0;
  for (const entry of list.entries) {
    const index = entry.statusListIndex;
    if (index === null) continue;
    const before = state.indices.get(entry.vectorId);
    if (before === undefined) {
      added.push([entry.vectorId, index]);
    } else if (before !== index) {
      return { again, added, mismatch: "an index changed" };
    } else {
      known++;
      const { n, p } = listPosition(index);
      if (state.values[n]![p] !== STATUS.invalid) again.push([entry.vectorId, index]);
    }
  }
  return { again, added, mismatch: known < state.indices.size ? "a record left the list" : null };
}

/**
 * The state after a follow step: the values of `state` with the new values of the records that the
 * step read, and the new indices. A list that no value changes in stays the same array.
 */
function advance(
  state: ListState,
  list: RecordList,
  added: ReadonlyArray<readonly [string, number]>,
  results: ReadonlyArray<readonly [number, StatusValue]>,
  asOf: number,
): { state: ListState; changed: number } {
  const indices = added.length === 0 ? state.indices : new Map([...state.indices, ...added]);
  const listCount = added.reduce((count, [, i]) => Math.max(count, listPosition(i).n + 1), state.values.length);
  const values = [...state.values];
  /** The lists that this step made or copied: it may write in them. */
  const own = new Set<number>();
  while (values.length < listCount) {
    own.add(values.length);
    values.push(new Uint8Array(LIST_SIZE));
  }
  let changed = 0;
  for (const [index, value] of results) {
    const { n, p } = listPosition(index);
    if (values[n]![p] === value) continue;
    if (!own.has(n)) {
      values[n] = values[n]!.slice();
      own.add(n);
    }
    values[n]![p] = value;
    changed++;
  }
  return { state: { tip: list.tip, asOf, indices, values }, changed };
}

export class StatusLists {
  private index: IndexCache | null = null;
  private indexBuild: Promise<IndexCache> | null = null;
  /** The lists that readers get. */
  private lists: Lists | null = null;
  /** The newest state of the records: the one of the last build or follow step. A follow step starts from it. */
  private state: ListState | null = null;
  private listsBuild: Promise<Lists> | null = null;
  private following: Promise<void> | null = null;
  /** The genesis values of the ledger source: the block time of a tip needs them. */
  private network: Promise<GenesisParameters> | null = null;
  /** When the last build started (POSIX ms). */
  private lastBuildAt = -Infinity;
  /** When the last build ended (POSIX ms); null before the first. */
  private builtAt: number | null = null;
  /** When a build or a follow step last read the state from the chain (POSIX ms); null before the first. */
  private checkedAt: number | null = null;
  /** The ticks of the timer since the services started, counted while the lists follow the chain. */
  private ticks = 0;
  /** When a failed follow step was last logged (POSIX ms): the log has one line for each refresh interval. */
  private followFailureLoggedAt = -Infinity;
  /** The age at which the timer builds the lists again (POSIX ms). */
  private readonly backgroundMs: number;
  /** The interval of the follow steps (POSIX ms); 0: none. */
  private readonly followMs: number;
  /**
   * How long lists count as read from the chain: the refresh interval. While the lists follow the
   * chain, a request starts a build only after two steps have failed, so not before 2 follow intervals.
   */
  private readonly staleMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ctx: M4Context,
    /** Agents whose Token Status List entry must read SUSPENDED (TokenRegistry.heldEntries). */
    private readonly heldEntries: (now: number) => ReadonlySet<string> = () => new Set(),
  ) {
    this.backgroundMs = ctx.settings.statusListBackgroundRefreshMs ?? DEFAULT_BACKGROUND_REFRESH_MS;
    this.followMs = ctx.settings.statusListFollowMs ?? DEFAULT_FOLLOW_MS;
    checkTiming(ctx.settings.statusListRefreshMs, this.backgroundMs, this.followMs);
    this.staleMs = this.followMs === 0 ? ctx.settings.statusListRefreshMs : Math.max(ctx.settings.statusListRefreshMs, 2 * this.followMs);
  }

  /** The status-list index of an identifier, or null when it has none (yet). A failed read throws. */
  async indexOf(vectorId: string): Promise<number | null> {
    const now = this.ctx.now();
    let cache = this.index;
    if (cache === null || now - cache.builtAt >= this.ctx.settings.statusListRefreshMs) cache = await this.buildIndex();
    const known = cache.indices.get(vectorId);
    if (known !== undefined) return known;
    // A mint that reached 30 confirmations after the last build: build again, at most every 10 s.
    if (now - cache.builtAt >= MIN_INDEX_REBUILD_MS) cache = await this.buildIndex();
    return cache.indices.get(vectorId) ?? null;
  }

  /** The signed Token Status List of list n (`application/statuslist+jwt`), or null when the list does not exist. */
  async tokenStatusList(n: number): Promise<string | null> {
    return this.signedList("tsl", n);
  }

  /** The signed Bitstring Status List credential of list n (`application/vc+jwt`), or null when the list does not exist. */
  async bitstringStatusList(n: number): Promise<string | null> {
    return this.signedList("bsl", n);
  }

  /** Builds the lists again now (or joins the running build), whenever the last build started. */
  async refresh(): Promise<void> {
    await this.buildLists("call");
  }

  /**
   * Reads the changes of the chain into the lists now (or joins the running step), whenever the last
   * step started. Before the first build has ended, there is no state to start from, and it reads
   * nothing. A failed step throws.
   */
  async follow(): Promise<void> {
    await this.followStep();
  }

  /**
   * Starts the timer, and the first build in the background so that the first requests find lists.
   * The timer builds the lists again when the last build ended as long ago as the background
   * interval, and, every follow interval, reads the changes of the chain into the lists.
   */
  start(): void {
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.tick(), REFRESH_TICK_MS);
      this.timer.unref();
      this.ctx.info?.(
        `identity-gateway: status lists: the timer builds them again when they are older than ${this.backgroundMs / 1000} s; a list is valid for ${LIST_VALIDITY_MS / 1000} s`,
      );
      this.ctx.info?.(
        this.followMs === 0
          ? "identity-gateway: status lists: they do not follow the chain: only a build changes them"
          : `identity-gateway: status lists: they follow the chain: the timer reads the changes every ${this.followMs / 1000} s`,
      );
    }
    if (this.lists === null && this.listsBuild === null) this.buildInBackground("start");
  }

  /** Stops the timer. A build or a step that runs ends on its own. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves when no build and no follow step runs (for tests and orderly shutdown). */
  async idle(): Promise<void> {
    while (this.listsBuild !== null || this.following !== null) await Promise.allSettled([this.listsBuild, this.following]);
  }

  /** One tick of the timer: a build when one is due, and a follow step when its interval has passed. */
  private tick(): void {
    this.startWhenDue("timer", this.builtAt, this.backgroundMs);
    // A step that fails is logged by `followOnce`; the next one starts at its own tick.
    if (this.followMs > 0 && ++this.ticks % (this.followMs / REFRESH_TICK_MS) === 0) this.followStep().catch(() => undefined);
  }

  private buildIndex(): Promise<IndexCache> {
    this.indexBuild ??= (async () => {
      try {
        const list = await this.ctx.records.listRecords();
        const indices = new Map<string, number>();
        for (const e of list.entries) if (e.statusListIndex !== null) indices.set(e.vectorId, e.statusListIndex);
        this.index = { builtAt: this.ctx.now(), indices, list };
        return this.index;
      } finally {
        this.indexBuild = null;
      }
    })();
    return this.indexBuild;
  }

  /** The genesis values of the ledger source, read once: the block time of a tip needs them. A failed read is not kept. */
  private genesis(): Promise<GenesisParameters> {
    this.network ??= this.ctx.chain.genesis().catch((e: unknown) => {
      this.network = null;
      throw e;
    });
    return this.network;
  }

  /**
   * The lists that readers get from `state`. A state with an older ledger point than the lists that
   * readers have does not replace them. The held entries of revoked tokens are part of the Token
   * Status List values.
   */
  private publish(state: ListState): Lists {
    const current = this.lists;
    if (current !== null && state.tip.blockHeight < current.state.tip.blockHeight) return current;
    const held = this.heldEntries(this.ctx.now());
    let tokenValues = state.values;
    if (held.size > 0) {
      tokenValues = state.values.map((v) => v.slice());
      for (const vectorId of held) {
        const index = state.indices.get(vectorId);
        if (index === undefined) continue;
        const { n, p } = listPosition(index);
        if (tokenValues[n]![p] === STATUS.valid) tokenValues[n]![p] = STATUS.suspended;
      }
    }
    const iat = Math.floor(state.asOf / 1000);
    this.lists = { state, expiresAt: (iat + LIST_VALIDITY_MS / 1000) * 1000, tokenValues, signed: new Map() };
    return this.lists;
  }

  /** One build, or the running one. It logs its start, its end and its failure. */
  private buildLists(reason: BuildReason): Promise<Lists> {
    this.listsBuild ??= inBackground(async () => {
      const startedAt = this.ctx.now();
      this.lastBuildAt = startedAt;
      try {
        const previous = this.checkedAt === null ? "no lists yet" : `the lists are ${seconds(startedAt - this.checkedAt)} s old`;
        this.ctx.info?.(`identity-gateway: status lists: build started (${reason}): ${previous}`);
        // The block time of the tip needs the genesis values: a build that cannot read them stops before its long reads.
        const network = await this.genesis();
        const { indices, list } = await this.buildIndex();
        const entries = [...indices];
        const listCount = entries.reduce((count, [, i]) => Math.max(count, listPosition(i).n + 1), 1);
        const values = Array.from({ length: listCount }, () => new Uint8Array(LIST_SIZE));
        await readStatuses(this.ctx.records, list, entries, (index, value) => {
          const { n, p } = listPosition(index);
          values[n]![p] = value;
        });
        const state: ListState = { tip: list.tip, asOf: blockTimeMs(list.tip.slot, network), indices, values };
        const endedAt = this.ctx.now();
        // The build replaces the newest state; the next follow step starts from it.
        this.state = state;
        this.builtAt = this.checkedAt = endedAt;
        const built = this.publish(state);
        const duration = endedAt - startedAt;
        this.ctx.info?.(`identity-gateway: status lists: build ended after ${seconds(duration)} s: ${entries.length} records`);
        if (this.backgroundMs + REFRESH_TICK_MS + duration + (endedAt - state.asOf) > LIST_VALIDITY_MS) {
          this.ctx.log(
            `identity-gateway: status lists: the build took ${seconds(duration)} s, and the interval is ${this.backgroundMs / 1000} s. ` +
              `A list is valid for ${LIST_VALIDITY_MS / 1000} s, so a list can expire before the next build ends. Use a shorter STATUS_LIST_BACKGROUND_REFRESH_SECONDS.`,
          );
        }
        return built;
      } catch (e) {
        this.ctx.log(`identity-gateway: status lists not rebuilt after ${seconds(this.ctx.now() - startedAt)} s: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      } finally {
        this.listsBuild = null;
      }
    });
    return this.listsBuild;
  }

  /** Starts a build that nobody waits for. `buildLists` logs its failure. */
  private buildInBackground(reason: BuildReason): void {
    this.buildLists(reason).catch(() => undefined);
  }

  /**
   * A follow step, or the running one. Without a state, there is nothing to follow. The step ends
   * before the next one can start, also when it fails.
   */
  private followStep(): Promise<void> {
    if (this.state === null) return Promise.resolve();
    if (this.following === null) {
      this.following = inBackground(() => this.followOnce()).finally(() => {
        this.following = null;
      });
    }
    return this.following;
  }

  /**
   * One follow step (see the head of this file): the new tip and list of records, then the status of
   * each record that is not final and of each new record, as of that tip. Nothing changes when a read
   * fails. A build that ends while the step reads makes the step useless, and the step ends.
   */
  private async followOnce(): Promise<void> {
    const base = this.state;
    if (base === null) return;
    const startedAt = this.ctx.now();
    try {
      const network = await this.genesis();
      const list = await this.ctx.records.listRecords();
      const { tip } = list;
      if (tip.blockHeight < base.tip.blockHeight || (tip.blockHeight === base.tip.blockHeight && tip.blockHash === base.tip.blockHash)) {
        // The ledger source shows no newer tip: the lists are as new as it can tell.
        if (this.state === base) this.checkedAt = this.ctx.now();
        return;
      }
      const plan = planFollow(base, list);
      if (plan.mismatch !== null) {
        this.repair(plan.mismatch);
        return;
      }
      const read = [...plan.again, ...plan.added];
      const results: Array<[number, StatusValue]> = [];
      await readStatuses(this.ctx.records, list, read, (index, value) => results.push([index, value]));
      const asOf = blockTimeMs(tip.slot, network);
      if (this.state !== base) return;
      const { state, changed } = advance(base, list, plan.added, results, asOf);
      const endedAt = this.ctx.now();
      this.state = state;
      this.checkedAt = endedAt;
      this.index = { builtAt: endedAt, indices: state.indices, list };
      this.publish(state);
      if (changed > 0) {
        this.ctx.info?.(`identity-gateway: status lists: followed to block ${tip.blockHeight} after ${seconds(endedAt - startedAt)} s: ${changed} of ${read.length} records changed`);
      }
    } catch (e) {
      const now = this.ctx.now();
      if (now - this.followFailureLoggedAt >= this.ctx.settings.statusListRefreshMs) {
        this.followFailureLoggedAt = now;
        this.ctx.log(`identity-gateway: status lists not followed after ${seconds(now - startedAt)} s: ${e instanceof Error ? e.message : String(e)}`);
      }
      throw e;
    }
  }

  /** The records do not fit the lists (see `planFollow`): a build reads every record again, when one may start. */
  private repair(why: string): void {
    const now = this.ctx.now();
    if (this.listsBuild !== null || now - this.lastBuildAt < this.ctx.settings.statusListRefreshMs) return;
    this.ctx.log(`identity-gateway: status lists: the records do not fit the lists (${why}); a full build starts`);
    this.buildInBackground("repair");
  }

  /**
   * Starts a build in the background when the last read of the state (`lastAt`, POSIX ms; null:
   * none) is `minAgeMs` ago or longer, no build runs, and the last build started one refresh
   * interval ago or earlier, also when it failed.
   */
  private startWhenDue(reason: BuildReason, lastAt: number | null, minAgeMs: number): void {
    const now = this.ctx.now();
    if (this.listsBuild !== null || now - this.lastBuildAt < this.ctx.settings.statusListRefreshMs) return;
    const age = lastAt === null ? Infinity : now - lastAt;
    if (age >= minAgeMs) this.buildInBackground(reason);
  }

  /**
   * The lists to serve: valid lists that a build or a step read from the chain less than the refresh
   * interval ago; else, while they are valid, the previous lists, and a build starts in the
   * background when the last one started a refresh interval ago; without valid lists, the result of
   * the running build.
   */
  private current(): Lists | Promise<Lists> {
    const now = this.ctx.now();
    const lists = this.lists !== null && now < this.lists.expiresAt ? this.lists : null;
    if (lists !== null && this.checkedAt !== null && now - this.checkedAt < this.staleMs) return lists;
    this.startWhenDue("request", this.checkedAt, this.staleMs);
    if (lists !== null) return lists;
    if (this.listsBuild !== null) return within(this.listsBuild, BUILD_WAIT_MS, "the status-list build").then((built) => this.validated(built));
    throw new Error("no valid status lists: the last build failed, and the next one starts one refresh interval after it");
  }

  /** The lists of a build that a request waited for, when they are still valid: the tip that the build read can be old. */
  private validated(lists: Lists): Lists {
    if (this.ctx.now() >= lists.expiresAt) throw new Error(`no valid status lists: the ledger tip is older than ${LIST_VALIDITY_MS / 1000} s`);
    return lists;
  }

  private async signedList(kind: "tsl" | "bsl", n: number): Promise<string | null> {
    const lists = await this.current();
    const values = (kind === "tsl" ? lists.tokenValues : lists.state.values)[n];
    if (values === undefined) return null;
    const key = `${kind}:${n}`;
    const known = lists.signed.get(key);
    if (known !== undefined) return known;
    const { asOf } = lists.state;
    const signed = kind === "tsl" ? await this.signTokenStatusList(n, values, asOf) : await this.signBitstringList(n, values, asOf);
    lists.signed.set(key, signed);
    return signed;
  }

  private ttlSeconds(): number {
    return Math.max(1, Math.round(this.ctx.settings.statusListRefreshMs / 1000));
  }

  /** `asOf`: the ledger point of the lists (POSIX ms): the block time of the tip that the values describe. */
  private signTokenStatusList(n: number, values: Uint8Array, asOf: number): Promise<string> {
    const { settings, keys } = this.ctx;
    const iat = Math.floor(asOf / 1000);
    return signJws(
      { alg: "ES256", kid: keys.p256.kid, typ: "statuslist+jwt" },
      {
        iss: settings.baseUrl,
        sub: `${settings.baseUrl}/status/tsl/${n}`,
        iat,
        exp: iat + LIST_VALIDITY_MS / 1000,
        ttl: this.ttlSeconds(),
        status_list: { bits: 2, lst: b64url(deflateSync(tokenStatusBytes(values), { level: 9 })) },
      },
      keys.p256,
    );
  }

  private signBitstringList(n: number, values: Uint8Array, asOf: number): Promise<string> {
    const { settings, keys } = this.ctx;
    const url = `${settings.baseUrl}/status/bsl/${n}`;
    return signJws(
      { alg: "ES256", kid: keys.p256.kid, typ: "vc+jwt", cty: "vc" },
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        id: url,
        type: ["VerifiableCredential", "BitstringStatusListCredential"],
        issuer: gatewayDid(settings),
        validFrom: formatTime(asOf),
        validUntil: formatTime(asOf + LIST_VALIDITY_MS),
        credentialSubject: {
          id: `${url}#list`,
          type: "BitstringStatusList",
          statusPurpose: ["revocation", "suspension"],
          encodedList: `u${b64url(gzipSync(bitstring(values), { level: 9 }))}`,
          ttl: this.ttlSeconds() * 1000,
        },
      },
      keys.p256,
    );
  }
}
