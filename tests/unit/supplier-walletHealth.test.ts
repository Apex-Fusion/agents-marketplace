/**
 * supplier-walletHealth.test.ts — Tests for the periodic + on-failure
 * wallet auto-consolidation hooks.
 *
 * Coverage:
 *   - Ticker calls consolidate when idle, logs already-healthy
 *   - Ticker skips when the supplier state is busy
 *   - Ticker releases the lock around runConsolidateWallet (success + failure)
 *   - On-failure trigger fires consolidate the first time
 *   - On-failure trigger debounces back-to-back invocations
 *   - On-failure trigger respects the state lock
 *
 * The consolidate function is injected via deps so the test never touches
 * a real Ogmios.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { SupplierState } from "../../supplier/src/state.js";
import {
  startWalletHealthTicker,
  triggerOnFailureConsolidate,
  _resetWalletHealthForTests,
  type ConsolidateFn,
} from "../../supplier/src/walletHealth.js";

const FAKE_CHAIN = {} as never;
const FAKE_KEY = {
  privateKeyHex: "0".repeat(64),
  pubKeyHex: "1".repeat(64),
  pubKeyHash: "2".repeat(56),
  address: "addr1_fake",
} as never;
const ESCROW_REF = `${"f".repeat(64)}#0`;

const healthyResult = {
  txHash: null,
  collateralRef: null,
  workingRef: null,
  reason: "already-healthy" as const,
  inputCount: 2,
  totalLovelaceIn: 200_000_000n,
  collateralOutputLovelace: 5_000_000n,
  workingOutputLovelace: 195_000_000n,
};

const consolidatedResult = {
  txHash: "a".repeat(64),
  collateralRef: `${"a".repeat(64)}#0`,
  workingRef: `${"a".repeat(64)}#1`,
  reason: "consolidate" as const,
  inputCount: 14,
  totalLovelaceIn: 328_530_235n,
  collateralOutputLovelace: 5_000_000n,
  workingOutputLovelace: 322_530_235n,
};

describe("walletHealth — ticker", () => {
  let state: SupplierState;
  let logLines: string[];
  let log: (line: string) => void;
  let consolidate: ReturnType<typeof vi.fn> & ConsolidateFn;

  beforeEach(() => {
    vi.useFakeTimers();
    state = new SupplierState();
    _resetWalletHealthForTests(state);
    logLines = [];
    log = (line) => logLines.push(line);
    consolidate = vi.fn() as never;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls consolidate when idle and logs already-healthy", async () => {
    consolidate.mockResolvedValue(healthyResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));

    expect(logLines).toContain("already-healthy");
    expect(state.snapshot().status).toBe("free");

    ticker.stop();
  });

  it("skips when supplier state is busy", async () => {
    state.tryAcquire(ESCROW_REF);
    consolidate.mockResolvedValue(healthyResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(consolidate).not.toHaveBeenCalled();
    expect(logLines).toContain("skip: supplier busy");
    expect(state.snapshot().status).toBe("working");

    ticker.stop();
  });

  it("releases the lock after a successful consolidate", async () => {
    consolidate.mockResolvedValue(consolidatedResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));

    expect(state.snapshot().status).toBe("free");
    expect(logLines.some((l) => l.startsWith("consolidated:"))).toBe(true);

    ticker.stop();
  });

  it("releases the lock when consolidate throws", async () => {
    consolidate.mockRejectedValue(new Error("ogmios unreachable"));

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));

    expect(state.snapshot().status).toBe("free");
    expect(logLines.some((l) => l.includes("consolidate failed"))).toBe(true);

    ticker.stop();
  });

  it("stop() prevents further ticks", async () => {
    consolidate.mockResolvedValue(healthyResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    ticker.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(consolidate).not.toHaveBeenCalled();
  });
});

describe("walletHealth — triggerOnFailureConsolidate", () => {
  let state: SupplierState;
  let logLines: string[];
  let log: (line: string) => void;
  let consolidate: ReturnType<typeof vi.fn> & ConsolidateFn;

  beforeEach(() => {
    state = new SupplierState();
    _resetWalletHealthForTests(state);
    logLines = [];
    log = (line) => logLines.push(line);
    consolidate = vi.fn() as never;
  });

  it("fires consolidate on first call", async () => {
    consolidate.mockResolvedValue(consolidatedResult);

    triggerOnFailureConsolidate(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { log, debounceMs: 60_000 },
    );

    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));
    expect(state.snapshot().status).toBe("free");
  });

  it("debounces back-to-back invocations", async () => {
    consolidate.mockResolvedValue(healthyResult);

    triggerOnFailureConsolidate(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { log, debounceMs: 60_000 },
    );
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));

    triggerOnFailureConsolidate(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { log, debounceMs: 60_000 },
    );
    // No second call — second invocation was inside the debounce window.
    expect(consolidate).toHaveBeenCalledTimes(1);
  });

  it("does not throw when supplier is busy — just skips", async () => {
    state.tryAcquire(ESCROW_REF);
    consolidate.mockResolvedValue(healthyResult);

    expect(() =>
      triggerOnFailureConsolidate(
        { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
        { log, debounceMs: 60_000 },
      ),
    ).not.toThrow();

    await Promise.resolve();
    expect(consolidate).not.toHaveBeenCalled();
    expect(logLines).toContain("skip: supplier busy");
    expect(state.snapshot().status).toBe("working");
  });
});
