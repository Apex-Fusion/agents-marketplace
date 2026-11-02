/**
 * cleanup-agent-b.ts — close out Agent B's lingering escrows.
 *   - Accept D3 Submitted (supplier processed, just needs Accept)
 *   - Recover A1 + A4 Open: RefundRevoked for a new escrow of a revoked or
 *     retired agent, else Reclaim after deliver_by (both layouts)
 * Throwaway.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import { runAccept } from "../src/cli/acceptFlow.js";
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

async function main(): Promise<void> {
  // D3's Submitted ref needs Accept.
  const d3Submitted = { txHash: "2d3db522d4e2f5221d75afcd31e4dbcc247866558a7841b5cf6be9bebfc93347", index: 0 };
  try {
    const r = await runAccept({
      chain, walletKey: wk, escrowRef: d3Submitted,
      log: (line) => console.log(`[D3-accept] ${line}`),
    });
    console.log(`D3 accept tx ${r.txHash}`);
  } catch (e) {
    console.error(`D3 accept FAILED:`, e instanceof Error ? e.message : String(e));
  }

  // A1 + A4 Open escrows need RefundRevoked or Reclaim.
  const openRefs = [
    { id: "A1", txHash: "45879f707e7c8521233ee3bd5b024300211b8d8675f2400784f6ac1744848184", index: 0 },
    { id: "A4", txHash: "8f1ec769bd883ed617b4f05143b4997d20bd93d970371c0358a0e395cb676271", index: 0 },
  ];
  for (const { id, txHash, index } of openRefs) {
    try {
      const r = await recoverEscrow({ chain, walletKey: wk, escrowRef: { txHash, index }, identity });
      await chain.awaitTx(r.txHash, 90_000);
      console.log(`${id} ${r.action} tx ${r.txHash}`);
    } catch (e) {
      console.error(`${id} recover FAILED:`, e instanceof Error ? e.message : String(e));
    }
  }

  const utxos = await chain.queryUtxosByAddress(wk.address);
  const bal = utxos.reduce((a, u) => a + BigInt(u.lovelace), 0n);
  console.log(`final wallet bal: ${bal} lovelace (~${Number(bal) / 1e6} AP3X)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
