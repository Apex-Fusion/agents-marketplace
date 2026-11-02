/**
 * indexer/src/listing/rule.ts — which adverts the indexer lists.
 *
 * Part 2 §6.2 listing rule for new adverts. An advert is listed only when:
 *   - the transaction that created it lists `supplier_pkh` as a required signer;
 *   - the record of `agent_id` is live and independent, with effective status
 *     Active (the view without options, Part 1 §7.2–7.3);
 *   - the record lists `supplier_pkh` as an Ed25519 key with the transaction purpose;
 *   - the record has `capability_id` as a capability.
 * The record facts come from the identity gateway (identity/gateway.ts). The
 * record must also be an unspent output at the identity address that the
 * follower saw.
 *
 * Part 2 §6.4 switch: before the switch slot, legacy adverts stay listed
 * (with agent_id null). From the switch slot on, only listed new adverts appear.
 *
 * Part 2 §6.5 F-29: no advert or escrow whose payment + buyer bond + supplier
 * bond exceed 10,000 AP3X is listed or routable.
 */

import { MAX_ESCROW_LOVELACE } from "@marketplace/shared/identity";

/** How long the last identity gateway answer counts when the gateway does not answer. */
export const IDENTITY_RESULT_MAX_AGE_MS = 600_000;

/** One row of `identity_facts`: the last definitive gateway answer for an agent. */
export interface IdentityFacts {
  agent_id: string;
  /** 1: the gateway resolved the DID (HTTP 200). 0: it answered that the DID is not usable (404, 410, 400). */
  found: number;
  /** `vectorStatus.effective`: active | suspended | revoked | retired. */
  effective: string | null;
  /** 1 when the result has no `vectorParent` (lineage Root). */
  independent: number;
  /** `vectorOrigin`: native | adopted | legacy. */
  origin: string | null;
  /** JSON array: key hashes of the Ed25519 keys that have the transaction purpose. */
  transaction_keys: string;
  /** JSON array: `vectorProfile.capabilities`. */
  capabilities: string;
  /** Why the DID is not usable, for answers with found = 0. */
  detail: string | null;
  /** Unix ms: start of the request that gave this answer. */
  resolved_at: number;
  /** Unix ms: the follower saw a record change after this answer. */
  invalidated_at: number | null;
}

/** The advert fields that the rule reads. */
export interface ListingCandidate {
  layout: string;
  supplier_pkh: string;
  capability_id: string;
  agent_id: string | null;
  creator_signed: number;
  price_lovelace: string;
  supplier_bond_lovelace: string;
  buyer_bond_lovelace: string;
}

export interface ListingContext {
  /** Slot of the last block that the follower processed. */
  currentSlot: number;
  /** Switch slot (§9.6). null: no switch configured. */
  switchSlot: number | null;
  nowMs: number;
  maxAgeMs: number;
}

export interface IdentityRecordState {
  /** The follower holds an unspent record output for agent_id at the identity address. */
  hasRecord: boolean;
  facts: IdentityFacts | null;
}

export type ListingRefusal =
  | "valueCap"
  | "afterSwitch"
  | "notSigned"
  | "noRecord"
  | "noIdentityResult"
  | "identityChanged"
  | "identityResultExpired"
  | "notFound"
  | "notActive"
  | "notIndependent"
  | "legacyRecord"
  | "keyNotListed"
  | "capabilityMissing"
  | "unknownLayout";

export type ListingVerdict = { listed: true } | { listed: false; reason: ListingRefusal };

/** F-29: payment + buyer bond + supplier bond ≤ 10,000 AP3X. A value that is not an integer fails. */
export function withinValueCap(payment: string, buyerBond: string, supplierBond: string): boolean {
  try {
    return BigInt(payment) + BigInt(buyerBond) + BigInt(supplierBond) <= MAX_ESCROW_LOVELACE;
  } catch {
    return false;
  }
}

function stringList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function refuse(reason: ListingRefusal): ListingVerdict {
  return { listed: false, reason };
}

export function advertListing(advert: ListingCandidate, record: IdentityRecordState, ctx: ListingContext): ListingVerdict {
  // An advert sets the escrow amounts: payment = price.
  if (!withinValueCap(advert.price_lovelace, advert.buyer_bond_lovelace, advert.supplier_bond_lovelace)) {
    return refuse("valueCap");
  }
  if (advert.layout === "legacy") {
    return ctx.switchSlot !== null && ctx.currentSlot >= ctx.switchSlot ? refuse("afterSwitch") : { listed: true };
  }
  if (advert.layout !== "identity") return refuse("unknownLayout");

  if (advert.creator_signed !== 1) return refuse("notSigned");
  if (advert.agent_id === null || !record.hasRecord) return refuse("noRecord");
  const facts = record.facts;
  if (facts === null) return refuse("noIdentityResult");
  if (facts.invalidated_at !== null) return refuse("identityChanged");
  if (ctx.nowMs - facts.resolved_at > ctx.maxAgeMs) return refuse("identityResultExpired");
  if (facts.found !== 1) return refuse("notFound");
  if (facts.effective !== "active") return refuse("notActive");
  if (facts.independent !== 1) return refuse("notIndependent");
  if (facts.origin !== "native" && facts.origin !== "adopted") return refuse("legacyRecord");
  if (!stringList(facts.transaction_keys).includes(advert.supplier_pkh.toLowerCase())) return refuse("keyNotListed");
  if (!stringList(facts.capabilities).includes(advert.capability_id)) return refuse("capabilityMissing");
  return { listed: true };
}
