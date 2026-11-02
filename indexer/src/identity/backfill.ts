/**
 * indexer/src/identity/backfill.ts — load the current outputs at the identity address.
 *
 * Part 2 §6.4: the release that adds identity support syncs again from a
 * block before the identity deployment (RESYNC_FROM_SLOT, SqliteCache.applyResync),
 * or it loads the current outputs at the identity address when it starts
 * (IDENTITY_LOAD_AT_START, this module). Without one of them, the follower
 * does not know the records that were made before it watched the address,
 * and their adverts are never listed.
 *
 * The outputs come from an Ogmios v6 ledger-state query
 * (`queryLedgerState/utxo` with `addresses`) at the node tip. An output
 * enters the UTxO table only when the table does not hold it yet. Its
 * creation slot is unknown, so it is stored as 0 and a rollback does not
 * remove it. When the follower reads the creating block later (cursor behind
 * the node tip), it writes the row again with the real slot.
 */

import type { Utxo } from "@marketplace/shared/chain";
import { isVectorId } from "@marketplace/shared/identity";
import type { SqliteCache } from "../db/cache.js";

export interface IdentityUtxoSource {
  queryUtxosByAddress(address: string): Promise<Utxo[]>;
}

export interface LoadIdentityOutputsOpts {
  cache: Pick<SqliteCache, "insertUtxoIfAbsent" | "transaction">;
  chain: IdentityUtxoSource;
  identityAddress: string;
  policyId: string;
}

export interface LoadIdentityOutputsResult {
  /** Outputs at the identity address that hold tokens of the identity policy. */
  outputs: number;
  /** Of these, the outputs that the UTxO table did not hold yet. */
  inserted: number;
}

export async function loadIdentityOutputs(opts: LoadIdentityOutputsOpts): Promise<LoadIdentityOutputsResult> {
  const utxos = await opts.chain.queryUtxosByAddress(opts.identityAddress);
  const prefix = `${opts.policyId}.`;
  const records = utxos
    .filter((u) => u.address === opts.identityAddress)
    .map((u) => ({
      utxo: u,
      tokens: Object.entries(u.assets).filter(([unit, qty]) => unit.startsWith(prefix) && qty !== 0n),
    }))
    .filter((r) => r.tokens.length > 0);

  let inserted = 0;
  opts.cache.transaction(() => {
    for (const { utxo, tokens } of records) {
      const [only] = tokens;
      const name = only![0].slice(prefix.length).toLowerCase();
      const agentId = tokens.length === 1 && only![1] === 1n && isVectorId(name) ? name : null;
      const ref = `${utxo.ref.txHash}#${utxo.ref.index}`;
      if (opts.cache.insertUtxoIfAbsent(ref, utxo.address, utxo.datumHex ?? "", 0, utxo.ref.txHash, agentId)) {
        inserted += 1;
      }
    }
  });
  return { outputs: records.length, inserted };
}
