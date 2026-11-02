// Attestation envelope vectors (Part 2 §4.2). The published file equals the builder's output; the
// protected header, the Sig_structure and the COSE_Sign1 message equal byte strings assembled here
// by hand from the spec; a CBOR decoder reads the same values back; and the signature verifies
// with the RFC 8032 test key.

import { createPublicKey, sign, verify } from "node:crypto";
import { Decoder, Tag } from "cbor-x";
import { describe, expect, test } from "vitest";
import { keyHash } from "@marketplace/shared/identity";
import { ENVELOPE_TEST_KEY, envelopeFile, envelopeTestKey, envelopeVectors, publishedFile } from "./vectors.js";
import { sha256Hex } from "./envelope.js";

const vectors = envelopeVectors();
const decoder = new Decoder({ mapsAsObjects: false });

const utf8Hex = (text: string): string => Buffer.from(text, "utf8").toString("hex");

/** A CBOR head (RFC 8949 Section 3) in the shortest form, as hex. */
function head(major: number, length: number): string {
  const type = major << 5;
  if (length < 24) return (type | length).toString(16).padStart(2, "0");
  if (length < 0x100) return `${(type | 24).toString(16)}${length.toString(16).padStart(2, "0")}`;
  if (length < 0x10000) return `${(type | 25).toString(16)}${length.toString(16).padStart(4, "0")}`;
  return `${(type | 26).toString(16)}${length.toString(16).padStart(8, "0")}`;
}

const textItem = (text: string): string => `${head(3, Buffer.byteLength(text))}${utf8Hex(text)}`;
const bytesItem = (hex: string): string => `${head(2, hex.length / 2)}${hex}`;

/** Bitcoin base58 (the base58btc multibase alphabet). */
function base58btc(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

describe("attestation envelope vectors", () => {
  test("the published file is the output of the envelope builder", () => {
    expect(publishedFile("attestation-envelope.json")).toBe(envelopeFile());
  });

  test("the test key is RFC 8032 TEST 1", () => {
    const spki = createPublicKey(envelopeTestKey()).export({ format: "der", type: "spki" });
    expect(spki.subarray(-32).toString("hex")).toBe(ENVELOPE_TEST_KEY.publicKey);
    expect(ENVELOPE_TEST_KEY.publicKey).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  });

  test("RFC 8032 TEST 1: the key signs the empty message as the RFC shows", () => {
    expect(sign(null, Buffer.alloc(0), envelopeTestKey()).toString("hex")).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
  });

  test("one vector has a registered issuer and a format, one a did:key issuer and no format", () => {
    expect(vectors.map((v) => [v.attestation.issuerId !== null, v.attestation.format])).toEqual([
      [true, 50],
      [false, null],
    ]);
  });

  test.each(vectors.map((v) => [v.name, v] as const))("%s: the kid and the issuer DID", (_name, v) => {
    const { attestation } = v;
    if (attestation.issuerId !== null) {
      expect(v.issuerDid).toBe(`did:vector:${attestation.issuerId}`);
      expect(v.kid).toBe(`did:vector:${attestation.issuerId}#${keyHash(attestation.issuer)}`);
    } else {
      const multibase = `z${base58btc(Buffer.from(`ed01${attestation.issuer}`, "hex"))}`;
      expect(multibase.startsWith("z6Mk")).toBe(true);
      expect(v.issuerDid).toBe(`did:key:${multibase}`);
      expect(v.kid).toBe(`did:key:${multibase}#${multibase}`);
    }
  });

  test.each(vectors.map((v) => [v.name, v] as const))("%s: the bytes assembled by hand from the spec", (_name, v) => {
    const { attestation } = v;
    expect(attestation.digest).toBe(sha256Hex(v.document));
    // Core deterministic encoding: keys 1, 4, 15, 258, 259 (encoded 01, 04, 0f, 190102, 190103).
    const claims = `a3 01${textItem(v.issuerDid)} 02${textItem(`did:vector:${attestation.subject}`)} 06${head(0, Math.floor(attestation.issuedAt / 1000))}`;
    const format = attestation.format === null ? "" : ` 190103${head(0, attestation.format)}`;
    const count = attestation.format === null ? "a4" : "a5";
    const protectedHex = `${count} 01 32 04${bytesItem(utf8Hex(v.kid))} 0f ${claims} 190102 2f${format}`.replaceAll(" ", "");
    expect(v.protectedHeader.hex).toBe(protectedHex);
    const sigStructure = `84${textItem("Signature1")}${bytesItem(protectedHex)}40${bytesItem(attestation.digest)}`;
    expect(v.sigStructure.hex).toBe(sigStructure);
    expect(v.coseSign1).toBe(`d284${bytesItem(protectedHex)}a0${bytesItem(attestation.digest)}${bytesItem(v.signature)}`);
  });

  test.each(vectors.map((v) => [v.name, v] as const))("%s: a CBOR decoder reads the header back", (_name, v) => {
    const { attestation } = v;
    const header: unknown = decoder.decode(Buffer.from(v.protectedHeader.hex, "hex"));
    if (!(header instanceof Map)) throw new Error("the protected header is not a map");
    const expected = new Map<number, unknown>([
      [1, -19],
      [4, Buffer.from(v.kid, "utf8")],
      [
        15,
        new Map<number, unknown>([
          [1, v.issuerDid],
          [2, `did:vector:${attestation.subject}`],
          [6, Math.floor(attestation.issuedAt / 1000)],
        ]),
      ],
      [258, -16],
    ]);
    if (attestation.format !== null) expected.set(259, attestation.format);
    expect([...header.keys()]).toEqual([...expected.keys()]);
    expect(header).toEqual(expected);
    const message: unknown = decoder.decode(Buffer.from(v.coseSign1, "hex"));
    if (!(message instanceof Tag)) throw new Error("the COSE_Sign1 message is not a tag");
    expect(message.tag).toBe(18);
  });

  test.each(vectors.map((v) => [v.name, v] as const))("%s: the signature verifies with the issuer key", (_name, v) => {
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(v.attestation.issuer, "hex")]),
      format: "der",
      type: "spki",
    });
    const message = Buffer.from(v.sigStructure.hex, "hex");
    const signature = Buffer.from(v.signature, "hex");
    expect(signature.length).toBe(64);
    expect(verify(null, message, publicKey, signature)).toBe(true);
    const other = Buffer.from(message);
    other[other.length - 1]! ^= 1;
    expect(verify(null, other, publicKey, signature)).toBe(false);
  });
});
