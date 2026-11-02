// Throwaway test keys derived from fixed seeds. They never sign anything outside the tests.

import { createECDH, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { keyHash } from "../../src/codec/keys.js";

/** Ed25519 public key (hex) of the 32-byte seed `seedByte` repeated. */
export function ed25519Key(seedByte: number): string {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seedByte)]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("hex");
}

/** P-256 group order. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export interface P256TestKey {
  /** Compressed point, 33 bytes, hex. */
  readonly publicKey: string;
  readonly keyHash: string;
  /** ES256 signature r || s (hex) over `message`, with s in the low or the high form. */
  sign(message: string, form?: "low" | "high"): string;
  /** The `pop` of a record key: a signature over `did:vector:<vectorId>#<key hash>`. */
  pop(vectorId: string, form?: "low" | "high"): string;
}

/** P-256 key with the private scalar `scalarByte` repeated 32 times. */
export function p256Key(scalarByte: number): P256TestKey {
  const d = Buffer.alloc(32, scalarByte);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const uncompressed = ecdh.getPublicKey();
  const publicKey = ecdh.getPublicKey(undefined, "compressed").toString("hex");
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: d.toString("base64url"),
      x: uncompressed.subarray(1, 33).toString("base64url"),
      y: uncompressed.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const hash = keyHash(publicKey);
  const signWith = (message: string, form: "low" | "high" = "low"): string => {
    const sig = sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" });
    let s = BigInt(`0x${sig.subarray(32).toString("hex")}`);
    if ((form === "high") !== s > N / 2n) s = N - s;
    return Buffer.concat([sig.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, "0"), "hex")]).toString("hex");
  };
  return { publicKey, keyHash: hash, sign: signWith, pop: (vectorId, form) => signWith(`did:vector:${vectorId}#${hash}`, form) };
}
