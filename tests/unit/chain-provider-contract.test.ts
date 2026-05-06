/**
 * Chain Provider Contract Tests — M0-B RED phase
 *
 * Generic contract tests for ANY ChainProvider implementation.
 * Structured as a shared suite that takes a factory so future Tier-2 and
 * Tier-3 providers can be verified against the same invariants.
 *
 * These tests MUST FAIL until Catherine implements MockChainProvider in M0-C.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ChainProvider, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";

// ─── Contract Suite Factory ───────────────────────────────────────────────────

/**
 * runChainProviderContract — runs the standard interface contract against any
 * ChainProvider instance produced by makeProvider().
 *
 * Preconditions assumed by every test in this suite:
 *   - Provider starts with tip >= 0
 *   - Provider has no pre-seeded UTxOs
 */
function runChainProviderContract(
  name: string,
  makeProvider: () => ChainProvider,
): void {
  describe(`ChainProvider contract — ${name}`, () => {
    let provider: ChainProvider;

    beforeEach(() => {
      provider = makeProvider();
    });

    // ─── tip() ──────────────────────────────────────────────────────────────

    describe("tip()", () => {
      it("returns a non-negative integer", async () => {
        const slot = await provider.tip();
        expect(typeof slot).toBe("number");
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(slot)).toBe(true);
      });
    });

    // ─── queryUtxo() ────────────────────────────────────────────────────────

    describe("queryUtxo()", () => {
      it("returns null for a ref that was never created", async () => {
        const result = await provider.queryUtxo({
          txHash: "a".repeat(64),
          index: 0,
        });
        expect(result).toBeNull();
      });

      it("returns null for a different index on a known-hash", async () => {
        // No UTxOs have been seeded; any ref should return null
        const result = await provider.queryUtxo({
          txHash: "b".repeat(64),
          index: 99,
        });
        expect(result).toBeNull();
      });
    });

    // ─── queryUtxosByAddress() ───────────────────────────────────────────────

    describe("queryUtxosByAddress()", () => {
      it("returns an empty array for an unknown bech32 address", async () => {
        const result = await provider.queryUtxosByAddress(
          "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2",
        );
        expect(result).toEqual([]);
      });

      it("returns an array (not null/undefined) for any address", async () => {
        const result = await provider.queryUtxosByAddress(
          "addr_test1vpqthemefkuvelrqprngush5adstneyesq2a4yh7jrfpheq3azpck",
        );
        expect(Array.isArray(result)).toBe(true);
      });
    });

    // ─── evaluateTx() ───────────────────────────────────────────────────────

    describe("evaluateTx()", () => {
      it("returns {ok: true} for a trivial well-formed CBOR hex", async () => {
        // Minimal valid CBOR: integer 0 = 0x00
        const result = await provider.evaluateTx("00");
        expect(result.ok).toBe(true);
      });

      it("result has ok property that is a boolean", async () => {
        const result = await provider.evaluateTx("00");
        expect(typeof result.ok).toBe("boolean");
      });
    });

    // ─── submitTx() ─────────────────────────────────────────────────────────

    describe("submitTx()", () => {
      it("returns a 64-character lowercase hex txHash", async () => {
        const txHash = await provider.submitTx("00");
        expect(typeof txHash).toBe("string");
        expect(txHash).toHaveLength(64);
        expect(txHash).toMatch(/^[0-9a-f]{64}$/);
      });

      it("returns a deterministic hash for the same CBOR input", async () => {
        const hash1 = await provider.submitTx("deadbeef");
        const hash2 = await provider.submitTx("deadbeef");
        expect(hash1).toBe(hash2);
      });

      it("returns a different hash for different CBOR input", async () => {
        const hash1 = await provider.submitTx("deadbeef");
        const hash2 = await provider.submitTx("cafebabe");
        expect(hash1).not.toBe(hash2);
      });
    });

    // ─── awaitTx() ──────────────────────────────────────────────────────────

    describe("awaitTx()", () => {
      it("resolves within 100ms for a hash returned by submitTx", async () => {
        const txHash = await provider.submitTx("aabbccdd");
        const start = Date.now();
        await provider.awaitTx(txHash, 500);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(100);
      });

      it("rejects after timeoutMs for an unknown txHash", async () => {
        const unknownHash = "f".repeat(64);
        const start = Date.now();
        await expect(
          provider.awaitTx(unknownHash, 80),
        ).rejects.toThrow();
        const elapsed = Date.now() - start;
        // Must have waited at least ~80ms (allow 20ms tolerance)
        expect(elapsed).toBeGreaterThanOrEqual(60);
      });

      it("rejection error message references timeout", async () => {
        const unknownHash = "e".repeat(64);
        await expect(
          provider.awaitTx(unknownHash, 50),
        ).rejects.toThrow(/timeout/i);
      });
    });
  });
}

// ─── Run Contract Against MockChainProvider ───────────────────────────────────

runChainProviderContract("MockChainProvider", () => new MockChainProvider({}));
