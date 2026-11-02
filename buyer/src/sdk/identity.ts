/**
 * buyer/src/sdk/identity.ts — the identity registry parts of the buyer SDK
 * during the escrow switch and drain (Part 2 §6.1–§6.4, §9.6).
 *
 * - Both layouts: a 13-field advert and a 14-field escrow are legacy; a
 *   14-field advert and a 16-field escrow carry `agent_id` (and `refund`).
 * - Post on a new advert needs the listing rule (§6.2). The shared Post
 *   builders check it through two lookups. The defaults here:
 *     lookupRecord        — the record output at the identity address;
 *     lookupAdvertSigners — the indexer listing of the advert (GET /suppliers).
 * - From the switch slot on, Post creates new escrows only (§9.6).
 * - A receipt for a new escrow has 9 fields; `agent_did` names the escrow's
 *   agent (§6.3). A receipt for a legacy escrow keeps the 8 fields.
 *
 * The SPA bundles this module through Marketplace.ts, so its imports stay
 * browser-safe: no Node builtins. It takes the receipt field lists from
 * @marketplace/shared/receipt-fields, not @marketplace/shared/receipt
 * (receipt/sign.ts imports Node crypto). The SPA never calls the lookups.
 */

import type { ChainProvider, Utxo } from "@marketplace/shared/chain";
import {
  decodeAdvertDatum,
  decodeAnyAdvertDatum,
  decodeAnyEscrowDatum,
  decodeEscrowDatum,
  encodeAdvertDatum,
  encodeEscrowDatum,
  encodeIdentityAdvertDatum,
  encodeIdentityEscrowDatum,
  encodePlutusAddress,
  encodePlutusDataHex,
  plutusAddressFromBech32,
  type AdvertDatum,
  type AnyAdvertDatum,
  type AnyEscrowDatum,
  type EscrowDatum,
  type IdentityAdvertDatum,
  type IdentityEscrowDatum,
  type Refund,
} from "@marketplace/shared/cbor";
import { vectorDid } from "@marketplace/shared/identity";
import { AGENT_RECEIPT_FIELDS, RECEIPT_FIELDS } from "@marketplace/shared/receipt-fields";
import {
  ESCROW_VALUE_CAP_LOVELACE,
  loadIdentityBlueprint,
  readAgentRecord,
  refundAllowed,
  TxConstructionError,
  type AdvertSignersLookup,
  type IdentityBlueprint,
  type MarketplaceLayout,
  type PostEscrowLayoutOptions,
  type RecordLookup,
} from "@marketplace/shared/tx";

/** An advert datum in either layout. */
export type AnyAdvert = AdvertDatum | IdentityAdvertDatum;
/** An escrow datum in either layout. */
export type AnyEscrow = EscrowDatum | IdentityEscrowDatum;

/** Identity options of `Marketplace` and `Paper2AgentClient`. All are optional. */
export interface BuyerIdentityOptions {
  /**
   * The switch slot (Part 2 §9.6), with the meaning of the indexer's
   * SWITCH_SLOT: from this chain slot on (`chain.tip() >= switchSlot`), Post
   * creates new escrows only and refuses a legacy advert. Unset or null: the
   * advert decides (the drain).
   */
  switchSlot?: number | null;
  /**
   * The new escrow and advert scripts. Default: loadIdentityBlueprint() at the
   * first new advert or escrow (env IDENTITY_POLICY_ID).
   */
  identityBlueprint?: IdentityBlueprint;
  /** Default: the record output at the identity address (chainRecordLookup). */
  lookupRecord?: RecordLookup;
  /** Default: the indexer listing of the advert (indexerAdvertSigners). */
  lookupAdvertSigners?: AdvertSignersLookup;
}

/** The advert datum in either layout. A datum that no layout accepts throws the legacy decoder's error. */
export function decodeAdvert(datumHex: string): AnyAdvertDatum {
  try {
    return decodeAnyAdvertDatum(datumHex);
  } catch {
    return { layout: "legacy", datum: decodeAdvertDatum(datumHex) };
  }
}

/** The escrow datum in either layout. A datum that no layout accepts throws the legacy decoder's error. */
export function decodeEscrow(datumHex: string): AnyEscrowDatum {
  try {
    return decodeAnyEscrowDatum(datumHex);
  } catch {
    return { layout: "legacy", datum: decodeEscrowDatum(datumHex) };
  }
}

/** `agent_id` of a new advert or escrow datum; null for the legacy layout. */
export function agentIdOf(datum: AnyAdvert | AnyEscrow): string | null {
  return "agent_id" in datum && typeof datum.agent_id === "string" ? datum.agent_id : null;
}

/** The datum bytes in its own layout. */
export function encodeAdvert(datum: AnyAdvert): string {
  return "agent_id" in datum ? encodeIdentityAdvertDatum(datum) : encodeAdvertDatum(datum);
}

/** The datum bytes in its own layout. */
export function encodeEscrow(datum: AnyEscrow): string {
  return "agent_id" in datum ? encodeIdentityEscrowDatum(datum) : encodeEscrowDatum(datum);
}

/** Two refund settings are equal: the same address and the same datum (Claim and Submit keep `refund`, §6.1). */
export function sameRefund(a: Refund | null, b: Refund | null): boolean {
  if (a === null || b === null) return a === b;
  if (encodePlutusAddress(a.address) !== encodePlutusAddress(b.address)) return false;
  if (a.datum === null || b.datum === null) return a.datum === b.datum;
  return encodePlutusDataHex(a.datum) === encodePlutusDataHex(b.datum);
}

/**
 * The refund that the Post builders write (§6.5): the buyer's own address,
 * with no datum. Its payment credential must be the buyer key.
 */
export function buyerRefund(address: string): Refund {
  return { address: plutusAddressFromBech32(address), datum: null };
}

/**
 * The value cap of Post (Part 2 §6.5, F-29) on the advert amounts: each of
 * payment, buyer bond and supplier bond is at least 0, and their sum is at
 * most 10,000 AP3X. Callers check it before any supplier call; the Post
 * builder checks it again, with the locked amount.
 */
export function assertWithinValueCap(advert: AdvertDatum): void {
  const payment = advert.price_lovelace;
  const buyerBond = advert.buyer_bond_lovelace;
  const supplierBond = advert.supplier_bond_lovelace;
  if (payment < 0n || buyerBond < 0n || supplierBond < 0n) {
    throw new TxConstructionError(
      "negative escrow amount",
      `payment ${payment}, buyer bond ${buyerBond}, supplier bond ${supplierBond}`,
    );
  }
  const total = payment + buyerBond + supplierBond;
  if (total > ESCROW_VALUE_CAP_LOVELACE) {
    throw new TxConstructionError("escrow above value cap", `payment + bonds = ${total} > ${ESCROW_VALUE_CAP_LOVELACE}`);
  }
}

/**
 * The agent fields of a receipt (Part 2 §6.3). For a legacy escrow
 * (`agentId` null) the receipt has exactly the 8 fields. For a new escrow it
 * has the 8 fields and `agent_did = "did:vector:<agent_id>"`. Returns the
 * ReceiptVerificationError reason, or null when the receipt passes.
 */
export function receiptAgentProblem(
  receipt: object,
  agentId: string | null,
): "agent_did_mismatch" | "malformed_receipt" | null {
  const raw = receipt as Record<string, unknown>;
  const agentDidOk = agentId === null ? !Object.hasOwn(raw, "agent_did") : raw.agent_did === vectorDid(agentId);
  if (!agentDidOk) return "agent_did_mismatch";
  const fields: readonly string[] = agentId === null ? RECEIPT_FIELDS : AGENT_RECEIPT_FIELDS;
  const exact = Object.keys(raw).length === fields.length && fields.every((field) => Object.hasOwn(raw, field));
  return exact ? null : "malformed_receipt";
}

/**
 * The record output of `agentId`: the output at the identity address (on
 * `networkId`) that holds the token identity_hash.agent_id. The builders
 * check the output as `find_record` does, so this lookup only finds it.
 */
export function chainRecordLookup(
  chain: ChainProvider,
  blueprint: () => IdentityBlueprint,
  networkId: 0 | 1,
): RecordLookup {
  return async (agentId: string): Promise<Utxo | null> => {
    const identity = blueprint();
    const token = identity.identityHash + agentId;
    const outputs = await chain.queryUtxosByAddress(identity.identityScriptAddress(networkId));
    // Units are policy ID + asset name; the Ogmios providers write "policy.name", lucid "policyname".
    return outputs.find((utxo) =>
      Object.keys(utxo.assets).some((unit) => unit.toLowerCase().replace(".", "") === token)) ?? null;
  };
}

/**
 * The signers of the transaction that created a new advert, from the indexer
 * listing. The indexer lists a new advert (GET /suppliers, `agent_id` set) only
 * when that transaction lists `supplier_pkh` as a required signer and the
 * agent's record passes the listing rule (Part 2 §6.2, §6.4). A listed row
 * gives `[supplier_pkh]` when its `agent_id` and `supplier_pkh` equal the
 * advert datum on chain, so Post copies `agent_id` from a listed advert.
 * Throws TxConstructionError "advert not listed" otherwise.
 *
 * `listedAdverts` returns the parsed GET /suppliers body and throws on an
 * indexer failure.
 */
export function indexerAdvertSigners(
  chain: ChainProvider,
  listedAdverts: () => Promise<readonly unknown[]>,
): AdvertSignersLookup {
  return async (advertRef) => {
    const ref = `${advertRef.txHash}#${advertRef.index}`;
    const row = (await listedAdverts()).find((value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && (value as Record<string, unknown>).utxo_ref === ref);
    const agentId = row?.agent_id;
    const supplierPkh = row?.supplier_pkh;
    if (typeof agentId !== "string" || typeof supplierPkh !== "string") {
      throw new TxConstructionError("advert not listed", `the indexer does not list ${ref} as a new advert`);
    }
    const utxo = await chain.queryUtxo(advertRef);
    const advert = utxo?.datumHex ? decodeAdvert(utxo.datumHex) : null;
    if (advert?.layout !== "identity" || advert.datum.agent_id !== agentId || advert.datum.supplier_pkh !== supplierPkh) {
      throw new TxConstructionError(
        "advert not listed",
        `the indexer lists ${ref} for agent ${agentId} and supplier ${supplierPkh}, which the advert on chain does not name`,
      );
    }
    return [supplierPkh];
  };
}

function checkedSwitchSlot(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`switchSlot must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

/**
 * The identity context of one buyer wallet: the lookups and the switch rule
 * that the Post, Accept, Reclaim and RefundRevoked builders get.
 */
export class BuyerIdentity {
  readonly lookupRecord: RecordLookup;
  readonly lookupAdvertSigners: AdvertSignersLookup;
  /** The `identityBlueprint` option; undefined lets the builders load it from the env. */
  readonly identityBlueprint: IdentityBlueprint | undefined;
  private readonly switchSlot: number | null;

  constructor(
    private readonly chain: ChainProvider,
    networkId: 0 | 1,
    options: BuyerIdentityOptions,
    listedAdverts: () => Promise<readonly unknown[]>,
  ) {
    this.switchSlot = checkedSwitchSlot(options.switchSlot);
    this.identityBlueprint = options.identityBlueprint;
    this.lookupRecord = options.lookupRecord ?? chainRecordLookup(chain, () => this.blueprint(), networkId);
    this.lookupAdvertSigners = options.lookupAdvertSigners ?? indexerAdvertSigners(chain, listedAdverts);
  }

  /** The new escrow and advert scripts: the option, else loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  blueprint(): IdentityBlueprint {
    return this.identityBlueprint ?? loadIdentityBlueprint();
  }

  /** "identity" from the switch slot on (Post refuses a legacy advert); undefined before it (the advert decides). */
  async escrowLayout(): Promise<MarketplaceLayout | undefined> {
    if (this.switchSlot === null) return undefined;
    return (await this.chain.tip()) >= this.switchSlot ? "identity" : undefined;
  }

  /** The layout options of the four Post builders. */
  async postOptions(): Promise<PostEscrowLayoutOptions> {
    return {
      escrowLayout: await this.escrowLayout(),
      lookupRecord: this.lookupRecord,
      lookupAdvertSigners: this.lookupAdvertSigners,
      identityBlueprint: this.identityBlueprint,
    };
  }

  /** Refuses a legacy advert after the switch, before any supplier call. The Post builder checks it again. */
  async assertAdvertLayout(advert: AnyAdvert): Promise<void> {
    if (agentIdOf(advert) !== null) return;
    if ((await this.escrowLayout()) === "identity") {
      throw new TxConstructionError(
        "advert layout mismatch",
        `from switch slot ${this.switchSlot} on, Post needs a new advert, got a legacy advert`,
      );
    }
  }

  /**
   * True when RefundRevoked applies now to the new escrow `datum` (Part 2
   * §6.1): Open or Claimed with the agent record Revoked or Retired, or
   * Submitted with the record Revoked and invalid_from ≤ submitted_at. The
   * transaction needs the record as a reference input, so a missing or
   * unauthentic record gives false.
   */
  async refundRevokedAllowed(datum: IdentityEscrowDatum): Promise<boolean> {
    const utxo = await this.lookupRecord(datum.agent_id);
    try {
      return refundAllowed(datum, readAgentRecord(utxo, this.blueprint().identityHash, datum.agent_id).status);
    } catch (error) {
      if (error instanceof TxConstructionError) return false;
      throw error;
    }
  }
}
