/**
 * gateway-settle-resolve.test.ts — resolveSubmittedRef() trusts chain state
 * before the indexer.
 *
 * 2026-09-05: a paid, Submitted OCR job failed with "could not resolve
 * Submitted escrow within 60000ms" because the settle path only knew the
 * indexer, which lagged the chain. The supplier's done payload names the
 * Submitted UTxO; the gateway must accept that hint when the on-chain datum
 * is a Submitted escrow of this wallet bound to our signed receipt, and must
 * fall back to the indexer when the hint does not verify.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveSubmittedRef, oneShotBudgetMs } from "../../gateway/src/onchain/settle.js";
import { Mutex } from "../../gateway/src/sdk/registry.js";
import { submitBudgetMs } from "../../buyer/src/sdk/budget.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { ChainProvider, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import {
  buildSubmittedEscrowUtxo,
  submittedEscrowDatum,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";
import { BUYER_PKH } from "../fixtures/buyer-side/wallet-keys.js";

const ORIGINAL_REF = `${"f".repeat(64)}#0`;
const RECEIPT_HASH = submittedEscrowDatum().result_receipt_hash as string;

function chainWith(utxo: Utxo | null): ChainProvider {
  return { queryUtxo: vi.fn(async () => utxo) } as unknown as ChainProvider;
}

/** An indexer that only ever knows the Submitted row (never called on the hint path). */
function indexerWith(rows: unknown[]) {
  return vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
}

describe("resolveSubmittedRef() — supplier hint", () => {
  it("returns a hint whose on-chain datum is our Submitted escrow bound to our receipt, without the indexer", async () => {
    const utxo = buildSubmittedEscrowUtxo();
    const fetchFn = indexerWith([]);

    const ref = await resolveSubmittedRef({
      chain: chainWith(utxo),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      hint: { ref: utxo.ref, resultReceiptHash: RECEIPT_HASH },
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 10,
    });

    expect(ref).toEqual(utxo.ref);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to the indexer when the hinted datum commits to a different receipt", async () => {
    const utxo = buildSubmittedEscrowUtxo();
    const indexed = `${"a".repeat(64)}#0`;
    const fetchFn = indexerWith([{ utxo_ref: indexed, state: "Submitted", posted_at: 1 }]);

    const ref = await resolveSubmittedRef({
      chain: chainWith(utxo),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      hint: { ref: utxo.ref, resultReceiptHash: "0".repeat(64) },
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 10,
      intervalMs: 1,
    });

    expect(ref).toEqual({ txHash: "a".repeat(64), index: 0 });
    expect(fetchFn).toHaveBeenCalled();
  });

  it("falls back to the indexer when the hinted UTxO belongs to another buyer", async () => {
    const foreign: Utxo = {
      ...buildSubmittedEscrowUtxo(),
      datumHex: encodeEscrowDatum({ ...submittedEscrowDatum(), buyer_pkh: "1".repeat(56) }),
    };
    const fetchFn = indexerWith([{ utxo_ref: ORIGINAL_REF, state: "Submitted", posted_at: 1 }]);

    const ref = await resolveSubmittedRef({
      chain: chainWith(foreign),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      hint: { ref: foreign.ref, resultReceiptHash: RECEIPT_HASH },
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 10,
      intervalMs: 1,
    });

    expect(ref).toEqual({ txHash: "f".repeat(64), index: 0 });
  });

  it("falls back to the indexer when the hinted UTxO is already spent", async () => {
    const fetchFn = indexerWith([{ utxo_ref: ORIGINAL_REF, state: "Submitted", posted_at: 1 }]);

    const ref = await resolveSubmittedRef({
      chain: chainWith(null),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      hint: { ref: { txHash: "c".repeat(64), index: 0 }, resultReceiptHash: RECEIPT_HASH },
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 10,
      intervalMs: 1,
    });

    expect(ref).toEqual({ txHash: "f".repeat(64), index: 0 });
  });
});

describe("one-shot run deadline", () => {
  it("covers the SDK's whole supplier window for the advert SLA", () => {
    // The mutex deadline must outlast every budget inside the run, or the run
    // is abandoned mid-settle and its zombie pays for a job the caller was
    // told failed (2026-09-07).
    expect(oneShotBudgetMs(300_000)).toBeGreaterThan(submitBudgetMs(300_000) + 120_000);
  });

  it("Mutex.run honours a per-run deadline longer than the mutex default", async () => {
    vi.useFakeTimers();
    try {
      const mutex = new Mutex({ timeoutMs: 1_000 });
      const slow = mutex.run(
        () => new Promise<string>((resolve) => setTimeout(() => resolve("settled"), 3_000)),
        "ocr",
        5_000,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(slow).resolves.toBe("settled");
    } finally {
      vi.useRealTimers();
    }
  });
});
