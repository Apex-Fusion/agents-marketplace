// Delegation records (Part 2 Section 5.2) as Plutus Data, with the gateway's own Plutus Data codec:
//
//   Delegator       PrincipalKey { hash: 28 bytes, organisation: Option<1..64 bytes> }  (Constr 0)
//                   Agent { id: 32 bytes }                                              (Constr 1)
//   ValueLimit      Constr 0 [per_tx, total, period_ms]
//   DelegationDatum Constr 0, 12 fields: delegator, parent, delegate, delegate_key, actions,
//                   resources, not_before, not_after, depth, remaining, purpose, value
//
// Byte strings are lowercase hex (patterns and organisations are their UTF-8 bytes). AP3X amounts
// are bigint. The decoder checks the layout, the fixed byte lengths and the integer ranges; the
// delegation contract checks the rest when it creates the record. The golden test compares both
// directions with the contracts' CBOR fixtures byte for byte.

import { MAX_TIME_MS } from "../codec/identity-datum.js";
import { bytesToHex, decodePlutusData, encodePlutusData, pdBytes, pdConstr, pdInt, pdList, type PlutusData } from "../codec/plutus-data.js";

export type Delegator = { readonly type: "PrincipalKey"; readonly hash: string; readonly organisation: string | null } | { readonly type: "Agent"; readonly id: string };

export interface ValueLimit {
  readonly perTx: bigint;
  readonly total: bigint;
  readonly periodMs: number;
}

export interface DelegationDatum {
  readonly delegator: Delegator;
  /** Token name of the parent delegation. */
  readonly parent: string | null;
  /** Identifier of the delegate agent. */
  readonly delegate: string;
  /** Key hash of the delegate's Ed25519 delegation key. */
  readonly delegateKey: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  /** POSIX ms. */
  readonly notBefore: number;
  readonly notAfter: number;
  readonly depth: number;
  readonly remaining: number;
  /** 32 bytes: hash of a purpose text or mandate. */
  readonly purpose: string | null;
  readonly value: ValueLimit | null;
}

export class DelegationDatumError extends Error {
  constructor(what: string) {
    super(`delegation datum: ${what}`);
  }
}

/** Part 1 Section 5: integers other than times are in [0, 2^63). */
const MAX_INT = (1n << 63n) - 1n;

function constr(data: PlutusData, what: string, arities: readonly number[]): { index: number; fields: readonly PlutusData[] } {
  if (data.type !== "constr" || data.index >= BigInt(arities.length)) throw new DelegationDatumError(`${what} is not one of its constructors`);
  const index = Number(data.index);
  if (data.fields.length !== arities[index]) throw new DelegationDatumError(`${what} constructor ${index} has ${data.fields.length} fields`);
  return { index, fields: data.fields };
}

function hex(data: PlutusData, what: string, length?: number): string {
  if (data.type !== "bytes") throw new DelegationDatumError(`${what} is not a byte string`);
  if (length !== undefined && data.value.length !== length) throw new DelegationDatumError(`${what} is ${data.value.length} bytes, expected ${length}`);
  return bytesToHex(data.value);
}

function bigint(data: PlutusData, what: string, max: bigint): bigint {
  if (data.type !== "int" || data.value < 0n || data.value > max) throw new DelegationDatumError(`${what} is not an integer in [0, ${max}]`);
  return data.value;
}

const number = (data: PlutusData, what: string, max: number): number => Number(bigint(data, what, BigInt(max)));

function option<T>(data: PlutusData, what: string, inner: (d: PlutusData) => T): T | null {
  const c = constr(data, what, [1, 0]);
  return c.index === 0 ? inner(c.fields[0]!) : null;
}

function byteList(data: PlutusData, what: string): string[] {
  if (data.type !== "list") throw new DelegationDatumError(`${what} is not a list`);
  return data.items.map((item, i) => hex(item, `${what}[${i}]`));
}

export function delegatorFromData(data: PlutusData): Delegator {
  const c = constr(data, "delegator", [2, 1]);
  if (c.index === 1) return { type: "Agent", id: hex(c.fields[0]!, "delegator id", 32) };
  return { type: "PrincipalKey", hash: hex(c.fields[0]!, "delegator hash", 28), organisation: option(c.fields[1]!, "organisation", (d) => hex(d, "organisation")) };
}

export function delegationDatumFromData(data: PlutusData): DelegationDatum {
  const f = constr(data, "datum", [12]).fields;
  return {
    delegator: delegatorFromData(f[0]!),
    parent: option(f[1]!, "parent", (d) => hex(d, "parent", 32)),
    delegate: hex(f[2]!, "delegate", 32),
    delegateKey: hex(f[3]!, "delegate_key", 28),
    actions: byteList(f[4]!, "actions"),
    resources: byteList(f[5]!, "resources"),
    notBefore: number(f[6]!, "not_before", MAX_TIME_MS),
    notAfter: number(f[7]!, "not_after", MAX_TIME_MS),
    depth: number(f[8]!, "depth", Number.MAX_SAFE_INTEGER),
    remaining: number(f[9]!, "remaining", Number.MAX_SAFE_INTEGER),
    purpose: option(f[10]!, "purpose", (d) => hex(d, "purpose", 32)),
    value: option(f[11]!, "value", (d) => {
      const v = constr(d, "value limit", [3]).fields;
      return { perTx: bigint(v[0]!, "per_tx", MAX_INT), total: bigint(v[1]!, "total", MAX_INT), periodMs: number(v[2]!, "period_ms", Number.MAX_SAFE_INTEGER) };
    }),
  };
}

export const decodeDelegationDatum = (cbor: Uint8Array): DelegationDatum => delegationDatumFromData(decodePlutusData(cbor));

const some = (value: PlutusData | null): PlutusData => (value === null ? pdConstr(1, []) : pdConstr(0, [value]));

export function delegatorToData(d: Delegator): PlutusData {
  return d.type === "Agent" ? pdConstr(1, [pdBytes(d.id)]) : pdConstr(0, [pdBytes(d.hash), some(d.organisation === null ? null : pdBytes(d.organisation))]);
}

export function delegationDatumToData(d: DelegationDatum): PlutusData {
  return pdConstr(0, [
    delegatorToData(d.delegator),
    some(d.parent === null ? null : pdBytes(d.parent)),
    pdBytes(d.delegate),
    pdBytes(d.delegateKey),
    pdList(d.actions.map((a) => pdBytes(a))),
    pdList(d.resources.map((r) => pdBytes(r))),
    pdInt(d.notBefore),
    pdInt(d.notAfter),
    pdInt(d.depth),
    pdInt(d.remaining),
    some(d.purpose === null ? null : pdBytes(d.purpose)),
    some(d.value === null ? null : pdConstr(0, [pdInt(d.value.perTx), pdInt(d.value.total), pdInt(d.value.periodMs)])),
  ]);
}

export const encodeDelegationDatum = (d: DelegationDatum): Uint8Array => encodePlutusData(delegationDatumToData(d));
