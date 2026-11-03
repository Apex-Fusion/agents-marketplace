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
// Builds: at most one runs at a time, and at most one starts in each refresh interval
// (STATUS_LIST_REFRESH_SECONDS), also after a failed build. The first starts with the services. A
// build is one pass over the records (one tip, kept ledger reads; resolver.ts), and its Koios reads
// go in the background lane (chain/limiter.ts), after the reads of requests. A list older than the
// refresh interval is built again in the background; until that build ends, requests get the
// previous lists, which stay valid (`exp`, `validUntil`) for an hour. Without valid lists, a request
// waits up to 10 s for a running build.
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
import type { RecordList } from "../resolve/records.js";
import type { EffectiveStatus } from "../resolve/status.js";
import { formatTime } from "../resolve/time.js";
import { gatewayDid, type M4Context } from "./context.js";
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

interface Lists {
  readonly builtAt: number;
  /** Status values of each list, by n. */
  readonly values: readonly Uint8Array[];
  /** The Token Status List values: `values` with the held entries of revoked tokens. */
  readonly tokenValues: readonly Uint8Array[];
  readonly signed: Map<string, string>;
}

/** Only one ledger read at a time builds the index or the lists; concurrent callers share it. */
const MIN_INDEX_REBUILD_MS = 10_000;
const BUILD_CONCURRENCY = 8;
/** Signed lists expire one hour after they are built (TSL `exp`, BSL `validUntil`). */
export const LIST_VALIDITY_MS = 3_600_000;
/** How long a request without valid lists waits for a running build. */
export const BUILD_WAIT_MS = 10_000;

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

export class StatusLists {
  private index: IndexCache | null = null;
  private indexBuild: Promise<IndexCache> | null = null;
  private lists: Lists | null = null;
  private listsBuild: Promise<Lists> | null = null;
  /** When the last build started (POSIX ms). */
  private lastBuildAt = -Infinity;

  constructor(
    private readonly ctx: M4Context,
    /** Agents whose Token Status List entry must read SUSPENDED (TokenRegistry.heldEntries). */
    private readonly heldEntries: (now: number) => ReadonlySet<string> = () => new Set(),
  ) {}

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
    await this.buildLists();
  }

  /** Starts the first build in the background, so that the first requests find lists. */
  start(): void {
    if (this.lists === null && this.listsBuild === null) this.buildInBackground();
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

  private buildLists(): Promise<Lists> {
    this.listsBuild ??= inBackground(async () => {
      this.lastBuildAt = this.ctx.now();
      try {
        const { indices, list } = await this.buildIndex();
        const entries = [...indices];
        const listCount = entries.reduce((count, [, i]) => Math.max(count, listPosition(i).n + 1), 1);
        const values = Array.from({ length: listCount }, () => new Uint8Array(LIST_SIZE));
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < entries.length) {
            const [vectorId, i] = entries[next++]!;
            const lookup = await this.ctx.records.currentStatus(vectorId, list);
            // An indexed identifier always resolves; if it does not, suspension is the reversible answer.
            const value = lookup.found ? statusValue(lookup.effective.status) : STATUS.suspended;
            const { n, p } = listPosition(i);
            values[n]![p] = value;
          }
        };
        await Promise.all(Array.from({ length: Math.min(BUILD_CONCURRENCY, entries.length) }, worker));
        const held = this.heldEntries(this.ctx.now());
        const tokenValues = held.size === 0 ? values : values.map((v) => v.slice());
        for (const [vectorId, i] of entries) {
          const { n, p } = listPosition(i);
          if (held.has(vectorId) && tokenValues[n]![p] === STATUS.valid) tokenValues[n]![p] = STATUS.suspended;
        }
        this.lists = { builtAt: this.ctx.now(), values, tokenValues, signed: new Map() };
        return this.lists;
      } finally {
        this.listsBuild = null;
      }
    });
    return this.listsBuild;
  }

  private buildInBackground(): void {
    this.buildLists().catch((e: unknown) => this.ctx.log(`identity-gateway: status lists not rebuilt: ${e instanceof Error ? e.message : String(e)}`));
  }

  /**
   * The lists to serve: lists younger than the refresh interval; else, while they are valid, the
   * previous lists, and a build starts in the background when the last one started a refresh
   * interval ago; without valid lists, the result of the running build.
   */
  private current(): Lists | Promise<Lists> {
    const now = this.ctx.now();
    const refreshMs = this.ctx.settings.statusListRefreshMs;
    const lists = this.lists;
    const age = lists === null ? Infinity : now - lists.builtAt;
    if (lists !== null && age < refreshMs) return lists;
    if (this.listsBuild === null && now - this.lastBuildAt >= refreshMs) this.buildInBackground();
    if (lists !== null && age < LIST_VALIDITY_MS) return lists;
    if (this.listsBuild !== null) return within(this.listsBuild, BUILD_WAIT_MS, "the status-list build");
    throw new Error("no valid status lists: the last build failed, and the next one starts one refresh interval after it");
  }

  private async signedList(kind: "tsl" | "bsl", n: number): Promise<string | null> {
    const lists = await this.current();
    const values = (kind === "tsl" ? lists.tokenValues : lists.values)[n];
    if (values === undefined) return null;
    const key = `${kind}:${n}`;
    const known = lists.signed.get(key);
    if (known !== undefined) return known;
    const signed = kind === "tsl" ? await this.signTokenStatusList(n, values, lists.builtAt) : await this.signBitstringList(n, values, lists.builtAt);
    lists.signed.set(key, signed);
    return signed;
  }

  private ttlSeconds(): number {
    return Math.max(1, Math.round(this.ctx.settings.statusListRefreshMs / 1000));
  }

  private signTokenStatusList(n: number, values: Uint8Array, builtAt: number): Promise<string> {
    const { settings, keys } = this.ctx;
    const iat = Math.floor(builtAt / 1000);
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

  private signBitstringList(n: number, values: Uint8Array, builtAt: number): Promise<string> {
    const { settings, keys } = this.ctx;
    const url = `${settings.baseUrl}/status/bsl/${n}`;
    return signJws(
      { alg: "ES256", kid: keys.p256.kid, typ: "vc+jwt", cty: "vc" },
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        id: url,
        type: ["VerifiableCredential", "BitstringStatusListCredential"],
        issuer: gatewayDid(settings),
        validFrom: formatTime(builtAt),
        validUntil: formatTime(builtAt + LIST_VALIDITY_MS),
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
