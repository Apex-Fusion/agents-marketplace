/**
 * MockChainProvider.buildTestTx round-trip equivalence — M0-D
 *
 * Verifies that buildTestTx (static helper) and the inline buildSpendingTxHex
 * convention used in mock-chain-provider.test.ts produce hex strings that
 * MockChainProvider interprets identically — i.e. both remove the same UTxOs
 * on submitTx.
 *
 * This test is intentionally a direct, standalone test of buildTestTx.
 * The existing mock-chain-provider.test.ts exercises spending only via
 * the inline helper; this suite verifies the static method produces the
 * same round-trip behaviour.
 */

import { describe, it, expect } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo, OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeUtxo(ref: OutputReference, address?: string): Utxo {
  return {
    ref,
    address: address ?? "addr_test1vpqthemefkuvelrqprngush5adstneyesq2a4yh7jrfpheq3azpck",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: null,
    scriptRef: null,
  };
}

/** Inline convention from mock-chain-provider.test.ts (the reference implementation). */
function buildSpendingTxHex(inputs: OutputReference[]): string {
  return Array.from(new TextEncoder().encode(JSON.stringify({ inputs })))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Static buildTestTx equivalence ──────────────────────────────────────────

describe("MockChainProvider.buildTestTx — static helper equivalence", () => {
  it("buildTestTx with inputs produces the same hex as the inline buildSpendingTxHex convention", () => {
    const ref: OutputReference = { txHash: "a".repeat(64), index: 0 };
    const fromStatic = MockChainProvider.buildTestTx({ inputs: [ref] });
    const fromInline = buildSpendingTxHex([ref]);
    expect(fromStatic).toBe(fromInline);
  });

  it("buildTestTx hex is non-empty and lowercase hex", () => {
    const ref: OutputReference = { txHash: "b".repeat(64), index: 1 };
    const hex = MockChainProvider.buildTestTx({ inputs: [ref] });
    expect(hex.length).toBeGreaterThan(0);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it("buildTestTx is deterministic (same inputs → same hex)", () => {
    const ref: OutputReference = { txHash: "c".repeat(64), index: 2 };
    const h1 = MockChainProvider.buildTestTx({ inputs: [ref] });
    const h2 = MockChainProvider.buildTestTx({ inputs: [ref] });
    expect(h1).toBe(h2);
  });

  it("buildTestTx with different inputs produces different hex", () => {
    const ref1: OutputReference = { txHash: "d".repeat(64), index: 0 };
    const ref2: OutputReference = { txHash: "e".repeat(64), index: 0 };
    const h1 = MockChainProvider.buildTestTx({ inputs: [ref1] });
    const h2 = MockChainProvider.buildTestTx({ inputs: [ref2] });
    expect(h1).not.toBe(h2);
  });
});

// ─── Round-trip equivalence: both helpers produce tx the mock understands ─────

describe("MockChainProvider — buildTestTx vs inline helper round-trip equivalence", () => {
  it("UTxO spent via buildTestTx is removed — identical to inline helper behaviour", async () => {
    const ref: OutputReference = { txHash: "f".repeat(64), index: 0 };

    // Provider A uses the static helper
    const mockA = new MockChainProvider({});
    mockA.seed(makeUtxo(ref));
    await mockA.submitTx(MockChainProvider.buildTestTx({ inputs: [ref] }));
    const resultA = await mockA.queryUtxo(ref);

    // Provider B uses the inline convention
    const mockB = new MockChainProvider({});
    mockB.seed(makeUtxo(ref));
    await mockB.submitTx(buildSpendingTxHex([ref]));
    const resultB = await mockB.queryUtxo(ref);

    // Both should have consumed the UTxO
    expect(resultA).toBeNull();
    expect(resultB).toBeNull();
  });

  it("the hex produced by both helpers is identical (same JSON encoding)", () => {
    const ref: OutputReference = { txHash: "1".repeat(64), index: 3 };
    const staticHex = MockChainProvider.buildTestTx({ inputs: [ref] });
    const inlineHex = buildSpendingTxHex([ref]);
    expect(staticHex).toBe(inlineHex);
  });

  it("spending multiple UTxOs via buildTestTx removes exactly those UTxOs", async () => {
    const mock = new MockChainProvider({});
    const address = "addr_test1vpqthemefkuvelrqprngush5adstneyesq2a4yh7jrfpheq3azpck";
    const ref1: OutputReference = { txHash: "2".repeat(64), index: 0 };
    const ref2: OutputReference = { txHash: "3".repeat(64), index: 0 };
    const ref3: OutputReference = { txHash: "4".repeat(64), index: 0 };

    mock.seed(makeUtxo(ref1, address));
    mock.seed(makeUtxo(ref2, address));
    mock.seed(makeUtxo(ref3, address));

    // Spend ref1 and ref2 via buildTestTx
    const tx = MockChainProvider.buildTestTx({ inputs: [ref1, ref2] });
    await mock.submitTx(tx);

    expect(await mock.queryUtxo(ref1)).toBeNull();
    expect(await mock.queryUtxo(ref2)).toBeNull();
    expect(await mock.queryUtxo(ref3)).not.toBeNull();
  });

  it("buildTestTx with only inputs field is accepted (outputs field is optional — no crash)", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "5".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref));

    // Shape without optional outputs — MockChainProvider must not crash
    const tx = MockChainProvider.buildTestTx({ inputs: [ref] });
    await expect(mock.submitTx(tx)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(await mock.queryUtxo(ref)).toBeNull();
  });

  it("submitTx with identical buildTestTx hex is idempotent (does not double-spend)", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "7".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref));

    const tx = MockChainProvider.buildTestTx({ inputs: [ref] });
    const hash1 = await mock.submitTx(tx);
    const hash2 = await mock.submitTx(tx);

    // Same hash returned — idempotent
    expect(hash1).toBe(hash2);
    // UTxO was spent on the first submit, still null after second
    expect(await mock.queryUtxo(ref)).toBeNull();
  });
});
