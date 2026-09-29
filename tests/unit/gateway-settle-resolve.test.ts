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
import {
  fetchEscrowLineage,
  resolveSubmittedRef,
  oneShotBudgetMs,
  type EscrowLineage,
} from "../../gateway/src/onchain/settle.js";
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

function chainWith(...utxos: Utxo[]): ChainProvider {
  return {
    queryUtxo: vi.fn(async (ref) => (
      utxos.find((utxo) => (
        utxo.ref.txHash === ref.txHash && utxo.ref.index === ref.index
      )) ?? null
    )),
  } as unknown as ChainProvider;
}

function submittedUtxo(
  txHash: string,
  buyerPkh = BUYER_PKH,
  receiptHash = RECEIPT_HASH,
): Utxo {
  const base = buildSubmittedEscrowUtxo();
  return {
    ...base,
    ref: { txHash, index: 0 },
    datumHex: encodeEscrowDatum({
      ...submittedEscrowDatum(),
      buyer_pkh: buyerPkh,
      result_receipt_hash: receiptHash,
    }),
  };
}

function lineageTo(
  submitted: Utxo,
  receiptHash = RECEIPT_HASH,
): EscrowLineage {
  const submittedRef = `${submitted.ref.txHash}#${submitted.ref.index}`;
  return {
    original_ref: ORIGINAL_REF,
    rows: [
      {
        utxo_ref: ORIGINAL_REF,
        state: "Open",
        posted_at: 1,
        spent_tx: submitted.ref.txHash,
      },
      {
        utxo_ref: submittedRef,
        state: "Submitted",
        posted_at: 1,
        result_receipt_hash: receiptHash,
        spent_tx: null,
      },
    ],
    terminal: null,
  };
}

function indexerWith(lineage: EscrowLineage | null, status = 200) {
  return vi.fn(async () => new Response(
    lineage === null ? JSON.stringify({ error: "escrow not found" }) : JSON.stringify(lineage),
    { status },
  ));
}

describe("fetchEscrowLineage()", () => {

  it("returns null for a missing origin", async () => {
    const fetchFn = indexerWith(null, 404);
    await expect(fetchEscrowLineage(
      "http://indexer.test",
      ORIGINAL_REF,
      fetchFn as unknown as typeof fetch,
    )).resolves.toBeNull();
  });
});

describe("resolveSubmittedRef() — exact lineage", () => {
  it("preserves a supplier hint verified against the expected receipt", async () => {
    const utxo = buildSubmittedEscrowUtxo();
    const fetchFn = indexerWith(null, 404);

    const ref = await resolveSubmittedRef({
      chain: chainWith(utxo),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      hint: { ref: utxo.ref, resultReceiptHash: RECEIPT_HASH },
      receiptHash: RECEIPT_HASH,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 0,
    });

    expect(ref).toEqual(utxo.ref);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back from an invalid hint to the exact indexed lineage", async () => {
    const hinted = submittedUtxo("b".repeat(64), BUYER_PKH, "0".repeat(64));
    const indexed = submittedUtxo("a".repeat(64));
    const fetchFn = indexerWith(lineageTo(indexed));

    const ref = await resolveSubmittedRef({
      chain: chainWith(hinted, indexed),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      hint: { ref: hinted.ref, resultReceiptHash: RECEIPT_HASH },
      receiptHash: RECEIPT_HASH,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 0,
    });

    expect(ref).toEqual(indexed.ref);
  });

  it("selects only the indexed lineage when simultaneous escrows share posted_at", async () => {
    const ours = submittedUtxo("c".repeat(64));
    const other = submittedUtxo("d".repeat(64));
    const fetchFn = indexerWith(lineageTo(ours));

    const ref = await resolveSubmittedRef({
      chain: chainWith(ours, other),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      receiptHash: RECEIPT_HASH,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 0,
    });

    expect(ref).toEqual(ours.ref);
  });

  it("rejects a lineage output whose live datum has the wrong owner", async () => {
    const foreign = submittedUtxo("e".repeat(64), "1".repeat(56));
    const fetchFn = indexerWith(lineageTo(foreign));

    await expect(resolveSubmittedRef({
      chain: chainWith(foreign),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      receiptHash: RECEIPT_HASH,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 0,
    })).rejects.toMatchObject({ code: "escrow_settle_failed" });
  });

  it("rejects a lineage output whose live datum has the wrong receipt", async () => {
    const wrongReceipt = "0".repeat(64);
    const submitted = submittedUtxo("e".repeat(64), BUYER_PKH, wrongReceipt);
    const fetchFn = indexerWith(lineageTo(submitted, wrongReceipt));

    await expect(resolveSubmittedRef({
      chain: chainWith(submitted),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      receiptHash: RECEIPT_HASH,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 0,
    })).rejects.toMatchObject({ code: "escrow_settle_failed" });
  });

  it("rejects a lineage output that has already been spent", async () => {
    const submitted = submittedUtxo("e".repeat(64));
    const fetchFn = indexerWith(lineageTo(submitted));

    await expect(resolveSubmittedRef({
      chain: chainWith(),
      indexerUrl: "http://indexer.test",
      buyerPkh: BUYER_PKH,
      originalRefStr: ORIGINAL_REF,
      receiptHash: RECEIPT_HASH,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 0,
    })).rejects.toMatchObject({ code: "escrow_settle_failed" });
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
