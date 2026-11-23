// Attestation records (Part 2 Section 4) as Plutus Data, with the gateway's own Plutus Data codec:
//
//   AttestationDatum  Constr 0, 16 fields: subject, issuer, issuer_id, att_type, format, profile,
//                     digest, locator, envelope_sig, issued_at, valid_from, valid_until, solicited,
//                     status, contested, links
//   AttStatus         AttActive (Constr 0, no fields)  |  AttRevoked { at, reason } (Constr 1)
//   Anchor            Constr 0 [uri, sha256]
//   Link              Constr 0 [rel, target]
//   Option            Some = Constr 0 [value], None = Constr 1 []
//   Bool              False = Constr 0 [], True = Constr 1 []
//
// Byte strings that name a key, a hash or an identifier are lowercase hex. The locator and the
// anchor URI stay raw bytes, because the resolver must check them before it shows them. Integers
// are numbers, except the revocation reason, which any integer below 2^63 can be: it is a bigint.
// The decoder checks the layout, the fixed byte lengths and the integer ranges; the attestation
// contract checks the rest when it creates the record. The golden test compares both directions
// with the contracts' CBOR fixtures byte for byte.

import { MAX_TIME_MS } from "./identity-datum.js";
import { bytesToHex, decodePlutusData, encodePlutusData, pdBytes, pdConstr, pdInt, pdList, type PlutusData } from "./plutus-data.js";

export type AttStatus = { readonly type: "Active" } | { readonly type: "Revoked"; readonly at: number; readonly reason: bigint };

/** The subject's reply to an attestation (`Contest`). */
export interface Anchor {
  /** 1 to 256 bytes. */
  readonly uri: Uint8Array;
  /** 32 bytes, hex. */
  readonly sha256: string;
}

/** `rel`: 0 supersedes, 1 depends_on, 2 corroborates, 3 disputes. `target` is the token name of another attestation (32 bytes, hex). */
export interface Link {
  readonly rel: number;
  readonly target: string;
}

export interface AttestationDatum {
  /** The identifier of the agent that the attestation is about (32 bytes, hex). */
  readonly subject: string;
  /** Ed25519 public key of the issuer (32 bytes, hex). */
  readonly issuer: string;
  /** The identifier of the issuer, when the issuer is a registered agent (32 bytes, hex). */
  readonly issuerId: string | null;
  /** 0 identity, 1 provenance, 2 software, 3 environment, 4 principal binding, 5 approval, 15 other. */
  readonly attType: number;
  /** CoAP Content-Format of the document. */
  readonly format: number | null;
  /** 32 bytes, hex: hash of the profile or type URI. */
  readonly profile: string | null;
  /** SHA-256 of the document (32 bytes, hex). */
  readonly digest: string;
  /** Retrieval hint, up to 256 bytes. */
  readonly locator: Uint8Array | null;
  /** COSE_Sign1 signature (64 bytes, hex). */
  readonly envelopeSig: string | null;
  /** POSIX ms: the upper bound of the validity range of the minting transaction. */
  readonly issuedAt: number;
  readonly validFrom: number | null;
  readonly validUntil: number | null;
  /** The subject's controller co-signed. */
  readonly solicited: boolean;
  readonly status: AttStatus;
  readonly contested: Anchor | null;
  readonly links: readonly Link[];
}

export class AttestationDatumError extends Error {
  constructor(what: string) {
    super(`attestation datum: ${what}`);
    this.name = "AttestationDatumError";
  }
}

/** The contract bounds the revocation reason by 2^63. */
const MAX_REASON = (1n << 63n) - 1n;

function constr(data: PlutusData, what: string, arities: readonly number[]): { index: number; fields: readonly PlutusData[] } {
  if (data.type !== "constr" || data.index >= BigInt(arities.length)) throw new AttestationDatumError(`${what} is not one of its constructors`);
  const index = Number(data.index);
  if (data.fields.length !== arities[index]) throw new AttestationDatumError(`${what} constructor ${index} has ${data.fields.length} fields`);
  return { index, fields: data.fields };
}

function bytes(data: PlutusData, what: string, length?: number): Uint8Array {
  if (data.type !== "bytes") throw new AttestationDatumError(`${what} is not a byte string`);
  if (length !== undefined && data.value.length !== length) throw new AttestationDatumError(`${what} is ${data.value.length} bytes, expected ${length}`);
  return data.value;
}

const hex = (data: PlutusData, what: string, length?: number): string => bytesToHex(bytes(data, what, length));

function bigint(data: PlutusData, what: string, max: bigint): bigint {
  if (data.type !== "int" || data.value < 0n || data.value > max) throw new AttestationDatumError(`${what} is not an integer in [0, ${max}]`);
  return data.value;
}

const number = (data: PlutusData, what: string, max: number): number => Number(bigint(data, what, BigInt(max)));
const time = (data: PlutusData, what: string): number => number(data, what, MAX_TIME_MS);

function option<T>(data: PlutusData, what: string, inner: (d: PlutusData) => T): T | null {
  const c = constr(data, what, [1, 0]);
  return c.index === 0 ? inner(c.fields[0]!) : null;
}

function status(data: PlutusData): AttStatus {
  const c = constr(data, "status", [0, 2]);
  if (c.index === 0) return { type: "Active" };
  return { type: "Revoked", at: time(c.fields[0]!, "revoked at"), reason: bigint(c.fields[1]!, "revocation reason", MAX_REASON) };
}

function anchor(data: PlutusData): Anchor {
  const f = constr(data, "contest anchor", [2]).fields;
  return { uri: bytes(f[0]!, "contest uri"), sha256: hex(f[1]!, "contest sha256", 32) };
}

function link(data: PlutusData, i: number): Link {
  const f = constr(data, `link ${i}`, [2]).fields;
  return { rel: number(f[0]!, `link ${i} rel`, Number.MAX_SAFE_INTEGER), target: hex(f[1]!, `link ${i} target`, 32) };
}

export function attestationDatumFromData(data: PlutusData): AttestationDatum {
  const f = constr(data, "datum", [16]).fields;
  const links = f[15]!;
  if (links.type !== "list") throw new AttestationDatumError("links is not a list");
  return {
    subject: hex(f[0]!, "subject", 32),
    issuer: hex(f[1]!, "issuer", 32),
    issuerId: option(f[2]!, "issuer_id", (d) => hex(d, "issuer_id", 32)),
    attType: number(f[3]!, "att_type", Number.MAX_SAFE_INTEGER),
    format: option(f[4]!, "format", (d) => number(d, "format", Number.MAX_SAFE_INTEGER)),
    profile: option(f[5]!, "profile", (d) => hex(d, "profile", 32)),
    digest: hex(f[6]!, "digest", 32),
    locator: option(f[7]!, "locator", (d) => bytes(d, "locator")),
    envelopeSig: option(f[8]!, "envelope_sig", (d) => hex(d, "envelope_sig", 64)),
    issuedAt: time(f[9]!, "issued_at"),
    validFrom: option(f[10]!, "valid_from", (d) => time(d, "valid_from")),
    validUntil: option(f[11]!, "valid_until", (d) => time(d, "valid_until")),
    solicited: constr(f[12]!, "solicited", [0, 0]).index === 1,
    status: status(f[13]!),
    contested: option(f[14]!, "contested", anchor),
    links: links.items.map(link),
  };
}

export const decodeAttestationDatum = (cbor: Uint8Array): AttestationDatum => attestationDatumFromData(decodePlutusData(cbor));

const some = (value: PlutusData | null): PlutusData => (value === null ? pdConstr(1, []) : pdConstr(0, [value]));

export function attestationDatumToData(d: AttestationDatum): PlutusData {
  return pdConstr(0, [
    pdBytes(d.subject),
    pdBytes(d.issuer),
    some(d.issuerId === null ? null : pdBytes(d.issuerId)),
    pdInt(d.attType),
    some(d.format === null ? null : pdInt(d.format)),
    some(d.profile === null ? null : pdBytes(d.profile)),
    pdBytes(d.digest),
    some(d.locator === null ? null : pdBytes(d.locator)),
    some(d.envelopeSig === null ? null : pdBytes(d.envelopeSig)),
    pdInt(d.issuedAt),
    some(d.validFrom === null ? null : pdInt(d.validFrom)),
    some(d.validUntil === null ? null : pdInt(d.validUntil)),
    pdConstr(d.solicited ? 1 : 0, []),
    d.status.type === "Active" ? pdConstr(0, []) : pdConstr(1, [pdInt(d.status.at), pdInt(d.status.reason)]),
    some(d.contested === null ? null : pdConstr(0, [pdBytes(d.contested.uri), pdBytes(d.contested.sha256)])),
    pdList(d.links.map((l) => pdConstr(0, [pdInt(l.rel), pdBytes(l.target)]))),
  ]);
}

export const encodeAttestationDatum = (d: AttestationDatum): Uint8Array => encodePlutusData(attestationDatumToData(d));
