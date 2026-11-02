// Identifier vectors (Part 1 §3.1, §3.2): the published file equals the shared helpers' output, and
// an independent derivation (the harness's Plutus Data encoder and blake2b, a base32 decoder written
// here) agrees with every vector.

import { describe, expect, test } from "vitest";
import { parseVectorDid } from "@marketplace/shared/identity";
import { constr, encodeData } from "../legacy-registry/harness/data.js";
import { blake2b256, fromHex, toHex } from "../legacy-registry/harness/ledger.js";
import { LEGACY_REGISTRY } from "../../identity-gateway/src/resolve/settings.js";
import { identifierVectors, identifiersFile, publishedFile } from "./vectors.js";

const vectors = identifierVectors();

/** RFC 4648 Section 6 base32 decoding of lowercase text without padding. */
function base32Decode(text: string): Uint8Array {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = "";
  for (const c of text) {
    const value = alphabet.indexOf(c);
    if (value < 0) throw new Error(`not base32: ${c}`);
    bits += value.toString(2).padStart(5, "0");
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if (/1/.test(bits.slice(out.length * 8))) throw new Error("non-zero padding bits");
  return out;
}

describe("identifier vectors", () => {
  test("the published file is the output of the shared helpers", () => {
    expect(publishedFile("identifiers.json")).toBe(identifiersFile());
  });

  test("the first two vectors are those of Part 1 §3.1 and §3.2", () => {
    expect(vectors.slice(0, 2).map((v) => [v.txId, v.outputIndex, v.vectorId, v.dnsSafe])).toEqual([
      ["00".repeat(32), 0, "a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9", "uls6ej4fr2cpdkhzwdasi3tmxsjtnvyh2q52ipiods34khcf6teq"],
      ["ab".repeat(32), 24, "3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b", "hxoqoulsaxoyu5cyq7btuco2bzff2y64uhyvdtxo3lxnubkryuvq"],
    ]);
  });

  test("the output indices cross each length of the CBOR integer head", () => {
    expect(vectors.map((v) => v.serialisedSeed.slice(74))).toEqual(["00ff", "1818ff", "01ff", "17ff", "18ffff", "190100ff", "19ffffff", "1a00010000ff"]);
  });

  test.each(vectors.map((v) => [`${v.txId.slice(0, 8)}#${v.outputIndex}`, v] as const))("%s: independent derivation", (_name, v) => {
    const seed = encodeData(constr(0, fromHex(v.txId), BigInt(v.outputIndex)));
    expect(toHex(seed)).toBe(v.serialisedSeed);
    expect(v.serialisedSeed.startsWith(`d8799f5820${v.txId}`)).toBe(true);
    expect(toHex(blake2b256(seed))).toBe(v.vectorId);
    expect(v.dnsSafe).toMatch(/^[a-z2-7]{52}$/);
    expect(toHex(base32Decode(v.dnsSafe))).toBe(v.vectorId);
    expect(parseVectorDid(v.did)).toEqual({ form: "canonical", vectorId: v.vectorId });
    expect(parseVectorDid(v.legacyDid)).toEqual({ form: "legacy", policyId: LEGACY_REGISTRY.policyId, vectorId: v.vectorId });
  });
});
