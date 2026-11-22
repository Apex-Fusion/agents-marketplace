/**
 * buyer-wallet-derive.test.ts — deriveWalletKey of buyer/src/index.ts.
 *
 * Covers buyer/src/index.ts:59-78. The buyer wallet is an enterprise address: the header byte 0x6<network>, then the blake2b-224
 * hash of the Ed25519 public key, in bech32 with the prefix addr_test (network 0) or addr (network 1). A wrong header, prefix or
 * hash gives an address that the key cannot spend from.
 *
 * buyer/src/cli/accept.ts:233 and buyer/src/cli/consolidate-wallet.ts:179 hold their own copies of this function. They are not
 * exported and these tests do not cover them.
 *
 * The key is the secret key of test vector 1 in RFC 8032, section 7.1. The expected public key and key hash come from node:crypto
 * (Ed25519 from a PKCS8 DER seed) and blake2b-224 of @noble/hashes. No expected value comes from the code under test.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import { describe, expect, it } from "vitest";
import { deriveWalletKey } from "../../buyer/src/index.js";

const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

const privateKey = createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${SEED}`, "hex"), format: "der", type: "pkcs8",
});
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
const keyHash = Buffer.from(blake2b(publicKey, { dkLen: 28 }));

/**
 * The mainnet address of SEED. The vector was computed once with node:crypto, blake2b-224 and bech32. A second run with
 * hashlib.blake2b, a pure Python Ed25519 (RFC 8032, section 6) and the BIP-173 reference bech32 gave the same string.
 */
const MAINNET_ADDRESS = "addr1vy6aahffs2sreuu70h8q8jpen98lmmpwc6cy788j6s8xrgcpajqhn";

const networks: Array<[networkId: 0 | 1, header: number, prefix: string]> = [
  [0, 0x60, "addr_test"],
  [1, 0x61, "addr"],
];

describe("deriveWalletKey", () => {
  it.each(networks)("derives the key and the enterprise address of network %i", (networkId, header, prefix) => {
    const key = deriveWalletKey(SEED, networkId);
    const decoded = bech32.decode(key.address, 1023);
    const payload = Buffer.from(bech32.fromWords(decoded.words));

    expect(key.privateKeyHex).toBe(SEED);
    expect(key.pubKeyHex).toBe(publicKey.toString("hex"));
    expect(key.pubKeyHash).toBe(keyHash.toString("hex"));
    expect(decoded.prefix).toBe(prefix);
    expect(payload).toHaveLength(29);
    expect(payload[0]).toBe(header);
    expect(payload.subarray(1).toString("hex")).toBe(keyHash.toString("hex"));
  });

  it("gives the known mainnet address of the key (literal vector)", () => {
    expect(deriveWalletKey(SEED, 1).address).toBe(MAINNET_ADDRESS);
  });
});
