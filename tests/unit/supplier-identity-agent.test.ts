/**
 * The supplier's agent (supplier/src/identity/agent.ts, Part 2 §6.1–§6.3,
 * §9.6): both layouts, the own-agent rule, the Claim refusals, receipts and
 * the chain record lookup.
 */

import { describe, expect, it, vi } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { encodeIdentityAdvertDatum, type IdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { encodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { plutusAddressFromBech32 } from "../../packages/shared/src/cbor/address.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import {
  advertRecordProblem, chainRecordLookup, decodeAdvert, decodeEscrow, identityOptions, identityRefusal, newEscrowRefusal,
  ownAgentId, parseAgentId, receiptAgentDid, supplierIdentity,
} from "../../supplier/src/identity/agent.js";
import { buildSampleEscrowDatum } from "../fixtures/supplier-side/escrow-datum-builders.js";
import { buildSampleAdvertDatum } from "../fixtures/supplier-side/advert-datum-builders.js";
import {
  AGENT_ID, IDENTITY, OTHER_AGENT_ID, identitySupplierKey, recordUtxo, supplierAgentRecord, testIdentity,
} from "../fixtures/supplier-side/identity.js";
import { tombstone } from "../fixtures/identity-builders/world.js";

const supplier = identitySupplierKey();
const CAPABILITY = "llm.text.generate.v1";

function legacyEscrow(): EscrowDatum {
  return { ...buildSampleEscrowDatum(), supplier_pkh: supplier.pubKeyHash };
}

function newEscrow(changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
  return {
    ...legacyEscrow(),
    agent_id: AGENT_ID,
    refund: { address: plutusAddressFromBech32("addr_test1vz4ummcpydzk0zdtehhszg69v7y6hn00qy352euf40x77qgmly3us"), datum: null },
    ...changes,
  };
}

function legacyAdvert(): AdvertDatum {
  return { ...buildSampleAdvertDatum(), supplier_pkh: supplier.pubKeyHash };
}

function newAdvert(agentId = AGENT_ID): IdentityAdvertDatum {
  return { ...legacyAdvert(), agent_id: agentId };
}

describe("AGENT_ID and both layouts", () => {
  it("accepts 64 lowercase hex characters and nothing else", () => {
    expect(parseAgentId(undefined)).toBeUndefined();
    expect(parseAgentId("")).toBeUndefined();
    expect(parseAgentId(AGENT_ID)).toBe(AGENT_ID);
    expect(() => parseAgentId(AGENT_ID.toUpperCase(), "AGENT_ID")).toThrow(/AGENT_ID must be 64 lowercase hex/);
    expect(() => parseAgentId("ab".repeat(31))).toThrow(/64 lowercase hex/);
  });

  it("decodes the legacy and the new escrow and advert", () => {
    expect(decodeEscrow(encodeEscrowDatum(legacyEscrow()))).toMatchObject({ layout: "legacy" });
    const escrow = decodeEscrow(encodeIdentityEscrowDatum(newEscrow()));
    expect(escrow.layout).toBe("identity");
    expect(escrow.datum).toMatchObject({ agent_id: AGENT_ID });
    expect(decodeAdvert(encodeAdvertDatum(legacyAdvert()))).toMatchObject({ layout: "legacy" });
    expect(decodeAdvert(encodeIdentityAdvertDatum(newAdvert()))).toMatchObject({ layout: "identity", datum: { agent_id: AGENT_ID } });
    expect(() => decodeEscrow("d87980")).toThrow();
  });

  it("takes the own agent from AGENT_ID or the new advert and refuses two different agents", () => {
    expect(ownAgentId(undefined, legacyAdvert())).toBeNull();
    expect(ownAgentId(AGENT_ID, legacyAdvert())).toBe(AGENT_ID);
    expect(ownAgentId(undefined, newAdvert())).toBe(AGENT_ID);
    expect(ownAgentId(AGENT_ID, newAdvert())).toBe(AGENT_ID);
    expect(() => ownAgentId(OTHER_AGENT_ID, newAdvert())).toThrow(/differs/);
  });
});

describe("Claim refusals of a new escrow", () => {
  const identity = testIdentity(new MockChainProvider());

  it("passes a legacy escrow without an agent", () => {
    expect(newEscrowRefusal(legacyEscrow(), 4_000_000n, null, identity)).toBeNull();
  });

  it("works a new escrow only for the own agent", () => {
    expect(newEscrowRefusal(newEscrow(), 4_000_000n, AGENT_ID, identity)).toBeNull();
    expect(newEscrowRefusal(newEscrow(), 4_000_000n, null, identity)).toMatchObject({ status: 503, reason: "agent_not_configured" });
    expect(newEscrowRefusal(newEscrow({ agent_id: OTHER_AGENT_ID }), 4_000_000n, AGENT_ID, identity))
      .toMatchObject({ status: 403, reason: "wrong_agent" });
  });

  it("refuses a new escrow above the value cap or with a negative amount", () => {
    const capped = newEscrow({ payment_lovelace: 9_999_000_000n, buyer_bond_lovelace: 1_000_000n, supplier_bond_lovelace: 1n });
    expect(newEscrowRefusal(capped, 10_000_000_001n, AGENT_ID, identity)).toMatchObject({ status: 409, reason: "escrow_not_claimable" });
    expect(newEscrowRefusal(newEscrow(), 10_005_000_001n, AGENT_ID, identity)).toMatchObject({ reason: "escrow_not_claimable" });
    expect(newEscrowRefusal(newEscrow({ buyer_bond_lovelace: -1n }), 4_000_000n, AGENT_ID, identity))
      .toMatchObject({ reason: "escrow_not_claimable" });
  });

  it("refuses a new escrow when the identity hash is not configured", () => {
    const unconfigured = supplierIdentity(new MockChainProvider(), 0);
    vi.stubEnv("IDENTITY_POLICY_ID", "");
    try {
      expect(newEscrowRefusal(newEscrow(), 4_000_000n, AGENT_ID, unconfigured))
        .toMatchObject({ status: 503, reason: "identity_not_configured" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("maps the builder's record and cap refusals, not chain failures", () => {
    for (const reason of ["agent record not found", "agent not active", "supplier key not listed", "capability not listed",
      "agent not independent", "agent record not authentic"]) {
      expect(identityRefusal(new TxConstructionError(reason, "x"))).toMatchObject({ status: 503, reason: "agent_not_eligible" });
    }
    for (const reason of ["escrow above value cap", "escrow input above cap", "escrow layout mismatch"]) {
      expect(identityRefusal(new TxConstructionError(reason, "x"))).toMatchObject({ status: 409, reason: "escrow_not_claimable" });
    }
    expect(identityRefusal(new TxConstructionError("claim after deliver_by", "x"))).toBeNull();
    expect(identityRefusal(new Error("Ogmios unreachable"))).toBeNull();
    expect(identityRefusal(new TxConstructionError("toString", "x"))).toBeNull();
  });
});

describe("Claim and Submit options and receipts", () => {
  it("gives the record lookup to both layouts and the blueprint to a new escrow only", () => {
    const identity = testIdentity(new MockChainProvider());
    expect(identityOptions(legacyEscrow(), identity)).toEqual({ lookupRecord: identity.lookupRecord });
    expect(identityOptions(newEscrow(), identity)).toEqual({ lookupRecord: identity.lookupRecord, identityBlueprint: IDENTITY });
    expect(identityOptions(newEscrow(), undefined)).toEqual({});
  });

  it("adds agent_did for a new escrow only (Part 2 §6.3)", () => {
    expect(receiptAgentDid(legacyEscrow())).toEqual({});
    expect(receiptAgentDid(newEscrow())).toEqual({ agent_did: `did:vector:${AGENT_ID}` });
  });
});

describe("chain record lookup", () => {
  it("finds the record output at the identity address, also with Ogmios units", async () => {
    const chain = new MockChainProvider();
    chain.seed(recordUtxo(supplierAgentRecord(supplier, [CAPABILITY]), { ogmiosUnit: true }));
    chain.seed(recordUtxo(supplierAgentRecord(supplier, [CAPABILITY]), { agentId: OTHER_AGENT_ID, ref: { txHash: "7f".repeat(32), index: 0 } }));
    const lookup = chainRecordLookup(chain, 0, () => IDENTITY);
    expect((await lookup(AGENT_ID))?.ref).toEqual({ txHash: "7e".repeat(32), index: 0 });
    expect((await lookup(OTHER_AGENT_ID))?.ref).toEqual({ txHash: "7f".repeat(32), index: 0 });
    expect(await lookup("cd".repeat(32))).toBeNull();
  });

  it("reads the known output first and scans again after a record update spends it", async () => {
    const chain = new MockChainProvider();
    const first = recordUtxo(supplierAgentRecord(supplier, [CAPABILITY]));
    chain.seed(first);
    const lookup = chainRecordLookup(chain, 0, () => IDENTITY);
    await lookup(AGENT_ID);
    const scan = vi.spyOn(chain, "queryUtxosByAddress");
    expect((await lookup(AGENT_ID))?.ref).toEqual(first.ref);
    expect(scan).not.toHaveBeenCalled();

    // A record update spends the output and writes the next one.
    const updated = { ...first, ref: { txHash: "8e".repeat(32), index: 1 } };
    await chain.submitTx(MockChainProvider.buildTestTx({ inputs: [first.ref] }));
    chain.seed(updated);
    expect((await lookup(AGENT_ID))?.ref).toEqual(updated.ref);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("checks the listing rule's record part for an advert", async () => {
    const chain = new MockChainProvider();
    const identity = testIdentity(chain);
    expect(await advertRecordProblem(identity, AGENT_ID, supplier.pubKeyHash, CAPABILITY, 1_000_000)).toBe("agent record not found");
    chain.seed(recordUtxo(supplierAgentRecord(supplier, [CAPABILITY])));
    expect(await advertRecordProblem(identity, AGENT_ID, supplier.pubKeyHash, CAPABILITY, 1_000_000)).toBeNull();
    expect(await advertRecordProblem(identity, AGENT_ID, supplier.pubKeyHash, "audio.synthesize.piper.v1", 1_000_000))
      .toBe("capability not listed");
    expect(await advertRecordProblem(identity, AGENT_ID, "00".repeat(28), CAPABILITY, 1_000_000)).toBe("supplier key not listed");
    chain.seed(recordUtxo(tombstone(supplierAgentRecord(supplier, [CAPABILITY]), { type: "Retired", at: 1, successor: null })));
    expect(await advertRecordProblem(testIdentity(chain), AGENT_ID, supplier.pubKeyHash, CAPABILITY, 1_000_000)).toBe("agent not active");
  });
});
