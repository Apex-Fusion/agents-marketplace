// Gateway key files (Part 2 Section 8.2): one Ed25519 key and one P-256 key, files that only the
// gateway user can read; public keys as JWKs; the signer shape that the agent-card renderer uses.

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { keyHash } from "../../src/codec/keys.js";
import { KeyFileError, loadGatewayKeys, readPrivateKeyFile, type GatewayKey } from "../../src/keys/gateway-keys.js";
import { recordKeyObject } from "../../src/m4/jose.js";

const GATEWAY_ID = "ab".repeat(32);
const dir = mkdtempSync(join(tmpdir(), "gateway-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fileCount = 0;
function keyFile(pem: string, mode = 0o600): string {
  const path = join(dir, `key-${fileCount++}.pem`);
  writeFileSync(path, pem);
  chmodSync(path, mode);
  return path;
}

const ed25519Pem = () => generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const p256Pem = (type: "pkcs8" | "sec1" = "pkcs8") => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type }).toString();

/** The interface that the A2A agent-card renderer (src/render/signer.ts) declares for its Ed25519 signer. */
interface Ed25519Signer {
  readonly kid: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

describe("loadGatewayKeys", () => {
  test("loads both keys from files with mode 600; JWKs, kids, key hashes and signatures", async () => {
    const keys = loadGatewayKeys({ ed25519: keyFile(ed25519Pem()), p256: keyFile(p256Pem()) }, GATEWAY_ID);
    const { ed25519, p256 } = keys;
    expect(ed25519).toMatchObject({ keyType: "Ed25519", alg: "EdDSA" });
    expect(p256).toMatchObject({ keyType: "P256", alg: "ES256" });
    for (const key of [ed25519, p256]) {
      expect(key.keyHash).toBe(keyHash(key.publicKey));
      expect(key.kid).toBe(`did:vector:${GATEWAY_ID}#${key.keyHash}`);
      expect(key.publicJwk).toMatchObject({ kid: key.kid, alg: key.alg, use: "sig" });
      expect(createPublicKey({ key: Buffer.from(key.spki), format: "der", type: "spki" }).export({ format: "jwk" })).toMatchObject({ x: key.publicJwk.x });
    }
    expect(ed25519.publicKey).toBe(Buffer.from(ed25519.publicJwk.x, "base64url").toString("hex"));
    expect(ed25519.publicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x: expect.any(String), kid: ed25519.kid, alg: "EdDSA", use: "sig" });
    expect(p256.publicJwk).toEqual({ kty: "EC", crv: "P-256", x: expect.any(String), y: expect.any(String), kid: p256.kid, alg: "ES256", use: "sig" });
    // The compressed point (as the record lists it) is the JWK point.
    expect(recordKeyObject("P256", p256.publicKey).export({ format: "jwk" })).toMatchObject({ x: p256.publicJwk.x, y: p256.publicJwk.y });

    const data = Buffer.from("agent card bytes");
    const edSig = await ed25519.sign(data);
    expect(edSig.length).toBe(64);
    expect(verify(null, data, recordKeyObject("Ed25519", ed25519.publicKey), edSig)).toBe(true);
    const p256Sig = await p256.sign(data);
    expect(p256Sig.length).toBe(64);
    expect(verify("sha256", data, { key: recordKeyObject("P256", p256.publicKey), dsaEncoding: "ieee-p1363" }, p256Sig)).toBe(true);

    // The Ed25519 key satisfies the renderer's signer interface without an adapter.
    const signer: Ed25519Signer = ed25519;
    expect(signer.kid).toBe(ed25519.kid);
  });

  test("a SEC1 (EC PRIVATE KEY) P-256 file and a file without group or other access bits but with owner execute are accepted", () => {
    const keys = loadGatewayKeys({ ed25519: keyFile(ed25519Pem(), 0o700), p256: keyFile(p256Pem("sec1"), 0o400) }, GATEWAY_ID);
    expect(keys.p256.keyType).toBe("P256");
  });

  test.each<[string, number, RegExp]>([
    ["world-readable (644)", 0o644, /readable by its group or by other users \(mode 644\)/],
    ["group-readable (640)", 0o640, /readable by its group or by other users \(mode 640\)/],
    ["readable by others only (604)", 0o604, /readable by its group or by other users \(mode 604\)/],
    ["group-writable (620)", 0o620, /writable by its group or by other users \(mode 620\)/],
  ])("a key file that is %s is refused", (_name, mode, message) => {
    const path = keyFile(ed25519Pem(), mode);
    expect(() => readPrivateKeyFile(path)).toThrow(KeyFileError);
    expect(() => readPrivateKeyFile(path)).toThrow(message);
    expect(() => loadGatewayKeys({ ed25519: path, p256: keyFile(p256Pem()) }, GATEWAY_ID)).toThrow(message);
  });

  test("errors name the file and never the key", () => {
    const pem = ed25519Pem();
    const swapped = () => loadGatewayKeys({ ed25519: keyFile(p256Pem()), p256: keyFile(pem) }, GATEWAY_ID);
    expect(swapped).toThrow(/does not hold an Ed25519 private key/);
    expect(() => loadGatewayKeys({ ed25519: keyFile(pem), p256: keyFile(ed25519Pem()) }, GATEWAY_ID)).toThrow(/does not hold a P-256 private key/);
    expect(() => readPrivateKeyFile(join(dir, "missing.pem"))).toThrow(/cannot be read: ENOENT/);
    const sub = join(dir, "a-directory");
    mkdirSync(sub);
    expect(() => readPrivateKeyFile(sub)).toThrow(/not a regular file/);
    expect(() => readPrivateKeyFile(keyFile("not a key"))).toThrow(/does not hold a PEM private key/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => loadGatewayKeys({ ed25519: keyFile(rsa), p256: keyFile(p256Pem()) }, GATEWAY_ID)).toThrow(/does not hold an Ed25519 private key/);
    try {
      swapped();
    } catch (e) {
      expect((e as Error).message).not.toContain(pem.split("\n")[1]!);
    }
  });

  test("the gateway identifier must be 64 lowercase hex characters", () => {
    expect(() => loadGatewayKeys({ ed25519: keyFile(ed25519Pem()), p256: keyFile(p256Pem()) }, "AB".repeat(32))).toThrow(/64 lowercase hex/);
  });

  test("the key object type is GatewayKey", () => {
    const key: GatewayKey = loadGatewayKeys({ ed25519: keyFile(ed25519Pem()), p256: keyFile(p256Pem()) }, GATEWAY_ID).p256;
    expect(key.spki.length).toBeGreaterThan(64);
  });
});
