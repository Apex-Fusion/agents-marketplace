/**
 * MockChainProvider-specific behavior tests — M0-B RED phase
 *
 * Tests the test-only extensions NOT present on the ChainProvider interface:
 *   - advanceSlot(n)
 *   - seed(utxo)
 *   - custom evaluator injection
 *   - UTxO spending on submitTx
 *   - concurrency safety on reads
 *   - idempotent submitTx
 *
 * These tests MUST FAIL until Catherine implements MockChainProvider in M0-C.
 *
 * Convention for synthetic tx CBOR used in spending tests:
 *   MockChainProvider parses a simple JSON-in-hex encoding for test-only txs:
 *     hex( JSON.stringify({ inputs: [{ txHash, index }], ... }) )
 *   This is documented here so Catherine implements the same convention.
 *   Production code NEVER uses this — it only applies to MockChainProvider
 *   test interaction. The exact encoding must be agreed between these tests
 *   and the MockChainProvider implementation.
 *
 *   Encoding helper: textToHex / hexToText below.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo, OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";

// ─── Fixture Helpers ──────────────────────────────────────────────────────────

function textToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build a synthetic Utxo for seeding. Address is bech32 per design decision #4. */
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

/**
 * Build a synthetic spending-tx CBOR hex that MockChainProvider can parse.
 *
 * Convention (MUST match MockChainProvider M0-C implementation):
 *   hex(JSON.stringify({ inputs: [{ txHash: string, index: number }, ...] }))
 *
 * The mock does NOT validate the tx structure beyond inputs — it just removes
 * any seeded UTxOs that appear in `inputs`.
 */
function buildSpendingTxHex(inputs: OutputReference[]): string {
  return textToHex(JSON.stringify({ inputs }));
}

// ─── advanceSlot() ────────────────────────────────────────────────────────────

describe("MockChainProvider.advanceSlot()", () => {
  it("advances tip() by exactly n slots", async () => {
    const mock = new MockChainProvider({});
    const before = await mock.tip();
    mock.advanceSlot(50);
    const after = await mock.tip();
    expect(after).toBe(before + 50);
  });

  it("advances tip() by exactly n=1", async () => {
    const mock = new MockChainProvider({});
    const before = await mock.tip();
    mock.advanceSlot(1);
    const after = await mock.tip();
    expect(after).toBe(before + 1);
  });

  it("advances tip() cumulatively across multiple calls", async () => {
    const mock = new MockChainProvider({});
    const before = await mock.tip();
    mock.advanceSlot(10);
    mock.advanceSlot(20);
    mock.advanceSlot(5);
    const after = await mock.tip();
    expect(after).toBe(before + 35);
  });

  it("does NOT auto-advance slot between read calls", async () => {
    const mock = new MockChainProvider({});
    const t1 = await mock.tip();
    const t2 = await mock.tip();
    expect(t1).toBe(t2);
  });

  it("n=0 leaves tip unchanged", async () => {
    const mock = new MockChainProvider({});
    const before = await mock.tip();
    mock.advanceSlot(0);
    const after = await mock.tip();
    expect(after).toBe(before);
  });
});

// ─── Custom evaluator injection ───────────────────────────────────────────────

describe("MockChainProvider — custom evaluator injection", () => {
  it("default evaluator returns {ok: true} for any input", async () => {
    const mock = new MockChainProvider({});
    const result = await mock.evaluateTx("deadbeef");
    expect(result.ok).toBe(true);
  });

  it("injected evaluator returning failure is respected", async () => {
    const mock = new MockChainProvider({
      evaluator: () => ({ ok: false, error: "nope" }),
    });
    const result = await mock.evaluateTx("deadbeef");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("nope");
  });

  it("injected evaluator is called with the exact txCborHex passed in", async () => {
    const captured: string[] = [];
    const mock = new MockChainProvider({
      evaluator: (hex) => {
        captured.push(hex);
        return { ok: true };
      },
    });
    await mock.evaluateTx("cafecafe");
    expect(captured).toEqual(["cafecafe"]);
  });

  it("injected evaluator can return cost alongside ok=true", async () => {
    const mock = new MockChainProvider({
      evaluator: () => ({ ok: true, cost: { memory: 512, steps: 1024 } }),
    });
    const result = await mock.evaluateTx("00");
    expect(result.ok).toBe(true);
    expect(result.cost?.memory).toBe(512);
    expect(result.cost?.steps).toBe(1024);
  });
});

// ─── seed() and UTxO queries ──────────────────────────────────────────────────

describe("MockChainProvider.seed()", () => {
  it("after seeding, queryUtxo returns the seeded UTxO", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "a".repeat(64), index: 0 };
    const utxo = makeUtxo(ref);
    mock.seed(utxo);

    const result = await mock.queryUtxo(ref);
    expect(result).not.toBeNull();
    expect(result?.ref.txHash).toBe(ref.txHash);
    expect(result?.ref.index).toBe(ref.index);
  });

  it("after seeding, queryUtxosByAddress returns the seeded UTxO", async () => {
    const mock = new MockChainProvider({});
    const address = "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2";
    const ref: OutputReference = { txHash: "b".repeat(64), index: 1 };
    const utxo = makeUtxo(ref, address);
    mock.seed(utxo);

    const results = await mock.queryUtxosByAddress(address);
    expect(results).toHaveLength(1);
    expect(results[0].ref.txHash).toBe(ref.txHash);
  });

  it("queryUtxo returns null for a ref with same txHash but different index", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "c".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref));

    const result = await mock.queryUtxo({ txHash: ref.txHash, index: 1 });
    expect(result).toBeNull();
  });

  it("multiple seeds at the same address are all returned", async () => {
    const mock = new MockChainProvider({});
    const address = "addr_test1vpqthemefkuvelrqprngush5adstneyesq2a4yh7jrfpheq3azpck";
    mock.seed(makeUtxo({ txHash: "d".repeat(64), index: 0 }, address));
    mock.seed(makeUtxo({ txHash: "e".repeat(64), index: 0 }, address));

    const results = await mock.queryUtxosByAddress(address);
    expect(results).toHaveLength(2);
  });

  it("seed preserves all UTxO fields (lovelace, assets, datumHex, scriptRef)", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "f".repeat(64), index: 2 };
    const utxo: Utxo = {
      ref,
      address: "addr_test1vpqthemefkuvelrqprngush5adstneyesq2a4yh7jrfpheq3azpck",
      lovelace: 5_000_000n,
      assets: { abcdef123456: 1n },
      datumHex: "deadbeef",
      scriptRef: null,
    };
    mock.seed(utxo);

    const result = await mock.queryUtxo(ref);
    expect(result?.lovelace).toBe(5_000_000n);
    expect(result?.assets).toEqual({ abcdef123456: 1n });
    expect(result?.datumHex).toBe("deadbeef");
    expect(result?.scriptRef).toBeNull();
  });
});

// ─── UTxO spending via submitTx ───────────────────────────────────────────────

describe("MockChainProvider — UTxO spending via submitTx", () => {
  it("after submitting a tx that consumes a seeded UTxO, queryUtxo returns null", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "1".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref));

    // Verify UTxO is present before spending
    expect(await mock.queryUtxo(ref)).not.toBeNull();

    // Submit a tx that spends this UTxO
    const spendHex = buildSpendingTxHex([ref]);
    await mock.submitTx(spendHex);

    // Now it should be gone
    expect(await mock.queryUtxo(ref)).toBeNull();
  });

  it("spending a UTxO removes it from queryUtxosByAddress as well", async () => {
    const mock = new MockChainProvider({});
    const address = "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2";
    const ref: OutputReference = { txHash: "2".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref, address));

    await mock.submitTx(buildSpendingTxHex([ref]));

    const results = await mock.queryUtxosByAddress(address);
    expect(results).toHaveLength(0);
  });

  it("spending only removes the specific input ref, not unrelated UTxOs", async () => {
    const mock = new MockChainProvider({});
    const address = "addr_test1vpqthemefkuvelrqprngush5adstneyesq2a4yh7jrfpheq3azpck";
    const ref1: OutputReference = { txHash: "3".repeat(64), index: 0 };
    const ref2: OutputReference = { txHash: "4".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref1, address));
    mock.seed(makeUtxo(ref2, address));

    await mock.submitTx(buildSpendingTxHex([ref1]));

    expect(await mock.queryUtxo(ref1)).toBeNull();
    expect(await mock.queryUtxo(ref2)).not.toBeNull();
  });
});

// ─── Concurrency ─────────────────────────────────────────────────────────────

describe("MockChainProvider — concurrency", () => {
  it("two parallel queryUtxo calls return consistent results", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "5".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref));

    // Fire both queries without awaiting individually
    const [r1, r2] = await Promise.all([
      mock.queryUtxo(ref),
      mock.queryUtxo(ref),
    ]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1?.ref.txHash).toBe(r2?.ref.txHash);
  });

  it("ten parallel queryUtxosByAddress calls all return the same result", async () => {
    const mock = new MockChainProvider({});
    const address = "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2";
    mock.seed(makeUtxo({ txHash: "6".repeat(64), index: 0 }, address));

    const results = await Promise.all(
      Array.from({ length: 10 }, () => mock.queryUtxosByAddress(address)),
    );

    for (const r of results) {
      expect(r).toHaveLength(1);
    }
  });
});

// ─── submitTx idempotency ─────────────────────────────────────────────────────

describe("MockChainProvider — submitTx idempotency", () => {
  it("re-submitting identical CBOR returns the same txHash", async () => {
    const mock = new MockChainProvider({});
    const cbor = "aabbccdd11223344";
    const hash1 = await mock.submitTx(cbor);
    const hash2 = await mock.submitTx(cbor);
    expect(hash1).toBe(hash2);
  });

  it("re-submitting identical CBOR does not double-register in known-tx set", async () => {
    const mock = new MockChainProvider({});
    const cbor = "11223344aabbccdd";
    const txHash = await mock.submitTx(cbor);
    await mock.submitTx(cbor); // idempotent re-submit

    // awaitTx should still resolve in one shot (no error from duplicate)
    await expect(mock.awaitTx(txHash, 200)).resolves.toBeUndefined();
  });

  it("different CBOR inputs produce different txHashes", async () => {
    const mock = new MockChainProvider({});
    const h1 = await mock.submitTx("aabb");
    const h2 = await mock.submitTx("ccdd");
    expect(h1).not.toBe(h2);
  });
});
