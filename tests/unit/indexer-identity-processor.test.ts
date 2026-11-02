/**
 * tests/unit/indexer-identity-processor.test.ts — processBlock with the identity registry.
 *
 * Part 2 §6.1–6.2, §6.4: the new advert and escrow addresses use the 14- and
 * 16-field layouts; the indexer decodes escrow redeemers, records
 * RefundRevoked as its own event and a Reclaim by a third party as a Reclaim;
 * outputs at the identity address change identity records.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { processBlock, type KnownUtxoInfo, type ScriptAddresses } from "../../indexer/src/follower/blockProcessor.js";
import {
  ADVERT_SCRIPT_ADDRESS,
  ESCROW_SCRIPT_ADDRESS,
  INDEXER_SUPPLIER_PKH,
  buildAdvertDatumHex,
  buildEscrowDatumHex,
  buildMockBlock,
  buildRetireAdvertTx,
  escrowRedeemerHex,
  type MockTx,
} from "../fixtures/indexer-side/sample-blocks.js";
import {
  AGENT_ID,
  IDENTITY_ADDRESS,
  IDENTITY_ADVERT_SCRIPT_ADDRESS,
  IDENTITY_ESCROW_SCRIPT_ADDRESS,
  IDENTITY_POLICY_ID,
  OTHER_AGENT_ID,
  THIRD_PARTY_PKH,
  buildIdentityAdvertDatumHex,
  buildIdentityEscrowDatumHex,
  buildIdentityEscrowSpendTx,
  buildIdentityPostAdvertTx,
  buildIdentityPostEscrowTx,
  buildIdentityRecordTx,
  identityRecordOutput,
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

const ESCROW_TX = "e1".repeat(32);
const ESCROW_REF = `${ESCROW_TX}#0`;

afterEach(() => {
  vi.restoreAllMocks();
});

function knownEscrow(state: "Open" | "Claimed" | "Submitted"): Map<string, KnownUtxoInfo> {
  const datumHex = state === "Submitted"
    ? buildIdentityEscrowDatumHex(submittedIdentityEscrowOpts())
    : buildIdentityEscrowDatumHex({ state });
  return new Map([[ESCROW_REF, { address: IDENTITY_ESCROW_SCRIPT_ADDRESS, datumHex }]]);
}

function run(txs: MockTx[], known = new Map<string, KnownUtxoInfo>()) {
  return processBlock(buildMockBlock({ slot: 5_000_000, transactions: txs }), known, ADDRESSES);
}

// ─── New adverts ──────────────────────────────────────────────────────────────

describe("processBlock — new advert address", () => {
  it("PostAdvert at the new advert address has the identity layout and the required signers", () => {
    const tx = buildIdentityPostAdvertTx({ txId: "a1".repeat(32) });
    const { events, created } = run([tx]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "PostAdvert",
      utxoRef: `${"a1".repeat(32)}#0`,
      address: IDENTITY_ADVERT_SCRIPT_ADDRESS,
      layout: "identity",
      requiredSigners: [INDEXER_SUPPLIER_PKH],
    });
    expect(created.map((c) => c.ref)).toEqual([`${"a1".repeat(32)}#0`]);
  });

  it("a legacy (13-field) datum at the new advert address is not an advert", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = buildIdentityPostAdvertTx({ txId: "a2".repeat(32) });
    tx.outputs[0]!.datum = buildAdvertDatumHex();
    expect(run([tx]).events).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy advert datum at the identity advert address"));
  });

  it("a new (14-field) datum at the legacy advert address is not an advert", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = buildIdentityPostAdvertTx({ txId: "a3".repeat(32) });
    tx.outputs[0]!.address = ADVERT_SCRIPT_ADDRESS;
    expect(run([tx]).events).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("identity advert datum at the legacy advert address"));
  });

  it("one transaction retires a legacy advert and posts a new one: RetireAdvert + PostAdvert", () => {
    const legacyRef = `${"a4".repeat(32)}#0`;
    const known = new Map([[legacyRef, { address: ADVERT_SCRIPT_ADDRESS, datumHex: buildAdvertDatumHex() }]]);
    const post = buildIdentityPostAdvertTx({ txId: "a5".repeat(32) });
    const tx = { ...post, inputs: [...buildRetireAdvertTx({ spentRef: { txId: "a4".repeat(32), index: 0 } }).inputs, ...post.inputs] };
    const { events } = run([tx], known);
    expect(events.map((e) => [e.type, e.utxoRef, e.layout])).toEqual([
      ["RetireAdvert", legacyRef, "legacy"],
      ["PostAdvert", `${"a5".repeat(32)}#0`, "identity"],
    ]);
  });

  it("an advert spend whose output datum is not a valid advert retires the advert", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ref = `${"a6".repeat(32)}#0`;
    const known = new Map([[ref, { address: IDENTITY_ADVERT_SCRIPT_ADDRESS, datumHex: buildIdentityAdvertDatumHex() }]]);
    const tx = {
      id: "a7".repeat(32),
      inputs: [{ transaction: { id: "a6".repeat(32) }, index: 0 }],
      outputs: [{ address: IDENTITY_ADVERT_SCRIPT_ADDRESS, value: { ada: { lovelace: 2_000_000 } }, datum: "deadbeef" }],
    };
    expect(run([tx], known).events.map((e) => [e.type, e.utxoRef])).toEqual([["RetireAdvert", ref]]);
  });
});

// ─── New escrows ──────────────────────────────────────────────────────────────

describe("processBlock — new escrow lifecycle", () => {
  it("PostEscrow at the new escrow address has the identity layout", () => {
    const { events } = run([buildIdentityPostEscrowTx({ txId: ESCROW_TX })]);
    expect(events.map((e) => [e.type, e.utxoRef, e.layout])).toEqual([["PostEscrow", ESCROW_REF, "identity"]]);
  });

  it("Claim and Submit continue with ClaimEscrow and SubmitEscrow", () => {
    const claim = buildIdentityEscrowSpendTx({
      txId: "c1".repeat(32), spentRef: { txId: ESCROW_TX, index: 0 }, redeemer: "Claim", continuing: { state: "Claimed" },
    });
    expect(run([claim], knownEscrow("Open")).events.map((e) => e.type)).toEqual(["ClaimEscrow"]);

    const submit = buildIdentityEscrowSpendTx({
      txId: "c2".repeat(32), spentRef: { txId: ESCROW_TX, index: 0 }, redeemer: "Submit", continuing: submittedIdentityEscrowOpts(),
    });
    expect(run([submit], knownEscrow("Claimed")).events.map((e) => e.type)).toEqual(["SubmitEscrow"]);
  });

  it("a Claimed output without a Claim redeemer is not a ClaimEscrow", () => {
    const tx = buildIdentityEscrowSpendTx({
      txId: "c3".repeat(32), spentRef: { txId: ESCROW_TX, index: 0 }, redeemer: "Reclaim", continuing: { state: "Claimed" },
    });
    expect(run([tx], knownEscrow("Open")).events.map((e) => e.type)).toEqual(["ReclaimEscrow"]);
  });

  it.each([
    ["Submitted", "Accept", "AcceptEscrow"],
    ["Submitted", "Release", "ReleaseEscrow"],
    ["Open", "Reclaim", "ReclaimEscrow"],
    ["Claimed", "Reclaim", "ReclaimEscrow"],
    ["Open", "RefundRevoked", "RefundRevokedEscrow"],
    ["Claimed", "RefundRevoked", "RefundRevokedEscrow"],
    ["Submitted", "RefundRevoked", "RefundRevokedEscrow"],
  ] as const)("%s escrow spent with %s → %s", (state, redeemer, type) => {
    const tx = buildIdentityEscrowSpendTx({ txId: "d1".repeat(32), spentRef: { txId: ESCROW_TX, index: 0 }, redeemer });
    const { events, spentRefs } = run([tx], knownEscrow(state));
    expect(events.map((e) => [e.type, e.utxoRef, e.layout])).toEqual([[type, ESCROW_REF, "identity"]]);
    expect(events[0]!.datumHex).toBe(knownEscrow(state).get(ESCROW_REF)!.datumHex);
    expect(spentRefs.map((s) => s.ref)).toEqual([ESCROW_REF]);
  });

  it.each([
    ["Submitted", "Reclaim"],
    ["Open", "Accept"],
    ["Claimed", "Release"],
  ] as const)("%s escrow spent with %s → no event and a warning", (state, redeemer) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = buildIdentityEscrowSpendTx({ txId: "d2".repeat(32), spentRef: { txId: ESCROW_TX, index: 0 }, redeemer });
    expect(run([tx], knownEscrow(state)).events).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("redeemer/state mismatch"));
  });

  it("a Reclaim submitted by a third party (refund set, no buyer signature) is recorded as a Reclaim", () => {
    const tx = buildIdentityEscrowSpendTx({
      txId: "d3".repeat(32), spentRef: { txId: ESCROW_TX, index: 0 }, redeemer: "Reclaim", signers: [THIRD_PARTY_PKH],
    });
    const { events } = run([tx], knownEscrow("Open"));
    expect(events.map((e) => [e.type, e.requiredSigners])).toEqual([["ReclaimEscrow", [THIRD_PARTY_PKH]]]);
  });

  it("RefundRevoked on a legacy escrow is not a transition of that contract", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacyRef = `${"d4".repeat(32)}#0`;
    const known = new Map([[legacyRef, { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Open" }) }]]);
    const tx = {
      id: "d5".repeat(32),
      inputs: [{ transaction: { id: "d4".repeat(32) }, index: 0 }],
      outputs: [],
      spendRedeemers: { [legacyRef]: escrowRedeemerHex("RefundRevoked") },
    };
    expect(run([tx], known).events).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("redeemer=RefundRevoked but priorState=Open (legacy)"));
  });

  it("a Reclaim and a new PostEscrow in one transaction give both events", () => {
    const tx = buildIdentityEscrowSpendTx({
      txId: "d6".repeat(32),
      spentRef: { txId: ESCROW_TX, index: 0 },
      redeemer: "Reclaim",
      extraOutputs: [{ address: IDENTITY_ESCROW_SCRIPT_ADDRESS, value: { ada: { lovelace: 4_000_000 } }, datum: buildIdentityEscrowDatumHex() }],
    });
    const { events } = run([tx], knownEscrow("Claimed"));
    expect(events.map((e) => [e.type, e.utxoRef])).toEqual([
      ["PostEscrow", `${"d6".repeat(32)}#1`],
      ["ReclaimEscrow", ESCROW_REF],
    ]);
  });

  it("a legacy Reclaim and a new PostEscrow in one transaction stay in their families", () => {
    const legacyRef = `${"d7".repeat(32)}#0`;
    const known = new Map([[legacyRef, { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Open" }) }]]);
    const post = buildIdentityPostEscrowTx({ txId: "d8".repeat(32) });
    const tx = {
      ...post,
      inputs: [{ transaction: { id: "d7".repeat(32) }, index: 0 }, ...post.inputs],
      spendRedeemers: { [legacyRef]: escrowRedeemerHex("Reclaim") },
    };
    expect(run([tx], known).events.map((e) => [e.type, e.layout])).toEqual([
      ["ReclaimEscrow", "legacy"],
      ["PostEscrow", "identity"],
    ]);
  });

  it("a post and a claim of the same escrow in one block are both seen", () => {
    const post = buildIdentityPostEscrowTx({ txId: "d9".repeat(32) });
    const claim = buildIdentityEscrowSpendTx({
      txId: "da".repeat(32), spentRef: { txId: "d9".repeat(32), index: 0 }, redeemer: "Claim", continuing: { state: "Claimed" },
    });
    const { events, spentRefs, created } = run([post, claim]);
    expect(events.map((e) => e.type)).toEqual(["PostEscrow", "ClaimEscrow"]);
    expect(spentRefs.map((s) => s.ref)).toEqual([`${"d9".repeat(32)}#0`]);
    expect(created.map((c) => c.ref)).toEqual([`${"d9".repeat(32)}#0`, `${"da".repeat(32)}#0`]);
  });
});

// ─── Identity records ─────────────────────────────────────────────────────────

describe("processBlock — identity address", () => {
  it("a register output with one token is the record of that agent and changes it", () => {
    const tx = buildIdentityRecordTx({ txId: "f1".repeat(32), agentId: AGENT_ID });
    const { created, identityChanges, events } = run([tx]);
    expect(events).toEqual([]);
    expect(created).toEqual([{ ref: `${"f1".repeat(32)}#0`, address: IDENTITY_ADDRESS, datumHex: "d87980", txHash: "f1".repeat(32), agentId: AGENT_ID }]);
    expect(identityChanges).toEqual([AGENT_ID]);
  });

  it("an update spends the known record output and writes the next one", () => {
    const recordRef = `${"f2".repeat(32)}#0`;
    const known = new Map([[recordRef, { address: IDENTITY_ADDRESS, datumHex: "d87980", agentId: AGENT_ID }]]);
    const tx = buildIdentityRecordTx({ txId: "f3".repeat(32), agentId: AGENT_ID, spentRef: { txId: "f2".repeat(32), index: 0 } });
    const { spentRefs, identityChanges, created } = run([tx], known);
    expect(spentRefs.map((s) => s.ref)).toEqual([recordRef]);
    expect(identityChanges).toEqual([AGENT_ID]);
    expect(created[0]!.agentId).toBe(AGENT_ID);
  });

  it("an output with two identity tokens is no record but changes both agents", () => {
    const tx = { id: "f4".repeat(32), inputs: [], outputs: [identityRecordOutput({ [AGENT_ID]: 1, [OTHER_AGENT_ID]: 1 })] };
    const { created, identityChanges } = run([tx]);
    expect(created[0]!.agentId).toBeNull();
    expect(identityChanges).toEqual([AGENT_ID, OTHER_AGENT_ID]);
  });

  it("an output at the identity address without identity tokens is not tracked", () => {
    const tx = {
      id: "f5".repeat(32),
      inputs: [],
      outputs: [{ address: IDENTITY_ADDRESS, value: { ada: { lovelace: 5_000_000 }, ["c0".repeat(28)]: { [AGENT_ID]: 1 } }, datum: "d87980" }],
    };
    const { created, identityChanges } = run([tx]);
    expect(created).toEqual([]);
    expect(identityChanges).toEqual([]);
  });

  it("without a configured identity policy the identity address is not followed", () => {
    const tx = buildIdentityRecordTx({ txId: "f6".repeat(32) });
    const result = processBlock(buildMockBlock({ slot: 1, transactions: [tx] }), new Map(), { ...ADDRESSES, identityPolicyId: undefined });
    expect(result.created).toEqual([]);
    expect(result.identityChanges).toEqual([]);
  });
});
