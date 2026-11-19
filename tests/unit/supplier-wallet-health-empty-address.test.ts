/**
 * supplier-wallet-health-empty-address.test.ts — a supplier whose wallet address is refused before Lucid reads it.
 *
 * SUPPLIER_ADDRESS has no default, and the supplier reads an unset value as the empty text. The wallet health of the supplier (a
 * timer, and a trigger after a failed Claim) builds a transaction that pays this address when the wallet needs a new shape. An
 * address that is empty, too long, or not a payment address is refused before Lucid reads it (checkedShelleyAddress). The same
 * address gives the same refusal at each try, so the health writes one line, stops, and tries no more: the refusal costs nothing,
 * and no path starts again in a tight loop. A TxConstructionError of another reason does not stop it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { SupplierState } from "../../supplier/src/state.js";
import { _resetWalletHealthForTests, startWalletHealthTicker, triggerOnFailureConsolidate, type ConsolidateFn } from "../../supplier/src/walletHealth.js";

const key = { address: "", pubKeyHash: "1".repeat(56), pubKeyHex: "2".repeat(64), privateKeyHex: "3".repeat(64) };

describe("supplier wallet health with a wallet address that is refused", () => {
  let state: SupplierState;
  beforeEach(() => {
    vi.useFakeTimers();
    state = new SupplierState();
  });
  afterEach(() => {
    _resetWalletHealthForTests(state);
    vi.useRealTimers();
  });

  it.each([
    ["address_empty", "the wallet address is empty"],
    ["address_too_long", "the wallet address is 2000 characters long"],
    ["address_invalid", "the wallet address is not a Cardano payment address"],
  ])("%s: writes one line and builds nothing more, not on the next ticks and not on a trigger after a failed Claim", async (reason, message) => {
    const consolidate = vi.fn(async () => {
      throw new TxConstructionError(reason, message);
    });
    const lines: string[] = [];
    const ticker = startWalletHealthTicker(
      { chain: {} as never, state, supplierKey: key, consolidate: consolidate as unknown as ConsolidateFn },
      { intervalMs: 1000, log: (line) => lines.push(line) },
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.startsWith("HALT:"))).toHaveLength(1);
    expect(lines.join("\n")).toContain(message);

    await vi.advanceTimersByTimeAsync(60_000);
    triggerOnFailureConsolidate({ chain: {} as never, state, supplierKey: key, consolidate: consolidate as unknown as ConsolidateFn }, { log: (line) => lines.push(line) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.startsWith("HALT:"))).toHaveLength(1);
    ticker.stop();
  });

  it.each([
    ["a TxConstructionError of another reason", () => new TxConstructionError("insufficient_funds", "balance too low")],
    ["a TxConstructionError with a reason that only starts like an address reason", () => new TxConstructionError("address_empty_again", "another text")],
    ["an error that is not a TxConstructionError, with an address reason", () => Object.assign(new Error("address_empty"), { reason: "address_empty" })],
    ["an error of another kind", () => new Error("balance too low")],
  ])("%s: is logged at each tick as before, and does not halt", async (_name, makeError) => {
    const consolidate = vi.fn(async () => {
      throw makeError();
    });
    const lines: string[] = [];
    const ticker = startWalletHealthTicker(
      { chain: {} as never, state, supplierKey: key, consolidate: consolidate as unknown as ConsolidateFn },
      { intervalMs: 1000, log: (line) => lines.push(line) },
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(consolidate).toHaveBeenCalledTimes(3);
    expect(lines.filter((line) => line.startsWith("consolidate failed:"))).toHaveLength(3);
    expect(lines.some((line) => line.startsWith("HALT:"))).toBe(false);
    ticker.stop();
  });
});
