//// EscrowScript — happy-path bonded escrow.
////
//// ARCHITECTURE.md §4.2 + §4.3. State machine:
////
////                                Reclaim (after deliver_by)
////                                  ┌──────────────────────┐
////                                  ▼                      │
////                              ┌───────┐                  │
////                              │ Open  │ ── Claim ──┐     │
////                              └───────┘            ▼     │
////                                  │           ┌─────────┐│
////                                  │           │ Claimed │┘
////                                  │           └────┬────┘
////                                  └────► Reclaim   │ Submit
////                                  (after deliver_by)
////                                                   ▼
////                                            ┌───────────┐
////                                            │ Submitted │
////                                            └─────┬─────┘
////                                  Accept (buyer)  │   Release (after window)
////                                  ▼                ▼
////                              ┌──────────┐    ┌──────────┐
////                              │ Accepted │    │ Released │
////                              └──────────┘    └──────────┘
////
//// Terminal states: Accepted, Reclaimed, Released. The validator never
//// sees a transition out of a terminal state because there's nothing to
//// re-bind: the funds have left the script address. Each transition rule
//// is implemented as a small pure function below; the spend handler is
//// just a router.
////
//// `advert_ref` is a SPEC-LOCK field — for v1 the validator does not
//// dereference or verify it points at a real Active advert. The TS-side
//// tx builder (M1-B) is responsible for ensuring `advert_ref` is real and
//// pricing matches. We do, however, propagate `advert_ref` through every
//// state transition by requiring the new datum to copy it unchanged. That
//// way the spec-lock is preserved end-to-end on-chain.

use aiken/interval.{Finite, Interval, IntervalBound}
use aiken/primitive/bytearray
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, find_input,
}
use marketplace/common.{
  accept_window_ms, after_or_at, before_or_at, lovelace_paid_to_pkh, signed_by,
  unique_output_to_credential, upper_bound_of, value_equal,
}
use marketplace/types.{
  Accept, Claim, Claimed, EscrowDatum, EscrowRedeemer, Open, Reclaim, Release,
  Submit, Submitted,
}

validator escrow {
  spend(
    datum: Option<EscrowDatum>,
    redeemer: EscrowRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(old_datum) = datum

    when redeemer is {
      Claim -> handle_claim(old_datum, own_ref, self)
      Submit { receipt_hash } -> handle_submit(old_datum, own_ref, receipt_hash, self)
      Accept -> handle_accept(old_datum, self)
      Reclaim -> handle_reclaim(old_datum, self)
      Release -> handle_release(old_datum, self)
    }
  }
}

// ─── Common: same-script-address rebind ──────────────────────────────

/// Resolve "the same script address as my own input" and locate the unique
/// continuing output. Returns (continuing_output, new_datum_parsed).
fn resolve_continuing(
  own_ref: OutputReference,
  self: Transaction,
) -> (Output, EscrowDatum) {
  expect Some(own_input) = find_input(self.inputs, own_ref)
  let own_credential = own_input.output.address.payment_credential
  let continuing = unique_output_to_credential(self.outputs, own_credential)
  expect new_datum: EscrowDatum = inline_datum_of(continuing)
  (continuing, new_datum)
}

fn own_input_value(own_ref: OutputReference, self: Transaction) -> Value {
  expect Some(own_input) = find_input(self.inputs, own_ref)
  own_input.output.value
}

fn inline_datum_of(output: Output) -> Data {
  when output.datum is {
    InlineDatum(d) -> d
    _ -> fail @"continuing escrow output must carry an inline datum"
  }
}

// ─── Claim (Open → Claimed) ──────────────────────────────────────────

fn handle_claim(
  old_datum: EscrowDatum,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  let (continuing, new_datum) = resolve_continuing(own_ref, self)
  let in_value = own_input_value(own_ref, self)

  let signer_ok = signed_by(self.extra_signatories, old_datum.supplier_pkh)
  let state_ok = old_datum.state == Open
  let new_state_ok = new_datum.state == Claimed
  let value_ok = value_equal(continuing.value, in_value)
  let datum_unchanged_apart_from_state =
    expect_unchanged_modulo_state(old_datum, new_datum)
  let deadline_ok = before_or_at(self.validity_range, old_datum.deliver_by)

  signer_ok && state_ok && new_state_ok && value_ok && datum_unchanged_apart_from_state && deadline_ok
}

// ─── Submit (Claimed → Submitted) ────────────────────────────────────

fn handle_submit(
  old_datum: EscrowDatum,
  own_ref: OutputReference,
  receipt_hash: ByteArray,
  self: Transaction,
) -> Bool {
  let (continuing, new_datum) = resolve_continuing(own_ref, self)
  let in_value = own_input_value(own_ref, self)

  // Validity-range upper bound serves as the canonical submission stamp.
  expect Some(stamp) = upper_bound_of(self.validity_range)

  let signer_ok = signed_by(self.extra_signatories, old_datum.supplier_pkh)
  let state_ok = old_datum.state == Claimed
  let new_state_ok = new_datum.state == Submitted
  let value_ok = value_equal(continuing.value, in_value)
  let receipt_hash_ok =
    new_datum.result_receipt_hash == Some(receipt_hash) && bytearray_len(
      receipt_hash,
    ) == 32
  let stamp_ok = new_datum.submitted_at == Some(stamp)
  let deadline_ok = before_or_at(self.validity_range, old_datum.deliver_by)
  let datum_invariants =
    expect_unchanged_modulo_submit(old_datum, new_datum)

  signer_ok && state_ok && new_state_ok && value_ok && receipt_hash_ok && stamp_ok && deadline_ok && datum_invariants
}

// ─── Accept (Submitted → Accepted, terminal) ─────────────────────────

fn handle_accept(old_datum: EscrowDatum, self: Transaction) -> Bool {
  let signer_ok = signed_by(self.extra_signatories, old_datum.buyer_pkh)
  let state_ok = old_datum.state == Submitted

  // Distribution rule:
  //   supplier receives payment + supplier_bond
  //   buyer    receives buyer_bond
  let supplier_due = old_datum.payment_lovelace + old_datum.supplier_bond_lovelace
  let buyer_due = old_datum.buyer_bond_lovelace
  let supplier_received =
    lovelace_paid_to_pkh(self.outputs, old_datum.supplier_pkh)
  let buyer_received = lovelace_paid_to_pkh(self.outputs, old_datum.buyer_pkh)
  let distribution_ok =
    supplier_received >= supplier_due && buyer_received >= buyer_due

  // Time rule: accept must occur within the window from submitted_at.
  expect Some(submitted_at) = old_datum.submitted_at
  let deadline = submitted_at + accept_window_ms
  let window_ok = before_or_at(self.validity_range, deadline)

  signer_ok && state_ok && distribution_ok && window_ok
}

// ─── Reclaim (Open|Claimed → Reclaimed, terminal) ────────────────────

fn handle_reclaim(old_datum: EscrowDatum, self: Transaction) -> Bool {
  let signer_ok = signed_by(self.extra_signatories, old_datum.buyer_pkh)
  let state_ok = old_datum.state == Open || old_datum.state == Claimed

  // After deliver_by: validity-range lower bound must be at or after.
  let deadline_ok = after_or_at(self.validity_range, old_datum.deliver_by)

  // Distribution: buyer receives payment + buyer_bond + supplier_bond.
  let buyer_due =
    old_datum.payment_lovelace + old_datum.buyer_bond_lovelace + old_datum.supplier_bond_lovelace
  let buyer_received = lovelace_paid_to_pkh(self.outputs, old_datum.buyer_pkh)
  let distribution_ok = buyer_received >= buyer_due

  signer_ok && state_ok && deadline_ok && distribution_ok
}

// ─── Release (Submitted → Released, terminal) ────────────────────────

fn handle_release(old_datum: EscrowDatum, self: Transaction) -> Bool {
  let signer_ok = signed_by(self.extra_signatories, old_datum.supplier_pkh)
  let state_ok = old_datum.state == Submitted

  // After submitted_at + ACCEPT_WINDOW.
  expect Some(submitted_at) = old_datum.submitted_at
  let threshold = submitted_at + accept_window_ms
  let timing_ok = after_or_at(self.validity_range, threshold)

  // Distribution: supplier receives payment + supplier_bond + buyer_bond.
  let supplier_due =
    old_datum.payment_lovelace + old_datum.supplier_bond_lovelace + old_datum.buyer_bond_lovelace
  let supplier_received =
    lovelace_paid_to_pkh(self.outputs, old_datum.supplier_pkh)
  let distribution_ok = supplier_received >= supplier_due

  signer_ok && state_ok && timing_ok && distribution_ok
}

// ─── Datum invariants ────────────────────────────────────────────────

/// On Claim, every field except `state` must be unchanged. This forbids the
/// supplier from rewriting hashes, prices, or the advert spec-lock.
fn expect_unchanged_modulo_state(
  old: EscrowDatum,
  new: EscrowDatum,
) -> Bool {
  new.buyer_pkh == old.buyer_pkh && new.supplier_pkh == old.supplier_pkh && new.advert_ref == old.advert_ref && new.capability_id == old.capability_id && new.request_spec_hash == old.request_spec_hash && new.prompt_hash == old.prompt_hash && new.payment_lovelace == old.payment_lovelace && new.buyer_bond_lovelace == old.buyer_bond_lovelace && new.supplier_bond_lovelace == old.supplier_bond_lovelace && new.deliver_by == old.deliver_by && new.posted_at == old.posted_at && new.submitted_at == old.submitted_at && new.result_receipt_hash == old.result_receipt_hash
}

/// On Submit, every field except `state`, `submitted_at`, and
/// `result_receipt_hash` must be unchanged. The first two of those three are
/// checked separately above; this guards the rest.
fn expect_unchanged_modulo_submit(
  old: EscrowDatum,
  new: EscrowDatum,
) -> Bool {
  new.buyer_pkh == old.buyer_pkh && new.supplier_pkh == old.supplier_pkh && new.advert_ref == old.advert_ref && new.capability_id == old.capability_id && new.request_spec_hash == old.request_spec_hash && new.prompt_hash == old.prompt_hash && new.payment_lovelace == old.payment_lovelace && new.buyer_bond_lovelace == old.buyer_bond_lovelace && new.supplier_bond_lovelace == old.supplier_bond_lovelace && new.deliver_by == old.deliver_by && new.posted_at == old.posted_at
}

fn bytearray_len(b: ByteArray) -> Int {
  bytearray.length(b)
}

// ─── Tests ───────────────────────────────────────────────────────────
//
// Test fixtures: buyer/supplier with distinct pkhs, a script hash for the
// escrow address, and a deterministic OutputReference for the advert spec
// lock. Time values use POSIX ms; we pick "deliver_by = 5_000_000_000" as
// a baseline and slot the validity range relative to it.

const buyer_pkh: ByteArray =
  #"1111111111111111111111111111111111111111111111111111111111"

const supplier_pkh: ByteArray =
  #"2222222222222222222222222222222222222222222222222222222222"

const stranger_pkh: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333"

const escrow_script_hash: ByteArray =
  #"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab"

const advert_tx_hash: ByteArray =
  #"baadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaad"

const request_hash: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

const prompt_hash: ByteArray =
  #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

const receipt_hash_32: ByteArray =
  #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

const receipt_hash_short: ByteArray =
  #"deadbeef"

const deliver_by_ms: Int = 5_000_000_000

const posted_at_ms: Int = 4_999_000_000

const submitted_at_ms: Int = 4_999_500_000

const payment_amt: Int = 5_000_000

const buyer_bond_amt: Int = 1_000_000

const supplier_bond_amt: Int = 1_000_000

fn locked_value() -> Value {
  assets.from_lovelace(payment_amt + buyer_bond_amt + supplier_bond_amt)
}

fn escrow_address() -> Address {
  Address {
    payment_credential: Script(escrow_script_hash),
    stake_credential: None,
  }
}

fn pkh_address(pkh: ByteArray) -> Address {
  Address {
    payment_credential: VerificationKey(pkh),
    stake_credential: None,
  }
}

fn advert_ref() -> OutputReference {
  OutputReference { transaction_id: advert_tx_hash, output_index: 0 }
}

fn placeholder_ref(ix: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: ix,
  }
}

fn open_datum() -> EscrowDatum {
  EscrowDatum {
    buyer_pkh,
    supplier_pkh,
    advert_ref: advert_ref(),
    capability_id: "llm.text.generate.v1",
    request_spec_hash: request_hash,
    prompt_hash,
    payment_lovelace: payment_amt,
    buyer_bond_lovelace: buyer_bond_amt,
    supplier_bond_lovelace: supplier_bond_amt,
    deliver_by: deliver_by_ms,
    posted_at: posted_at_ms,
    submitted_at: None,
    result_receipt_hash: None,
    state: Open,
  }
}

fn claimed_datum() -> EscrowDatum {
  EscrowDatum { ..open_datum(), state: Claimed }
}

fn submitted_datum() -> EscrowDatum {
  EscrowDatum {
    ..open_datum(),
    submitted_at: Some(submitted_at_ms),
    result_receipt_hash: Some(receipt_hash_32),
    state: Submitted,
  }
}

fn escrow_input(ref: OutputReference, datum: EscrowDatum) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: escrow_address(),
      value: locked_value(),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn escrow_output(datum: EscrowDatum) -> Output {
  Output {
    address: escrow_address(),
    value: locked_value(),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn pkh_output(pkh: ByteArray, lovelace: Int) -> Output {
  Output {
    address: pkh_address(pkh),
    value: assets.from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

/// Closed-interval validity range [lo, hi].
fn validity_between(lo: Int, hi: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lo), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(hi), is_inclusive: True },
  }
}

fn base_tx() -> Transaction {
  transaction.placeholder
}

// ─── Happy: Claim ─────────────────────────────────────────────────────
test claim_happy_path() {
  let own_ref = placeholder_ref(0)
  let old = open_datum()
  let new = claimed_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(own_ref, old)],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(
        deliver_by_ms - 1_000_000,
        deliver_by_ms - 500_000,
      ),
    }
  handle_claim(old, own_ref, t)
}

// ─── Happy: Submit ────────────────────────────────────────────────────
test submit_happy_path() {
  let own_ref = placeholder_ref(0)
  let old = claimed_datum()
  let stamp = deliver_by_ms - 500_000
  let new =
    EscrowDatum {
      ..old,
      submitted_at: Some(stamp),
      result_receipt_hash: Some(receipt_hash_32),
      state: Submitted,
    }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(own_ref, old)],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(deliver_by_ms - 1_000_000, stamp),
    }
  handle_submit(old, own_ref, receipt_hash_32, t)
}

// ─── Happy: Accept ────────────────────────────────────────────────────
test accept_happy_path() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms,
      ),
    }
  handle_accept(old, t)
}

// ─── Happy: Reclaim from Open ─────────────────────────────────────────
test reclaim_from_open_happy_path() {
  let old = open_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(buyer_pkh, payment_amt + buyer_bond_amt + supplier_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(deliver_by_ms, deliver_by_ms + 1_000_000),
    }
  handle_reclaim(old, t)
}

// ─── Happy: Reclaim from Claimed ──────────────────────────────────────
test reclaim_from_claimed_happy_path() {
  let old = claimed_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(buyer_pkh, payment_amt + buyer_bond_amt + supplier_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(deliver_by_ms, deliver_by_ms + 1_000_000),
    }
  handle_reclaim(old, t)
}

// ─── Happy: Release after window ──────────────────────────────────────
test release_happy_path() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(
          supplier_pkh,
          payment_amt + supplier_bond_amt + buyer_bond_amt,
        ),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(
        submitted_at_ms + accept_window_ms,
        submitted_at_ms + accept_window_ms + 1_000_000,
      ),
    }
  handle_release(old, t)
}

// ─── Adversarial: Claim ───────────────────────────────────────────────
test claim_rejects_non_supplier() fail {
  let own_ref = placeholder_ref(0)
  let old = open_datum()
  let new = claimed_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(own_ref, old)],
      outputs: [escrow_output(new)],
      extra_signatories: [stranger_pkh],
      validity_range: validity_between(
        deliver_by_ms - 1_000_000,
        deliver_by_ms - 500_000,
      ),
    }
  expect handle_claim(old, own_ref, t)
  True
}

test claim_rejects_after_deliver_by() fail {
  let own_ref = placeholder_ref(0)
  let old = open_datum()
  let new = claimed_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(own_ref, old)],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      // Upper bound past deliver_by — must reject.
      validity_range: validity_between(
        deliver_by_ms - 1_000,
        deliver_by_ms + 1_000,
      ),
    }
  expect handle_claim(old, own_ref, t)
  True
}

// ─── Adversarial: Submit ──────────────────────────────────────────────
test submit_rejects_no_receipt_hash() fail {
  let own_ref = placeholder_ref(0)
  let old = claimed_datum()
  let stamp = deliver_by_ms - 500_000
  // New datum reaches state Submitted but result_receipt_hash is None.
  let new =
    EscrowDatum {
      ..old,
      submitted_at: Some(stamp),
      result_receipt_hash: None,
      state: Submitted,
    }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(own_ref, old)],
      // Note: continuing output's datum has receipt = None so the rule
      // `new.result_receipt_hash == Some(receipt_hash)` fails.
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(deliver_by_ms - 1_000_000, stamp),
    }
  expect handle_submit(old, own_ref, receipt_hash_32, t)
  True
}

test submit_rejects_short_receipt_hash() fail {
  let own_ref = placeholder_ref(0)
  let old = claimed_datum()
  let stamp = deliver_by_ms - 500_000
  let new =
    EscrowDatum {
      ..old,
      submitted_at: Some(stamp),
      result_receipt_hash: Some(receipt_hash_short),
      state: Submitted,
    }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(own_ref, old)],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(deliver_by_ms - 1_000_000, stamp),
    }
  expect handle_submit(old, own_ref, receipt_hash_short, t)
  True
}

test submit_rejects_double_submit() fail {
  let own_ref = placeholder_ref(0)
  // Old state is already Submitted — double-submit attempt.
  let old = submitted_datum()
  let stamp = deliver_by_ms - 500_000
  let new =
    EscrowDatum {
      ..old,
      submitted_at: Some(stamp),
      result_receipt_hash: Some(receipt_hash_32),
      state: Submitted,
    }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(own_ref, old)],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(deliver_by_ms - 1_000_000, stamp),
    }
  expect handle_submit(old, own_ref, receipt_hash_32, t)
  True
}

// ─── Adversarial: Accept ──────────────────────────────────────────────
test accept_rejects_non_buyer() fail {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms,
      ),
    }
  expect handle_accept(old, t)
  True
}

test accept_rejects_after_window() fail {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      // Validity range strictly after the window — must reject.
      validity_range: validity_between(
        submitted_at_ms + accept_window_ms + 1,
        submitted_at_ms + accept_window_ms + 1_000,
      ),
    }
  expect handle_accept(old, t)
  True
}

test accept_rejects_supplier_shorted() fail {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        // Supplier short-paid by 1 lovelace.
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt - 1),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms,
      ),
    }
  expect handle_accept(old, t)
  True
}

test accept_rejects_buyer_shorted() fail {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        // Buyer short-paid by 1 lovelace.
        pkh_output(buyer_pkh, buyer_bond_amt - 1),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms,
      ),
    }
  expect handle_accept(old, t)
  True
}

// ─── Adversarial: Reclaim ─────────────────────────────────────────────
test reclaim_rejects_before_deliver_by() fail {
  let old = open_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(buyer_pkh, payment_amt + buyer_bond_amt + supplier_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(
        deliver_by_ms - 1_000_000,
        deliver_by_ms - 1,
      ),
    }
  expect handle_reclaim(old, t)
  True
}

// ─── Adversarial: Release ─────────────────────────────────────────────
test release_rejects_before_window() fail {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      outputs: [
        pkh_output(
          supplier_pkh,
          payment_amt + supplier_bond_amt + buyer_bond_amt,
        ),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms - 1,
      ),
    }
  expect handle_release(old, t)
  True
}
