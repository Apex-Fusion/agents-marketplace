// Legacy registry record datum (Part 1 Section 5, LegacyDatum): Constr 0 with 7 fields
//   [owner credential, name, description, capabilities, framework, endpoint, registered_at].
// `registered_at` is self-declared; the resolver keeps it only to re-encode the datum exactly.

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

export interface LegacyOwner {
  /** Plutus Credential: Constr 0 = verification key hash, Constr 1 = script hash. */
  readonly kind: "key" | "script";
  /** 28-byte hash, lowercase hex. */
  readonly hash: string;
}

export interface LegacyDatum {
  readonly owner: LegacyOwner;
  readonly name: Uint8Array;
  readonly description: Uint8Array;
  readonly capabilities: readonly Uint8Array[];
  readonly framework: Uint8Array;
  readonly endpoint: Uint8Array;
  /** Self-declared; not used. */
  readonly registeredAt: bigint;
}

function byteField(data: PlutusData | undefined, what: string): Uint8Array {
  if (data?.type !== "bytes") throw new Error(`legacy datum: ${what} is not a byte string`);
  return data.value;
}

/** Decodes Plutus Data as a legacy datum. Throws when the data does not have the 7-field layout. */
export function legacyDatumFromData(data: PlutusData): LegacyDatum {
  if (data.type !== "constr" || data.index !== 0n || data.fields.length !== 7) {
    throw new Error("legacy datum: not a legacy record (Constr 0 with 7 fields)");
  }
  const [owner, name, description, capabilities, framework, endpoint, registeredAt] = data.fields;
  const hash = owner?.type === "constr" && owner.fields.length === 1 ? owner.fields[0] : undefined;
  if (owner?.type !== "constr" || owner.index > 1n || hash?.type !== "bytes" || hash.value.length !== 28) {
    throw new Error("legacy datum: owner is not a credential with a 28-byte hash");
  }
  if (capabilities?.type !== "list") throw new Error("legacy datum: capabilities is not a list");
  if (registeredAt?.type !== "int") throw new Error("legacy datum: registered_at is not an integer");
  return {
    owner: { kind: owner.index === 0n ? "key" : "script", hash: bytesToHex(hash.value) },
    name: byteField(name, "name"),
    description: byteField(description, "description"),
    capabilities: capabilities.items.map((c) => byteField(c, "capability")),
    framework: byteField(framework, "framework"),
    endpoint: byteField(endpoint, "endpoint"),
    registeredAt: registeredAt.value,
  };
}

export function decodeLegacyDatum(cbor: Uint8Array): LegacyDatum {
  return legacyDatumFromData(decodePlutusData(cbor));
}

export function encodeLegacyDatum(d: LegacyDatum): Uint8Array {
  return encodePlutusData(
    pdConstr(0, [
      pdConstr(d.owner.kind === "key" ? 0 : 1, [pdBytes(d.owner.hash)]),
      pdBytes(d.name),
      pdBytes(d.description),
      pdList(d.capabilities.map((c) => pdBytes(c))),
      pdBytes(d.framework),
      pdBytes(d.endpoint),
      pdInt(d.registeredAt),
    ]),
  );
}
