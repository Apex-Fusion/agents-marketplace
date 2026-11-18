/**
 * supplier-wallet-health-empty-address.test.ts — a supplier whose wallet address is empty.
 *
 * SUPPLIER_ADDRESS has no default, and the supplier reads an unset value as the empty text. The wallet health of the supplier (a
 * timer, and a trigger after a failed Claim) builds a transaction that pays this address when the wallet needs a new shape. The empty
 * text is refused before Lucid reads it (checkedAddressText). The health writes one line, stops, and tries no more: the refusal costs
 * nothing, and no path starts again in a tight loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { SupplierState } from "../../supplier/src/state.js";
import { _resetWalletHealthForTests, startWalletHealthTicker, triggerOnFailureConsolidate, type ConsolidateFn } from "../../supplier/src/walletHealth.js";

const key = { address: "", pubKeyHash: "1".repeat(56), pubKeyHex: "2".repeat(64), privateKeyHex: "3".repeat(64) };

describe("supplier wallet health with an empty wallet address", () => {
  let state: SupplierState;
  beforeEach(() => {
    vi.useFakeTimers();
    state = new SupplierState();
  });
  afterEach(() => {
    _resetWalletHealthForTests(state);
    vi.useRealTimers();
  });

  it("writes one line and builds nothing more: not on the next ticks, not on a trigger after a failed Claim", async () => {
    const consolidate = vi.fn(async () => {
      throw new TxConstructionError("address_empty", "the wallet address is empty");
    });
    const lines: string[] = [];
    const ticker = startWalletHealthTicker(
      { chain: {} as never, state, supplierKey: key, consolidate: consolidate as unknown as ConsolidateFn },
      { intervalMs: 1000, log: (line) => lines.push(line) },
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.startsWith("HALT:"))).toHaveLength(1);
    expect(lines.join("\n")).toContain("the wallet address is empty");

    await vi.advanceTimersByTimeAsync(60_000);
    triggerOnFailureConsolidate({ chain: {} as never, state, supplierKey: key, consolidate: consolidate as unknown as ConsolidateFn }, { log: (line) => lines.push(line) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.startsWith("HALT:"))).toHaveLength(1);
    ticker.stop();
  });

  it("an error of another kind is logged at each tick as before, and does not halt", async () => {
    const consolidate = vi.fn(async () => {
      throw new Error("balance too low");
    });
    const lines: string[] = [];
    const ticker = startWalletHealthTicker(
      { chain: {} as never, state, supplierKey: key, consolidate: consolidate as unknown as ConsolidateFn },
      { intervalMs: 1000, log: (line) => lines.push(line) },
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(consolidate).toHaveBeenCalledTimes(3);
    expect(lines.filter((line) => line.startsWith("consolidate failed:"))).toHaveLength(3);
    ticker.stop();
  });
});
