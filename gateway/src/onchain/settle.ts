/**
 * gateway/src/onchain/settle.ts — settlement + recovery helpers.
 *
 * submitPrompt returns the ORIGINAL Open escrow ref, but the supplier's
 * Claim→Submit moves the live escrow to a NEW ref. To Accept (settle) we must
 * find the current Submitted ref. Two sources, in order:
 *
 *   1. The supplier's done payload carries `submitted_ref` (the Submit tx
 *      output). We verify it from chain state alone: the UTxO must be a
 *      Submitted escrow of this wallet whose result_receipt_hash equals the
 *      hash of the signed receipt we hold — Submit binds that hash on chain,
 *      so a supplier cannot point us at a different escrow.
 *   2. Fallback (older suppliers, or a hint that fails verification): poll the
 *      indexer (mirrors buyer /v1/accept: match the lineage by posted_at).
 *      Because the per-key mutex serializes a wallet's escrows, at settle time
 *      the wallet has at most one in-flight escrow, so a lone Submitted row is
 *      unambiguously ours. The indexer lags the chain by up to minutes under
 *      load (2026-09-05: a 60 s poll gave up on a paid, submitted job), so the
 *      fallback budget is generous; the accept window is 600 s from
 *      submitted_at and the Accept itself needs ACCEPT_CONFIRM_TIMEOUT_MS.
 *
 * acceptResult/reclaim on the SDK are fire-and-forget; here we buildAcceptTx /
 * buildReclaimTx and AWAIT confirmation so a returned success means settled.
 */

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import { decodeEscrowDatum } from "@marketplace/shared/cbor";
import type { WalletKey } from "@marketplace/shared/tx";
import { buildAcceptTx, buildReclaimTx } from "@marketplace/shared/tx";
import { submitBudgetMs } from "@marketplace/buyer/sdk";
import { parseRef } from "../routing/selectSupplier.js";
import { GatewayError } from "../openai/errors.js";

/** Indexer poll budget for the Submitted ref when no verifiable hint exists. */
export const RESOLVE_SUBMITTED_TIMEOUT_MS = 180_000;
/** awaitTx budget for the Accept / Reclaim tx. */
export const ACCEPT_CONFIRM_TIMEOUT_MS = 120_000;
/** Candidate busy checks, preflight and tx build before the escrow posts. */
const PRE_POST_SLACK_MS = 60_000;
/** Post-settle wallet re-shape: one consolidate tx build + confirmation. */
const WALLET_HEALTH_SLACK_MS = 150_000;

/**
 * Worst-case wall clock for one escrow-backed job against an advert with the
 * given SLA, end to end: pre-post checks, the SDK's submit budget (escrow
 * confirmation + the supplier's window), Submitted-ref resolution, Accept
 * confirmation and the wallet re-shape. Sizes the per-key mutex deadline so a
 * slow-but-legitimate job is never abandoned mid-settle (2026-09-07: the flat
 * 180 s deadline cut an OCR job that then Accepted as a zombie — the caller
 * got a 502 for a job it paid for).
 */
export function oneShotBudgetMs(maxProcessingMs: number): number {
  return (
    PRE_POST_SLACK_MS +
    submitBudgetMs(maxProcessingMs) +
    RESOLVE_SUBMITTED_TIMEOUT_MS +
    ACCEPT_CONFIRM_TIMEOUT_MS +
    WALLET_HEALTH_SLACK_MS
  );
}

export interface EscrowRow {
  utxo_ref: string;
  state: string;
  posted_at: number;
  /** Validator reclaim floor (indexer serves it; absent on very old rows). */
  deliver_by?: number;
}

export async function fetchEscrows(
  indexerUrl: string,
  buyerPkh: string,
  fetchFn: typeof globalThis.fetch,
): Promise<EscrowRow[]> {
  const res = await fetchFn(`${indexerUrl}/escrows?buyer=${buyerPkh}`);
  if (!res.ok) throw new Error(`indexer /escrows returned ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("indexer /escrows did not return an array");
  return body as EscrowRow[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The Submitted UTxO a supplier reported on its done payload, plus what its
 * datum must commit to for us to trust it. */
export interface SubmittedHint {
  ref: OutputReference;
  /** receiptResultHash(signed receipt) — the value Submit bound on chain. */
  resultReceiptHash: string;
}

/** True when the hinted UTxO is a live Submitted escrow of this wallet bound
 * to our receipt. Any lookup or decode failure counts as unverified. */
async function hintVerified(chain: ChainProvider, buyerPkh: string, hint: SubmittedHint): Promise<boolean> {
  try {
    const utxo = await chain.queryUtxo(hint.ref);
    if (!utxo?.datumHex) return false;
    const datum = decodeEscrowDatum(utxo.datumHex);
    return (
      datum.state === "Submitted" &&
      datum.buyer_pkh === buyerPkh &&
      datum.result_receipt_hash === hint.resultReceiptHash
    );
  } catch {
    return false;
  }
}

/** Resolve the current Submitted UTxO of our in-flight escrow: the verified
 * supplier hint when there is one, else poll the indexer. */
export async function resolveSubmittedRef(opts: {
  chain: ChainProvider;
  indexerUrl: string;
  buyerPkh: string;
  originalRefStr: string;
  hint?: SubmittedHint;
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<OutputReference> {
  if (opts.hint) {
    if (await hintVerified(opts.chain, opts.buyerPkh, opts.hint)) return opts.hint.ref;
    // eslint-disable-next-line no-console
    console.warn(
      `[gateway] supplier submitted_ref ${opts.hint.ref.txHash}#${opts.hint.ref.index} for ${opts.originalRefStr} did not verify on chain; falling back to the indexer`,
    );
  }

  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? RESOLVE_SUBMITTED_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  let lastErr: unknown;
  for (;;) {
    try {
      const rows = await fetchEscrows(opts.indexerUrl, opts.buyerPkh, fetchFn);

      // 1. Direct: the original ref already shows Submitted.
      const direct = rows.find((r) => r.utxo_ref === opts.originalRefStr && r.state === "Submitted");
      if (direct) return refOrThrow(direct.utxo_ref);

      // 2. Lineage: find the original row to read posted_at, then the Submitted
      //    row sharing it (the validator preserves posted_at across states).
      const lineage = rows.find((r) => r.utxo_ref === opts.originalRefStr);
      if (lineage) {
        const submitted = rows.find((r) => r.posted_at === lineage.posted_at && r.state === "Submitted");
        if (submitted) return refOrThrow(submitted.utxo_ref);
      }

      // 3. Fallback: the mutex guarantees ≤1 in-flight escrow for this wallet,
      //    so a single Submitted row is ours.
      const submittedRows = rows.filter((r) => r.state === "Submitted");
      if (submittedRows.length === 1) return refOrThrow(submittedRows[0].utxo_ref);
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw new GatewayError(
        502,
        "server_error",
        "escrow_settle_failed",
        `could not resolve Submitted escrow within ${timeoutMs}ms${lastErr ? `: ${String(lastErr)}` : ""}`,
      );
    }
    await sleep(intervalMs);
  }
}

function refOrThrow(refStr: string): OutputReference {
  const ref = parseRef(refStr);
  if (!ref) {
    throw new GatewayError(502, "server_error", "escrow_settle_failed", `bad escrow ref ${refStr}`);
  }
  return ref;
}

/** Build + submit + await the Accept tx (Submitted → Accepted, terminal). */
export async function acceptAndConfirm(
  chain: ChainProvider,
  walletKey: WalletKey,
  escrowRef: OutputReference,
  awaitTimeoutMs = ACCEPT_CONFIRM_TIMEOUT_MS,
): Promise<string> {
  const built = await buildAcceptTx({ chain, buyerKey: walletKey, escrowRef });
  await chain.awaitTx(built.expectedTxHash, awaitTimeoutMs);
  return built.expectedTxHash;
}

/** Build + submit + await a Reclaim tx (Open/Claimed → Reclaimed). */
export async function reclaimAndConfirm(
  chain: ChainProvider,
  walletKey: WalletKey,
  escrowRef: OutputReference,
  awaitTimeoutMs = ACCEPT_CONFIRM_TIMEOUT_MS,
): Promise<string> {
  const built = await buildReclaimTx({ chain, buyerKey: walletKey, escrowRef });
  await chain.awaitTx(built.expectedTxHash, awaitTimeoutMs);
  return built.expectedTxHash;
}
