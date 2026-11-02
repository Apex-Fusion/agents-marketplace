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
 *      hash of the signed receipt we hold.
 *   2. Fallback follows the indexer's exact spend-linked lineage from the
 *      original ref. The candidate is still verified from live chain state.
 *
 * Timestamp and lone-Submitted guesses are intentionally forbidden. Multiple
 * concurrent escrows can share a buyer and posted_at, so either guess can pay
 * for another request.
 *
 * acceptResult/reclaim on the SDK are fire-and-forget; here we buildAcceptTx /
 * buildReclaimTx and AWAIT confirmation so a returned success means settled.
 *
 * Both escrow layouts (Part 2 §9.6 drain): the datum decides. The builders
 * spend a legacy (14-field) escrow at the legacy script and a new (16-field)
 * escrow at the new script. A new escrow with `refund` set returns its funds
 * to refund.address, and anybody may submit its Reclaim. RefundRevoked
 * (new escrow only) returns the whole escrow when the agent is revoked or
 * retired (onchain/records.ts).
 */

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import { decodeAnyEscrowDatum } from "@marketplace/shared/cbor";
import type { RecordLookup, WalletKey } from "@marketplace/shared/tx";
import { buildAcceptTx, buildReclaimTx, buildRefundRevokedTx } from "@marketplace/shared/tx";
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
  buyer_pkh?: string;
  supplier_pkh?: string;
  advert_ref?: string;
  capability_id?: string;
  request_spec_hash?: string;
  prompt_hash?: string;
  payment_lovelace?: string;
  buyer_bond_lovelace?: string;
  supplier_bond_lovelace?: string;
  submitted_at?: number | null;
  result_receipt_hash?: string | null;
  created_slot?: number;
  spent_tx?: string | null;
  /** Datum layout; absent from an indexer without identity support (legacy). */
  layout?: "legacy" | "identity";
  /** 64 lowercase hex for a new escrow, null for a legacy escrow. */
  agent_id?: string | null;
  /** Where buyer payouts go (bech32 address, inline datum CBOR); null: the buyer key. */
  refund?: { address: string; datum: string | null } | null;
  /** false when payment + bonds exceed 10,000 AP3X (F-29): only Reclaim after deliver_by returns it. */
  routable?: boolean;
}

export interface EscrowLineageRow extends EscrowRow {
  spent_tx: string | null;
}

export type EscrowTerminalType = "AcceptEscrow" | "ReclaimEscrow" | "ReleaseEscrow" | "RefundRevokedEscrow";

/** Reclaim and RefundRevoked return the escrow to the buyer; Accept and Release pay the supplier. */
export function isRefundTerminal(type: EscrowTerminalType): boolean {
  return type === "ReclaimEscrow" || type === "RefundRevokedEscrow";
}

export interface EscrowLineage {
  original_ref: string;
  rows: EscrowLineageRow[];
  terminal: { type: EscrowTerminalType; tx_hash: string } | null;
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

function isEscrowLineageRow(value: unknown): value is EscrowLineageRow {
  if (typeof value !== "object" || value === null) return false;
  return (
    "utxo_ref" in value &&
    typeof value.utxo_ref === "string" &&
    "state" in value &&
    typeof value.state === "string" &&
    "posted_at" in value &&
    typeof value.posted_at === "number" &&
    "spent_tx" in value &&
    (typeof value.spent_tx === "string" || value.spent_tx === null)
  );
}

function isEscrowTerminal(
  value: unknown,
): value is { type: EscrowTerminalType; tx_hash: string } {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("type" in value) ||
    !("tx_hash" in value) ||
    typeof value.tx_hash !== "string"
  ) {
    return false;
  }
  return (
    value.type === "AcceptEscrow" ||
    value.type === "ReclaimEscrow" ||
    value.type === "ReleaseEscrow" ||
    value.type === "RefundRevokedEscrow"
  );
}

export async function fetchEscrowLineage(
  indexerUrl: string,
  originalRef: string,
  fetchFn: typeof globalThis.fetch,
): Promise<EscrowLineage | null> {
  const res = await fetchFn(
    `${indexerUrl}/escrows/${encodeURIComponent(originalRef)}/lineage`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer escrow lineage returned ${res.status}`);
  const body = (await res.json()) as unknown;
  if (
    typeof body !== "object" ||
    body === null ||
    !("original_ref" in body) ||
    typeof body.original_ref !== "string" ||
    body.original_ref !== originalRef ||
    !("rows" in body) ||
    !("terminal" in body)
  ) {
    throw new Error("indexer escrow lineage returned an invalid response");
  }
  const rows = body.rows;
  const terminal = body.terminal;
  if (
    !Array.isArray(rows) ||
    !rows.every(isEscrowLineageRow) ||
    (terminal !== null && !isEscrowTerminal(terminal))
  ) {
    throw new Error("indexer escrow lineage returned an invalid response");
  }
  return { original_ref: body.original_ref, rows, terminal };
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
 * to the expected receipt. Any lookup or decode failure counts as unverified. */
async function hintVerified(
  chain: ChainProvider,
  buyerPkh: string,
  hint: SubmittedHint,
  expectedReceiptHash?: string,
): Promise<boolean> {
  try {
    const receiptHash = expectedReceiptHash ?? hint.resultReceiptHash;
    if (hint.resultReceiptHash !== receiptHash) return false;
    const utxo = await chain.queryUtxo(hint.ref);
    if (!utxo?.datumHex) return false;
    const { datum } = decodeAnyEscrowDatum(utxo.datumHex);
    return (
      datum.state === "Submitted" &&
      datum.buyer_pkh === buyerPkh &&
      datum.result_receipt_hash === receiptHash
    );
  } catch {
    return false;
  }
}

async function lineageSubmittedVerified(
  chain: ChainProvider,
  buyerPkh: string,
  row: EscrowLineageRow,
  expectedReceiptHash?: string,
): Promise<boolean> {
  try {
    if (row.state !== "Submitted" || row.spent_tx !== null) return false;
    const receiptHash = expectedReceiptHash ?? row.result_receipt_hash;
    if (!receiptHash) return false;
    const ref = refOrThrow(row.utxo_ref);
    const utxo = await chain.queryUtxo(ref);
    if (!utxo?.datumHex) return false;
    const { datum } = decodeAnyEscrowDatum(utxo.datumHex);
    return (
      datum.state === "Submitted" &&
      datum.buyer_pkh === buyerPkh &&
      datum.result_receipt_hash === receiptHash
    );
  } catch {
    return false;
  }
}

/** Resolve the current Submitted UTxO of our in-flight escrow: the verified
 * supplier hint when there is one, else its exact spend-linked lineage. */
export async function resolveSubmittedRef(opts: {
  chain: ChainProvider;
  indexerUrl: string;
  buyerPkh: string;
  originalRefStr: string;
  hint?: SubmittedHint;
  receiptHash?: string;
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<OutputReference> {
  if (opts.hint) {
    if (
      await hintVerified(
        opts.chain,
        opts.buyerPkh,
        opts.hint,
        opts.receiptHash,
      )
    ) {
      return opts.hint.ref;
    }
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
      const lineage = await fetchEscrowLineage(
        opts.indexerUrl,
        opts.originalRefStr,
        fetchFn,
      );
      const current = lineage?.rows.at(-1);
      if (
        current &&
        await lineageSubmittedVerified(
          opts.chain,
          opts.buyerPkh,
          current,
          opts.receiptHash,
        )
      ) {
        return refOrThrow(current.utxo_ref);
      }
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

/** Build + submit + await a Reclaim tx (Open/Claimed → Reclaimed). For a new
 * escrow with `refund` set, the builder needs no buyer signature. */
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

/** Build + submit + await a RefundRevoked tx (new escrow, terminal): the whole
 * escrow goes to the buyer because the agent is revoked or retired. */
export async function refundRevokedAndConfirm(
  chain: ChainProvider,
  walletKey: WalletKey,
  escrowRef: OutputReference,
  lookupRecord: RecordLookup,
  awaitTimeoutMs = ACCEPT_CONFIRM_TIMEOUT_MS,
): Promise<string> {
  const built = await buildRefundRevokedTx({ chain, walletKey, escrowRef, lookupRecord });
  await chain.awaitTx(built.expectedTxHash, awaitTimeoutMs);
  return built.expectedTxHash;
}
