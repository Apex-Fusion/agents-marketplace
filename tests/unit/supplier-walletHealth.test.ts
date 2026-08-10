/**
 * supplier-walletHealth.test.ts — Tests for the periodic + on-failure
 * wallet auto-consolidation hooks.
 *
 * Coverage:
 *   - Ticker calls consolidate when idle, logs already-healthy
 *   - Consolidation runs even while session slots are held (wallet ops don't
 *     consume session slots) but queues behind a held walletMutex
 *   - Failure paths never leave the walletMutex poisoned
 *   - On-failure trigger fires consolidate the first time
 *   - On-failure trigger debounces back-to-back invocations
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

  it("runs even while a session slot is held (wallet ops don't consume slots)", async () => {
    state.tryAcquire(ESCROW_REF);
    consolidate.mockResolvedValue(healthyResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));

    // The held session slot is untouched.
    expect(state.snapshot().status).toBe("working");
    expect(state.snapshot().activeEscrowRefs).toEqual([ESCROW_REF]);

    ticker.stop();
  });

  it("queues behind a held walletMutex instead of racing it", async () => {
    consolidate.mockResolvedValue(healthyResult);
    let releaseChainOp: () => void = () => undefined;
    const chainOp = state.walletMutex.run(
      () => new Promise<void>((resolve) => { releaseChainOp = resolve; }),
    );

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    // The mutex is held by the fake chain op — consolidate must wait.
    expect(consolidate).not.toHaveBeenCalled();

    releaseChainOp();
    await chainOp;
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));

    ticker.stop();
  });

  it("logs success after a real consolidate", async () => {
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

  it("does not poison the walletMutex when consolidate throws", async () => {
    consolidate.mockRejectedValue(new Error("ogmios unreachable"));

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));

    expect(logLines.some((l) => l.includes("consolidate failed"))).toBe(true);
    // The mutex still serves the next wallet op.
    expect(await state.walletMutex.run(async () => "ok")).toBe("ok");

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

  it("runs even when session slots are held (queues on the wallet mutex)", async () => {
    state.tryAcquire(ESCROW_REF);
    consolidate.mockResolvedValue(healthyResult);

    expect(() =>
      triggerOnFailureConsolidate(
        { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
        { log, debounceMs: 60_000 },
      ),
    ).not.toThrow();

    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(1));
    // The held session slot is untouched.
    expect(state.snapshot().status).toBe("working");
  });
});

describe("walletHealth — F7 circuit breakers", () => {
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

  it("halts after 3 consecutive consolidations that never reach healthy", async () => {
    // The 2026-08-07 pump: every tick consolidates, none lands healthy.
    consolidate.mockResolvedValue(consolidatedResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(3));
    expect(logLines.some((l) => l.includes("HALT") && l.includes("consecutive"))).toBe(true);

    // Two more ticks: the breaker holds, no further txs.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(consolidate).toHaveBeenCalledTimes(3);

    ticker.stop();
  });

  it("an already-healthy result resets the consecutive counter", async () => {
    consolidate
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValueOnce(healthyResult)
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValue(healthyResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    // 6 ticks: c,c,h,c,c,h — never 3 consecutive, so never halted.
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(6));
    expect(logLines.some((l) => l.includes("HALT"))).toBe(false);

    ticker.stop();
  });

  it("halts when the 24h consolidation budget is exhausted", async () => {
    // Interleave healthy results so the consecutive guard never fires:
    // c,c,h,c,c,h,c,c -> 6 consolidations inside the window at tick 8.
    consolidate
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValueOnce(healthyResult)
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValueOnce(healthyResult)
      .mockResolvedValue(consolidatedResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    await vi.advanceTimersByTimeAsync(8_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(8));
    expect(logLines.some((l) => l.includes("HALT") && l.includes("budget"))).toBe(true);

    // Breaker holds on subsequent ticks.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(consolidate).toHaveBeenCalledTimes(8);

    ticker.stop();
  });

  it("failed consolidations neither trip nor reset the breakers", async () => {
    // Errors spend no fee: they must not count as consolidations, but they
    // must not clear the consecutive count either.
    consolidate
      .mockResolvedValueOnce(consolidatedResult)
      .mockResolvedValueOnce(consolidatedResult)
      .mockRejectedValueOnce(new Error("balance too low to consolidate"))
      .mockResolvedValue(consolidatedResult);

    const ticker = startWalletHealthTicker(
      { chain: FAKE_CHAIN, state, supplierKey: FAKE_KEY, consolidate },
      { intervalMs: 1_000, log },
    );

    // c,c,error,c -> the 4th call is the 3rd consecutive consolidation.
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(consolidate).toHaveBeenCalledTimes(4));
    expect(logLines.some((l) => l.includes("HALT") && l.includes("consecutive"))).toBe(true);

    ticker.stop();
  });
});
