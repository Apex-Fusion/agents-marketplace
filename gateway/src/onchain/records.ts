/**
 * gateway/src/onchain/records.ts — agent records for RefundRevoked (Part 2 §6.1).
 *
 * A new (16-field) escrow names its agent in `agent_id`. RefundRevoked returns
 * the whole escrow to the buyer when the agent's own record status allows it:
 *   - Open or Claimed: the record is Revoked or Retired;
 *   - Submitted: the record is Revoked with invalid_from ≤ submitted_at.
 * Any wallet can submit it, before or after deliver_by. The builder puts the
 * record in the reference inputs, so the gateway reads the current record
 * output from the chain: the output at the identity address that holds the
 * token <identity policy ID><agent_id> (Part 1 §4). The identity policy ID
 * comes from IDENTITY_POLICY_ID, as for the escrow builders.
 */

import type { ChainProvider, Utxo } from "@marketplace/shared/chain";
import type { IdentityEscrowDatum } from "@marketplace/shared/cbor";
import {
  loadIdentityBlueprint,
  readAgentRecord,
  refundAllowed,
  TxConstructionError,
  type RecordLookup,
} from "@marketplace/shared/tx";

/**
 * A record lookup that reads the identity address at most once. A sweep makes
 * one lookup, so it reads the address once at most, and only when a new escrow
 * needs its agent's record.
 */
export function chainRecordLookup(chain: ChainProvider, networkId: 0 | 1): RecordLookup {
  let outputs: Promise<Utxo[]> | undefined;
  return async (agentId) => {
    const blueprint = loadIdentityBlueprint();
    outputs ??= chain.queryUtxosByAddress(blueprint.identityScriptAddress(networkId));
    const unit = `${blueprint.identityHash}${agentId}`;
    // Asset units: Ogmios providers write "<policy>.<name>", lucid "<policy><name>".
    return (await outputs).find((utxo) =>
      Object.keys(utxo.assets).some((key) => key.toLowerCase().replace(".", "") === unit)) ?? null;
  };
}

/**
 * True when RefundRevoked applies to the new escrow `datum` now. A missing or
 * unauthentic record gives false, because the transaction needs the record.
 * A failed chain read throws: the caller tries again at the next sweep.
 */
export async function refundRevokedApplies(
  datum: IdentityEscrowDatum,
  lookupRecord: RecordLookup,
): Promise<boolean> {
  const { identityHash } = loadIdentityBlueprint();
  const utxo = await lookupRecord(datum.agent_id);
  try {
    return refundAllowed(datum, readAgentRecord(utxo, identityHash, datum.agent_id).status);
  } catch (err) {
    if (err instanceof TxConstructionError) return false;
    throw err;
  }
}
