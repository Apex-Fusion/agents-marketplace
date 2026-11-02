//// Rules of the new escrow contract: Part 2 §6.1 of
//// `docs/IDENTITY_REGISTRY.md`. The validator `validators/escrow.ak` passes
//// every spend to `spend`.
////
//// The legacy escrow (`contracts/marketplace/validators/escrow.ak`) is the
//// base. Its states, signers, timing and amounts stay. §6.1 adds:
////
//// - the rules for every redeemer: one script input; no mint, withdrawal,
////   certificate, vote or proposal; a validity range of at most one hour; the
////   supplier and buyer payout rules;
//// - the identity checks of Claim and Submit, and the value cap of Claim;
//// - the exact continuing output of Claim and Submit, which also keeps
////   `agent_id` and `refund`;
//// - Reclaim by anybody when `refund` is set, with a full refund;
//// - the redeemer `RefundRevoked`.
////
//// Accept, Reclaim and Release do not read the identity registry.

use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address
use cardano/transaction.{
  InlineDatum, NoDatum, Output, OutputReference, Transaction,
}
use identity_marketplace/common.{
  Window, accept_window_ms, after_or_at, ap3x_of, ap3x_paid_to_address,
  ap3x_paid_to_address_with_datum, ap3x_paid_to_key, before_or_at,
  count_script_inputs, no_mint_withdrawal_certificate_vote_proposal, signed_by,
  window,
}
use identity_marketplace/types.{
  Accept, Claim, Claimed, EscrowDatum, EscrowRedeemer, Open, Reclaim, Refund,
  RefundRevoked, Release, Submit, Submitted,
}
use vector_identity.{
  active_key, effective, find_record, has_capability, independent,
  purpose_transaction,
}
use vector_identity/types.{EffActive, Retired, Revoked, Status} as identity

/// The most that payment + buyer bond + supplier bond can be for a Claim:
/// 10,000 AP3X, in base units (1 AP3X = 1,000,000).
pub const value_cap: Int = 10_000_000_000

/// The most AP3X that the escrow input can hold for a Claim: 10,005 AP3X.
pub const input_cap: Int = 10_005_000_000

/// Every rule of §6.1 for the spend of the escrow output `own_ref`, whose
/// datum is `datum`. `identity_hash` is the parameter of the escrow script.
pub fn spend(
  identity_hash: ByteArray,
  datum: EscrowDatum,
  redeemer: EscrowRedeemer,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  expect Some(own_input) = transaction.find_input(tx.inputs, own_ref)
  let own = own_input.output
  // Rule 3: `window` fails unless both bounds are finite and
  // `hi - lo <= max_range_ms`. The first check below uses `w`, so the
  // compiler keeps the call before the redeemer branches, and the rule applies
  // to every redeemer.
  let w = window(tx.validity_range)
  and {
    w.lo <= w.hi,
    // Rule 1: the escrow input is the only input whose payment credential is
    // a script.
    count_script_inputs(tx.inputs) == 1,
    // Rule 2.
    no_mint_withdrawal_certificate_vote_proposal(tx),
    when redeemer is {
      Claim -> claim(identity_hash, datum, own, w, tx)
      Submit { receipt_hash } ->
        submit(identity_hash, datum, receipt_hash, own, w, tx)
      Accept -> accept(datum, tx)
      Reclaim -> reclaim(datum, own, tx)
      Release -> release(datum, tx)
      RefundRevoked -> refund_revoked(identity_hash, datum, own, tx)
    },
  }
}

/// Claim (Open to Claimed). `own` is the escrow input and `w` the validity
/// window.
pub fn claim(
  identity_hash: ByteArray,
  datum: EscrowDatum,
  own: Output,
  w: Window,
  tx: Transaction,
) -> Bool {
  let refs = tx.reference_inputs
  when find_record(refs, identity_hash, datum.agent_id) is {
    Some(record) -> and {
        datum.state == Open,
        signed_by(tx.extra_signatories, datum.supplier_pkh),
        before_or_at(tx.validity_range, datum.deliver_by),
        within_cap(datum, own),
        independent(record),
        active_key(record, datum.supplier_pkh, purpose_transaction),
        has_capability(record, datum.capability_id),
        effective(record, refs, identity_hash, w.lo, w.hi) == EffActive,
        continues(own, EscrowDatum { ..datum, state: Claimed }, tx.outputs),
      }
    None -> False
  }
}

/// Submit (Claimed to Submitted). The new datum records `receipt_hash` and
/// `submitted_at = Some(hi)`.
pub fn submit(
  identity_hash: ByteArray,
  datum: EscrowDatum,
  receipt_hash: ByteArray,
  own: Output,
  w: Window,
  tx: Transaction,
) -> Bool {
  let refs = tx.reference_inputs
  when find_record(refs, identity_hash, datum.agent_id) is {
    Some(record) -> and {
        datum.state == Claimed,
        signed_by(tx.extra_signatories, datum.supplier_pkh),
        before_or_at(tx.validity_range, datum.deliver_by),
        bytearray.length(receipt_hash) == 32,
        independent(record),
        active_key(record, datum.supplier_pkh, purpose_transaction),
        effective(record, refs, identity_hash, w.lo, w.hi) == EffActive,
        continues(
          own,
          EscrowDatum {
            ..datum,
            submitted_at: Some(w.hi),
            result_receipt_hash: Some(receipt_hash),
            state: Submitted,
          },
          tx.outputs,
        ),
      }
    None -> False
  }
}

/// Accept (Submitted to Accepted, terminal): the buyer signs within the
/// acceptance window. The supplier gets payment + supplier bond, and the buyer
/// payouts are at least the buyer bond.
pub fn accept(datum: EscrowDatum, tx: Transaction) -> Bool {
  when datum.submitted_at is {
    Some(submitted_at) -> and {
        datum.state == Submitted,
        signed_by(tx.extra_signatories, datum.buyer_pkh),
        before_or_at(tx.validity_range, submitted_at + accept_window_ms),
        supplier_payouts(datum, tx.outputs) >= datum.payment_lovelace + datum.supplier_bond_lovelace,
        buyer_payouts(datum, tx.outputs) >= datum.buyer_bond_lovelace,
      }
    None -> False
  }
}

/// Reclaim (Open or Claimed to Reclaimed, terminal), at or after
/// `deliver_by`. Without `refund`, the buyer signs and the buyer payouts are
/// at least payment + buyer bond + supplier bond. With `refund`, anybody can
/// submit it, and the buyer payouts are a full refund.
pub fn reclaim(datum: EscrowDatum, own: Output, tx: Transaction) -> Bool {
  and {
    datum.state == Open || datum.state == Claimed,
    after_or_at(tx.validity_range, datum.deliver_by),
    when datum.refund is {
      None -> and {
          signed_by(tx.extra_signatories, datum.buyer_pkh),
          buyer_payouts(datum, tx.outputs) >= datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace,
        }
      Some(_) -> buyer_payouts(datum, tx.outputs) >= ap3x_of(own.value)
    },
  }
}

/// Release (Submitted to Released, terminal): the supplier signs after the
/// acceptance window and gets payment + supplier bond + buyer bond.
pub fn release(datum: EscrowDatum, tx: Transaction) -> Bool {
  when datum.submitted_at is {
    Some(submitted_at) -> and {
        datum.state == Submitted,
        signed_by(tx.extra_signatories, datum.supplier_pkh),
        after_or_at(tx.validity_range, submitted_at + accept_window_ms),
        supplier_payouts(datum, tx.outputs) >= datum.payment_lovelace + datum.supplier_bond_lovelace + datum.buyer_bond_lovelace,
      }
    None -> False
  }
}

/// RefundRevoked: anybody, before or after `deliver_by`, when the agent's
/// record allows it (`refund_allowed`). The buyer payouts are a full refund.
pub fn refund_revoked(
  identity_hash: ByteArray,
  datum: EscrowDatum,
  own: Output,
  tx: Transaction,
) -> Bool {
  when find_record(tx.reference_inputs, identity_hash, datum.agent_id) is {
    Some(record) -> and {
        refund_allowed(datum, record.status),
        revoked_buyer_payouts(datum, tx.outputs) >= ap3x_of(own.value),
      }
    None -> False
  }
}

/// The record condition of RefundRevoked, from the status of the agent's
/// record:
///
/// - state Open or Claimed: the record is Revoked or Retired;
/// - state Submitted: the record is Revoked with
///   `invalid_from <= submitted_at`.
pub fn refund_allowed(datum: EscrowDatum, status: Status) -> Bool {
  when datum.state is {
    Open | Claimed ->
      when status is {
        Revoked { .. } | Retired { .. } -> True
        _ -> False
      }
    Submitted ->
      when (status, datum.submitted_at) is {
        (Revoked { invalid_from: Some(invalid_from), .. }, Some(submitted_at)) ->
          invalid_from <= submitted_at
        _ -> False
      }
    _ -> False
  }
}

/// Rule 4: the AP3X in outputs whose payment credential is
/// `VerificationKey(supplier_pkh)`.
pub fn supplier_payouts(datum: EscrowDatum, outputs: List<Output>) -> Int {
  ap3x_paid_to_key(outputs, datum.supplier_pkh)
}

/// Rule 5 for Accept and Reclaim: the AP3X at the refund address with the
/// refund datum when `refund` is set, else the AP3X in outputs whose payment
/// credential is `VerificationKey(buyer_pkh)`.
pub fn buyer_payouts(datum: EscrowDatum, outputs: List<Output>) -> Int {
  when datum.refund is {
    Some(refund) -> refund_payouts(refund, outputs)
    None -> ap3x_paid_to_key(outputs, datum.buyer_pkh)
  }
}

/// Rule 5 for RefundRevoked: as `buyer_payouts`, but without `refund` only
/// outputs at the enterprise address of `buyer_pkh` count.
pub fn revoked_buyer_payouts(datum: EscrowDatum, outputs: List<Output>) -> Int {
  when datum.refund is {
    Some(refund) -> refund_payouts(refund, outputs)
    None ->
      ap3x_paid_to_address(
        outputs,
        address.from_verification_key(datum.buyer_pkh),
      )
  }
}

/// The AP3X in outputs at exactly `refund.address`: with no datum when
/// `refund.datum` is `None`, or with the inline datum `d` when it is
/// `Some(d)`.
fn refund_payouts(refund: Refund, outputs: List<Output>) -> Int {
  let datum =
    when refund.datum is {
      Some(data) -> InlineDatum(data)
      None -> NoDatum
    }
  ap3x_paid_to_address_with_datum(outputs, refund.address, datum)
}

/// The value cap of Claim. Each amount must also be at least 0, so that a
/// negative bond cannot hide a payment above the cap.
fn within_cap(datum: EscrowDatum, own: Output) -> Bool {
  and {
    datum.payment_lovelace >= 0,
    datum.buyer_bond_lovelace >= 0,
    datum.supplier_bond_lovelace >= 0,
    datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace <= value_cap,
    ap3x_of(own.value) <= input_cap,
  }
}

/// The continuing output of Claim and Submit. Exactly one output has the
/// payment credential of the escrow input. That output has no stake
/// credential (so it is at the exact escrow address), the value of the escrow
/// input, no reference script, and the inline datum `expected`.
fn continues(own: Output, expected: EscrowDatum, outputs: List<Output>) -> Bool {
  let credential = own.address.payment_credential
  let continuing =
    list.filter(
      outputs,
      fn(output) { output.address.payment_credential == credential },
    )
  when continuing is {
    [output] -> {
      let expected_data: Data = expected
      and {
        output.address.stake_credential == None,
        output.value == own.value,
        output.reference_script == None,
        output.datum == InlineDatum(expected_data),
      }
    }
    _ -> False
  }
}
