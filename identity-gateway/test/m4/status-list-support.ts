// Helpers of the status-list tests: the lists as bytes and the comparison of two sets of lists, a status-list
// service on a fake ledger without an HTTP server, and a full build of the same ledger as the reference for the follow steps.

import { gunzipSync, inflateSync } from "node:zlib";
import { expect } from "vitest";
import type { IdentityDatum, Status } from "../../src/codec/identity-datum.js";
import { LIST_SIZE, StatusLists } from "../../src/m4/status-lists.js";
import type { M4Context } from "../../src/m4/context.js";
import { VectorResolver } from "../../src/resolve/resolver.js";
import { CONTROLLER_2, LedgerBuilder, PARTY_KEY, identityDatum, keySigner, timeAt } from "../support/ledger.js";
import { BASE, GATEWAY_ID, NOW, TRUST_DOMAIN, at, decodeJwt, gatewayKeys, text } from "./support.js";

/** The blocks of the test ledger are 10 s apart. */
export const BLOCK_MS = 10_000;

/** The clock of a test: 10 s after the block time of the tip, as in the harness (`NOW`). */
export const clockAt = (tipHeight: number): number => timeAt(tipHeight) + (NOW - timeAt(1000));

/** A hold by the controller that lasts until `until` (POSIX ms). */
export const hold = (until: number): Status => ({ type: "Suspended", holds: [{ by: { type: "ControllerSet" }, reason: 6, since: timeAt(100), until }] });

/** The end of a record by a party: a tombstone status at block `height`, with an optional "invalid from" time. */
export const revocation = (height: number, invalidFrom: number | null = null): Status => ({
  type: "Revoked",
  by: keySigner(PARTY_KEY),
  reason: 3,
  at: timeAt(height),
  invalidFrom,
  successor: null,
});

/** The retirement of a record at block `height`. */
export const retirement = (height: number): Status => ({ type: "Retired", at: timeAt(height), successor: null });

/** The datum of a subagent of `parent` (its subagent epoch is `parentEpoch`) at `depth`. */
export const child = (parent: string, depth: number, parentEpoch = 0, overrides: Partial<IdentityDatum> = {}): IdentityDatum =>
  identityDatum({ lineage: { type: "Subagent", parent, parentEpoch, depth }, endpoint: new Uint8Array(), controller: CONTROLLER_2, ...overrides });

/** The lists as bytes: list n of each format, and the ledger point and the validity of list 0. */
export interface DecodedLists {
  /** Token Status List bytes (2 bits per entry) of each list. */
  readonly tsl: readonly Buffer[];
  /** Bitstring Status List bytes (revocation bits, then suspension bits) of each list. Empty when only the Token Status Lists were read. */
  readonly bsl: readonly Buffer[];
  /** `iat` and `exp` of Token Status List 0 (POSIX s). */
  readonly iat: number;
  readonly exp: number;
  /** `validFrom` and `validUntil` of Bitstring Status List 0. Empty when only the Token Status Lists were read. */
  readonly validFrom: string;
  readonly validUntil: string;
}

/** The formats that `decode` reads: both, or the Token Status Lists only (one signing less for each list). */
export type Formats = "both" | "token";

/** Reads every list that the service has, in the formats `formats`. A failed read throws. */
export async function decode(lists: StatusLists, formats: Formats = "both"): Promise<DecodedLists> {
  const both = formats === "both";
  const tsl: Buffer[] = [];
  const bsl: Buffer[] = [];
  let first: { iat: number; exp: number; validFrom: string; validUntil: string } | null = null;
  for (let n = 0; ; n++) {
    const token = await lists.tokenStatusList(n);
    const credential = both ? await lists.bitstringStatusList(n) : undefined;
    if (token === null || credential === null) {
      if (both && (token === null) !== (credential === null)) throw new Error(`list ${n} exists in one format only`);
      break;
    }
    const { payload } = decodeJwt(token);
    const subject = credential === undefined ? null : decodeJwt(credential).payload;
    tsl.push(inflateSync(Buffer.from(text(at(payload, "status_list", "lst")), "base64url")));
    if (subject !== null) bsl.push(gunzipSync(Buffer.from(text(at(subject, "credentialSubject", "encodedList")).slice(1), "base64url")));
    first ??= {
      iat: Number(payload.iat),
      exp: Number(payload.exp),
      validFrom: subject === null ? "" : text(subject.validFrom),
      validUntil: subject === null ? "" : text(subject.validUntil),
    };
  }
  if (first === null) throw new Error("the service has no list 0");
  return { tsl, bsl, ...first };
}

/** The Token Status List value of index i (0 valid, 1 invalid, 2 suspended). */
export const tslValue = (lists: DecodedLists, i: number): number => {
  const bytes = lists.tsl[Math.floor(i / LIST_SIZE)]!;
  const p = i % LIST_SIZE;
  return (bytes[p >> 2]! >> ((p & 3) * 2)) & 0b11;
};

/** The Bitstring Status List bits of index i: [revocation, suspension]. */
export const bslBits = (lists: DecodedLists, i: number): [number, number] => {
  const bits = lists.bsl[Math.floor(i / LIST_SIZE)]!;
  const p = i % LIST_SIZE;
  const bit = (k: number): number => (bits[k >> 3]! >> (7 - (k & 7))) & 1;
  return [bit(p), bit(LIST_SIZE + p)];
};

/**
 * Where two sets of lists differ, as text; empty when they are the same lists: the same ledger point and
 * validity, and the same bytes in each list. The bytes go through `Buffer.equals` (`toEqual` on two 32 KiB
 * buffers takes about 150 ms). Only when a list differs, the first entries that differ are named.
 */
export function listDifferences(actual: DecodedLists, expected: DecodedLists): string[] {
  const found: string[] = [];
  for (const key of ["iat", "exp", "validFrom", "validUntil"] as const) {
    if (actual[key] !== expected[key]) found.push(`${key} ${actual[key]}, expected ${expected[key]}`);
  }
  if (actual.tsl.length !== expected.tsl.length || actual.bsl.length !== expected.bsl.length) {
    found.push(`list counts ${actual.tsl.length}/${actual.bsl.length}, expected ${expected.tsl.length}/${expected.bsl.length}`);
    return found;
  }
  const withBits = actual.bsl.length > 0;
  actual.tsl.forEach((bytes, n) => {
    if (bytes.equals(expected.tsl[n]!) && (!withBits || actual.bsl[n]!.equals(expected.bsl[n]!))) return;
    const before = found.length;
    for (let p = 0; p < 4096 && found.length < before + 10; p++) {
      const i = n * LIST_SIZE + p;
      const a = [tslValue(actual, i), ...(withBits ? bslBits(actual, i) : [])];
      const e = [tslValue(expected, i), ...(withBits ? bslBits(expected, i) : [])];
      if (a.join() !== e.join()) found.push(`index ${i}: [${a}], expected [${e}]`);
    }
    if (found.length === before) found.push(`list ${n} differs after its first 4096 entries`);
  });
  return found;
}

/** `actual` and `expected` are the same lists. A failure names the differences. */
export function sameLists(actual: DecodedLists, expected: DecodedLists, label = "the lists"): void {
  expect(listDifferences(actual, expected), label).toEqual([]);
}

export interface ServiceOptions {
  /** The clock of the service (POSIX ms); the test moves `now`. */
  readonly clock: { now: number };
  readonly refreshMs?: number;
  readonly backgroundRefreshMs?: number;
  /** How often the timer reads the changes of the chain (ms); 0: never. Default: the setting's default. */
  readonly followMs?: number;
  readonly logs?: string[];
  readonly info?: string[];
  /** The agents whose Token Status List entry reads SUSPENDED. */
  readonly heldEntries?: (now: number) => ReadonlySet<string>;
}

/** A status-list service on the ledger, with its own resolver (and so its own ledger reads). */
export function listsOn(builder: LedgerBuilder, options: ServiceOptions): StatusLists {
  const resolver = new VectorResolver(builder.chain, builder.settings, { log: (m) => options.logs?.push(m) });
  const ctx: M4Context = {
    settings: {
      baseUrl: BASE,
      gatewayId: GATEWAY_ID,
      trustDomain: TRUST_DOMAIN,
      delegation: null,
      statusListRefreshMs: options.refreshMs ?? 60_000,
      ...(options.backgroundRefreshMs === undefined ? {} : { statusListBackgroundRefreshMs: options.backgroundRefreshMs }),
      ...(options.followMs === undefined ? {} : { statusListFollowMs: options.followMs }),
    },
    keys: gatewayKeys(),
    records: resolver,
    chain: builder.chain,
    now: () => options.clock.now,
    log: (m) => options.logs?.push(m),
    info: (m) => options.info?.push(m),
  };
  return new StatusLists(ctx, options.heldEntries);
}

/** The lists of a full build at the tip that the ledger has now: the reference for a service that follows the chain. */
export async function fullBuildOf(builder: LedgerBuilder, clock: { now: number }, formats: Formats = "both"): Promise<{ lists: StatusLists; decoded: DecodedLists }> {
  const lists = listsOn(builder, { clock, followMs: 0 });
  await lists.refresh();
  return { lists, decoded: await decode(lists, formats) };
}
