/**
 * MockChainProvider tests.
 *
 * The mock is the in-memory chain of the unit tests and of the `--mock` flag of buyer/src/cli/accept.ts. This file asserts what
 * a user of the mock sees: a submitted transaction spends its inputs, a second submit of the same transaction changes nothing,
 * awaitTx ends with a timeout error for a hash that never arrives, and evaluateTx accepts any transaction by default.
 *
 * A test transaction is hex(JSON.stringify({ inputs: [{ txHash, index }] })). The mock decodes it on submitTx and removes the
 * UTxOs of `inputs`. MockChainProvider.buildTestTx builds the same hex. Production code never uses this form.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo, OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";

afterEach(() => {
  vi.useRealTimers();
});

// ─── Fixture Helpers ──────────────────────────────────────────────────────────

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
 * Build a synthetic spending-tx CBOR hex that MockChainProvider can parse: hex(JSON.stringify({ inputs })).
 * It is written by hand, so that the spend cases do not depend on MockChainProvider.buildTestTx.
 *
 * The mock does NOT validate the tx structure beyond inputs — it just removes
 * any seeded UTxOs that appear in `inputs`.
 */
function buildSpendingTxHex(inputs: OutputReference[]): string {
  return Array.from(new TextEncoder().encode(JSON.stringify({ inputs })))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

    // Verify the UTxO is listed before spending
    expect((await mock.queryUtxosByAddress(address)).map((u) => u.ref)).toEqual([ref]);

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

  it("a tx from buildTestTx spends each of its inputs and no other UTxO", async () => {
    const mock = new MockChainProvider({});
    const address = "addr_test1vpqthemefkuvelrqprngush5adstneyesq2a4yh7jrfpheq3azpck";
    const ref1: OutputReference = { txHash: "5".repeat(64), index: 0 };
    const ref2: OutputReference = { txHash: "6".repeat(64), index: 0 };
    const ref3: OutputReference = { txHash: "7".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref1, address));
    mock.seed(makeUtxo(ref2, address));
    mock.seed(makeUtxo(ref3, address));

    await mock.submitTx(MockChainProvider.buildTestTx({ inputs: [ref1, ref2] }));

    expect(await mock.queryUtxo(ref1)).toBeNull();
    expect(await mock.queryUtxo(ref2)).toBeNull();
    expect(await mock.queryUtxo(ref3)).not.toBeNull();
  });
});

// ─── submitTx idempotency ─────────────────────────────────────────────────────

describe("MockChainProvider — submitTx idempotency", () => {
  it("re-submitting identical CBOR returns the same 64-character lowercase hex txHash", async () => {
    const mock = new MockChainProvider({});
    const cbor = "aabbccdd11223344";
    const hash1 = await mock.submitTx(cbor);
    const hash2 = await mock.submitTx(cbor);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
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

// ─── awaitTx timeout ──────────────────────────────────────────────────────────

describe("MockChainProvider — awaitTx", () => {
  it("rejects with a timeout error once timeoutMs passes for a hash that never arrives", async () => {
    vi.useFakeTimers();
    const mock = new MockChainProvider({});

    // Attach the rejection expectation BEFORE advancing time so the rejection is not treated as unhandled.
    let settled = false;
    const rejected = expect(
      mock.awaitTx("f".repeat(64), 80).finally(() => {
        settled = true;
      }),
    ).rejects.toThrow(/timeout/i);

    await vi.advanceTimersByTimeAsync(70);
    expect(settled).toBe(false); // still waiting before the deadline

    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(settled).toBe(true);
  });
});

// ─── evaluateTx ───────────────────────────────────────────────────────────────

describe("MockChainProvider — evaluateTx", () => {
  it("accepts any transaction by default", async () => {
    const mock = new MockChainProvider({});
    expect(await mock.evaluateTx("deadbeef")).toEqual({ ok: true });
  });
});
