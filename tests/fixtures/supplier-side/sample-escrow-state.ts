/**
 * Supplier-side escrow UTxO fixtures — M1-C RED phase
 *
 * Builds Utxo objects for mock-chain injection in supplier route tests.
 * Built INDEPENDENTLY from buyer-side fixtures. No shared helpers.
 *
 * Key design choices:
 *   - SUPPLIER_PKH matches the supplier wallet key fixture so supplier_pkh === self checks pass.
 *   - request_spec_hash and prompt_hash are pre-computed from known test inputs so
 *     route handler validation tests can construct matching request bodies.
 *   - All hashes are deterministic 64-char hex strings.
 */

import type { Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import { encodeEscrowDatum } from "../../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../../packages/shared/src/cbor/types.js";
import { SUPPLIER_PKH } from "./wallet-keys.js";

// ─── Constants (supplier-side, derived independently from spec) ──────────────

/** Buyer PKH used in these UTxOs (distinct from supplier). */
export const BUYER_PKH = "1234567890abcdef1234567890abcdef1234567890abcdef12345678";

/** The advert UTxO the escrow spec-locks to (matches sample-config). */
export const ADVERT_TX_HASH = "b".repeat(64);
export const ADVERT_INDEX = 0;

export const CAPABILITY_ID = "llm.text.generate.v1";

/**
 * REQUEST_SPEC_HASH = sha256(canonical({capability_id, max_output_tokens, model}))
 * Inputs: { capability_id: "llm.text.generate.v1", max_output_tokens: 512, model: "qwen2.5:0.5b" }
 *
 * CATHERINE M1-C-green: replaced Caroline placeholder hashes with computed values
 * matching the on-chain hash convention used by buildPostEscrowTx
 * (sha256(canonical(...)) using packages/shared/src/cbor/canonical.ts JCS subset).
 */
export const REQUEST_SPEC_HASH =
  "fd14d4c9bb9a1dcefa63f9d5581e3adc9a3e2a984e5e762c8e8589fb1bc61d61";

/**
 * PROMPT_HASH = sha256(canonical(TEST_MESSAGES))
 * = sha256(canonical([{role:"user", content:"Hello, who are you?"}]))
 *
 * CATHERINE M1-C-green: replaced Caroline placeholder hashes with computed values
 * matching the on-chain hash convention used by buildPostEscrowTx.
 */
export const PROMPT_HASH =
  "570efb953417ae9974db00aba826e8e67110c26de86a486b1abb196ef7228581";

/** The messages array that corresponds to PROMPT_HASH. */
export const TEST_MESSAGES = [
  { role: "user" as const, content: "Hello, who are you?" },
];

/** Model used in test request bodies. Must match what's in advert. */
export const TEST_MODEL = "qwen2.5:0.5b";
export const TEST_MAX_OUTPUT_TOKENS = 512;

export const PAYMENT_LOVELACE = 2_000_000n;
export const BUYER_BOND = 1_000_000n;
export const SUPPLIER_BOND = 1_000_000n;
export const TOTAL_LOCKED = PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND;

/** POSTED_AT and DELIVER_BY: deliver_by is well in the future relative to test clock. */
export const POSTED_AT = 1_745_500_000_000;
export const DELIVER_BY = POSTED_AT + 90_000; // 90s window — comfortably in the future

export const SUBMITTED_AT = POSTED_AT + 50_000;
export const RECEIPT_HASH = "e".repeat(64);

/** The escrow script address (placeholder). */
export const ESCROW_SCRIPT_ADDRESS =
  "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";

/** Deterministic escrow UTxO tx hash. */
export const ESCROW_TX_HASH = "f".repeat(64);

// ─── Base datum ──────────────────────────────────────────────────────────────

function openDatum(): EscrowDatum {
  return {
    buyer_pkh: BUYER_PKH,
    supplier_pkh: SUPPLIER_PKH,
    advert_ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    capability_id: CAPABILITY_ID,
    request_spec_hash: REQUEST_SPEC_HASH,
    prompt_hash: PROMPT_HASH,
    payment_lovelace: PAYMENT_LOVELACE,
    buyer_bond_lovelace: BUYER_BOND,
    supplier_bond_lovelace: SUPPLIER_BOND,
    deliver_by: DELIVER_BY,
    posted_at: POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };
}

function claimedDatum(): EscrowDatum {
  return { ...openDatum(), state: "Claimed" };
}

function submittedDatum(): EscrowDatum {
  return {
    ...openDatum(),
    state: "Submitted",
    submitted_at: SUBMITTED_AT,
    result_receipt_hash: RECEIPT_HASH,
  };
}

/** Datum from a DIFFERENT supplier — for wrong_supplier tests. */
function wrongSupplierDatum(): EscrowDatum {
  return {
    ...openDatum(),
    supplier_pkh: "9999999999999999999999999999999999999999999999999999999999",
  };
}

/** Datum with a past deliver_by — for past_deliver_by tests. */
function pastDeliverByDatum(): EscrowDatum {
  return { ...openDatum(), deliver_by: POSTED_AT - 1_000 };
}

/** Datum with a mismatched capability_id — for capability_mismatch tests. */
function wrongCapabilityDatum(): EscrowDatum {
  return { ...openDatum(), capability_id: "speech.transcribe.v1" };
}

/** Datum with a mismatched request_spec_hash — for request_spec_mismatch tests. */
function wrongRequestSpecHashDatum(): EscrowDatum {
  return { ...openDatum(), request_spec_hash: "0".repeat(64) };
}

/** Datum with a mismatched prompt_hash — for prompt_mismatch tests. */
function wrongPromptHashDatum(): EscrowDatum {
  return { ...openDatum(), prompt_hash: "1".repeat(64) };
}

// ─── UTxO builder ────────────────────────────────────────────────────────────

function buildEscrowUtxo(datum: EscrowDatum, index: number): Utxo {
  return {
    ref: { txHash: ESCROW_TX_HASH, index },
    address: ESCROW_SCRIPT_ADDRESS,
    lovelace: TOTAL_LOCKED,
    assets: {},
    datumHex: encodeEscrowDatum(datum),
    scriptRef: null,
  };
}

// ─── Exported builders ───────────────────────────────────────────────────────

export function buildOpenEscrowUtxo(): Utxo {
  return buildEscrowUtxo(openDatum(), 0);
}

export function buildClaimedEscrowUtxo(): Utxo {
  return buildEscrowUtxo(claimedDatum(), 1);
}

export function buildSubmittedEscrowUtxo(): Utxo {
  return buildEscrowUtxo(submittedDatum(), 2);
}

export function buildWrongSupplierEscrowUtxo(): Utxo {
  return buildEscrowUtxo(wrongSupplierDatum(), 3);
}

export function buildPastDeliverByEscrowUtxo(): Utxo {
  return buildEscrowUtxo(pastDeliverByDatum(), 4);
}

export function buildWrongCapabilityEscrowUtxo(): Utxo {
  return buildEscrowUtxo(wrongCapabilityDatum(), 5);
}

export function buildWrongRequestSpecHashEscrowUtxo(): Utxo {
  return buildEscrowUtxo(wrongRequestSpecHashDatum(), 6);
}

export function buildWrongPromptHashEscrowUtxo(): Utxo {
  return buildEscrowUtxo(wrongPromptHashDatum(), 7);
}

/** Convenience: the escrow ref for the default Open UTxO. */
export const OPEN_ESCROW_REF = `${ESCROW_TX_HASH}#0`;
