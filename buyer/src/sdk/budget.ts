/**
 * buyer/src/sdk/budget.ts — wall-clock budgets for one escrow-backed job.
 *
 * Every wait in submitPrompt / submitTts / submitOcr derives from the advert's
 * max_processing_ms — the SLA the supplier committed to on chain. The escrow's
 * deliver_by is posted_at + max_processing_ms + NETWORK_BUFFER_MS and the
 * validator lets the supplier Submit right up to it, so a fixed budget shorter
 * than the SLA gives up while the supplier is still inside its window (the
 * 2026-09 Apify OCR outage: a 180 s poll budget against a 300 s advert).
 *
 * The gateway composes submitBudgetMs() with its own settle budgets to size the
 * per-key mutex deadline, so keep the constants here in step with the awaitTx /
 * poll calls in Marketplace.ts.
 */

import { NETWORK_BUFFER_MS } from "@marketplace/shared/tx";

/** awaitTx budget for the PostEscrow tx before the supplier is called. */
export const ESCROW_CONFIRM_TIMEOUT_MS = 120_000;

/** Grace past deliver_by: the supplier's Submit confirmation plus one poll
 * interval. Beyond this the supplier can no longer Submit (validity upper
 * bound ≤ deliver_by) and the escrow is the sweeper's to reclaim. */
export const SUPPLIER_SLACK_MS = 90_000;

/** Floor so a job posted with almost no SLA left still gets one real attempt. */
export const SUPPLIER_MIN_BUDGET_MS = 30_000;

/** Time left to wait on the supplier (initial POST and job polling) for an
 * escrow with the given deliver_by. Absolute: the deadline is
 * deliver_by + SUPPLIER_SLACK_MS regardless of when the wait starts. */
export function supplierBudgetMs(deliverByMs: number, nowMs = Date.now()): number {
  return Math.max(SUPPLIER_MIN_BUDGET_MS, deliverByMs + SUPPLIER_SLACK_MS - nowMs);
}

/** deliver_by the escrow builders stamp for an advert SLA. Used when the
 * datum re-fetch after posting did not return one. */
export function deliverByFor(postedAtMs: number, maxProcessingMs: number): number {
  return postedAtMs + maxProcessingMs + NETWORK_BUFFER_MS;
}

/** Upper bound on one submit* call end to end: escrow confirmation, then the
 * supplier window measured from the post. */
export function submitBudgetMs(maxProcessingMs: number): number {
  return ESCROW_CONFIRM_TIMEOUT_MS + NETWORK_BUFFER_MS + maxProcessingMs + SUPPLIER_SLACK_MS;
}
