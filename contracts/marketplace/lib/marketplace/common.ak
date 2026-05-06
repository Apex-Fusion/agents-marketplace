//// Shared helpers for the AdvertScript and EscrowScript validators.
////
//// Conventions:
////   - All time values are POSIX milliseconds (matches TS `POSIXTime`).
////   - All "must be signed by X" checks compare a `VerificationKeyHash`
////     against `tx.extra_signatories`. We do NOT inspect input owners; the
////     ledger ensures `extra_signatories` carries the witness keys.
////   - Time-bound checks are conservative: we require the worst-case
////     boundary of the validity range to satisfy the rule, so the script
////     cannot be tricked by a wide validity window.

use aiken/interval.{
  Finite, Interval, IntervalBound, NegativeInfinity, PositiveInfinity,
}
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{Output, ValidityRange}

/// 10 minutes in milliseconds. The buyer has this long after the supplier's
/// `submitted_at` to call `Accept`; after the window the supplier may
/// `Release` and walk away with the buyer bond. ARCHITECTURE.md §4.3.
pub const accept_window_ms: Int = 600_000

// ─── Signer checks ───────────────────────────────────────────────────

/// True iff `signer` appears in the transaction's required signers list.
pub fn signed_by(extra_signatories: List<VerificationKeyHash>, signer: VerificationKeyHash) -> Bool {
  list_contains_pkh(extra_signatories, signer)
}

fn list_contains_pkh(xs: List<VerificationKeyHash>, target: VerificationKeyHash) -> Bool {
  when xs is {
    [] -> False
    [head, ..tail] ->
      if head == target {
        True
      } else {
        list_contains_pkh(tail, target)
      }
  }
}

// ─── Time-bound checks ───────────────────────────────────────────────

/// True iff every point in the validity range is `<= deadline`.
/// In other words, the upper bound is finite and at most `deadline`.
/// We use the inclusive interpretation: an upper bound of exactly `deadline`
/// is allowed (validity ranges in the ledger have inclusive upper bounds in
/// the common case). This is the rule for `Claim` and `Submit`: the tx must
/// be impossible to drift past `deliver_by`.
pub fn before_or_at(range: ValidityRange, deadline: Int) -> Bool {
  when range.upper_bound.bound_type is {
    Finite(upper) ->
      if range.upper_bound.is_inclusive {
        upper <= deadline
      } else {
        // Exclusive upper bound: any point < upper. We require the strict
        // upper to be at most deadline + 1 (i.e. all points <= deadline).
        upper <= deadline + 1
      }
    NegativeInfinity -> True
    PositiveInfinity -> False
  }
}

/// True iff every point in the validity range is `>= threshold`.
/// Used for `Reclaim` (after `deliver_by`) and `Release` (after
/// `submitted_at + ACCEPT_WINDOW`). We use the inclusive interpretation:
/// a lower bound of exactly `threshold` is allowed.
pub fn after_or_at(range: ValidityRange, threshold: Int) -> Bool {
  when range.lower_bound.bound_type is {
    Finite(lower) ->
      if range.lower_bound.is_inclusive {
        lower >= threshold
      } else {
        // Exclusive lower bound: any point > lower. We require lower >=
        // threshold - 1 (i.e. all points >= threshold).
        lower >= threshold - 1
      }
    PositiveInfinity -> True
    NegativeInfinity -> False
  }
}

/// Pick a representative POSIX timestamp from the validity range to stamp
/// onto an on-chain field (`submitted_at`). We use the **upper bound**: the
/// latest possible time the tx could have been included. Cardano's standard
/// convention. The bound must be finite for this to be meaningful.
pub fn upper_bound_of(range: ValidityRange) -> Option<Int> {
  when range.upper_bound.bound_type is {
    Finite(t) -> Some(t)
    _ -> None
  }
}

// ─── Address / output helpers ────────────────────────────────────────

/// True iff the output's payment credential is a verification-key with the
/// given hash. Used by `RetireAdvert` to ensure the deposit goes back to the
/// supplier's own wallet rather than another script address.
pub fn output_paid_to_pkh(output: Output, pkh: VerificationKeyHash) -> Bool {
  when output.address.payment_credential is {
    VerificationKey(vk) -> vk == pkh
    _ -> False
  }
}

/// True iff the output's payment credential is a script with the given
/// script hash. Used to find the "continuing" output for advert/escrow
/// state transitions.
pub fn output_paid_to_script(output: Output, script_hash: ByteArray) -> Bool {
  when output.address.payment_credential is {
    Script(sh) -> sh == script_hash
    _ -> False
  }
}

/// True iff the output's payment credential equals the given Credential.
/// More flexible than `output_paid_to_script` when callers already have a
/// `Credential` (e.g. taken from the script's own input).
pub fn output_paid_to_credential(output: Output, credential: Credential) -> Bool {
  output.address.payment_credential == credential
}

/// Sum of lovelace across all outputs paying to the given pkh address
/// (verification-key payment credential, any/no stake credential).
pub fn lovelace_paid_to_pkh(outputs: List<Output>, pkh: VerificationKeyHash) -> Int {
  sum_lovelace_to_pkh(outputs, pkh, 0)
}

fn sum_lovelace_to_pkh(outputs: List<Output>, pkh: VerificationKeyHash, acc: Int) -> Int {
  when outputs is {
    [] -> acc
    [head, ..tail] ->
      if output_paid_to_pkh(head, pkh) {
        sum_lovelace_to_pkh(tail, pkh, acc + assets.lovelace_of(head.value))
      } else {
        sum_lovelace_to_pkh(tail, pkh, acc)
      }
  }
}

/// Total lovelace across all outputs paid to the given Credential.
pub fn lovelace_paid_to_credential(outputs: List<Output>, credential: Credential) -> Int {
  sum_lovelace_to_credential(outputs, credential, 0)
}

fn sum_lovelace_to_credential(outputs: List<Output>, credential: Credential, acc: Int) -> Int {
  when outputs is {
    [] -> acc
    [head, ..tail] ->
      if output_paid_to_credential(head, credential) {
        sum_lovelace_to_credential(tail, credential, acc + assets.lovelace_of(head.value))
      } else {
        sum_lovelace_to_credential(tail, credential, acc)
      }
  }
}

/// Find the unique output paying to the given Credential. `fail`s if there
/// is not exactly one. Use this to locate the "continuing" UTxO for the
/// advert/escrow validator's same-address rebind.
pub fn unique_output_to_credential(outputs: List<Output>, credential: Credential) -> Output {
  let matches =
    list_filter_outputs_to_credential(outputs, credential, [])
  when matches is {
    [single] -> single
    _ -> fail @"expected exactly one continuing output to script address"
  }
}

fn list_filter_outputs_to_credential(
  outputs: List<Output>,
  credential: Credential,
  acc: List<Output>,
) -> List<Output> {
  when outputs is {
    [] -> reverse_list(acc, [])
    [head, ..tail] ->
      if output_paid_to_credential(head, credential) {
        list_filter_outputs_to_credential(tail, credential, [head, ..acc])
      } else {
        list_filter_outputs_to_credential(tail, credential, acc)
      }
  }
}

fn reverse_list(xs: List<Output>, acc: List<Output>) -> List<Output> {
  when xs is {
    [] -> acc
    [head, ..tail] -> reverse_list(tail, [head, ..acc])
  }
}

// ─── Value comparison helpers ────────────────────────────────────────

/// True iff two values carry the same lovelace AND the same non-ADA assets.
/// Used to enforce "value preserved" on Claim and Submit transitions.
pub fn value_equal(a: Value, b: Value) -> Bool {
  a == b
}
