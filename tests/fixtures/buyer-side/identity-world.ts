/**
 * Identity-layout world for the buyer tests (Part 2 §6.1–§6.4, §9.6): the new
 * escrow and advert scripts with a stand-in identity hash, an agent record at
 * the identity address, new adverts and escrows, and the indexer views.
 *
 * Every key is a throwaway test key. The mock chain backend writes testnet
 * addresses (network 0), so the outputs here sit on network 0 too.
 */
import type { MockChainProvider } from "../../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference, Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import { encodeIdentityAdvertDatum, type IdentityAdvertDatum } from "../../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { encodeIdentityDatum, type IdentityDatum } from "../../../packages/shared/src/cbor/IdentityDatum.js";
import {
  encodeIdentityEscrowDatum, type IdentityEscrowDatum,
} from "../../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { encodePlutusDataHex } from "../../../packages/shared/src/cbor/plutus-data.js";
import { plutusAddressFromBech32, plutusAddressToBech32 } from "../../../packages/shared/src/cbor/address.js";
import type { IdentityBlueprint } from "../../../packages/shared/src/tx/blueprint.js";
import type { WalletKey } from "../../../packages/shared/src/tx/types.js";
import { testIdentityBlueprint } from "../identity-builders/blueprint.js";
import { AGENT_ID, agentRecord, testWallet, tombstone } from "../identity-builders/world.js";
import { buildBuyerWalletKey } from "./wallet-keys.js";

export { AGENT_ID, agentRecord, tombstone };

/** The committed new escrow and advert, with the stand-in identity hash applied. */
export const identityBlueprint: IdentityBlueprint = testIdentityBlueprint();

export const buyer: WalletKey = buildBuyerWalletKey();
/** The listed supplier key: its key hash is blake2b-224 of its public key, as the record check computes it. */
export const supplier: WalletKey = testWallet("buyer-side identity supplier", 0);
/** Controller of the agent record; it signs nothing in these tests. */
export const controller: WalletKey = testWallet("buyer-side identity controller", 0);
/** A wallet that is neither buyer nor supplier. */
export const stranger: WalletKey = testWallet("buyer-side identity stranger", 0);

export const OTHER_AGENT_ID = "b2".repeat(32);

export const refText = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

/** A record without a parent that lists the supplier key with the transaction purpose and `capability`. */
export function activeRecord(capability = "llm.text.generate.v1"): IdentityDatum {
  return agentRecord(controller, supplier, { capabilities: [Buffer.from(capability, "utf8").toString("hex")] });
}

/** The authentic record output of `agentId` at the identity address (network 0). */
export function recordOutput(
  datum: IdentityDatum,
  agentId = AGENT_ID,
  ref: OutputReference = { txHash: "7e".repeat(32), index: 0 },
): Utxo {
  return {
    ref,
    address: identityBlueprint.identityScriptAddress(0),
    lovelace: 10_000_000n,
    assets: { [`${identityBlueprint.identityHash}${agentId}`]: 1n },
    datumHex: encodeIdentityDatum(datum),
    scriptRef: null,
  };
}

/** A new advert of `supplier` for AGENT_ID. */
export function newAdvert(changes: Partial<IdentityAdvertDatum> = {}): IdentityAdvertDatum {
  return {
    supplier_pkh: supplier.pubKeyHash,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
    agent_id: AGENT_ID,
    ...changes,
  };
}

/** The advert output at the new advert script (network 0). */
export function newAdvertOutput(datum: IdentityAdvertDatum, ref: OutputReference): Utxo {
  return {
    ref,
    address: identityBlueprint.advertScriptAddress(0),
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeIdentityAdvertDatum(datum),
    scriptRef: null,
  };
}

/** The indexer supplier view of a listed advert (W2-IDX: agent_id set for a new advert, null for a legacy one). */
export function listingRow(
  ref: OutputReference,
  advert: { supplier_pkh: string; capability_id: string; model: string; price_lovelace: bigint },
  agentId: string | null,
): Record<string, unknown> {
  return {
    utxo_ref: refText(ref),
    supplier_pkh: advert.supplier_pkh,
    capability_id: advert.capability_id,
    model: advert.model,
    price_lovelace: advert.price_lovelace.toString(),
    status: "free",
    advert_status: "Active",
    agent_id: agentId,
  };
}

/** A new escrow of `buyer` for AGENT_ID, refund to the buyer's own address. */
export function newEscrow(changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
  return {
    buyer_pkh: buyer.pubKeyHash,
    supplier_pkh: supplier.pubKeyHash,
    advert_ref: { txHash: "ad".repeat(32), index: 0 },
    capability_id: "llm.text.generate.v1",
    request_spec_hash: "1b".repeat(32),
    prompt_hash: "c3".repeat(32),
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: 1_745_500_090_000,
    posted_at: 1_745_500_000_000,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    agent_id: AGENT_ID,
    refund: { address: plutusAddressFromBech32(buyer.address), datum: null },
    ...changes,
  };
}

/** Seeds a new escrow at the new escrow script (network 0). */
export function seedNewEscrow(chain: MockChainProvider, datum: IdentityEscrowDatum, ref: OutputReference, lovelace = 4_500_000n): Utxo {
  const utxo: Utxo = {
    ref,
    address: identityBlueprint.escrowScriptAddress(0),
    lovelace,
    assets: {},
    datumHex: encodeIdentityEscrowDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
  return utxo;
}

/** The indexer escrow view of `utxo` (W2-IDX): layout, agent_id, refund { bech32 address, datum CBOR hex | null }. */
export function escrowView(utxo: Utxo, datum: IdentityEscrowDatum, spentTx: string | null): Record<string, unknown> {
  return {
    utxo_ref: refText(utxo.ref),
    buyer_pkh: datum.buyer_pkh,
    supplier_pkh: datum.supplier_pkh,
    advert_ref: refText(datum.advert_ref),
    capability_id: datum.capability_id,
    request_spec_hash: datum.request_spec_hash,
    prompt_hash: datum.prompt_hash,
    payment_lovelace: datum.payment_lovelace.toString(),
    buyer_bond_lovelace: datum.buyer_bond_lovelace.toString(),
    supplier_bond_lovelace: datum.supplier_bond_lovelace.toString(),
    deliver_by: datum.deliver_by,
    posted_at: datum.posted_at,
    submitted_at: datum.submitted_at,
    result_receipt_hash: datum.result_receipt_hash,
    state: datum.state,
    created_slot: 1,
    layout: "identity",
    agent_id: datum.agent_id,
    refund: datum.refund === null ? null : {
      address: plutusAddressToBech32(datum.refund.address, 1),
      datum: datum.refund.datum === null ? null : encodePlutusDataHex(datum.refund.datum),
    },
    routable: true,
    spent_tx: spentTx,
  };
}
