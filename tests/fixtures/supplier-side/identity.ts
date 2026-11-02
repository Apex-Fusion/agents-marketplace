/**
 * Identity-layout fixtures for the supplier and Paper2Agent tests (Part 2
 * §6.1–§6.3, §9.2): the committed identity-marketplace blueprint with a
 * stand-in identity hash, agent records at the identity address, new adverts
 * and new escrows. Every key comes from a public label and controls nothing
 * on any network.
 */

import type { ChainProvider, OutputReference, Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import type { MockChainProvider } from "../../../packages/shared/src/chain/MockChainProvider.js";
import { encodeIdentityDatum, type IdentityDatum } from "../../../packages/shared/src/cbor/IdentityDatum.js";
import { encodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { encodeIdentityAdvertDatum, type IdentityAdvertDatum } from "../../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { utf8ToHex, vectorIdFromSeed } from "../../../packages/shared/src/identity/id.js";
import type { TestTxBody } from "../../../packages/shared/src/tx/internal/testTxBody.js";
import type { WalletKey } from "../../../packages/shared/src/tx/types.js";
import { testIdentityBlueprint } from "../identity-builders/blueprint.js";
import { agentRecord } from "../identity-builders/world.js";
import { supplierIdentity, type SupplierIdentity } from "../../../supplier/src/identity/agent.js";
import { deriveSupplierKey } from "../../../supplier/src/paper2agent/identity.js";

/** The new escrow and advert with the stand-in identity hash applied. */
export const IDENTITY = testIdentityBlueprint();

/** The supplier's agent and an unrelated agent. */
export const AGENT_ID = vectorIdFromSeed("a1".repeat(32), 0);
export const OTHER_AGENT_ID = vectorIdFromSeed("b2".repeat(32), 1);

/** The record controller (stands in for the Foundation operator key). */
export const CONTROLLER = deriveSupplierKey("c0".repeat(32), 0);

/** A supplier key whose hash matches its public key (the record lists keys by public key). */
export function identitySupplierKey(networkId: 0 | 1 = 0): WalletKey {
  return deriveSupplierKey("5e".repeat(32), networkId);
}

/** A record without a parent: CONTROLLER, the supplier key with purposes 9, an Accountable Party from 0, `capabilities`. */
export function supplierAgentRecord(
  supplier: WalletKey,
  capabilities: readonly string[],
  changes: Partial<IdentityDatum> = {},
): IdentityDatum {
  return agentRecord(CONTROLLER, supplier, { capabilities: capabilities.map(utf8ToHex), ...changes });
}

/** The authentic record output of `agentId` at the identity address of `networkId`. */
export function recordUtxo(
  datum: IdentityDatum,
  options: { agentId?: string; networkId?: 0 | 1; ref?: OutputReference; ogmiosUnit?: boolean } = {},
): Utxo {
  const agentId = options.agentId ?? AGENT_ID;
  const unit = options.ogmiosUnit ? `${IDENTITY.identityHash}.${agentId}` : `${IDENTITY.identityHash}${agentId}`;
  return {
    ref: options.ref ?? { txHash: "7e".repeat(32), index: 0 },
    address: IDENTITY.identityScriptAddress(options.networkId ?? 0),
    lovelace: 10_000_000n,
    assets: { [unit]: 1n },
    datumHex: encodeIdentityDatum(datum),
    scriptRef: null,
  };
}

/** A new escrow at the new escrow address, holding payment + bonds. */
export function identityEscrowUtxo(datum: IdentityEscrowDatum, ref: OutputReference, networkId: 0 | 1 = 0): Utxo {
  return {
    ref,
    address: IDENTITY.escrowScriptAddress(networkId),
    lovelace: datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace,
    assets: {},
    datumHex: encodeIdentityEscrowDatum(datum),
    scriptRef: null,
  };
}

/** A new advert at the new advert address. */
export function identityAdvertUtxo(datum: IdentityAdvertDatum, ref: OutputReference, networkId: 0 | 1 = 0): Utxo {
  return {
    ref,
    address: IDENTITY.advertScriptAddress(networkId),
    lovelace: datum.supplier_bond_lovelace,
    assets: {},
    datumHex: encodeIdentityAdvertDatum(datum),
    scriptRef: null,
  };
}

/** The supplier identity over `chain` with the test blueprint. */
export function testIdentity(chain: ChainProvider, networkId: 0 | 1 = 0): SupplierIdentity {
  return supplierIdentity(chain, networkId, { blueprint: IDENTITY });
}

/** Every synthetic (mock backend) transaction body that `chain` received, in order. */
export function recordSubmissions(chain: MockChainProvider): TestTxBody[] {
  const bodies: TestTxBody[] = [];
  const submit = chain.submitTx.bind(chain);
  chain.submitTx = async (txCborHex: string) => {
    const length = Number.parseInt(txCborHex.slice(0, 8), 16);
    bodies.push(JSON.parse(Buffer.from(txCborHex.slice(8, 8 + length * 2), "hex").toString("utf8")) as TestTxBody);
    return submit(txCborHex);
  };
  return bodies;
}
