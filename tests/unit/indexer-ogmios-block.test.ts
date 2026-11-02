/**
 * tests/unit/indexer-ogmios-block.test.ts — Ogmios v6 block conversion.
 *
 * Fixtures follow the Ogmios v6 JSON schema (v6.14.0 docs/static/cardano.json):
 * Transaction { id, spends, inputs, outputs, requiredExtraSignatories,
 * redeemers: [{ validator: { purpose, index }, redeemer, executionUnits }] }.
 * A spend redeemer's index points into the inputs in ledger order
 * (transaction id bytes, then output index), not into the JSON array order.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { compareInputs, fromOgmiosBlock } from "../../indexer/src/follower/ogmiosBlock.js";
import { processBlock, type ScriptAddresses } from "../../indexer/src/follower/blockProcessor.js";
import {
  ADVERT_SCRIPT_ADDRESS,
  ESCROW_SCRIPT_ADDRESS,
  INDEXER_SUPPLIER_PKH,
  buildEscrowDatumHex,
  escrowRedeemerHex,
} from "../fixtures/indexer-side/sample-blocks.js";
import {
  IDENTITY_ADDRESS,
  IDENTITY_ADVERT_SCRIPT_ADDRESS,
  IDENTITY_ESCROW_SCRIPT_ADDRESS,
  IDENTITY_POLICY_ID,
  THIRD_PARTY_ADDRESS,
  THIRD_PARTY_PKH,
  buildIdentityEscrowDatumHex,
  ogmiosRedeemer,
  submittedIdentityEscrowOpts,
} from "../fixtures/indexer-side/identity-blocks.js";

const ADDRESSES: ScriptAddresses = {
  advertAddress: ADVERT_SCRIPT_ADDRESS,
  escrowAddress: ESCROW_SCRIPT_ADDRESS,
  identityAdvertAddress: IDENTITY_ADVERT_SCRIPT_ADDRESS,
  identityEscrowAddress: IDENTITY_ESCROW_SCRIPT_ADDRESS,
  identityAddress: IDENTITY_ADDRESS,
  identityPolicyId: IDENTITY_POLICY_ID,
};

const LOW = "1".repeat(64);
const HIGH = "f".repeat(64);
const FUNDING = "9".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
});

function praosBlock(slot: number, transactions: unknown[]): Record<string, unknown> {
  return {
    type: "praos",
    era: "conway",
    id: "b".repeat(64),
    ancestor: "a".repeat(64),
    height: 1234,
    size: { bytes: 1000 },
    slot,
    protocol: { version: { major: 10, minor: 0, patch: 0 } },
    issuer: {},
    transactions,
  };
}

describe("compareInputs — ledger order of transaction inputs", () => {
  it("orders by transaction id bytes, then by output index as a number", () => {
    const inputs = [
      { transaction: { id: HIGH }, index: 0 },
      { transaction: { id: LOW }, index: 10 },
      { transaction: { id: LOW }, index: 9 },
    ];
    expect([...inputs].sort(compareInputs)).toEqual([
      { transaction: { id: LOW }, index: 9 },
      { transaction: { id: LOW }, index: 10 },
      { transaction: { id: HIGH }, index: 0 },
    ]);
  });
});

describe("fromOgmiosBlock — transactions", () => {
  it("maps each spend redeemer to the input at its ledger-order index, not the JSON order", () => {
    const block = fromOgmiosBlock(praosBlock(100, [{
      id: "C".repeat(64),
      spends: "inputs",
      // JSON order: HIGH#0, LOW#3. Ledger order: LOW#3 (index 0), HIGH#0 (index 1).
      inputs: [
        { transaction: { id: HIGH }, index: 0 },
        { transaction: { id: LOW }, index: 3 },
      ],
      outputs: [],
      redeemers: [
        ogmiosRedeemer("spend", 0, escrowRedeemerHex("Reclaim")), // LOW#3
        ogmiosRedeemer("spend", 1, escrowRedeemerHex("Release")), // HIGH#0
        ogmiosRedeemer("mint", 0, "d87980"),
      ],
      signatories: [],
    }]));
    const tx = block.transactions![0]!;
    expect(tx.id).toBe("c".repeat(64));
    expect(tx.spendRedeemers).toEqual({
      [`${LOW}#3`]: escrowRedeemerHex("Reclaim"),
      [`${HIGH}#0`]: escrowRedeemerHex("Release"),
    });
    // The inputs keep their JSON order; only the redeemer lookup uses ledger order.
    expect(tx.inputs.map((i) => i.transaction.id)).toEqual([HIGH, LOW]);
  });

  it("logs and leaves out a spend redeemer whose index has no input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const block = fromOgmiosBlock(praosBlock(100, [{
      id: "c".repeat(64),
      spends: "inputs",
      inputs: [{ transaction: { id: LOW }, index: 0 }],
      outputs: [],
      redeemers: [ogmiosRedeemer("spend", 1, escrowRedeemerHex("Accept"))],
      signatories: [],
    }]));
    expect(block.transactions![0]!.spendRedeemers).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("has no input"));
  });

  it("leaves out a transaction that failed script validation (spends: collaterals)", () => {
    const block = fromOgmiosBlock(praosBlock(100, [
      {
        id: "d".repeat(64),
        spends: "collaterals",
        inputs: [{ transaction: { id: LOW }, index: 0 }],
        collaterals: [{ transaction: { id: FUNDING }, index: 0 }],
        outputs: [{ address: ESCROW_SCRIPT_ADDRESS, value: { ada: { lovelace: 1 } }, datum: buildEscrowDatumHex() }],
        redeemers: [ogmiosRedeemer("spend", 0, escrowRedeemerHex("Accept"))],
        signatories: [],
      },
      { id: "e".repeat(64), spends: "inputs", inputs: [], outputs: [], signatories: [] },
    ]));
    expect(block.transactions!.map((t) => t.id)).toEqual(["e".repeat(64)]);
  });

  it("copies requiredExtraSignatories as lowercase required signers", () => {
    const block = fromOgmiosBlock(praosBlock(100, [{
      id: "c".repeat(64),
      spends: "inputs",
      inputs: [],
      outputs: [],
      requiredExtraSignatories: [INDEXER_SUPPLIER_PKH.toUpperCase()],
      signatories: [],
    }]));
    expect(block.transactions![0]!.requiredSigners).toEqual([INDEXER_SUPPLIER_PKH]);
  });

  it("keeps output positions, inline datums and multi-asset values", () => {
    const value = { ada: { lovelace: 10_000_000 }, [IDENTITY_POLICY_ID]: { ["7a".repeat(32)]: 1 } };
    const block = fromOgmiosBlock(praosBlock(100, [{
      id: "c".repeat(64),
      spends: "inputs",
      inputs: [],
      outputs: [
        { address: THIRD_PARTY_ADDRESS, value: { ada: { lovelace: 1 } } },
        { address: IDENTITY_ADDRESS, value, datum: "D87980" },
      ],
      signatories: [],
    }]));
    const outputs = block.transactions![0]!.outputs;
    expect(outputs).toHaveLength(2);
    expect(outputs[1]).toEqual({ address: IDENTITY_ADDRESS, value, datum: "d87980" });
  });

  it("passes the header fields and handles a block without transactions", () => {
    const block = fromOgmiosBlock({ type: "ebb", era: "byron", id: "e".repeat(64), ancestor: "genesis", height: 0 });
    expect(block.slot).toBeUndefined();
    expect(block.id).toBe("e".repeat(64));
    expect(block.transactions).toEqual([]);
  });
});

// ─── Full path: raw Ogmios v6 block → processBlock ────────────────────────────

describe("fromOgmiosBlock + processBlock — terminal escrow spends get their real redeemer", () => {
  const legacySubmitted = `${LOW}#0`;
  const identitySubmitted = `${HIGH}#1`;

  function knownSubmitted() {
    return new Map([
      [legacySubmitted, { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
      [identitySubmitted, {
        address: IDENTITY_ESCROW_SCRIPT_ADDRESS,
        datumHex: buildIdentityEscrowDatumHex(submittedIdentityEscrowOpts()),
      }],
    ]);
  }

  function spendTx(id: string, ref: string, redeemer: string, signers: string[] = []) {
    const [txId, index] = ref.split("#");
    return {
      id,
      spends: "inputs",
      inputs: [{ transaction: { id: FUNDING }, index: 0 }, { transaction: { id: txId }, index: Number(index) }],
      outputs: [{ address: THIRD_PARTY_ADDRESS, value: { ada: { lovelace: 4_000_000 } } }],
      requiredExtraSignatories: signers,
      // Ledger order: LOW…, then FUNDING (9…), then HIGH (f…).
      redeemers: [ogmiosRedeemer("spend", txId === LOW ? 0 : 1, redeemer)],
      signatories: [],
    };
  }

  it("a legacy Release is a ReleaseEscrow (the old missing-redeemer default said Accept)", () => {
    const block = fromOgmiosBlock(praosBlock(200, [spendTx("1a".repeat(32), legacySubmitted, escrowRedeemerHex("Release"))]));
    const { events } = processBlock(block, knownSubmitted(), ADDRESSES);
    expect(events.map((e) => [e.type, e.utxoRef, e.layout])).toEqual([["ReleaseEscrow", legacySubmitted, "legacy"]]);
  });

  it("a RefundRevoked on a Submitted new escrow is a RefundRevokedEscrow, signed by a third party", () => {
    const block = fromOgmiosBlock(praosBlock(200, [
      spendTx("1b".repeat(32), identitySubmitted, escrowRedeemerHex("RefundRevoked"), [THIRD_PARTY_PKH]),
    ]));
    const { events } = processBlock(block, knownSubmitted(), ADDRESSES);
    expect(events.map((e) => [e.type, e.utxoRef, e.layout])).toEqual([["RefundRevokedEscrow", identitySubmitted, "identity"]]);
  });

  it("an Accept on the new escrow is an AcceptEscrow", () => {
    const block = fromOgmiosBlock(praosBlock(200, [spendTx("1c".repeat(32), identitySubmitted, escrowRedeemerHex("Accept"))]));
    const { events } = processBlock(block, knownSubmitted(), ADDRESSES);
    expect(events.map((e) => e.type)).toEqual(["AcceptEscrow"]);
  });
});
