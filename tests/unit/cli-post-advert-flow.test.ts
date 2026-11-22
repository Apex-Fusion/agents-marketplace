/**
 * cli-post-advert-flow.test.ts — runPostAdvert(params) of the `tx:post-advert` CLI.
 *
 * Tests the flow logic against MockChainProvider: what it posts, which input it
 * refuses, and how a failure of submitTx or awaitTx surfaces.
 *
 * Spec: supplier/src/cli/postAdvertFlow.ts interface + ARCHITECTURE.md §4.1 / §4.3.
 */

import { describe, it, expect } from "vitest";
import { runPostAdvert } from "../../supplier/src/cli/postAdvertFlow.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import {
  buildCliAdvertDatum,
  VALID_TIP_SLOT,
} from "../fixtures/supplier-side/sample-advert-datum.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

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
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe("runPostAdvert() — refusals", () => {
  // Each row reaches one check. A valid detail_hash has exactly 64 hex chars: the two detail_hash rows
  // are one char too few (odd length) and one byte too many.
  it.each<[string, Partial<AdvertDatum>, RegExp]>([
    ["walletKey.pubKeyHash !== advertDatum.supplier_pkh", { supplier_pkh: "0".repeat(56) }, /^supplier signature mismatch$/],
    ["advertDatum.status === 'Retired'", { status: "Retired" }, /Active/],
    ["endpoint_url is empty", { endpoint_url: "" }, /endpoint_url required/],
    ["detail_hash has 63 chars", { detail_hash: "a".repeat(63) }, /detail_hash must be 32 bytes/],
    ["detail_hash has 66 chars (33 bytes)", { detail_hash: "a".repeat(66) }, /detail_hash must be 32 bytes/],
  ])("throws TxConstructionError when %s", async (_case, overrides, reason) => {
    const chain = buildMockChain();
    let caught: unknown;
    try {
      await runPostAdvert({
        chain,
        walletKey: buildSupplierWalletKey(),
        advertDatum: buildCliAdvertDatum(overrides),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxConstructionError);
    expect((caught as TxConstructionError).reason).toMatch(reason);
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
