/**
 * tests/unit/indexer-block-processor.test.ts — blockProcessor + chain follower tests (Category B)
 *
 * Injects synthetic blocks via MockChainSyncSource to test event detection.
 * Tests call processBlock() directly.
 *
 * M1-D-fix changes:
 *   - AcceptEscrow / ReleaseEscrow tests now assert EXCLUSIVE event emission
 *     (Accept → no Release; Release → no Accept) driven by tx.redeemers.
 *   - Added: fallback test (ambiguous Submitted-spend → 1 AcceptEscrow + console.warn).
 *   - Added: redeemer/state mismatch tests (e.g. Accept redeemer on Open → no event + warn).
 *   - DELETED (3 tests): old tests that asserted both AcceptEscrow AND ReleaseEscrow
 *     were emitted on the same Submitted-spend via .some() — those encoded the broken
 *     double-emit behaviour Catherine's blockProcessor.ts must no longer exhibit.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { processBlock } from "../../indexer/src/follower/blockProcessor.js";
import type { ScriptAddresses } from "../../indexer/src/follower/blockProcessor.js";
import {
  buildMockBlock,
  buildPostAdvertTx,
  buildUpdateAdvertTx,
  buildRetireAdvertTx,
  buildPostEscrowTx,
  buildClaimEscrowTx,
  buildSubmitEscrowTx,
  buildAcceptEscrowTx,
  buildReclaimEscrowTx,
  buildReleaseEscrowTx,
  buildAmbiguousSubmittedSpendTx,
  buildMalformedDatumTx,
  buildByronBlock,
  buildAdvertDatumHex,
  buildEscrowDatumHex,
  ADVERT_SCRIPT_ADDRESS,
  ESCROW_SCRIPT_ADDRESS,
  INDEXER_SUPPLIER_PKH,
  SAMPLE_RECEIPT_HASH,
  SAMPLE_SUBMITTED_AT,
} from "../fixtures/indexer-side/sample-blocks.js";

const ADDRESSES: ScriptAddresses = {
  advertAddress: ADVERT_SCRIPT_ADDRESS,
  escrowAddress: ESCROW_SCRIPT_ADDRESS,
};

// Restore console.warn after any test that spies on it.
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── PostAdvert ───────────────────────────────────────────────────────────────

describe("blockProcessor — PostAdvert", () => {
  it("PostAdvert tx at advertAddress emits PostAdvert event", () => {
    const tx = buildPostAdvertTx({ txId: "a".repeat(64) });
    const block = buildMockBlock({ slot: 1_000_000, transactions: [tx] });
    const result = processBlock(block, new Map(), ADDRESSES);
    expect(result.events.length).toBe(1);
    expect(result.events[0].type).toBe("PostAdvert");
    expect(result.events[0].txHash).toBe("a".repeat(64));
    expect(result.events[0].utxoRef).toBe("a".repeat(64) + "#0");
    expect(result.events[0].slot).toBe(1_000_000);
  });

  it("PostAdvert event datumHex decodes to valid AdvertDatum", () => {
    const datumHex = buildAdvertDatumHex({ supplierPkh: INDEXER_SUPPLIER_PKH });
    const tx = buildPostAdvertTx({ txId: "a".repeat(64), advertDatumOpts: { supplierPkh: INDEXER_SUPPLIER_PKH } });
    const block = buildMockBlock({ slot: 1_000_000, transactions: [tx] });
    const result = processBlock(block, new Map(), ADDRESSES);
    expect(result.events[0].datumHex).toBe(datumHex);
  });

  it("PostAdvert address is ADVERT_SCRIPT_ADDRESS", () => {
    const tx = buildPostAdvertTx();
    const block = buildMockBlock({ slot: 1_000_000, transactions: [tx] });
    const result = processBlock(block, new Map(), ADDRESSES);
    expect(result.events[0].address).toBe(ADVERT_SCRIPT_ADDRESS);
  });
});

// ─── UpdateAdvert ─────────────────────────────────────────────────────────────

describe("blockProcessor — UpdateAdvert", () => {
  it("UpdateAdvert tx spends old advert UTxO and emits UpdateAdvert event", () => {
    const postTxId = "a".repeat(64);
    const knownUtxos = new Map([
      [postTxId + "#0", { address: ADVERT_SCRIPT_ADDRESS, datumHex: buildAdvertDatumHex() }],
    ]);
    const tx = buildUpdateAdvertTx({
      txId: "b".repeat(64),
      spentRef: { txId: postTxId, index: 0 },
      newAdvertDatumOpts: { maxOutputTokens: 1024 },
    });
    const block = buildMockBlock({ slot: 1_000_100, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.some(e => e.type === "UpdateAdvert")).toBe(true);
  });

  it("UpdateAdvert: advertisements table reflects new datum after update", () => {
    const postTxId = "a".repeat(64);
    const knownUtxos = new Map([
      [postTxId + "#0", { address: ADVERT_SCRIPT_ADDRESS, datumHex: buildAdvertDatumHex() }],
    ]);
    const newDatumHex = buildAdvertDatumHex({ maxOutputTokens: 1024 });
    const tx = buildUpdateAdvertTx({
      txId: "b".repeat(64),
      spentRef: { txId: postTxId, index: 0 },
      newAdvertDatumOpts: { maxOutputTokens: 1024 },
    });
    const block = buildMockBlock({ slot: 1_000_100, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    const ev = result.events.find(e => e.type === "UpdateAdvert");
    expect(ev!.datumHex).toBe(newDatumHex);
  });
});

// ─── RetireAdvert ─────────────────────────────────────────────────────────────

describe("blockProcessor — RetireAdvert", () => {
  it("RetireAdvert tx spends advert with no continuing script output → RetireAdvert event", () => {
    const postTxId = "a".repeat(64);
    const knownUtxos = new Map([
      [postTxId + "#0", { address: ADVERT_SCRIPT_ADDRESS, datumHex: buildAdvertDatumHex() }],
    ]);
    const tx = buildRetireAdvertTx({ txId: "b".repeat(64), spentRef: { txId: postTxId, index: 0 } });
    const block = buildMockBlock({ slot: 1_000_200, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.some(e => e.type === "RetireAdvert")).toBe(true);
  });
});

// ─── PostEscrow ───────────────────────────────────────────────────────────────

describe("blockProcessor — PostEscrow", () => {
  it("PostEscrow tx at escrowAddress with Open state emits PostEscrow event", () => {
    const tx = buildPostEscrowTx({ txId: "c".repeat(64) });
    const block = buildMockBlock({ slot: 1_001_000, transactions: [tx] });
    const result = processBlock(block, new Map(), ADDRESSES);
    expect(result.events.some(e => e.type === "PostEscrow")).toBe(true);
  });

  it("PostEscrow event has state=Open in decoded datum", () => {
    const datumHex = buildEscrowDatumHex({ state: "Open" });
    const tx = buildPostEscrowTx({ txId: "c".repeat(64) });
    const block = buildMockBlock({ slot: 1_001_000, transactions: [tx] });
    const result = processBlock(block, new Map(), ADDRESSES);
    const ev = result.events.find(e => e.type === "PostEscrow");
    expect(ev!.datumHex).toBe(datumHex);
  });
});

// ─── ClaimEscrow ──────────────────────────────────────────────────────────────

describe("blockProcessor — ClaimEscrow", () => {
  it("ClaimEscrow tx spends Open escrow, produces Claimed output → ClaimEscrow event", () => {
    const postTxId = "c".repeat(64);
    const knownUtxos = new Map([
      [postTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Open" }) }],
    ]);
    const tx = buildClaimEscrowTx({
      txId: "d".repeat(64),
      spentRef: { txId: postTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_001_100, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.some(e => e.type === "ClaimEscrow")).toBe(true);
  });
});

// ─── SubmitEscrow ─────────────────────────────────────────────────────────────

describe("blockProcessor — SubmitEscrow", () => {
  it("SubmitEscrow tx spends Claimed escrow, produces Submitted output with receipt hash", () => {
    const claimTxId = "d".repeat(64);
    const knownUtxos = new Map([
      [claimTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Claimed" }) }],
    ]);
    const tx = buildSubmitEscrowTx({
      txId: "e".repeat(64),
      spentRef: { txId: claimTxId, index: 0 },
      receiptHash: SAMPLE_RECEIPT_HASH,
    });
    const block = buildMockBlock({ slot: 1_001_200, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.some(e => e.type === "SubmitEscrow")).toBe(true);
  });

  it("SubmitEscrow event datumHex has Submitted state and result_receipt_hash set", () => {
    const claimTxId = "d".repeat(64);
    const knownUtxos = new Map([
      [claimTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Claimed" }) }],
    ]);
    const tx = buildSubmitEscrowTx({
      txId: "e".repeat(64),
      spentRef: { txId: claimTxId, index: 0 },
      receiptHash: SAMPLE_RECEIPT_HASH,
    });
    const block = buildMockBlock({ slot: 1_001_200, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    const ev = result.events.find(e => e.type === "SubmitEscrow");
    // SPEC FIX 2026-04-25: Submit redeemer also stamps submitted_at per ARCHITECTURE §4.3 ("New datum sets state = Submitted, submitted_at = <upper bound>"); fixture builder includes it, so expectation must too.
    expect(ev!.datumHex).toBe(buildEscrowDatumHex({ state: "Submitted", submittedAt: SAMPLE_SUBMITTED_AT, resultReceiptHash: SAMPLE_RECEIPT_HASH }));
  });
});

// ─── AcceptEscrow ─────────────────────────────────────────────────────────────
//
// M1-D-fix: Accept redeemer → AcceptEscrow ONLY. No ReleaseEscrow must appear.

describe("blockProcessor — AcceptEscrow (redeemer-aware)", () => {
  it("buildAcceptEscrowTx → exactly one AcceptEscrow event emitted", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const tx = buildAcceptEscrowTx({
      txId: "f".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_001_300, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    const acceptEvents = result.events.filter(e => e.type === "AcceptEscrow");
    expect(acceptEvents.length).toBe(1);
  });

  it("buildAcceptEscrowTx → NO ReleaseEscrow event emitted", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const tx = buildAcceptEscrowTx({
      txId: "f".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_001_300, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.some(e => e.type === "ReleaseEscrow")).toBe(false);
  });

  it("AcceptEscrow event carries correct utxoRef, slot, txHash", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const tx = buildAcceptEscrowTx({
      txId: "f".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_001_300, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    const ev = result.events.find(e => e.type === "AcceptEscrow");
    expect(ev).toBeDefined();
    expect(ev!.utxoRef).toBe(submitTxId + "#0");
    expect(ev!.slot).toBe(1_001_300);
    expect(ev!.txHash).toBe("f".repeat(64));
  });
});

// ─── ReclaimEscrow ────────────────────────────────────────────────────────────

describe("blockProcessor — ReclaimEscrow", () => {
  it("ReclaimEscrow tx spends Open escrow after deliver_by → ReclaimEscrow event", () => {
    const postTxId = "c".repeat(64);
    const knownUtxos = new Map([
      [postTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Open" }) }],
    ]);
    const tx = buildReclaimEscrowTx({
      txId: "g".repeat(64),
      spentRef: { txId: postTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_002_000, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.some(e => e.type === "ReclaimEscrow")).toBe(true);
  });

  it("ReclaimEscrow from Claimed state also emits ReclaimEscrow", () => {
    const claimTxId = "d".repeat(64);
    const knownUtxos = new Map([
      [claimTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Claimed" }) }],
    ]);
    const tx = buildReclaimEscrowTx({
      txId: "h".repeat(64),
      spentRef: { txId: claimTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_002_000, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.some(e => e.type === "ReclaimEscrow")).toBe(true);
  });
});

// ─── ReleaseEscrow ────────────────────────────────────────────────────────────
//
// M1-D-fix: Release redeemer → ReleaseEscrow ONLY. No AcceptEscrow must appear.

describe("blockProcessor — ReleaseEscrow (redeemer-aware)", () => {
  it("buildReleaseEscrowTx → exactly one ReleaseEscrow event emitted", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const tx = buildReleaseEscrowTx({
      txId: "i".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_002_000, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    const releaseEvents = result.events.filter(e => e.type === "ReleaseEscrow");
    expect(releaseEvents.length).toBe(1);
  });

  it("buildReleaseEscrowTx → NO AcceptEscrow event emitted", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const tx = buildReleaseEscrowTx({
      txId: "i".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_002_000, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.some(e => e.type === "AcceptEscrow")).toBe(false);
  });

  it("ReleaseEscrow event carries correct utxoRef, slot, txHash", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const tx = buildReleaseEscrowTx({
      txId: "i".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_002_000, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    const ev = result.events.find(e => e.type === "ReleaseEscrow");
    expect(ev).toBeDefined();
    expect(ev!.utxoRef).toBe(submitTxId + "#0");
    expect(ev!.slot).toBe(1_002_000);
    expect(ev!.txHash).toBe("i".repeat(64));
  });
});

// ─── Redeemer fallback (ambiguous Submitted-spend) ────────────────────────────
//
// M1-D-fix: When a Submitted-spend has NO redeemer, blockProcessor must emit
// exactly ONE AcceptEscrow event (defensive default) and call console.warn.
// This handles real-world Ogmios responses where redeemer info may be absent.

describe("blockProcessor — redeemer fallback (ambiguous Submitted-spend)", () => {
  it("ambiguous Submitted-spend → exactly ONE AcceptEscrow event (no ReleaseEscrow)", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const tx = buildAmbiguousSubmittedSpendTx({
      txId: "z".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_009_000, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    const acceptEvents = result.events.filter(e => e.type === "AcceptEscrow");
    const releaseEvents = result.events.filter(e => e.type === "ReleaseEscrow");
    expect(acceptEvents.length).toBe(1);
    expect(releaseEvents.length).toBe(0);
  });

  it("ambiguous Submitted-spend → console.warn is called with a message mentioning missing redeemer", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = buildAmbiguousSubmittedSpendTx({
      txId: "z".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_009_000, transactions: [tx] });
    processBlock(block, knownUtxos, ADDRESSES);
    expect(warnSpy).toHaveBeenCalled();
    // At least one warn call should mention the missing redeemer
    const warnArgs = warnSpy.mock.calls.flat().join(" ");
    expect(warnArgs).toMatch(/redeemer/i);
  });

  it("ambiguous Submitted-spend → total event count is exactly 1", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = buildAmbiguousSubmittedSpendTx({
      txId: "z".repeat(64),
      spentRef: { txId: submitTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_009_000, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.length).toBe(1);
  });
});

// ─── Redeemer / state mismatch ────────────────────────────────────────────────
//
// M1-D-fix: When the redeemer disagrees with the on-chain prior state,
// blockProcessor must emit NO event and call console.warn.
// e.g. "Accept" redeemer on an Open escrow is invalid.
// e.g. "Reclaim" redeemer on a Submitted escrow is invalid.

describe("blockProcessor — redeemer / state mismatch", () => {
  it("Accept redeemer on Open escrow → no event emitted, console.warn called", () => {
    const postTxId = "c".repeat(64);
    const knownUtxos = new Map([
      [postTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Open" }) }],
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Inline mismatch: Accept redeemer on an Open-state escrow is nonsensical
    const tx = {
      id: "m1".repeat(32),
      inputs: [{ transaction: { id: postTxId }, index: 0 }],
      outputs: [{
        address: "addr_test1vqfrg4ncjz4ummcjx3t83y9tehh3ydzk0zg2hn00zg69v7q7sa96j",
        value: { ada: { lovelace: 4_000_000 } },
      }],
      redeemers: { [postTxId + "#0"]: "Accept" as const },
    };
    const block = buildMockBlock({ slot: 1_010_000, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("Reclaim redeemer on Submitted escrow → no event emitted, console.warn called", () => {
    const submitTxId = "e".repeat(64);
    const knownUtxos = new Map([
      [submitTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Submitted" }) }],
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reclaim on Submitted is invalid per ARCHITECTURE.md §4.3
    const tx = {
      id: "n1".repeat(32),
      inputs: [{ transaction: { id: submitTxId }, index: 0 }],
      outputs: [{
        address: "addr_test1vqfrg4ncjz4ummcjx3t83y9tehh3ydzk0zg2hn00zg69v7q7sa96j",
        value: { ada: { lovelace: 4_000_000 } },
      }],
      redeemers: { [submitTxId + "#0"]: "Reclaim" as const },
    };
    const block = buildMockBlock({ slot: 1_010_100, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("Release redeemer on Open escrow → no event emitted, console.warn called", () => {
    const postTxId = "c".repeat(64);
    const knownUtxos = new Map([
      [postTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Open" }) }],
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = {
      id: "o1".repeat(32),
      inputs: [{ transaction: { id: postTxId }, index: 0 }],
      outputs: [{
        address: "addr_test1vqfrg4ncjz4ummcjx3t83y9tehh3ydzk0zg2hn00zg69v7q7sa96j",
        value: { ada: { lovelace: 4_000_000 } },
      }],
      redeemers: { [postTxId + "#0"]: "Release" as const },
    };
    const block = buildMockBlock({ slot: 1_010_200, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("Accept redeemer on Claimed escrow → no event emitted, console.warn called", () => {
    const claimTxId = "d".repeat(64);
    const knownUtxos = new Map([
      [claimTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Claimed" }) }],
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = {
      id: "p1".repeat(32),
      inputs: [{ transaction: { id: claimTxId }, index: 0 }],
      outputs: [{
        address: "addr_test1vqfrg4ncjz4ummcjx3t83y9tehh3ydzk0zg2hn00zg69v7q7sa96j",
        value: { ada: { lovelace: 4_000_000 } },
      }],
      redeemers: { [claimTxId + "#0"]: "Accept" as const },
    };
    const block = buildMockBlock({ slot: 1_010_300, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.events.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("blockProcessor — error handling", () => {
  it("malformed datum at advertAddress → no event emitted (does not throw)", () => {
    const tx = buildMalformedDatumTx({ txId: "j".repeat(64), address: ADVERT_SCRIPT_ADDRESS });
    const block = buildMockBlock({ slot: 1_003_000, transactions: [tx] });
    // Should not throw — malformed datum is logged and skipped
    const result = processBlock(block, new Map(), ADDRESSES);
    expect(result.events.length).toBe(0);
  });

  it("malformed datum at escrowAddress → no event emitted (does not throw)", () => {
    const tx = buildMalformedDatumTx({ txId: "k".repeat(64), address: ESCROW_SCRIPT_ADDRESS });
    const block = buildMockBlock({ slot: 1_003_100, transactions: [tx] });
    const result = processBlock(block, new Map(), ADDRESSES);
    expect(result.events.length).toBe(0);
  });

  it("Byron-era block with no transactions field is handled gracefully", () => {
    const block = buildByronBlock({ slot: 500_000 }) as any;
    // transactions field is absent — must not throw
    const result = processBlock(block, new Map(), ADDRESSES);
    expect(result.events.length).toBe(0);
  });

  it("block with transactions: null is handled gracefully", () => {
    const block = { ...buildMockBlock({ slot: 600_000 }), transactions: null };
    const result = processBlock(block as any, new Map(), ADDRESSES);
    expect(result.events.length).toBe(0);
  });

  it("tx at untracked address generates no events", () => {
    const tx = {
      id: "l".repeat(64),
      inputs: [{ transaction: { id: "prev" + "l".repeat(60) }, index: 0 }],
      outputs: [{ address: "addr_test1quntracked", value: { ada: { lovelace: 1_000_000 } }, datum: buildAdvertDatumHex() }],
    };
    const block = buildMockBlock({ slot: 1_004_000, transactions: [tx] });
    const result = processBlock(block, new Map(), ADDRESSES);
    expect(result.events.length).toBe(0);
  });
});

// ─── Spend detection ──────────────────────────────────────────────────────────

describe("blockProcessor — spend-driven detection", () => {
  it("spentRefs includes known UTxO refs consumed by the block", () => {
    const postTxId = "c".repeat(64);
    const knownUtxos = new Map([
      [postTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Open" }) }],
    ]);
    const tx = buildClaimEscrowTx({ txId: "d".repeat(64), spentRef: { txId: postTxId, index: 0 } });
    const block = buildMockBlock({ slot: 1_001_100, transactions: [tx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    expect(result.spentRefs.some(r => r.ref === postTxId + "#0")).toBe(true);
  });

  it("spentRefs does not include unknown UTxO refs", () => {
    const tx = buildPostAdvertTx();
    const block = buildMockBlock({ slot: 1_000_000, transactions: [tx] });
    const result = processBlock(block, new Map(), ADDRESSES);
    // All inputs are from untracked prev-txs
    expect(result.spentRefs.length).toBe(0);
  });
});

// ─── Rollback via worker ──────────────────────────────────────────────────────

describe("blockProcessor — rollback integration note", () => {
  it("rollback to before a Submit: escrow returns to Claimed state (via cache rollback)", () => {
    // This test documents rollback semantics at the worker level.
    // The actual mechanic is tested in sqlite-cache.test.ts (rollbackToSlot).
    // Here we verify processBlock correctly tracks which events were at which slots.
    const claimTxId = "d".repeat(64);
    const knownUtxos = new Map([
      [claimTxId + "#0", { address: ESCROW_SCRIPT_ADDRESS, datumHex: buildEscrowDatumHex({ state: "Claimed" }) }],
    ]);
    const submitTx = buildSubmitEscrowTx({
      txId: "e".repeat(64),
      spentRef: { txId: claimTxId, index: 0 },
    });
    const block = buildMockBlock({ slot: 1_001_200, transactions: [submitTx] });
    const result = processBlock(block, knownUtxos, ADDRESSES);
    const ev = result.events.find(e => e.type === "SubmitEscrow");
    expect(ev!.slot).toBe(1_001_200);
    // If we rolled back to slot 1_001_100, this SubmitEscrow event at 1_001_200
    // would be soft-deleted. The cache test validates that directly.
  });
});
