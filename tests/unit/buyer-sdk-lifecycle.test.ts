/**
 * buyer-sdk-lifecycle.test.ts — RED phase (M1-E)
 *
 * Category F: SDK — Marketplace lifecycle (~5 tests)
 *
 * All tests FAIL until M1-E-green.
 */

import { describe, it, expect, vi } from "vitest";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import type { ProgressEvent } from "../../buyer/src/sdk/types.js";

function makeMp() {
  return new Marketplace({
    chain: new MockChainProvider(),
    indexerUrl: "http://indexer.test",
    walletKey: buildBuyerWalletKey(),
    networkParams: { networkId: 0 },
  });
}

describe("Marketplace lifecycle", () => {
  it("new Marketplace(...) constructs synchronously without any network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const mp = new Marketplace({
      chain: new MockChainProvider(),
      indexerUrl: "http://indexer.test",
      walletKey: buildBuyerWalletKey(),
      networkParams: { networkId: 0 },
    });
    expect(mp).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("marketplace.on('progress', listener) receives progress events emitted via emitProgress", () => {
    const mp = makeMp();
    const received: ProgressEvent[] = [];
    mp.on("progress", (e) => received.push(e));
    mp.emitProgress({ type: "escrow_posted", escrow_ref: "x".repeat(64) + "#0" });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("escrow_posted");
  });

  it("marketplace.off('progress', listener) stops receiving events", () => {
    const mp = makeMp();
    const received: ProgressEvent[] = [];
    const listener = (e: ProgressEvent) => received.push(e);
    mp.on("progress", listener);
    mp.emitProgress({ type: "escrow_posted" });
    mp.off("progress", listener);
    mp.emitProgress({ type: "supplier_called" });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("escrow_posted");
  });

  it("marketplace.close() does not throw (no-op in v1)", () => {
    const mp = makeMp();
    expect(() => mp.close()).not.toThrow();
  });

  it("multiple listeners can be registered for 'progress'", () => {
    const mp = makeMp();
    const received1: string[] = [];
    const received2: string[] = [];
    mp.on("progress", (e) => received1.push(e.type));
    mp.on("progress", (e) => received2.push(e.type));
    mp.emitProgress({ type: "receipt_verified" });
    expect(received1).toEqual(["receipt_verified"]);
    expect(received2).toEqual(["receipt_verified"]);
  });
});
