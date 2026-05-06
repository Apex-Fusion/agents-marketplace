//// Datum schemas for the Local Agents Marketplace.
////
//// On-chain encoding mirrors `packages/shared/src/cbor/types.ts`:
////   - Records serialize as Plutus `Constr0` (CBOR tag 121) with fields in
////     declaration order.
////   - Sum-type variants are tagged 121, 122, ... in declaration order, so
////     **declaration order is load-bearing**.
////   - `Option<T>` is the stdlib `Option`; `Some(v)` = tag 121 [v],
////     `None` = tag 122 []. (Stdlib re-exports it from `aiken/option`.)
////   - `OutputReference` from `cardano/transaction` is `Constr0[bytes, int]`
////     (`transaction_id`, `output_index`), matching the TS encoder's
////     `Constr0[txHash, index]`.
////
//// Cross-reference: `docs/ARCHITECTURE.md` §4.1, §4.2.

use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{OutputReference}

/// AdvertStatus mirrors the TS literal type:
///   Active  -> Constr 121 []
///   Retired -> Constr 122 []
/// Declaration order MUST stay Active, then Retired.
pub type AdvertStatus {
  Active
  Retired
}

/// EscrowState mirrors the TS string-union, tag layout 121..126:
///   Open=121, Claimed=122, Submitted=123,
///   Accepted=124, Reclaimed=125, Released=126
/// Declaration order MUST match this exact sequence — it is checked against
/// `STATE_TAGS` in `packages/shared/src/cbor/EscrowDatum.ts`.
pub type EscrowState {
  Open
  Claimed
  Submitted
  Accepted
  Reclaimed
  Released
}

/// AdvertDatum — ARCHITECTURE.md §4.1. 13 fields, declaration order matches
/// the TS encoder in `packages/shared/src/cbor/AdvertDatum.ts`.
///
///   0  supplier_pkh            ByteArray(28)
///   1  capability_id           ByteArray (UTF-8)
///   2  model                   ByteArray (UTF-8)
///   3  max_output_tokens       Int
///   4  max_processing_ms       Int
///   5  price_lovelace          Int
///   6  supplier_bond_lovelace  Int
///   7  buyer_bond_lovelace     Int
///   8  endpoint_url            ByteArray (UTF-8)
///   9  detail_uri              ByteArray (UTF-8)
///   10 detail_hash             ByteArray(32)
///   11 advertised_at           Int (POSIX ms)
///   12 status                  AdvertStatus
pub type AdvertDatum {
  supplier_pkh: VerificationKeyHash,
  capability_id: ByteArray,
  model: ByteArray,
  max_output_tokens: Int,
  max_processing_ms: Int,
  price_lovelace: Int,
  supplier_bond_lovelace: Int,
  buyer_bond_lovelace: Int,
  endpoint_url: ByteArray,
  detail_uri: ByteArray,
  detail_hash: ByteArray,
  advertised_at: Int,
  status: AdvertStatus,
}

/// EscrowDatum — ARCHITECTURE.md §4.2. 14 fields, declaration order matches
/// the TS encoder in `packages/shared/src/cbor/EscrowDatum.ts`.
///
///   0  buyer_pkh               ByteArray(28)
///   1  supplier_pkh            ByteArray(28)
///   2  advert_ref              OutputReference  (Constr0[bytes, int])
///   3  capability_id           ByteArray (UTF-8)
///   4  request_spec_hash       ByteArray(32)
///   5  prompt_hash             ByteArray(32)
///   6  payment_lovelace        Int
///   7  buyer_bond_lovelace     Int
///   8  supplier_bond_lovelace  Int
///   9  deliver_by              Int (POSIX ms)
///   10 posted_at               Int (POSIX ms)
///   11 submitted_at            Option<Int>
///   12 result_receipt_hash     Option<ByteArray>
///   13 state                   EscrowState
pub type EscrowDatum {
  buyer_pkh: VerificationKeyHash,
  supplier_pkh: VerificationKeyHash,
  advert_ref: OutputReference,
  capability_id: ByteArray,
  request_spec_hash: ByteArray,
  prompt_hash: ByteArray,
  payment_lovelace: Int,
  buyer_bond_lovelace: Int,
  supplier_bond_lovelace: Int,
  deliver_by: Int,
  posted_at: Int,
  submitted_at: Option<Int>,
  result_receipt_hash: Option<ByteArray>,
  state: EscrowState,
}

/// AdvertScript redeemer set. Declaration order is informational here — the
/// tx builder constructs the redeemer Data; tags 121/122/123 in declaration
/// order match the M1-B encoder.
pub type AdvertRedeemer {
  PostAdvert
  UpdateAdvert
  RetireAdvert
}

/// EscrowScript redeemer set. Tags 121..125 in declaration order:
///   Claim=121, Submit=122, Accept=123, Reclaim=124, Release=125.
/// `Submit` carries the receipt-hash payload chosen by the supplier; the
/// validator binds it into `result_receipt_hash` of the new datum.
pub type EscrowRedeemer {
  Claim
  Submit { receipt_hash: ByteArray }
  Accept
  Reclaim
  Release
}
