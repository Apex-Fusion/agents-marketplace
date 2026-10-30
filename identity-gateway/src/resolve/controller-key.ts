// Controller key of a generation-1 record (method spec Section 6.5). Generation 1 stores only the
// owner's key hash; the public key is taken from the most recent vkey witness whose blake2b-224
// hash equals that hash.
//
// A witness with a given hash can only carry one key, so every matching witness yields the same key;
// what the search set decides is whether a key is found at all. The ledger has no index of vkey
// witnesses, so the search covers the blocks of (a) the record's own transactions and (b) every
// transaction that spends from or pays to an address whose payment credential is the owner hash.
// Every transaction of each searched block is checked, newest block first, last transaction first.
// A key that only ever signed elsewhere (for example as a required signer while paying fees from
// another address) is not found.

import { blake2b } from "@noble/hashes/blake2b";
import type { ChainSource, LedgerTx } from "../chain/types.js";

const ED25519_KEY_HEX = /^[0-9a-f]{64}$/;

/** blake2b-224 of an Ed25519 public key: the ledger's verification key hash. */
export function vkeyHash(publicKeyHex: string): string {
  return Buffer.from(blake2b(Buffer.from(publicKeyHex, "hex"), { dkLen: 28 })).toString("hex");
}

export async function findControllerKey(chain: ChainSource, ownerHash: string, recordTxs: LedgerTx[]): Promise<string | null> {
  const credentialTxs = await chain.paymentCredentialTxs(ownerHash);
  const heights = [...new Set([...recordTxs.map((t) => t.blockHeight), ...credentialTxs.map((t) => t.blockHeight)])].sort((a, b) => b - a);
  for (const height of heights) {
    const txs = await chain.blockWitnesses(height);
    for (let i = txs.length - 1; i >= 0; i--) {
      const key = txs[i]!.vkeys.find((k) => ED25519_KEY_HEX.test(k) && vkeyHash(k) === ownerHash);
      if (key) return key;
    }
  }
  return null;
}
