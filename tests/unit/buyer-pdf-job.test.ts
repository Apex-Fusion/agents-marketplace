/**
 * buyer-pdf-job.test.ts — the map-reduce orchestrator, exercised with an
 * injected per-call lifecycle (no chain/lucid). Covers the happy path,
 * cost/coverage accounting, SSE done signalling, and the retry→gap policy.
 */

import { describe, it, expect } from "vitest";
import { JobStore, type RunCallFn } from "../../buyer/src/pdf/summarize-job.js";
import { loadPdfCaps } from "../../buyer/src/pdf/caps.js";
import type { Chunk } from "../../buyer/src/pdf/types.js";
import type { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import type { SupplierView } from "../../buyer/src/sdk/types.js";
import type { ChainProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";

function supplierView(model: string, ref: string, price: string): SupplierView {
  return {
    utxo_ref: ref,
    supplier_pkh: `pkh_${model}`,
    capability_id: "llm.text.generate.v1",
    model,
    max_output_tokens: 512,
    max_processing_ms: 60000,
    price_lovelace: price,
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "http://supplier",
    detail_uri: "",
    detail_hash: "",
    advertised_at: 0,
    status: "active",
    advert_status: "Active",
    current_escrow_ref: null,
    last_seen_iso: null,
    created_slot: 0,
  };
}

const MARKETPLACE = {
  discoverSuppliers: async () => [
    supplierView("kimi-k2", `${"a".repeat(64)}#0`, "2000000"),
    supplierView("deepseek", `${"b".repeat(64)}#0`, "3000000"),
  ],
} as unknown as Marketplace;

const WALLET = { address: "addr_test", pubKeyHash: "pkh", pubKeyHex: "", privateKeyHex: "0".repeat(64) } as WalletKey;
const CHAIN = {} as ChainProvider;

function chunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, text: `chunk ${i} text`, tokenEstimate: 5 }));
}

function waitForDone(store: JobStore, job: { subscribe: (f: (frame: string) => void) => () => void }): Promise<void> {
  return new Promise<void>((resolve) => {
    job.subscribe((frame) => {
      if (frame.startsWith("event: done")) resolve();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.start(job as any);
  });
}

describe("JobStore orchestrator", () => {
  it("estimates map + reduce calls", async () => {
    const caps = loadPdfCaps({ PDF_RETRY_K: "1" });
    const store = new JobStore({
      marketplace: MARKETPLACE,
      chain: CHAIN,
      walletKey: WALLET,
      indexerUrl: "http://indexer",
      caps,
      walletBalance: async () => 10_000_000_000n,
    });
    const job = store.createJob("book.pdf", 10, chunks(20));
    const est = await store.estimate(job);
    expect(est.mapCalls).toBe(20);
    expect(est.reduceCalls).toBe(reduceExpected(20, caps.reduceFanin));
    expect(est.no_capable_suppliers).toBe(false);
    expect(est.would_drop_below_floor).toBe(false);
    expect(est.perCallMaxLovelace).toBe("3000000"); // priciest supplier
  });

  it("flags would_drop_below_floor when balance is too low", async () => {
    const caps = loadPdfCaps({ PDF_WALLET_FLOOR_LOVELACE: "50000000" });
    const store = new JobStore({
      marketplace: MARKETPLACE,
      chain: CHAIN,
      walletKey: WALLET,
      indexerUrl: "http://indexer",
      caps,
      walletBalance: async () => 1_000_000n, // basically empty
    });
    const job = store.createJob("book.pdf", 1, chunks(3));
    const est = await store.estimate(job);
    expect(est.would_drop_below_floor).toBe(true);
  });

  it("runs map+reduce to a final summary, accounting cost + escrows", async () => {
    const caps = loadPdfCaps({ PDF_RETRY_K: "1" });
    let n = 0;
    const runCall: RunCallFn = async (sup, prompt) => {
      n += 1;
      return {
        response: `S[${prompt.slice(0, 14)}]`,
        escrowRef: `${"f".repeat(64)}#${n}`,
        supplierPkh: sup.supplierPkh,
        model: sup.model,
        receipt: { supplier_pkh: sup.supplierPkh, model: sup.model },
        receiptSignature: "sig",
      };
    };
    const store = new JobStore({
      marketplace: MARKETPLACE,
      chain: CHAIN,
      walletKey: WALLET,
      indexerUrl: "http://indexer",
      caps,
      runCall,
      walletBalance: async () => 10_000_000_000n,
    });
    const job = store.createJob("book.pdf", 5, chunks(5));
    await waitForDone(store, job);

    expect(job.status).toBe("completed");
    expect(job.coverageDone).toBe(5);
    expect(typeof job.finalSummary).toBe("string");
    expect((job.finalSummary as string).length).toBeGreaterThan(0);
    const expectedCalls = 5 + reduceExpected(5, caps.reduceFanin);
    expect(job.escrowRefs.length).toBe(expectedCalls);
    // round-robin mixes 2M + 3M priced suppliers; cost is the sum actually paid.
    expect(BigInt(job.view().running_cost_lovelace)).toBeGreaterThan(0n);
  });

  it("retries a failing chunk on a different supplier, then marks a gap", async () => {
    const caps = loadPdfCaps({ PDF_RETRY_K: "1" });
    const runCall: RunCallFn = async (sup, prompt) => {
      // chunk index 1 → prompt contains "[chunk 2]" → always fail (both suppliers)
      if (prompt.includes("[chunk 2]")) {
        throw new Error("supplier exploded");
      }
      return {
        response: `S`,
        escrowRef: `${"f".repeat(64)}#${Math.floor(Math.random() * 1e6)}`,
        supplierPkh: sup.supplierPkh,
        model: sup.model,
        receipt: {},
        receiptSignature: "sig",
      };
    };
    const store = new JobStore({
      marketplace: MARKETPLACE,
      chain: CHAIN,
      walletKey: WALLET,
      indexerUrl: "http://indexer",
      caps,
      runCall,
      walletBalance: async () => 10_000_000_000n,
    });
    const job = store.createJob("book.pdf", 3, chunks(3));
    await waitForDone(store, job);

    expect(job.status).toBe("completed_with_gaps");
    expect(job.coverageDone).toBe(2); // chunks 0 and 2 only
    expect(job.failedCount).toBeGreaterThanOrEqual(1);
    expect(job.chunkResults[1].status).toBe("gap");
    expect(typeof job.finalSummary).toBe("string");
  });

  it("fails cleanly when no capable suppliers exist", async () => {
    const emptyMarket = { discoverSuppliers: async () => [] } as unknown as Marketplace;
    const store = new JobStore({
      marketplace: emptyMarket,
      chain: CHAIN,
      walletKey: WALLET,
      indexerUrl: "http://indexer",
      caps: loadPdfCaps({}),
      runCall: async () => {
        throw new Error("should not be called");
      },
      walletBalance: async () => 10_000_000_000n,
    });
    const job = store.createJob("book.pdf", 1, chunks(2));
    await waitForDone(store, job);
    expect(job.status).toBe("failed");
  });
});

/** Mirror of estimate.reduceCallCount for the expected value in assertions. */
function reduceExpected(n: number, fanin: number): number {
  if (n <= 1) return 0;
  let total = 0;
  let level = n;
  while (level > 1) {
    level = Math.ceil(level / fanin);
    total += level;
  }
  return total;
}
