/**
 * cli-post-advert-flow.test.ts — RED phase tests for M1-F-3
 *
 * Tests runPostAdvert(params) pure logic against MockChainProvider.
 * All tests are expected to FAIL (red) until Catherine implements
 * supplier/src/cli/postAdvertFlow.ts in M1-F-3-green.
 *
 * Spec: supplier/src/cli/postAdvertFlow.ts interface + ARCHITECTURE.md §4.1 / §4.3.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPostAdvert } from "../../supplier/src/cli/postAdvertFlow.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import {
  buildCliAdvertDatum,
  VALID_TIP_SLOT,
} from "../fixtures/supplier-side/sample-advert-datum.js";
import {
  buildSupplierWalletKey,
  SUPPLIER_PKH,
} from "../fixtures/supplier-side/wallet-keys.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a MockChainProvider whose tip slot corresponds to the fixture
 * advertised_at (VALID_TIP_SLOT = 0, wallclock 0ms).
 */
function buildMockChain(): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(VALID_TIP_SLOT);
  return chain;
}

// ─── Happy-path ───────────────────────────────────────────────────────────────

describe("runPostAdvert() — happy path", () => {
  it("resolves with txHash (64 hex chars)", async () => {
    const chain = buildMockChain();
    const result = await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/i);
  });

  it("resolves with advertRef whose txHash matches result.txHash and index 0", async () => {
    const chain = buildMockChain();
    const result = await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });
    expect(result.advertRef.txHash).toBe(result.txHash);
    expect(result.advertRef.index).toBe(0);
  });

  it("resolves with formattedRef = '<txHash>#0'", async () => {
    const chain = buildMockChain();
    const result = await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });
    expect(result.formattedRef).toBe(`${result.txHash}#0`);
  });

  it("advert UTxO is queryable via chain.queryUtxo(result.advertRef) after completion", async () => {
    const chain = buildMockChain();
    const result = await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });
    const utxo = await chain.queryUtxo(result.advertRef);
    expect(utxo).not.toBeNull();
    expect(utxo!.ref.txHash).toBe(result.txHash);
    expect(utxo!.ref.index).toBe(0);
  });

  it("the seeded UTxO carries a non-null datumHex", async () => {
    const chain = buildMockChain();
    const result = await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });
    const utxo = await chain.queryUtxo(result.advertRef);
    expect(utxo!.datumHex).toBeTruthy();
    expect(utxo!.datumHex).toMatch(/^[0-9a-f]+$/i);
  });
});

// ─── Validation — signature mismatch ─────────────────────────────────────────

describe("runPostAdvert() — validation: supplier_pkh mismatch", () => {
  it("throws TxConstructionError when walletKey.pubKeyHash !== advertDatum.supplier_pkh", async () => {
    const chain = buildMockChain();
    // Build a datum whose supplier_pkh does NOT match the wallet key.
    const datum = buildCliAdvertDatum({ supplier_pkh: "0".repeat(56) });
    await expect(
      runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: datum,
      }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("error reason is 'supplier signature mismatch'", async () => {
    const chain = buildMockChain();
    const datum = buildCliAdvertDatum({ supplier_pkh: "0".repeat(56) });
    let caught: unknown;
    try {
      await runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: datum,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toBe("supplier signature mismatch");
  });
});

// ─── Validation — non-Active status ──────────────────────────────────────────

describe("runPostAdvert() — validation: Retired status", () => {
  it("throws TxConstructionError when advertDatum.status === 'Retired'", async () => {
    const chain = buildMockChain();
    const datum = buildCliAdvertDatum({ status: "Retired" });
    await expect(
      runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: datum,
      }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("error reason includes 'Active'", async () => {
    const chain = buildMockChain();
    const datum = buildCliAdvertDatum({ status: "Retired" });
    let caught: unknown;
    try {
      await runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: datum,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    // buildPostAdvertTx uses "fresh advert must be Active" as the reason
    expect((caught as TxConstructionError).reason).toMatch(/Active/);
  });
});

// ─── Validation — endpoint_url required ──────────────────────────────────────

describe("runPostAdvert() — validation: empty endpoint_url", () => {
  it("throws TxConstructionError with reason containing 'endpoint_url required'", async () => {
    const chain = buildMockChain();
    const datum = buildCliAdvertDatum({ endpoint_url: "" });
    let caught: unknown;
    try {
      await runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: datum,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toMatch(/endpoint_url required/);
  });
});

// ─── Validation — detail_hash must be 32 bytes (64 hex chars) ────────────────

describe("runPostAdvert() — validation: invalid detail_hash", () => {
  it("throws TxConstructionError when detail_hash is not 64 hex chars", async () => {
    const chain = buildMockChain();
    const datum = buildCliAdvertDatum({ detail_hash: "abc" });
    let caught: unknown;
    try {
      await runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: datum,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toMatch(/detail_hash must be 32 bytes/);
  });

  it("throws when detail_hash is 63 chars (odd length, not 32 bytes)", async () => {
    const chain = buildMockChain();
    const datum = buildCliAdvertDatum({ detail_hash: "a".repeat(63) });
    await expect(
      runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: datum,
      }),
    ).rejects.toThrow(TxConstructionError);
  });

  it("throws when detail_hash is 66 chars (33 bytes)", async () => {
    const chain = buildMockChain();
    const datum = buildCliAdvertDatum({ detail_hash: "a".repeat(66) });
    await expect(
      runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: datum,
      }),
    ).rejects.toThrow(TxConstructionError);
  });
});

// ─── awaitTx timeout ─────────────────────────────────────────────────────────

describe("runPostAdvert() — awaitTx timeout", () => {
  it("rejects when awaitTx times out, error message contains the txHash", async () => {
    // Override awaitTx to always time out immediately and record the txHash
    // that runPostAdvert passed to it.
    const chain = new MockChainProvider();
    chain.advanceSlot(VALID_TIP_SLOT);

    let capturedHash: string | undefined;
    chain.awaitTx = async (txHash: string, _timeoutMs: number): Promise<void> => {
      capturedHash = txHash;
      throw new Error(`awaitTx timeout after 1ms waiting for txHash ${txHash}`);
    };

    let caughtErr: unknown;
    try {
      await runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: buildCliAdvertDatum(),
        awaitTimeoutMs: 1,
      });
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(Error);
    // capturedHash must be a non-empty 64-char hex string (the real txHash),
    // not the empty string that would trivially satisfy .toContain("").
    // This assertion will fail in RED because runPostAdvert throws "not implemented"
    // before ever calling awaitTx.
    expect(typeof capturedHash).toBe("string");
    expect(capturedHash).toMatch(/^[0-9a-f]{64}$/i);
    // The surfaced error must mention the txHash for operator manual recovery.
    expect((caughtErr as Error).message).toContain(capturedHash!);
  });
});

// ─── chain.submitTx rejects ───────────────────────────────────────────────────

describe("runPostAdvert() — submitTx failure", () => {
  it("rejects with the underlying error when chain.submitTx rejects", async () => {
    const chain = buildMockChain();
    const submitError = new Error("OgmiosSubmitError: rejected by mempool");
    chain.submitTx = async (_txCborHex: string): Promise<string> => {
      throw submitError;
    };

    await expect(
      runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: buildCliAdvertDatum(),
      }),
    ).rejects.toThrow("OgmiosSubmitError: rejected by mempool");
  });
});

// ─── log callback ─────────────────────────────────────────────────────────────

describe("runPostAdvert() — log callback", () => {
  it("calls log with 'posting advert' before submission", async () => {
    const chain = buildMockChain();
    const lines: string[] = [];
    await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
      log: (line) => lines.push(line),
    });
    expect(lines.some((l) => l.includes("posting advert"))).toBe(true);
  });

  it("calls log with 'submitted tx <hash>' after submitTx", async () => {
    const chain = buildMockChain();
    const lines: string[] = [];
    const result = await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
      log: (line) => lines.push(line),
    });
    expect(lines.some((l) => l.includes("submitted tx") && l.includes(result.txHash))).toBe(true);
  });

  it("calls log with 'awaiting confirmation' after submission", async () => {
    const chain = buildMockChain();
    const lines: string[] = [];
    await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
      log: (line) => lines.push(line),
    });
    expect(lines.some((l) => l.includes("awaiting confirmation"))).toBe(true);
  });

  it("calls log with 'confirmed' as the final progress line", async () => {
    const chain = buildMockChain();
    const lines: string[] = [];
    await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
      log: (line) => lines.push(line),
    });
    expect(lines.some((l) => l.includes("confirmed"))).toBe(true);
  });

  it("log lines arrive in order: 'posting advert' → 'submitted tx' → 'awaiting confirmation' → 'confirmed'", async () => {
    const chain = buildMockChain();
    const lines: string[] = [];
    await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
      log: (line) => lines.push(line),
    });
    const idxPosting = lines.findIndex((l) => l.includes("posting advert"));
    const idxSubmitted = lines.findIndex((l) => l.includes("submitted tx"));
    const idxAwaiting = lines.findIndex((l) => l.includes("awaiting confirmation"));
    const idxConfirmed = lines.findIndex((l) => l.includes("confirmed"));
    expect(idxPosting).toBeGreaterThanOrEqual(0);
    expect(idxSubmitted).toBeGreaterThan(idxPosting);
    expect(idxAwaiting).toBeGreaterThan(idxSubmitted);
    expect(idxConfirmed).toBeGreaterThan(idxAwaiting);
  });

  it("defaults to console.log when log is not supplied", async () => {
    const chain = buildMockChain();
    const spy = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
    try {
      await runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: buildCliAdvertDatum(),
        // no log param — should default to console.log
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── awaitTimeoutMs default ───────────────────────────────────────────────────

describe("runPostAdvert() — awaitTimeoutMs default", () => {
  it("passes 120_000 as the timeout when awaitTimeoutMs is not supplied", async () => {
    const chain = buildMockChain();
    let capturedTimeout = -1;
    const originalAwait = chain.awaitTx.bind(chain);
    chain.awaitTx = async (txHash: string, timeoutMs: number): Promise<void> => {
      capturedTimeout = timeoutMs;
      return originalAwait(txHash, timeoutMs);
    };
    await runPostAdvert({
      chain,
      walletKey: buildSupplierWalletKey(),
      advertDatum: buildCliAdvertDatum(),
    });
    expect(capturedTimeout).toBe(120_000);
  });
});
