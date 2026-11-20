//// Tests of the escrow when a delegation, or the identity of the buyer, ends
//// while a payment from a vault is open. Each test pins one part of what the
//// escrow does in that case:
////
//// - The escrow rules read neither the delegation nor the identity of the
////   buyer. The payment runs to its end when the delegation is gone, and when
////   the record of the buyer is revoked.
//// - The supplier can Claim and Submit until `deliver_by`.
//// - After Submit, the delegate key can Accept for 10 minutes. After that, the
////   supplier can Release, with no end date.
//// - Anybody can Reclaim an escrow that nobody submitted, from `deliver_by`.
////   Nobody can Reclaim a Submitted escrow.
//// - RefundRevoked frees a Submitted escrow only when the record of the
////   supplier is revoked with an "invalid from" time at or before the Submit.
////
//// A vault Pay writes the escrow with the delegate key as `buyer_pkh`. It also
//// writes the vault as `refund`, with the datum `Returned { owner }`
//// (`paid_by_vault`). The times and amounts are those of `escrow/fixtures`.
////
//// `tests/escrow.md` maps each part to its tests.

use aiken/collection/list
use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/address.{Address, Script}
use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use identity_marketplace/escrow/fixtures.{
  Case, buyer_bond_amt, claim_of, claimed_datum, deliver_by_ms, ended_at_ms,
  escrow_address, escrow_input, escrow_output, identity_hash, locked_value,
  open_datum, output_at, payment_amt, pkh_output, placeholder_ref,
  receipt_hash_32, reclaim_range, record_input, record_value,
  refund_revoked_case_with, retired, revoked, run, stranger_pkh, submit_of,
  submitted_at_ms, submitted_datum, supplier_bond_amt, supplier_pkh, tombstone,
  validity_between, wallet_input, with_outputs, with_range, with_refs,
  with_signers,
}
use identity_marketplace/types.{
  Accept, EscrowDatum, PrincipalKey, Reclaim, Refund, Release, Returned,
  Submitted,
}
use vector_identity.{find_record}
use vector_identity/types.{IdentityDatum, Status} as identity

// ## Test data

/// The key of the delegate agent: the `delegate_key` of its delegation. A vault
/// Pay writes its hash as `buyer_pkh`.
const delegate_pkh: ByteArray =
  #"d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"

/// The principal key that owns the vault.
const owner_pkh: ByteArray =
  #"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"

/// The script hash of the vault.
const vault_hash: ByteArray =
  #"7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b"

/// The script hash and policy ID of the delegation contract.
const delegation_hash: ByteArray =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"

/// The token name of the delegation.
const delegation_id: ByteArray =
  #"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"

/// The identifier of the buyer agent: the agent that owns the delegate key.
const buyer_agent_id: ByteArray =
  #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"

/// The enterprise address of the vault.
fn vault_address() -> Address {
  address.from_script(vault_hash)
}

/// The datum of a vault output that holds a refund: `Returned { owner }`.
fn returned(owner: ByteArray) -> Data {
  let datum: Data =
    Returned { owner: PrincipalKey { hash: owner, organisation: None } }
  datum
}

/// An output at the vault with `value` and the datum `Returned { owner }`.
fn vault_output(owner: ByteArray, value: Value) -> Output {
  output_at(vault_address(), value, InlineDatum(returned(owner)))
}

/// The escrow as a vault Pay writes it: the delegate key is the buyer, and the
/// buyer payouts go to the vault with the datum `Returned { owner }`.
fn paid_by_vault(datum: EscrowDatum) -> EscrowDatum {
  EscrowDatum {
    ..datum,
    buyer_pkh: delegate_pkh,
    refund: Some(
      Refund { address: vault_address(), datum: Some(returned(owner_pkh)) },
    ),
  }
}

/// A delegation as a reference input: at the delegation script, with its token.
fn delegation_input() -> Input {
  Input {
    output_reference: placeholder_ref(5),
    output: output_at(
      address.from_script(delegation_hash),
      record_value(delegation_hash, delegation_id),
      InlineDatum(0),
    ),
  }
}

/// True when no input, reference input or output of `tx` is at the delegation
/// script, and none holds a token of its policy.
fn without_delegation(tx: Transaction) -> Bool {
  let inputs = list.concat(tx.inputs, tx.reference_inputs)
  let outputs =
    list.concat(list.map(inputs, fn(input) { input.output }), tx.outputs)
  list.all(
    outputs,
    fn(output) {
      and {
        output.address.payment_credential != Script(delegation_hash),
        !list.has(assets.policies(output.value), delegation_hash),
      }
    },
  )
}

/// The record of the buyer agent after its end, as a reference input: a
/// tombstone with `status`.
fn buyer_tombstone(status: Status) -> Input {
  record_input(
    buyer_agent_id,
    IdentityDatum { ..tombstone(status), name: "buyer-agent" },
  )
}

// ## Cases of a payment from a vault

/// The datum that the transaction of `case` writes to the escrow address.
fn continuing_datum(case: Case) -> EscrowDatum {
  expect Some(output) =
    list.find(
      case.tx.outputs,
      fn(candidate) { candidate.address == escrow_address() },
    )
  expect InlineDatum(data) = output.datum
  expect datum: EscrowDatum = data
  datum
}

/// An Accept of the Submitted `datum`: the buyer key signs inside the window.
/// The supplier gets payment + supplier bond, and the vault gets the buyer
/// bond.
fn accept_of(datum: EscrowDatum) -> Case {
  expect Some(submitted_at) = datum.submitted_at
  Case {
    datum,
    redeemer: Accept,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(datum), wallet_input(datum.buyer_pkh, 1)],
      outputs: [
        pkh_output(
          datum.supplier_pkh,
          datum.payment_lovelace + datum.supplier_bond_lovelace,
        ),
        vault_output(owner_pkh, assets.from_lovelace(datum.buyer_bond_lovelace)),
      ],
      extra_signatories: [datum.buyer_pkh],
      validity_range: validity_between(submitted_at + 1, submitted_at + 600_000),
    },
  }
}

/// A Release of the Submitted `datum`: the supplier signs at the first valid
/// time and gets the whole value.
fn release_of(datum: EscrowDatum) -> Case {
  expect Some(submitted_at) = datum.submitted_at
  let due =
    datum.payment_lovelace + datum.supplier_bond_lovelace + datum.buyer_bond_lovelace
  Case {
    datum,
    redeemer: Release,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(datum), wallet_input(datum.supplier_pkh, 1)],
      outputs: [pkh_output(datum.supplier_pkh, due)],
      extra_signatories: [datum.supplier_pkh],
      validity_range: validity_between(
        submitted_at + 600_000,
        submitted_at + 1_600_000,
      ),
    },
  }
}

/// A Reclaim of the escrow `datum` at `deliver_by`. Nobody signs, and the whole
/// value goes to the vault.
fn reclaim_of(datum: EscrowDatum) -> Case {
  Case {
    datum,
    redeemer: Reclaim,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(datum), wallet_input(stranger_pkh, 1)],
      outputs: [vault_output(owner_pkh, locked_value())],
      extra_signatories: [],
      validity_range: reclaim_range(),
    },
  }
}

/// A Submit of the Claimed `datum` whose validity range ends at `hi`. The new
/// datum has `submitted_at = hi`.
fn submit_at(datum: EscrowDatum, hi: Int) -> Case {
  ending_at(submit_of(datum), hi)
    |> with_outputs(
        [
          escrow_output(
            EscrowDatum {
              ..datum,
              submitted_at: Some(hi),
              result_receipt_hash: Some(receipt_hash_32),
              state: Submitted,
            },
          ),
          pkh_output(datum.supplier_pkh, 4_000_000),
        ],
      )
}

/// A RefundRevoked of the escrow `datum`, after the record of the supplier
/// ended with `status`. Nobody signs, and the whole value goes to the vault.
fn refund_revoked_of(datum: EscrowDatum, status: Status) -> Case {
  refund_revoked_case_with(datum, tombstone(status))
    |> with_outputs([vault_output(owner_pkh, locked_value())])
    |> with_range(validity_between(ended_at_ms + 1, ended_at_ms + 600_000))
}

/// The case with a validity range that starts at `lo` and lasts 1 second.
fn starting_at(case: Case, lo: Int) -> Case {
  with_range(case, validity_between(lo, lo + 1_000))
}

/// The case with a validity range that ends at `hi` and lasts 1 second.
fn ending_at(case: Case, hi: Int) -> Case {
  with_range(case, validity_between(hi - 1_000, hi))
}

/// The case with a validity range that ends before `until` and lasts 1 second.
/// The upper bound is open, so the last valid time is `until - 1`.
fn ending_before(case: Case, until: Int) -> Case {
  with_range(
    case,
    Interval {
      lower_bound: IntervalBound {
        bound_type: Finite(until - 1_000),
        is_inclusive: True,
      },
      upper_bound: IntervalBound {
        bound_type: Finite(until),
        is_inclusive: False,
      },
    },
  )
}

// ## The escrow reads no delegation and no buyer identity

test vault_paid_escrow_runs_to_accept_without_a_delegation() {
  // Each transaction takes the datum that the one before it wrote. The
  // delegation is gone, so no transaction has it.
  let claim = claim_of(paid_by_vault(open_datum()), locked_value())
  let submit = submit_of(continuing_datum(claim))
  let accept = accept_of(continuing_datum(submit))
  let with_delegation = with_refs(accept, [delegation_input()])
  and {
    run(claim),
    run(submit),
    run(accept),
    without_delegation(claim.tx),
    without_delegation(submit.tx),
    without_delegation(accept.tx),
    // The check finds a delegation that is there, and the rules ignore it.
    !without_delegation(with_delegation.tx),
    run(with_delegation),
  }
}

test vault_paid_escrow_steps_need_their_own_signer() {
  // The supplier signs Claim and Submit. Only Accept is signed by the delegate
  // key, and nobody else can sign it: not the supplier, not the vault owner.
  let claim = claim_of(paid_by_vault(open_datum()), locked_value())
  let submit = submit_of(continuing_datum(claim))
  let accept = accept_of(continuing_datum(submit))
  and {
    !run(with_signers(claim, [delegate_pkh])),
    !run(with_signers(submit, [delegate_pkh])),
    !run(with_signers(accept, [supplier_pkh])),
    !run(with_signers(accept, [owner_pkh])),
    !run(with_signers(accept, [])),
  }
}

test accept_returns_the_buyer_bond_to_the_vault_owner() {
  // The delegate key signs the Accept. It cannot take the buyer bond: the bond
  // goes to the vault with the datum that the vault Pay wrote.
  let accept = accept_of(paid_by_vault(submitted_datum()))
  let supplier_share = pkh_output(supplier_pkh, payment_amt + supplier_bond_amt)
  let bond = assets.from_lovelace(buyer_bond_amt)
  let paying =
    fn(output) { with_outputs(accept, [supplier_share, output]) }
  and {
    run(paying(vault_output(owner_pkh, bond))),
    !run(paying(pkh_output(delegate_pkh, buyer_bond_amt))),
    !run(paying(pkh_output(owner_pkh, buyer_bond_amt))),
    !run(paying(vault_output(delegate_pkh, bond))),
  }
}

/// An Accept after the record of the buyer ended with `status`. The record is a
/// reference input. The Accept comes after the end.
fn accept_runs_after_buyer_end(status: Status) -> Bool {
  let case =
    accept_of(paid_by_vault(submitted_datum()))
      |> with_refs([buyer_tombstone(status)])
      |> with_range(
          validity_between(ended_at_ms + 1, submitted_at_ms + 600_000),
        )
  and {
    // The rules can find the record, so they could read it.
    find_record(case.tx.reference_inputs, identity_hash, buyer_agent_id) != None,
    run(case),
  }
}

test accept_ignores_the_revoked_record_of_the_buyer() {
  and {
    // Revoked, with an "invalid from" time before the Accept.
    accept_runs_after_buyer_end(revoked(Some(submitted_at_ms))),
    // Revoked, without that time.
    accept_runs_after_buyer_end(revoked(None)),
    // Retired.
    accept_runs_after_buyer_end(retired()),
  }
}

// ## The windows of the escrow

test accept_window_closes_600_000_ms_after_submit() {
  let accept = accept_of(paid_by_vault(submitted_datum()))
  and {
    run(ending_at(accept, submitted_at_ms + 600_000)),
    !run(ending_at(accept, submitted_at_ms + 600_001)),
    // With an open upper bound, the last valid time is the same.
    run(ending_before(accept, submitted_at_ms + 600_001)),
    !run(ending_before(accept, submitted_at_ms + 600_002)),
  }
}

test release_window_opens_600_000_ms_after_submit() {
  let release = release_of(paid_by_vault(submitted_datum()))
  and {
    run(starting_at(release, submitted_at_ms + 600_000)),
    !run(starting_at(release, submitted_at_ms + 599_999)),
    // The window has no end. Ten years later, the supplier can still Release.
    run(starting_at(release, submitted_at_ms + 600_000 + 315_360_000_000)),
  }
}

test claim_stops_after_deliver_by() {
  let claim = claim_of(paid_by_vault(open_datum()), locked_value())
  and {
    run(ending_at(claim, deliver_by_ms)),
    !run(ending_at(claim, deliver_by_ms + 1)),
    run(ending_before(claim, deliver_by_ms + 1)),
    !run(ending_before(claim, deliver_by_ms + 2)),
  }
}

test submit_stops_after_deliver_by() {
  // With an open upper bound `until`, `submitted_at` is `until`.
  let claimed = paid_by_vault(claimed_datum())
  let open =
    fn(until) { ending_before(submit_at(claimed, until), until) }
  and {
    run(submit_at(claimed, deliver_by_ms)),
    !run(submit_at(claimed, deliver_by_ms + 1)),
    run(open(deliver_by_ms + 1)),
    !run(open(deliver_by_ms + 2)),
  }
}

test accept_ends_600_000_ms_after_deliver_by_at_the_latest() {
  // The latest Submit has `deliver_by` as its upper bound. The delegate key
  // can Accept for 10 minutes after it. Then the supplier can Release.
  let submit = submit_at(paid_by_vault(claimed_datum()), deliver_by_ms)
  let submitted = continuing_datum(submit)
  let accept = accept_of(submitted)
  let release = release_of(submitted)
  and {
    run(submit),
    run(ending_at(accept, deliver_by_ms + 600_000)),
    !run(ending_at(accept, deliver_by_ms + 600_001)),
    !run(starting_at(release, deliver_by_ms + 599_999)),
    run(starting_at(release, deliver_by_ms + 600_000)),
  }
}

// ## Return to the vault

test reclaim_of_vault_paid_escrow_waits_for_deliver_by() {
  // Nobody signs the Reclaim. It is valid from `deliver_by` for an escrow that
  // nobody submitted, and not one millisecond before.
  let open = reclaim_of(paid_by_vault(open_datum()))
  let claimed = reclaim_of(paid_by_vault(claimed_datum()))
  and {
    run(starting_at(open, deliver_by_ms)),
    run(starting_at(claimed, deliver_by_ms)),
    !run(starting_at(open, deliver_by_ms - 1)),
    !run(starting_at(claimed, deliver_by_ms - 1)),
  }
}

test reclaim_rejects_submitted_vault_paid_escrow() {
  // The same Reclaim works while the escrow is only Claimed. After Submit, it
  // fails: at `deliver_by`, after the window, and a week later.
  let reclaim = reclaim_of(paid_by_vault(submitted_datum()))
  and {
    run(reclaim_of(paid_by_vault(claimed_datum()))),
    !run(reclaim),
    !run(starting_at(reclaim, deliver_by_ms + 600_000)),
    !run(starting_at(reclaim, deliver_by_ms + 604_800_000)),
  }
}

test refund_revoked_returns_submitted_vault_paid_escrow_to_the_vault() {
  // The record of the supplier ends after the Submit, with an "invalid from"
  // time at the Submit. Nobody signs, and the vault gets the whole value. The
  // supplier gets no part of it.
  let submitted = paid_by_vault(submitted_datum())
  let refund = refund_revoked_of(submitted, revoked(Some(submitted_at_ms)))
  let supplier_paid =
    with_outputs(
      refund,
      [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        vault_output(owner_pkh, assets.from_lovelace(buyer_bond_amt)),
      ],
    )
  and {
    run(refund),
    !run(supplier_paid),
    // An "invalid from" time after the Submit does not free the escrow.
    !run(refund_revoked_of(submitted, revoked(Some(submitted_at_ms + 1)))),
  }
}
