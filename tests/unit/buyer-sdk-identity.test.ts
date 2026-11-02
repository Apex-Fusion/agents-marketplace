/**
 * buyer-sdk-identity.test.ts — the identity helpers of the buyer SDK
 * (buyer/src/sdk/identity.ts; Part 2 §6.1–§6.4, §9.6): both layouts, the
 * receipt fields, the value cap, the record and listing lookups, the switch
 * rule and the RefundRevoked condition.
 */
import { describe, expect, it } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { encodeIdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { encodeIdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { ESCROW_VALUE_CAP_LOVELACE, TxConstructionError } from "../../packages/shared/src/tx/index.js";
import {
  agentIdOf, assertWithinValueCap, BuyerIdentity, buyerRefund, chainRecordLookup, decodeAdvert, decodeEscrow,
  encodeAdvert, encodeEscrow, indexerAdvertSigners, receiptAgentProblem, sameRefund,
} from "../../buyer/src/sdk/identity.js";
import { parseSwitchSlot } from "../../buyer/src/config.js";
import {
  AGENT_ID, activeRecord, buyer, identityBlueprint, listingRow, newAdvert, newAdvertOutput, newEscrow, OTHER_AGENT_ID,
  recordOutput, stranger, supplier, tombstone,
} from "../fixtures/buyer-side/identity-world.js";

const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };

function legacyAdvert(): AdvertDatum {
  const { agent_id: _agent, ...legacy } = newAdvert();
  return legacy;
}

function legacyEscrow(): EscrowDatum {
  const { agent_id: _agent, refund: _refund, ...legacy } = newEscrow();
  return legacy;
}

function receipt(agentDid?: string): Record<string, unknown> {
  return {
    prompt_hash: "a".repeat(64), response_hash: "b".repeat(64), model: "m", prompt_tokens: 1, completion_tokens: 1,
    wallclock_ms: 1, supplier_pkh: supplier.pubKeyHash, escrow_ref: `${"e".repeat(64)}#0`,
    ...(agentDid === undefined ? {} : { agent_did: agentDid }),
  };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TxConstructionError);
    return (error as TxConstructionError).reason;
  }
  throw new Error("expected a TxConstructionError");
}

function identityAt(chain: MockChainProvider, switchSlot: number | null = null, rows: unknown[] = []): BuyerIdentity {
  return new BuyerIdentity(chain, 0, { identityBlueprint, switchSlot }, async () => rows);
}

describe("both layouts", () => {
  it("decodes a legacy and a new advert, and encodes each in its own layout", () => {
    const legacy = decodeAdvert(encodeAdvertDatum(legacyAdvert()));
    const identity = decodeAdvert(encodeIdentityAdvertDatum(newAdvert()));
    expect(legacy.layout).toBe("legacy");
    expect(identity.layout).toBe("identity");
    expect(agentIdOf(legacy.datum)).toBeNull();
    expect(agentIdOf(identity.datum)).toBe(AGENT_ID);
    expect(encodeAdvert(legacy.datum)).toBe(encodeAdvertDatum(legacyAdvert()));
    expect(encodeAdvert(identity.datum)).toBe(encodeIdentityAdvertDatum(newAdvert()));
  });

  it("decodes a legacy and a new escrow, and encodes each in its own layout", () => {
    const legacy = decodeEscrow(encodeEscrowDatum(legacyEscrow()));
    const identity = decodeEscrow(encodeIdentityEscrowDatum(newEscrow()));
    expect(legacy.layout).toBe("legacy");
    expect(identity.layout).toBe("identity");
    expect(agentIdOf(legacy.datum)).toBeNull();
    expect(agentIdOf(identity.datum)).toBe(AGENT_ID);
    expect(encodeEscrow(legacy.datum)).toBe(encodeEscrowDatum(legacyEscrow()));
    expect(encodeEscrow(identity.datum)).toBe(encodeIdentityEscrowDatum(newEscrow()));
  });

  it("rejects a datum that no layout accepts", () => {
    expect(() => decodeAdvert("d87980")).toThrow();
    expect(() => decodeEscrow("d87980")).toThrow();
  });

  it("compares refunds by address and datum", () => {
    const own = buyerRefund(buyer.address);
    expect(sameRefund(own, buyerRefund(buyer.address))).toBe(true);
    expect(sameRefund(own, buyerRefund(stranger.address))).toBe(false);
    expect(sameRefund(own, { ...own, datum: { kind: "int", value: 1n } })).toBe(false);
    expect(sameRefund(null, null)).toBe(true);
    expect(sameRefund(own, null)).toBe(false);
  });
});

describe("receipt fields (Part 2 §6.3)", () => {
  it("accepts 8 fields for a legacy escrow and 9 with the agent DID for a new escrow", () => {
    expect(receiptAgentProblem(receipt(), null)).toBeNull();
    expect(receiptAgentProblem(receipt(`did:vector:${AGENT_ID}`), AGENT_ID)).toBeNull();
  });

  it("refuses agent_did on a legacy escrow, and a missing or other DID on a new escrow", () => {
    expect(receiptAgentProblem(receipt(`did:vector:${AGENT_ID}`), null)).toBe("agent_did_mismatch");
    expect(receiptAgentProblem(receipt(), AGENT_ID)).toBe("agent_did_mismatch");
    expect(receiptAgentProblem(receipt(`did:vector:${OTHER_AGENT_ID}`), AGENT_ID)).toBe("agent_did_mismatch");
    expect(receiptAgentProblem(receipt(`did:vector:agent:${"0".repeat(56)}:${AGENT_ID}`), AGENT_ID)).toBe("agent_did_mismatch");
  });

  it("refuses an extra or a missing field", () => {
    expect(receiptAgentProblem({ ...receipt(), extra: 1 }, null)).toBe("malformed_receipt");
    const { wallclock_ms: _dropped, ...seven } = receipt();
    expect(receiptAgentProblem(seven, null)).toBe("malformed_receipt");
    expect(receiptAgentProblem({ ...seven, other: 1 }, null)).toBe("malformed_receipt");
    expect(receiptAgentProblem({ ...receipt(`did:vector:${AGENT_ID}`), extra: 1 }, AGENT_ID)).toBe("malformed_receipt");
  });
});

describe("value cap (Part 2 §6.5, F-29)", () => {
  it("accepts payment + bonds up to 10,000 AP3X", () => {
    expect(() => assertWithinValueCap(newAdvert({
      price_lovelace: ESCROW_VALUE_CAP_LOVELACE - 2n, buyer_bond_lovelace: 1n, supplier_bond_lovelace: 1n,
    }))).not.toThrow();
  });

  it("refuses payment + bonds above 10,000 AP3X and negative amounts", () => {
    expect(() => assertWithinValueCap(newAdvert({
      price_lovelace: ESCROW_VALUE_CAP_LOVELACE - 1n, buyer_bond_lovelace: 1n, supplier_bond_lovelace: 1n,
    }))).toThrow(expect.objectContaining({ reason: "escrow above value cap" }));
    expect(() => assertWithinValueCap(newAdvert({ buyer_bond_lovelace: -1n })))
      .toThrow(expect.objectContaining({ reason: "negative escrow amount" }));
  });
});

describe("chainRecordLookup", () => {
  it("finds the record output that holds the agent token, in either unit notation", async () => {
    const chain = new MockChainProvider();
    const record = recordOutput(activeRecord());
    const other = recordOutput(activeRecord(), OTHER_AGENT_ID, { txHash: "7f".repeat(32), index: 0 });
    const dotted = { ...record, assets: { [`${identityBlueprint.identityHash}.${AGENT_ID}`]: 1n } };
    chain.seed(other);
    chain.seed(dotted);
    const lookup = chainRecordLookup(chain, () => identityBlueprint, 0);
    expect((await lookup(AGENT_ID))?.ref).toEqual(dotted.ref);
    expect((await lookup(OTHER_AGENT_ID))?.ref).toEqual(other.ref);
    expect(await lookup("c3".repeat(32))).toBeNull();
  });

  it("reads only the identity address of its network", async () => {
    const chain = new MockChainProvider();
    chain.seed({ ...recordOutput(activeRecord()), address: identityBlueprint.identityScriptAddress(1) });
    expect(await chainRecordLookup(chain, () => identityBlueprint, 0)(AGENT_ID)).toBeNull();
    expect(await chainRecordLookup(chain, () => identityBlueprint, 1)(AGENT_ID)).not.toBeNull();
  });
});

describe("indexerAdvertSigners (listing rule, Part 2 §6.2)", () => {
  const advert = newAdvert();

  function chainWithAdvert(): MockChainProvider {
    const chain = new MockChainProvider();
    chain.seed(newAdvertOutput(advert, ADVERT_REF));
    return chain;
  }

  it("gives supplier_pkh for an advert that the indexer lists with the same agent", async () => {
    const lookup = indexerAdvertSigners(chainWithAdvert(), async () => [listingRow(ADVERT_REF, advert, AGENT_ID)]);
    expect(await lookup(ADVERT_REF)).toEqual([supplier.pubKeyHash]);
  });

  it("refuses an advert that the indexer does not list as a new advert", async () => {
    expect(await reason(indexerAdvertSigners(chainWithAdvert(), async () => [])(ADVERT_REF))).toBe("advert not listed");
    expect(await reason(indexerAdvertSigners(chainWithAdvert(), async () => [listingRow(ADVERT_REF, advert, null)])(ADVERT_REF)))
      .toBe("advert not listed");
  });

  it("refuses a listing whose agent or supplier differs from the advert on chain", async () => {
    const otherAgent = indexerAdvertSigners(chainWithAdvert(), async () => [listingRow(ADVERT_REF, advert, OTHER_AGENT_ID)]);
    expect(await reason(otherAgent(ADVERT_REF))).toBe("advert not listed");
    const otherSupplier = indexerAdvertSigners(chainWithAdvert(), async () =>
      [listingRow(ADVERT_REF, { ...advert, supplier_pkh: stranger.pubKeyHash }, AGENT_ID)]);
    expect(await reason(otherSupplier(ADVERT_REF))).toBe("advert not listed");
  });

  it("refuses a listing of an advert that is legacy on chain", async () => {
    const chain = new MockChainProvider();
    chain.seed({ ...newAdvertOutput(advert, ADVERT_REF), datumHex: encodeAdvertDatum(legacyAdvert()) });
    expect(await reason(indexerAdvertSigners(chain, async () => [listingRow(ADVERT_REF, advert, AGENT_ID)])(ADVERT_REF)))
      .toBe("advert not listed");
  });
});

describe("BuyerIdentity switch rule (Part 2 §9.6)", () => {
  it("lets the advert decide without a switch slot and before it", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(100);
    expect(await identityAt(chain).escrowLayout()).toBeUndefined();
    expect(await identityAt(chain, 101).escrowLayout()).toBeUndefined();
    await expect(identityAt(chain, 101).assertAdvertLayout(legacyAdvert())).resolves.toBeUndefined();
  });

  it("pins the new layout from the switch slot on and refuses a legacy advert", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(100);
    const identity = identityAt(chain, 100);
    expect(await identity.escrowLayout()).toBe("identity");
    expect((await identity.postOptions()).escrowLayout).toBe("identity");
    expect(await reason(identity.assertAdvertLayout(legacyAdvert()))).toBe("advert layout mismatch");
    await expect(identity.assertAdvertLayout(newAdvert())).resolves.toBeUndefined();
  });

  it("refuses a switch slot that is not a non-negative safe integer", () => {
    const chain = new MockChainProvider();
    expect(() => identityAt(chain, -1)).toThrow(/switchSlot/);
    expect(() => identityAt(chain, 1.5)).toThrow(/switchSlot/);
  });

  it("parses SWITCH_SLOT from the env", () => {
    expect(parseSwitchSlot(undefined)).toBeNull();
    expect(parseSwitchSlot(" ")).toBeNull();
    expect(parseSwitchSlot("0")).toBe(0);
    expect(parseSwitchSlot("123456789")).toBe(123_456_789);
    for (const bad of ["-1", "1.5", "01", "1e3", "abc", "9007199254740993"]) {
      expect(() => parseSwitchSlot(bad)).toThrow(/SWITCH_SLOT/);
    }
  });
});

describe("BuyerIdentity.refundRevokedAllowed (Part 2 §6.1)", () => {
  function allowed(record: Parameters<typeof recordOutput>[0] | null, escrow = newEscrow()): Promise<boolean> {
    const chain = new MockChainProvider();
    if (record !== null) chain.seed(recordOutput(record));
    return identityAt(chain).refundRevokedAllowed(escrow);
  }

  const revokedAt = (invalidFrom: number | null) => tombstone(activeRecord(), {
    type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: 1_745_500_050_000, invalidFrom, successor: null,
  });

  it("allows Open and Claimed escrows of a revoked or retired agent", async () => {
    expect(await allowed(revokedAt(null))).toBe(true);
    expect(await allowed(revokedAt(null), newEscrow({ state: "Claimed" }))).toBe(true);
    expect(await allowed(tombstone(activeRecord(), { type: "Retired", at: 1_745_500_050_000, successor: null }))).toBe(true);
  });

  it("allows a Submitted escrow only when invalid_from ≤ submitted_at", async () => {
    const submitted = newEscrow({ state: "Submitted", submitted_at: 1_745_500_060_000, result_receipt_hash: "d4".repeat(32) });
    expect(await allowed(revokedAt(1_745_500_060_000), submitted)).toBe(true);
    expect(await allowed(revokedAt(1_745_500_060_001), submitted)).toBe(false);
    expect(await allowed(revokedAt(null), submitted)).toBe(false);
  });

  it("refuses a live agent and a missing record", async () => {
    expect(await allowed(activeRecord())).toBe(false);
    expect(await allowed(null)).toBe(false);
  });
});
