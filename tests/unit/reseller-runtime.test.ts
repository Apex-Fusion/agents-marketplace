/**
 * reseller-runtime.test.ts — the money decision of ResellerRuntime.
 *
 * `recordOutput` stores the upstream cost of a job: the request price, plus the prompt price for each prompt token, plus the
 * completion price for each completion token, unless the caller gives the cost. A failing database makes the runtime report
 * `offline`, so that the supplier takes no job that it cannot record. A fake store and a fake provider feed the real runtime and the
 * real capacity gate. No database runs.
 */

import { expect, it, vi } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { CapacityGate } from "../../supplier/src/reseller/capacityGate.js";
import type { RecordedOutput, ResellerEvidenceStore } from "../../supplier/src/reseller/evidenceStore.js";
import type { CapacityProvider } from "../../supplier/src/reseller/provider.js";
import { ResellerRuntime } from "../../supplier/src/reseller/runtime.js";
import { SupplierState } from "../../supplier/src/state.js";
import { buildCliAdvertDatum } from "../fixtures/supplier-side/sample-advert-datum.js";

/** The prices in USD nanos: 1,000 for a request, 80 for a prompt token, 160 for a completion token. */
const provider: CapacityProvider = {
  id: "openrouter",
  readCapacity: async () => ({
    provider: "openrouter", keyLimitUsdNanos: 10_000_000_000n, keyRemainingUsdNanos: 10_000_000_000n, limitReset: null, checkedAtMs: 1_000,
    pricing: { model: "provider/model", promptUsdNanosPerToken: 80n, completionUsdNanosPerToken: 160n, requestUsdNanos: 1_000n, fetchedAtMs: 1_000 },
  }),
};

it("stores the cost that the gate prices unless the caller gives one, and goes offline when the database fails", async () => {
  const recordOutput = vi.fn(async (_escrowRef: string, _output: RecordedOutput): Promise<void> => undefined);
  const store = { ping: async () => undefined, saveCapacity: async () => undefined, recordOutput } as unknown as ResellerEvidenceStore;
  const gate = new CapacityGate({
    provider, model: "provider/model", reserveUsd: "0", maxInputTokens: 100, maxOutputTokens: 10, staleAfterMs: 5_000, now: () => 1_000,
  });
  const runtime = new ResellerRuntime({
    chain: new MockChainProvider(), state: new SupplierState(), gate, store, advert: buildCliAdvertDatum(),
    advertRef: { txHash: "b".repeat(64), index: 0 }, providerModel: "provider/model", pollIntervalMs: 60_000, maxInputTokens: 100,
  });
  await runtime.refreshCapacity();
  expect(runtime.effectiveStatus()).toBe("free");

  // Without a cost from the caller (undefined or null), 7 prompt tokens and 3 completion tokens cost 1,000 + 80 × 7 + 160 × 3.
  // A cost from the caller wins, also when it is 0.
  const output = { response: {}, receipt: {}, promptTokens: 7, completionTokens: 3, outputText: "ok" };
  for (const actualCostUsdNanos of [undefined, null, 700n, 0n]) await runtime.recordOutput("e#0", { ...output, actualCostUsdNanos });
  expect(recordOutput.mock.calls.map(([, recorded]) => recorded.actualCostUsdNanos)).toEqual([2_040n, 2_040n, 700n, 0n]);

  recordOutput.mockRejectedValueOnce(new Error("connection lost"));
  await expect(runtime.recordOutput("e#0", output)).rejects.toThrow("connection lost");
  expect(runtime.effectiveStatus()).toBe("offline");
  expect(runtime.capacitySnapshot()).toMatchObject({ canServe: false, reason: "database_unavailable", error: "connection lost" });
});
