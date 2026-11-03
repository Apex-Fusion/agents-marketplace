/**
 * Ed25519 payment keys of the deployment: cardano-cli TextEnvelope files
 * (`PaymentSigningKeyShelley_ed25519`, `PaymentVerificationKeyShelley_ed25519`)
 * or a file with the 32-byte signing key as 64 hex characters.
 *
 * The tool reads a signing key only from the path that the operator gives,
 * keeps it in memory, and never prints, logs or copies it. Error messages
 * name the path, never the content.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { enterpriseAddress, keyHash, type NetworkId } from "@marketplace/shared";
import { DeployError } from "./network.js";

const SIGNING_TYPE = "PaymentSigningKeyShelley_ed25519";
const VERIFICATION_TYPE = "PaymentVerificationKeyShelley_ed25519";
/** CBOR head of a 32-byte byte string: the `cborHex` of both key envelopes starts with it. */
const KEY_CBOR_HEAD = "5820";
/** DER prefix of a PKCS #8 Ed25519 private key; the 32-byte key follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A payment key in memory. `privateKeyHex` never leaves the process except as a signature. */
export interface PaymentKey {
  readonly privateKeyHex: string;
  readonly publicKeyHex: string;
  readonly keyHash: string;
}

export interface VerificationKey {
  readonly publicKeyHex: string;
  readonly keyHash: string;
}

function publicKeyOf(privateKey: Buffer): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, privateKey]), format: "der", type: "pkcs8" });
  return createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
}

function envelopeKey(path: string, raw: string, type: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const envelope = parsed as { type?: unknown; cborHex?: unknown };
  if (envelope.type !== type || typeof envelope.cborHex !== "string") {
    throw new DeployError(`${path}: expected a cardano-cli ${type} envelope`);
  }
  const cborHex = envelope.cborHex.toLowerCase();
  if (!cborHex.startsWith(KEY_CBOR_HEAD) || !/^[0-9a-f]{68}$/.test(cborHex)) throw new DeployError(`${path}: the cborHex is not a 32-byte key`);
  return cborHex.slice(KEY_CBOR_HEAD.length);
}

/** Reads a signing key: a TextEnvelope payment signing key, or 64 hex characters. */
export function readSigningKey(path: string): PaymentKey {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new DeployError(`cannot read the signing key ${path}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  const fromEnvelope = envelopeKey(path, raw, SIGNING_TYPE);
  const privateKeyHex = fromEnvelope ?? raw.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) {
    throw new DeployError(`${path}: not a payment signing key (a cardano-cli ${SIGNING_TYPE} envelope or 64 hex characters)`);
  }
  const publicKeyHex = publicKeyOf(Buffer.from(privateKeyHex, "hex"));
  return { privateKeyHex, publicKeyHex, keyHash: keyHash(publicKeyHex) };
}

/** Reads a TextEnvelope payment verification key. */
export function readVerificationKey(path: string): VerificationKey {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new DeployError(`cannot read the verification key ${path}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  const publicKeyHex = envelopeKey(path, raw, VERIFICATION_TYPE);
  if (publicKeyHex === null) throw new DeployError(`${path}: not a cardano-cli ${VERIFICATION_TYPE} envelope`);
  return { publicKeyHex, keyHash: keyHash(publicKeyHex) };
}

/** The enterprise address of a payment key hash. */
export function keyAddress(hash: string, networkId: NetworkId): string {
  return enterpriseAddress({ type: "VerificationKey", hash }, networkId);
}

/** A new random Ed25519 payment key. */
export function generatePaymentKey(): PaymentKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex");
  const publicKeyHex = publicKeyOf(Buffer.from(privateKeyHex, "hex"));
  return { privateKeyHex, publicKeyHex, keyHash: keyHash(publicKeyHex) };
}

function writeNew(path: string, content: string, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `<dir>/<name>.skey` (mode 600) and `<dir>/<name>.vkey` as cardano-cli
 * TextEnvelope files. Refuses to replace a file.
 */
export function writeKeyFiles(dir: string, name: string, key: PaymentKey): { skey: string; vkey: string } {
  const skey = join(dir, `${name}.skey`);
  const vkey = join(dir, `${name}.vkey`);
  for (const path of [skey, vkey]) if (existsSync(path)) throw new DeployError(`${path} exists; the tool never replaces a key file`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const envelope = (type: string, description: string, hex: string): string =>
    `${JSON.stringify({ type, description, cborHex: `${KEY_CBOR_HEAD}${hex}` }, null, 4)}\n`;
  writeNew(skey, envelope(SIGNING_TYPE, "Payment Signing Key", key.privateKeyHex), 0o600);
  writeNew(vkey, envelope(VERIFICATION_TYPE, "Payment Verification Key", key.publicKeyHex), 0o644);
  return { skey, vkey };
}
