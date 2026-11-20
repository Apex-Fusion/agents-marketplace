// Helpers of the status-list tests: the lists as bytes, a status-list service on a fake ledger without
// an HTTP server, and a full build of the same ledger as the reference for the follow steps.

import { gunzipSync, inflateSync } from "node:zlib";
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
  /** Bitstring Status List bytes (revocation bits, then suspension bits) of each list. */
  readonly bsl: readonly Buffer[];
  /** `iat` and `exp` of Token Status List 0 (POSIX s). */
  readonly iat: number;
  readonly exp: number;
  /** `validFrom` and `validUntil` of Bitstring Status List 0. */
  readonly validFrom: string;
  readonly validUntil: string;
}

/** Reads every list that the service has, in both formats. A failed read throws. */
export async function decode(lists: StatusLists): Promise<DecodedLists> {
  const tsl: Buffer[] = [];
  const bsl: Buffer[] = [];
  let first: { iat: number; exp: number; validFrom: string; validUntil: string } | null = null;
  for (let n = 0; ; n++) {
    const token = await lists.tokenStatusList(n);
    const credential = await lists.bitstringStatusList(n);
    if (token === null || credential === null) {
      if ((token === null) !== (credential === null)) throw new Error(`list ${n} exists in one format only`);
      break;
    }
    const { payload } = decodeJwt(token);
    const subject = decodeJwt(credential).payload;
    tsl.push(inflateSync(Buffer.from(text(at(payload, "status_list", "lst")), "base64url")));
    bsl.push(gunzipSync(Buffer.from(text(at(subject, "credentialSubject", "encodedList")).slice(1), "base64url")));
    first ??= { iat: Number(payload.iat), exp: Number(payload.exp), validFrom: text(subject.validFrom), validUntil: text(subject.validUntil) };
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
export async function fullBuildOf(builder: LedgerBuilder, clock: { now: number }): Promise<{ lists: StatusLists; decoded: DecodedLists }> {
  const lists = listsOn(builder, { clock, followMs: 0 });
  await lists.refresh();
  return { lists, decoded: await decode(lists) };
}
