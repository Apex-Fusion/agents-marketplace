/**
 * Recover B2 + C2 escrows that were left Open after their post-escrow
 * rejections in run-agent-b's first pass: RefundRevoked for a new escrow of a
 * revoked or retired agent, else Reclaim after deliver_by (both layouts).
 * Throwaway.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import { recoverEscrow } from "../src/cli/reclaim-orphans.js";
import { deriveWalletKey } from "../src/index.js";
import { Marketplace } from "../src/sdk/Marketplace.js";

ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const x of m) h.update(x);
  return new Uint8Array(h.digest());
};

const env: Record<string, string> = {};
for (const line of readFileSync("/home/david/code/agents-marketplace/buyer/.env", "utf-8").split("\n")) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i === -1) continue;
  env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
// The shared tx builders read the identity blueprint and its reference script from process.env.
for (const key of ["IDENTITY_POLICY_ID", "IDENTITY_ESCROW_REF_UTXO"]) {
  if (env[key] && !process.env[key]) process.env[key] = env[key];
}

const wk = deriveWalletKey(env.BUYER_PRIV_KEY_HEX, 1);
const chain = new LiveOgmiosProvider({ ogmiosUrl: env.OGMIOS_URL });
const { identity } = new Marketplace({ chain, indexerUrl: env.INDEXER_URL, walletKey: wk, networkParams: { networkId: 1 } });

const refs = [
  { txHash: "50c59e7621a05bde5df06e4ded1513f821f56c26e2af0a3aacc05a6448ae690b", index: 0 },
  { txHash: "6449cb53f1a15a48c9c1c01ca885a3dbd238930d86d91501215be87d9739384c", index: 0 },
];

async function main(): Promise<void> {
  for (const escrowRef of refs) {
    try {
      const r = await recoverEscrow({ chain, walletKey: wk, escrowRef, identity });
      // eslint-disable-next-line no-console
      console.log(`${r.action} ${escrowRef.txHash}#${escrowRef.index} -> tx ${r.txHash}`);
      await chain.awaitTx(r.txHash, 90000);
      // eslint-disable-next-line no-console
      console.log(`  confirmed`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`recover ${escrowRef.txHash}#${escrowRef.index} FAILED:`, e instanceof Error ? e.message : String(e));
    }
  }
  const utxos = await chain.queryUtxosByAddress(wk.address);
  const bal = utxos.reduce((a, u) => a + BigInt(u.lovelace), 0n);
  // eslint-disable-next-line no-console
  console.log(`wallet bal: ${bal} lovelace (~${Number(bal) / 1e6} AP3X)`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
