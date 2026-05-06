/**
 * tests/fixtures/buyer-side/sample-task-records.ts
 *
 * Independently-built TaskRecord[] for buyer-side history tests.
 * MUST NOT import from supplier-side fixtures or shared fixture helpers.
 * ARCHITECTURE.md §7.2: "buyer and supplier tests each build datums independently".
 */

import type { TaskRecord } from "../../../buyer/src/sdk/types.js";

// ─── Fixture constants ─────────────────────────────────────────────────────

/** Buyer PKH used in these fixtures — matches buyer-side wallet-keys.ts. */
const BUYER_PKH_FIXTURE = "1234567890abcdef1234567890abcdef1234567890abcdef12345678";

/** Supplier PKH for fixture records — different from buyer per spec invariant 4. */
const SUPPLIER_PKH_FIXTURE = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01";

/** Deterministic escrow refs for fixture tasks. */
const ESCROW_TX_A = "a".repeat(64);
const ESCROW_TX_B = "b".repeat(64);
const ESCROW_TX_C = "c".repeat(64);
const ESCROW_TX_D = "d".repeat(64);

/** Deterministic receipt data for completed tasks. */
const PROMPT_HASH_A = "1".repeat(64);
const RESPONSE_HASH_A = "2".repeat(64);

// ─── Sample records ────────────────────────────────────────────────────────

/**
 * A completed task — has receipt and response.
 */
export const TASK_COMPLETED: TaskRecord = {
  escrow_ref: `${ESCROW_TX_A}#0`,
  supplier_pkh: SUPPLIER_PKH_FIXTURE,
  capability_id: "llm.text.generate.v1",
  prompt_preview: "What is 2+2?",
  posted_at: 1_745_500_000_000,
  status: "completed",
  response: "2 + 2 = 4.",
  receipt: {
    prompt_hash: PROMPT_HASH_A,
    response_hash: RESPONSE_HASH_A,
    model: "qwen2.5:0.5b",
    prompt_tokens: 12,
    completion_tokens: 8,
    wallclock_ms: 1200,
    supplier_pkh: SUPPLIER_PKH_FIXTURE,
    escrow_ref: `${ESCROW_TX_A}#0`,
  },
  receipt_signature: "e".repeat(128),
};

/**
 * A failed task — has failure_reason, no receipt.
 */
export const TASK_FAILED: TaskRecord = {
  escrow_ref: `${ESCROW_TX_B}#0`,
  supplier_pkh: SUPPLIER_PKH_FIXTURE,
  capability_id: "llm.text.generate.v1",
  prompt_preview: "Tell me a story.",
  posted_at: 1_745_500_010_000,
  status: "failed",
  failure_reason: "supplier_5xx",
};

/**
 * A pending task — not yet resolved.
 */
export const TASK_PENDING: TaskRecord = {
  escrow_ref: `${ESCROW_TX_C}#0`,
  supplier_pkh: SUPPLIER_PKH_FIXTURE,
  capability_id: "llm.text.generate.v1",
  prompt_preview: "Translate hello to Spanish.",
  posted_at: 1_745_500_020_000,
  status: "pending",
};

/**
 * A reclaimed task — buyer reclaimed after deliver_by.
 */
export const TASK_RECLAIMED: TaskRecord = {
  escrow_ref: `${ESCROW_TX_D}#0`,
  supplier_pkh: SUPPLIER_PKH_FIXTURE,
  capability_id: "llm.text.generate.v1",
  prompt_preview: "Summarise this document.",
  posted_at: 1_745_400_000_000,
  status: "reclaimed",
};

/**
 * All sample records in spec-natural insertion order (oldest first).
 * NOTE: getTaskHistory() returns them posted_at DESCENDING — tests must account for this.
 */
export const ALL_SAMPLE_TASK_RECORDS: TaskRecord[] = [
  TASK_RECLAIMED,
  TASK_COMPLETED,
  TASK_FAILED,
  TASK_PENDING,
];

/**
 * A second completed task with a DIFFERENT supplier PKH — used for supplier filter tests.
 */
export const TASK_COMPLETED_OTHER_SUPPLIER: TaskRecord = {
  escrow_ref: `${"f".repeat(64)}#0`,
  supplier_pkh: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba98",
  capability_id: "llm.text.generate.v1",
  prompt_preview: "Other supplier task.",
  posted_at: 1_745_500_005_000,
  status: "completed",
  response: "Response from other supplier.",
  receipt: {
    prompt_hash: "3".repeat(64),
    response_hash: "4".repeat(64),
    model: "qwen2.5:0.5b",
    prompt_tokens: 8,
    completion_tokens: 5,
    wallclock_ms: 900,
    supplier_pkh: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba98",
    escrow_ref: `${"f".repeat(64)}#0`,
  },
  receipt_signature: "7".repeat(128),
};

// Suppress unused variable warning (BUYER_PKH_FIXTURE is documentation-only here).
void BUYER_PKH_FIXTURE;
