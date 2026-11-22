/**
 * wallet-derivation.test.ts — deriveWalletKey turns a private key into the public key, key hash and address of a custodial wallet.
 *
 * Key path: AP3X that goes to a wrong address is lost, and a derivation that is wrong but stable passes every test that only
 * uses its own output. Each row fixes a private key and gives the answer from outside this code base:
 *   - the public keys are the Ed25519 test vectors 1 and 2 of RFC 8032 section 7.1;
 *   - the key hash is the BLAKE2b hash of the public key with a 28-byte digest (`b2sum -l 224` gives the same value);
 *   - the address is the Shelley enterprise address of that hash in bech32: header byte 0x60 and prefix `addr_test` for the
 *     test network, header byte 0x61 and prefix `addr` for the main network. A separate bech32 code made the strings, and the
 *     same code gives the CIP-19 enterprise address examples.
 * The public keys and hashes contain bytes below 0x10, so the rows also show that each byte keeps two hex digits.
 */

import { describe, expect, it } from "vitest";
import { deriveWalletKey } from "../src/wallet.js";

const KEY_1 = {
  privateKeyHex: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  pubKeyHex: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  pubKeyHash: "35dedd2982a03cf39e7dce03c839994ffdec2ec6b04f1cf2d40e61a3",
};
const KEY_2 = {
  privateKeyHex: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
  pubKeyHex: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
  pubKeyHash: "977efb35ab621d39dbeb7274ec7795a34708ff4d25a01a1df04c1f27",
};

const ROWS: Array<[string, typeof KEY_1, 0 | 1, string]> = [
  ["RFC 8032 test 1, test network", KEY_1, 0, "addr_test1vq6aahffs2sreuu70h8q8jpen98lmmpwc6cy788j6s8xrgc64xuck"],
  ["RFC 8032 test 1, main network", KEY_1, 1, "addr1vy6aahffs2sreuu70h8q8jpen98lmmpwc6cy788j6s8xrgcpajqhn"],
  ["RFC 8032 test 2, test network", KEY_2, 0, "addr_test1vztha7e44d3p6wwmade8fmrhjk35wz8lf5j6qxsa7pxp7fcx5qd7f"],
  ["RFC 8032 test 2, main network", KEY_2, 1, "addr1vxtha7e44d3p6wwmade8fmrhjk35wz8lf5j6qxsa7pxp7fcau533v"],
];

describe("deriveWalletKey", () => {
  it.each(ROWS)("%s: gives the public key, the key hash and the address of the vector", (_name, key, networkId, address) => {
    expect(deriveWalletKey(key.privateKeyHex, networkId)).toMatchObject({ ...key, address });
  });
});
