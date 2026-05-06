/**
 * Buyer-side escrow UTxO fixtures — M1-B RED phase
 *
 * Builds Utxo objects representing realistic escrow states.
 * Derived INDEPENDENTLY from ARCHITECTURE.md §4.2 and escrow.ak.
 * MUST NOT import from supplier-side fixtures.
 *
 * Three states are provided: Open, Claimed, Submitted.
 * Datum hex is produced using the shared CBOR encoder (same rationale
 * as advert-datum-builders.ts — byte-level machinery, not semantic logic).
 */

import type { Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import { encodeEscrowDatum } from "../../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../../packages/shared/src/cbor/types.js";
import { BUYER_PKH } from "./wallet-keys.js";

// ─── Constants (buyer-side, derived independently from spec) ─────────────────

/** Supplier PKH used in these UTxOs (matches supplier-side fixture identity). */
const ESCROW_SUPPLIER_PKH =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01";

/** The advert UTxO that the escrow spec-locks to. */
const ADVERT_TX_HASH = "b".repeat(64);
const ADVERT_INDEX = 0;

const CAPABILITY_ID = "llm.text.generate.v1";
const REQUEST_SPEC_HASH = "c".repeat(64);
const PROMPT_HASH = "d".repeat(64);
const RECEIPT_HASH = "e".repeat(64);       // 32 bytes, hex

const PAYMENT_LOVELACE = 2_000_000n;
const BUYER_BOND = 1_000_000n;
const SUPPLIER_BOND = 1_000_000n;
const TOTAL_LOCKED = PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND;

// POSTED_AT is set far enough in the future that:
//   - DELIVER_BY > Date.now() at test runtime (avoids "tip >= deliver_by" errors)
//   - SUBMITTED_AT is recent enough that ACCEPT_WINDOW (600_000 ms) hasn't expired
// Using a fixed value 30 days ahead of 2026-04-28 to avoid brittle relative dates.
const POSTED_AT = 1_780_000_000_000;         // 2026-06-25 (well after current date)
const DELIVER_BY = POSTED_AT + 60_000 + 30_000;  // max_processing_ms=60000, network_buffer=30000
const SUBMITTED_AT = POSTED_AT + 50_000;          // within deliver_by window; accept window ends SUBMITTED_AT+600_000

/** The escrow script address on testnet (placeholder — real address from blueprint). */
const ESCROW_SCRIPT_ADDRESS =
  "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";

/** A deterministic tx hash for escrow ref. */
const ESCROW_TX_HASH = "f".repeat(64);

// ─── Base datum ──────────────────────────────────────────────────────────────

function openDatum(): EscrowDatum {
  return {
    buyer_pkh: BUYER_PKH,
    supplier_pkh: ESCROW_SUPPLIER_PKH,
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

// ─── UTxO builders ──────────────────────────────────────────────────────────

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

/** An escrow UTxO in the Open state (buyer posted, waiting for claim). */
export function buildOpenEscrowUtxo(): Utxo {
  return buildEscrowUtxo(openDatum(), 0);
}

/** An escrow UTxO in the Claimed state (supplier claimed, processing). */
export function buildClaimedEscrowUtxo(): Utxo {
  return buildEscrowUtxo(claimedDatum(), 1);
}

/** An escrow UTxO in the Submitted state (supplier submitted receipt). */
export function buildSubmittedEscrowUtxo(): Utxo {
  return buildEscrowUtxo(submittedDatum(), 2);
}

/** The datum for the Open escrow (decoded form, for assertion convenience). */
export function openEscrowDatum(): EscrowDatum {
  return openDatum();
}

/** The datum for the Claimed escrow. */
export function claimedEscrowDatum(): EscrowDatum {
  return claimedDatum();
}

/** The datum for the Submitted escrow. */
export function submittedEscrowDatum(): EscrowDatum {
  return submittedDatum();
}

/** SUBMITTED_AT — used in accept/release window boundary tests. */
export { SUBMITTED_AT, DELIVER_BY, TOTAL_LOCKED, PAYMENT_LOVELACE, BUYER_BOND, SUPPLIER_BOND, ESCROW_SUPPLIER_PKH };
