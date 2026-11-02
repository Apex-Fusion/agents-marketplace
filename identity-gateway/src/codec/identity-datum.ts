// Identity record datum (Part 1 Section 5): Constr 0 with 14 fields, field and constructor order
// as written there. Byte strings that name keys, hashes or identifiers are lowercase hex; text
// fields stay raw bytes, because the resolver must check them before it shows them (Part 1
// Section 8.2). Integers are numbers: every time is at most 253,402,300,799,999 and every other
// integer that a valid record holds is far below 2^53, so a value outside these bounds makes the
// datum invalid.

import {
  bytesToHex,
  decodePlutusData,
  encodePlutusData,
  pdBytes,
  pdConstr,
  pdInt,
  pdList,
  type PlutusData,
} from "./plutus-data.js";

export type KeyType = "Ed25519" | "P256";
export type Role = "Accountable" | "Responsible" | "Provider" | "Distributor" | "Guardian";

export type Signer =
  | { readonly type: "KeyHash"; readonly hash: string }
  | { readonly type: "Script"; readonly hash: string }
  | { readonly type: "ControllerSet" };

export interface Key {
  readonly keyType: KeyType;
  /** 32 bytes (Ed25519) or a 33-byte compressed point (P-256), hex. */
  readonly key: string;
  /** Sum of purpose values: 1 authentication, 2 assertion, 8 transaction, 16 delegation. */
  readonly purposes: number;
  /** 64-byte r || s signature (P-256 only), hex. */
  readonly pop: string | null;
}

export interface Party {
  readonly role: Role;
  readonly signer: Signer;
  readonly organisation: Uint8Array | null;
  readonly notBefore: number;
  readonly notAfter: number | null;
  /** Bits: 1 suspend, 2 revoke, 4 recover. */
  readonly rights: number;
  readonly removalAfter: number | null;
}

export interface PendingRecovery {
  readonly newController: string;
  readonly effectiveAfter: number;
}

export type Lineage =
  | { readonly type: "Root" }
  | { readonly type: "Subagent"; readonly parent: string; readonly parentEpoch: number; readonly depth: number };

export interface Hold {
  readonly by: Signer;
  readonly reason: number;
  readonly since: number;
  readonly until: number;
}

export type Status =
  | { readonly type: "Active" }
  | { readonly type: "Suspended"; readonly holds: readonly Hold[] }
  | {
      readonly type: "Revoked";
      readonly by: Signer;
      readonly reason: number;
      readonly at: number;
      readonly invalidFrom: number | null;
      readonly successor: string | null;
    }
  | { readonly type: "Retired"; readonly at: number; readonly successor: string | null };

export interface IdentityDatum {
  /** Ed25519 public key, 32 bytes, hex. */
  readonly controller: string;
  readonly keys: readonly Key[];
  readonly parties: readonly Party[];
  readonly guardianThreshold: number;
  readonly pendingRecovery: PendingRecovery | null;
  readonly lineage: Lineage;
  readonly subagentEpoch: number;
  readonly name: Uint8Array;
  readonly description: Uint8Array;
  readonly framework: Uint8Array;
  readonly endpoint: Uint8Array;
  readonly capabilities: readonly Uint8Array[];
  /** POSIX milliseconds. */
  readonly createdAt: number;
  readonly status: Status;
}

/** Part 1 Section 5: every time is a POSIX millisecond value up to the end of the year 9999. */
export const MAX_TIME_MS = 253_402_300_799_999;

const KEY_TYPES: readonly KeyType[] = ["Ed25519", "P256"];
const ROLES: readonly Role[] = ["Accountable", "Responsible", "Provider", "Distributor", "Guardian"];

class DatumError extends Error {
  constructor(what: string) {
    super(`identity datum: ${what}`);
    this.name = "DatumError";
  }
}

function constr(data: PlutusData, what: string, arity?: number): { index: number; fields: readonly PlutusData[] } {
  if (data.type !== "constr" || data.index > 255n) throw new DatumError(`${what} is not a constructor`);
  if (arity !== undefined && data.fields.length !== arity) throw new DatumError(`${what} has ${data.fields.length} fields, expected ${arity}`);
  return { index: Number(data.index), fields: data.fields };
}

function variant(data: PlutusData, what: string, arities: readonly number[]): { index: number; fields: readonly PlutusData[] } {
  const c = constr(data, what);
  const arity = arities[c.index];
  if (arity === undefined) throw new DatumError(`${what} has constructor ${c.index}`);
  if (c.fields.length !== arity) throw new DatumError(`${what} constructor ${c.index} has ${c.fields.length} fields`);
  return c;
}

function bytes(data: PlutusData, what: string, length?: number): Uint8Array {
  if (data.type !== "bytes") throw new DatumError(`${what} is not a byte string`);
  if (length !== undefined && data.value.length !== length) throw new DatumError(`${what} is ${data.value.length} bytes, expected ${length}`);
  return data.value;
}

const hex = (data: PlutusData, what: string, length?: number): string => bytesToHex(bytes(data, what, length));

function list(data: PlutusData, what: string): readonly PlutusData[] {
  if (data.type !== "list") throw new DatumError(`${what} is not a list`);
  return data.items;
}

function int(data: PlutusData, what: string, max = BigInt(Number.MAX_SAFE_INTEGER)): number {
  if (data.type !== "int") throw new DatumError(`${what} is not an integer`);
  if (data.value < 0n || data.value > max) throw new DatumError(`${what} is out of range`);
  return Number(data.value);
}

const time = (data: PlutusData, what: string): number => int(data, what, BigInt(MAX_TIME_MS));

function option<T>(data: PlutusData, what: string, inner: (d: PlutusData) => T): T | null {
  const c = variant(data, what, [1, 0]);
  return c.index === 0 ? inner(c.fields[0]!) : null;
}

function signer(data: PlutusData, what: string): Signer {
  const c = variant(data, what, [1, 1, 0]);
  if (c.index === 2) return { type: "ControllerSet" };
  return { type: c.index === 0 ? "KeyHash" : "Script", hash: hex(c.fields[0]!, `${what} hash`, 28) };
}

function key(data: PlutusData): Key {
  const f = constr(data, "key", 4).fields;
  const keyType = KEY_TYPES[variant(f[0]!, "key type", [0, 0]).index]!;
  const keyBytes = bytes(f[1]!, "key", keyType === "Ed25519" ? 32 : 33);
  if (keyType === "P256" && keyBytes[0] !== 2 && keyBytes[0] !== 3) throw new DatumError("P-256 key is not a compressed point");
  return {
    keyType,
    key: bytesToHex(keyBytes),
    purposes: int(f[2]!, "key purposes"),
    pop: option(f[3]!, "key pop", (d) => hex(d, "key pop")),
  };
}

function party(data: PlutusData): Party {
  const f = constr(data, "party", 7).fields;
  return {
    role: ROLES[variant(f[0]!, "role", [0, 0, 0, 0, 0]).index]!,
    signer: signer(f[1]!, "party signer"),
    organisation: option(f[2]!, "organisation", (d) => bytes(d, "organisation")),
    notBefore: time(f[3]!, "not_before"),
    notAfter: option(f[4]!, "not_after", (d) => time(d, "not_after")),
    rights: int(f[5]!, "rights"),
    removalAfter: option(f[6]!, "removal_after", (d) => time(d, "removal_after")),
  };
}

function hold(data: PlutusData): Hold {
  const f = constr(data, "hold", 4).fields;
  return { by: signer(f[0]!, "hold author"), reason: int(f[1]!, "hold reason"), since: time(f[2]!, "since"), until: time(f[3]!, "until") };
}

function status(data: PlutusData): Status {
  const c = variant(data, "status", [0, 1, 5, 2]);
  const f = c.fields;
  switch (c.index) {
    case 0:
      return { type: "Active" };
    case 1:
      return { type: "Suspended", holds: list(f[0]!, "holds").map(hold) };
    case 2:
      return {
        type: "Revoked",
        by: signer(f[0]!, "revoked by"),
        reason: int(f[1]!, "revocation reason"),
        at: time(f[2]!, "revoked at"),
        invalidFrom: option(f[3]!, "invalid_from", (d) => time(d, "invalid_from")),
        successor: option(f[4]!, "successor", (d) => hex(d, "successor", 32)),
      };
    default:
      return { type: "Retired", at: time(f[0]!, "retired at"), successor: option(f[1]!, "successor", (d) => hex(d, "successor", 32)) };
  }
}

function lineage(data: PlutusData): Lineage {
  const c = variant(data, "lineage", [0, 3]);
  if (c.index === 0) return { type: "Root" };
  return {
    type: "Subagent",
    parent: hex(c.fields[0]!, "parent", 32),
    parentEpoch: int(c.fields[1]!, "parent_epoch"),
    depth: int(c.fields[2]!, "depth"),
  };
}

/** Decodes Plutus Data as an identity datum. Throws when the data does not have the Part 1 Section 5 layout. */
export function identityDatumFromData(data: PlutusData): IdentityDatum {
  const datum = constr(data, "datum", 14);
  if (datum.index !== 0) throw new DatumError("datum is not constructor 0");
  const f = datum.fields;
  return {
    controller: hex(f[0]!, "controller", 32),
    keys: list(f[1]!, "keys").map(key),
    parties: list(f[2]!, "parties").map(party),
    guardianThreshold: int(f[3]!, "guardian_threshold"),
    pendingRecovery: option(f[4]!, "pending_recovery", (d) => {
      const r = constr(d, "pending recovery", 2).fields;
      return { newController: hex(r[0]!, "new_controller", 32), effectiveAfter: time(r[1]!, "effective_after") };
    }),
    lineage: lineage(f[5]!),
    subagentEpoch: int(f[6]!, "subagent_epoch"),
    name: bytes(f[7]!, "name"),
    description: bytes(f[8]!, "description"),
    framework: bytes(f[9]!, "framework"),
    endpoint: bytes(f[10]!, "endpoint"),
    capabilities: list(f[11]!, "capabilities").map((c) => bytes(c, "capability")),
    createdAt: time(f[12]!, "created_at"),
    status: status(f[13]!),
  };
}

export function decodeIdentityDatum(cbor: Uint8Array): IdentityDatum {
  return identityDatumFromData(decodePlutusData(cbor));
}

// ── encoding (fixtures, vectors and builders) ───────────────────────────────

const none: PlutusData = pdConstr(1, []);
const opt = <T>(v: T | null, f: (x: T) => PlutusData): PlutusData => (v === null ? none : pdConstr(0, [f(v)]));

function signerData(s: Signer): PlutusData {
  if (s.type === "ControllerSet") return pdConstr(2, []);
  return pdConstr(s.type === "KeyHash" ? 0 : 1, [pdBytes(s.hash)]);
}

function statusData(s: Status): PlutusData {
  switch (s.type) {
    case "Active":
      return pdConstr(0, []);
    case "Suspended":
      return pdConstr(1, [pdList(s.holds.map((h) => pdConstr(0, [signerData(h.by), pdInt(h.reason), pdInt(h.since), pdInt(h.until)])))]);
    case "Revoked":
      return pdConstr(2, [signerData(s.by), pdInt(s.reason), pdInt(s.at), opt(s.invalidFrom, pdInt), opt(s.successor, pdBytes)]);
    case "Retired":
      return pdConstr(3, [pdInt(s.at), opt(s.successor, pdBytes)]);
  }
}

export function identityDatumToData(d: IdentityDatum): PlutusData {
  return pdConstr(0, [
    pdBytes(d.controller),
    pdList(d.keys.map((k) => pdConstr(0, [pdConstr(KEY_TYPES.indexOf(k.keyType), []), pdBytes(k.key), pdInt(k.purposes), opt(k.pop, pdBytes)]))),
    pdList(
      d.parties.map((p) =>
        pdConstr(0, [
          pdConstr(ROLES.indexOf(p.role), []),
          signerData(p.signer),
          opt(p.organisation, pdBytes),
          pdInt(p.notBefore),
          opt(p.notAfter, pdInt),
          pdInt(p.rights),
          opt(p.removalAfter, pdInt),
        ]),
      ),
    ),
    pdInt(d.guardianThreshold),
    opt(d.pendingRecovery, (r) => pdConstr(0, [pdBytes(r.newController), pdInt(r.effectiveAfter)])),
    d.lineage.type === "Root" ? pdConstr(0, []) : pdConstr(1, [pdBytes(d.lineage.parent), pdInt(d.lineage.parentEpoch), pdInt(d.lineage.depth)]),
    pdInt(d.subagentEpoch),
    pdBytes(d.name),
    pdBytes(d.description),
    pdBytes(d.framework),
    pdBytes(d.endpoint),
    pdList(d.capabilities.map((c) => pdBytes(c))),
    pdInt(d.createdAt),
    statusData(d.status),
  ]);
}

export function encodeIdentityDatum(d: IdentityDatum): Uint8Array {
  return encodePlutusData(identityDatumToData(d));
}

export function signerEquals(a: Signer, b: Signer): boolean {
  if (a.type === "ControllerSet" || b.type === "ControllerSet") return a.type === b.type;
  return a.type === b.type && a.hash === b.hash;
}
