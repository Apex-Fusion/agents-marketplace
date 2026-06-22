/**
 * gateway/src/onchain/settle.ts — settlement + recovery helpers.
 *
 * submitPrompt returns the ORIGINAL Open escrow ref, but the supplier's
 * Claim→Submit moves the live escrow to a NEW ref. To Accept (settle) we must
 * resolve the current Submitted ref via the indexer (mirrors buyer /v1/accept:
 * match the lineage by posted_at). Because the per-key mutex serializes a
 * wallet's escrows, at settle time the wallet has at most one in-flight escrow,
 * so a lone Submitted row is unambiguously ours.
 *
 * acceptResult/reclaim on the SDK are fire-and-forget; here we buildAcceptTx /
 * buildReclaimTx and AWAIT confirmation so a returned success means settled.
 */

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import { buildAcceptTx, buildReclaimTx } from "@marketplace/shared/tx";
import { parseRef } from "../routing/selectSupplier.js";
import { GatewayError } from "../openai/errors.js";

export interface EscrowRow {
  utxo_ref: string;
  state: string;
  posted_at: number;
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

/** Poll the indexer for the current Submitted UTxO of our in-flight escrow. */
export async function resolveSubmittedRef(opts: {
  indexerUrl: string;
  buyerPkh: string;
  originalRefStr: string;
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<OutputReference> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
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
  awaitTimeoutMs = 120_000,
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
  awaitTimeoutMs = 120_000,
): Promise<string> {
  const built = await buildReclaimTx({ chain, buyerKey: walletKey, escrowRef });
  await chain.awaitTx(built.expectedTxHash, awaitTimeoutMs);
  return built.expectedTxHash;
}
