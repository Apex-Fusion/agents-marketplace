// Generation-1 record datum: Constr 0 with 7 fields
//   [owner credential, name, description, capabilities, framework, endpoint, registered_at]
// (same layout as vector-service-agents packages/vector-read/src/datum.ts decodeRegistryDatum).
// Only the owner credential is used: the other six fields are self-declared and are not rendered
// (method spec Section 6.5).

import { asConstr, decodeCbor } from "./cbor.js";

export interface LegacyOwner {
  /** Plutus Credential: Constr 0 = verification key hash, Constr 1 = script hash. */
  kind: "key" | "script";
  /** 28-byte hash, lowercase hex. */
  hash: string;
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/;

export function decodeLegacyOwner(datumHex: string): LegacyOwner {
  if (!HEX.test(datumHex)) throw new Error("datum is not hex");
  const record = asConstr(decodeCbor(Buffer.from(datumHex, "hex")));
  if (!record || record.index !== 0 || record.fields.length !== 7) {
    throw new Error("datum is not a generation-1 record (Constr 0 with 7 fields)");
  }
  const credential = asConstr(record.fields[0]!);
  const hash = credential?.fields[0];
  if (!credential || credential.index > 1 || credential.fields.length !== 1 || !(hash instanceof Uint8Array) || hash.length !== 28) {
    throw new Error("datum owner is not a credential with a 28-byte hash");
  }
  return { kind: credential.index === 0 ? "key" : "script", hash: Buffer.from(hash).toString("hex") };
}
