//// Tests of the new escrow rules (Part 2 §6.1): a positive control for every
//// redeemer and boundary, and every escrow attack of §12.1. Each attack test
//// changes one part of a passing case from `escrow/fixtures`. A test that
//// asserts `!run(...)` passes only when the rules return False. A `fail` test
//// is used only where the rule stops the script: the validity window.
////
//// `tests/escrow.md` maps the §12.1 items to these tests.

use aiken/collection/list
use aiken/crypto.{blake2b_224}
use aiken/interval
use cardano/address.{Script, VerificationKey}
use cardano/assets
use cardano/certificate
use cardano/governance
use cardano/transaction.{DatumHash, InlineDatum, NoDatum, Output, Transaction}
use identity_marketplace/escrow/fixtures.{
  Case, accept_case, accountable_party, add_input, agent_id, buyer_pkh,
  buyer_refund, capability, claim_case, claim_of, claim_range, claimed_datum,
  controller_key, deliver_by_ms, escrow_address, escrow_hash, escrow_input,
  escrow_input_with, escrow_output, every_case, hold, identity_hash, key_address,
  largest_claim_case, largest_submit_case, legacy_escrow_hash, locked_ap3x,
  locked_value, open_datum, other_agent_id, other_key, other_script_hash,
  output_at, parent_id, pkh_output, receipt_hash_32, reclaim_case, reclaim_range,
  reclaim_refund_case, record_input, record_input_with, record_value,
  refund_revoked_case, refund_revoked_case_with, release_case, retired, revoked,
  run, script_input, stranger_pkh, submit_case, submit_of, submit_range,
  submitted_at_ms, submitted_datum, supplier_key, supplier_key_entry,
  supplier_pkh, supplier_record, tombstone, validity_between, vault_refund,
  vault_returned_datum, wallet_input, widened, with_outputs, with_range,
  with_record, with_refs, with_refund, with_signers, with_tx,
}
use identity_marketplace/escrow/rules.{input_cap, value_cap}
use identity_marketplace/types.{
  Accepted, Claimed, EscrowDatum, Open, Reclaimed, Refund, Released, Submit,
}
use vector_identity.{effective}
use vector_identity/types.{
  Ed25519, EffActive, IdentityDatum, Key, Subagent, Suspended,
} as identity

// ## Helpers

/// The lower and upper bound of `claim_range()`.
const claim_lo: Int = 4_999_000_000

const claim_hi: Int = 4_999_500_000

/// A Claim whose agent record is `record`.
fn claim_with_record(record: IdentityDatum) -> Case {
  with_record(claim_case(), record)
}

/// A Submit whose agent record is `record`.
fn submit_with_record(record: IdentityDatum) -> Case {
  with_record(submit_case(), record)
}

/// The agent record, Suspended with one hold by `stranger_pkh` until `until`.
fn suspended_record(until: Int) -> IdentityDatum {
  IdentityDatum {
    ..supplier_record(),
    status: Suspended { holds: [hold(stranger_pkh, until)] },
  }
}

/// The address of `pkh` with a stake credential.
fn staked_key_address(pkh: ByteArray) -> address.Address {
  key_address(pkh) |> address.with_delegation_key(stranger_pkh)
}

/// An Open escrow with the given amounts.
fn amounts(payment: Int, buyer_bond: Int, supplier_bond: Int) -> EscrowDatum {
  EscrowDatum {
    ..open_datum(),
    payment_lovelace: payment,
    buyer_bond_lovelace: buyer_bond,
    supplier_bond_lovelace: supplier_bond,
  }
}

/// A Claim whose continuing output is `output`.
fn claim_continuing(output: Output) -> Case {
  with_outputs(claim_case(), [output, pkh_output(supplier_pkh, 4_000_000)])
}

/// A Submit whose continuing output is `output`.
fn submit_continuing(output: Output) -> Case {
  with_outputs(submit_case(), [output, pkh_output(supplier_pkh, 4_000_000)])
}

/// The case with an escrow input that holds `value` (for example more AP3X
/// than payment + bonds, after a minimum-value top-up).
fn with_input_value(case: Case, value: assets.Value) -> Case {
  let inputs =
    list.map(
      case.tx.inputs,
      fn(input) {
        if input.output.address == escrow_address() {
          escrow_input_with(value, case.datum)
        } else {
          input
        }
      },
    )
  with_tx(case, Transaction { ..case.tx, inputs })
}

/// RefundRevoked of a Submitted escrow (submitted at `submitted_at_ms`) with
/// the agent `record`.
fn refund_submitted(record: IdentityDatum) -> Case {
  refund_revoked_case_with(submitted_datum(), record)
}

/// A Reclaim with the vault refund whose payout is `output`.
fn reclaim_refund_paying(output: Output) -> Case {
  with_outputs(reclaim_refund_case(), [output])
}

/// An Accept with `refund` whose buyer payout is `output`.
fn accept_with_refund_paying(refund: Refund, output: Output) -> Case {
  let datum = with_refund(submitted_datum(), refund)
  let case = accept_case()
  Case {
    ..with_tx(
      case,
      Transaction {
        ..case.tx,
        inputs: [escrow_input(datum), wallet_input(buyer_pkh, 1)],
        outputs: [pkh_output(supplier_pkh, 6_000_000), output],
      },
    ),
    datum,
  }
}

// ## Positive controls

test every_case_passes() {
  list.all(every_case(), run)
}

test claim_with_one_hour_range() {
  run(
    with_range(
      claim_case(),
      validity_between(deliver_by_ms - 3_600_000, deliver_by_ms),
    ),
  )
}

test claim_at_value_cap() {
  run(
    claim_of(
      amounts(value_cap - 2_000_000, 1_000_000, 1_000_000),
      assets.from_lovelace(input_cap),
    ),
  )
}

test claim_keeps_refund() {
  run(claim_of(with_refund(open_datum(), vault_refund()), locked_value()))
}

test submit_keeps_refund() {
  run(submit_of(with_refund(claimed_datum(), vault_refund())))
}

test claim_with_listed_controller_key() {
  let controller_pkh = blake2b_224(controller_key)
  let record =
    IdentityDatum {
      ..supplier_record(),
      keys: [
        Key { key_type: Ed25519, key: controller_key, purposes: 8, pop: None },
      ],
    }
  let case =
    claim_of(
      EscrowDatum { ..open_datum(), supplier_pkh: controller_pkh },
      locked_value(),
    )
  run(with_record(case, record))
}

test claim_with_ended_hold() {
  run(claim_with_record(suspended_record(claim_lo)))
}

test claim_with_largest_record() {
  run(largest_claim_case())
}

test submit_with_largest_record() {
  run(largest_submit_case())
}

test submit_skips_capability_and_value_checks() {
  let record = IdentityDatum { ..supplier_record(), capabilities: [] }
  let above_cap =
    EscrowDatum {
      ..claimed_datum(),
      payment_lovelace: value_cap,
      buyer_bond_lovelace: 1_000_000,
    }
  and {
    run(submit_with_record(record)),
    run(submit_of(above_cap)),
  }
}

test accept_with_buyer_refund_address() {
  run(
    accept_with_refund_paying(buyer_refund(), pkh_output(buyer_pkh, 1_000_000)),
  )
}

test accept_with_vault_refund() {
  run(
    accept_with_refund_paying(
      vault_refund(),
      output_at(
        vault_refund().address,
        assets.from_lovelace(1_000_000),
        InlineDatum(vault_returned_datum()),
      ),
    ),
  )
}

test reclaim_with_refund_without_any_signature() {
  run(with_signers(reclaim_refund_case(), []))
}

test reclaim_with_refund_returns_input_ap3x() {
  let value = assets.from_lovelace(locked_ap3x + 1_500_000)
  let case = with_input_value(reclaim_refund_case(), value)
  run(
    with_outputs(
      case,
      [
        output_at(
          vault_refund().address,
          value,
          InlineDatum(vault_returned_datum()),
        ),
      ],
    ),
  )
}

test reclaim_without_refund_keeps_legacy_amount() {
  // The input holds 1.5 AP3X more than payment + bonds. Without a refund
  // address, the buyer signs and payment + bonds are enough (as today).
  let value = assets.from_lovelace(locked_ap3x + 1_500_000)
  run(with_input_value(reclaim_case(), value))
}

test release_with_refund_set() {
  let datum = with_refund(submitted_datum(), vault_refund())
  let case = release_case()
  run(
    Case {
      ..with_tx(
        case,
        Transaction {
          ..case.tx,
          inputs: [escrow_input(datum), wallet_input(supplier_pkh, 1)],
        },
      ),
      datum,
    },
  )
}

test release_does_not_read_registry() {
  // Release keeps its legacy rules: a revocation after the submission does
  // not stop it.
  run(
    with_refs(
      release_case(),
      [record_input(agent_id, tombstone(revoked(Some(submitted_at_ms + 1))))],
    ),
  )
}

test refund_revoked_open_escrow_of_revoked_agent() {
  run(refund_revoked_case())
}

test refund_revoked_open_escrow_of_retired_agent() {
  run(refund_revoked_case_with(open_datum(), tombstone(retired())))
}

test refund_revoked_claimed_escrow_of_revoked_agent() {
  run(refund_revoked_case_with(claimed_datum(), tombstone(revoked(None))))
}

test refund_revoked_claimed_escrow_of_retired_agent() {
  run(refund_revoked_case_with(claimed_datum(), tombstone(retired())))
}

test refund_revoked_submitted_invalid_from_at_submission() {
  run(refund_submitted(tombstone(revoked(Some(submitted_at_ms)))))
}

test refund_revoked_submitted_invalid_from_before_submission() {
  run(refund_submitted(tombstone(revoked(Some(4_100_000_000)))))
}

test refund_revoked_after_deliver_by() {
  run(with_range(refund_revoked_case(), reclaim_range()))
}

test refund_revoked_to_vault_refund() {
  let datum = with_refund(claimed_datum(), vault_refund())
  run(
    refund_revoked_case_with(datum, tombstone(revoked(None)))
      |> with_outputs(
          [
            output_at(
              vault_refund().address,
              locked_value(),
              InlineDatum(vault_returned_datum()),
            ),
          ],
        ),
  )
}

test refund_revoked_to_buyer_refund_address() {
  let datum = with_refund(open_datum(), buyer_refund())
  run(refund_revoked_case_with(datum, tombstone(retired())))
}

// ## Rules 1 and 2: scope (every redeemer)

test two_escrow_inputs_rejected() {
  let staked_escrow =
    escrow_address() |> address.with_delegation_key(stranger_pkh)
  list.all(
    every_case(),
    fn(case) {
      and {
        !run(add_input(case, script_input(escrow_address(), 9))),
        !run(add_input(case, script_input(staked_escrow, 9))),
      }
    },
  )
}

test legacy_escrow_input_rejected() {
  list.all(
    every_case(),
    fn(case) {
      !run(
        add_input(
          case,
          script_input(address.from_script(legacy_escrow_hash), 9),
        ),
      )
    },
  )
}

test second_script_input_rejected() {
  let staked_other =
    address.from_script(other_script_hash)
      |> address.with_delegation_key(stranger_pkh)
  list.all(
    every_case(),
    fn(case) {
      and {
        !run(
          add_input(case, script_input(address.from_script(identity_hash), 9)),
        ),
        !run(add_input(case, script_input(staked_other, 9))),
      }
    },
  )
}

test mint_rejected() {
  list.all(
    every_case(),
    fn(case) {
      !run(
        with_tx(
          case,
          Transaction {
            ..case.tx,
            mint: assets.from_asset(other_script_hash, #"01", 1),
          },
        ),
      )
    },
  )
}

test withdrawal_rejected() {
  list.all(
    every_case(),
    fn(case) {
      !run(
        with_tx(
          case,
          Transaction {
            ..case.tx,
            withdrawals: [Pair(Script(other_script_hash), 0)],
          },
        ),
      )
    },
  )
}

test certificate_rejected() {
  list.all(
    every_case(),
    fn(case) {
      !run(
        with_tx(
          case,
          Transaction {
            ..case.tx,
            certificates: [
              certificate.UpdateDelegateRepresentative {
                delegate_representative: VerificationKey(stranger_pkh),
              },
            ],
          },
        ),
      )
    },
  )
}

test vote_rejected() {
  list.all(
    every_case(),
    fn(case) {
      !run(
        with_tx(
          case,
          Transaction {
            ..case.tx,
            votes: [
              Pair(
                governance.StakePool(stranger_pkh),
                [
                  Pair(
                    governance.GovernanceActionId {
                      transaction: escrow_hash,
                      proposal_procedure: 0,
                    },
                    governance.Yes,
                  ),
                ],
              ),
            ],
          },
        ),
      )
    },
  )
}

test proposal_rejected() {
  list.all(
    every_case(),
    fn(case) {
      !run(
        with_tx(
          case,
          Transaction {
            ..case.tx,
            proposal_procedures: [
              governance.ProposalProcedure {
                deposit: 100_000_000_000,
                return_address: VerificationKey(stranger_pkh),
                governance_action: governance.NicePoll,
              },
            ],
          },
        ),
      )
    },
  )
}

// ## Rule 3: validity range (every redeemer)

test claim_rejects_range_over_one_hour() fail {
  run(
    with_range(
      claim_case(),
      validity_between(deliver_by_ms - 3_600_001, deliver_by_ms),
    ),
  )
}

test submit_rejects_range_over_one_hour() fail {
  run(
    with_range(
      submit_case(),
      validity_between(submitted_at_ms - 3_600_001, submitted_at_ms),
    ),
  )
}

test accept_rejects_range_over_one_hour() fail {
  run(
    with_range(
      accept_case(),
      validity_between(submitted_at_ms - 3_000_000, submitted_at_ms + 600_002),
    ),
  )
}

test reclaim_rejects_range_over_one_hour() fail {
  run(widened(reclaim_case(), 3_600_001))
}

test reclaim_with_refund_rejects_range_over_one_hour() fail {
  run(widened(reclaim_refund_case(), 3_600_001))
}

test release_rejects_range_over_one_hour() fail {
  run(widened(release_case(), 3_600_001))
}

test refund_revoked_rejects_range_over_one_hour() fail {
  run(widened(refund_revoked_case(), 3_600_001))
}

test claim_rejects_unbounded_lower_bound() fail {
  run(with_range(claim_case(), interval.before(claim_hi)))
}

test submit_rejects_unbounded_upper_bound() fail {
  run(with_range(submit_case(), interval.after(submitted_at_ms - 1_000)))
}

test reclaim_rejects_unbounded_upper_bound() fail {
  // The legacy Reclaim accepted an unbounded upper bound. Rule 3 applies to
  // every redeemer now.
  run(with_range(reclaim_case(), interval.after(deliver_by_ms)))
}

// ## Claim: identity checks

test claim_rejects_unlisted_key() {
  let record =
    IdentityDatum {
      ..supplier_record(),
      keys: [Key { key_type: Ed25519, key: other_key, purposes: 11, pop: None }],
    }
  !run(claim_with_record(record))
}

test claim_rejects_key_without_transaction_purpose() {
  let record =
    IdentityDatum {
      ..supplier_record(),
      keys: [supplier_key_entry(1 + 2 + 16)],
    }
  !run(claim_with_record(record))
}

test claim_rejects_controller_only_key() {
  // The supplier key is the controller key, which the record does not list.
  let controller_pkh = blake2b_224(controller_key)
  let case =
    claim_of(
      EscrowDatum { ..open_datum(), supplier_pkh: controller_pkh },
      locked_value(),
    )
  !run(case)
}

test claim_rejects_missing_capability() {
  let record =
    IdentityDatum { ..supplier_record(), capabilities: ["llm.chat.v1"] }
  !run(claim_with_record(record))
}

test claim_rejects_subagent() {
  let subagent =
    IdentityDatum {
      ..supplier_record(),
      lineage: Subagent { parent: parent_id, parent_epoch: 0, depth: 1 },
      endpoint: "",
    }
  let refs =
    [
      record_input(parent_id, supplier_record()),
      record_input(agent_id, subagent),
    ]
  and {
    // The subagent is Active; only the independence check fails.
    effective(subagent, refs, identity_hash, claim_lo, claim_hi) == EffActive,
    !run(with_refs(claim_case(), refs)),
  }
}

test claim_rejects_suspended_agent() {
  !run(claim_with_record(suspended_record(claim_lo + 1)))
}

test claim_rejects_unaccountable_agent() {
  let ends_before_hi =
    identity.Party { ..accountable_party(), not_after: Some(claim_hi - 1) }
  let starts_after_lo =
    identity.Party { ..accountable_party(), not_before: claim_lo + 1 }
  and {
    !run(claim_with_record(IdentityDatum { ..supplier_record(), parties: [] })),
    !run(
      claim_with_record(
        IdentityDatum { ..supplier_record(), parties: [ends_before_hi] },
      ),
    ),
    !run(
      claim_with_record(
        IdentityDatum { ..supplier_record(), parties: [starts_after_lo] },
      ),
    ),
  }
}

test claim_rejects_revoked_or_retired_agent() {
  and {
    !run(claim_with_record(tombstone(revoked(None)))),
    !run(claim_with_record(tombstone(retired()))),
  }
}

test claim_rejects_record_at_wrong_address() {
  let value = record_value(identity_hash, agent_id)
  let staked =
    address.from_script(identity_hash)
      |> address.with_delegation_key(stranger_pkh)
  let at =
    fn(addr) { [record_input_with(addr, value, supplier_record())] }
  and {
    !run(with_refs(claim_case(), at(staked))),
    !run(with_refs(claim_case(), at(address.from_script(other_script_hash)))),
    !run(with_refs(claim_case(), at(key_address(identity_hash)))),
  }
}

test claim_rejects_record_with_fake_token() {
  let at_ia = address.from_script(identity_hash)
  let fake = record_value(other_script_hash, agent_id)
  let none = assets.from_lovelace(10_000_000)
  and {
    !run(
      with_refs(
        claim_case(),
        [record_input_with(at_ia, fake, supplier_record())],
      ),
    ),
    !run(
      with_refs(
        claim_case(),
        [record_input_with(at_ia, none, supplier_record())],
      ),
    ),
  }
}

test claim_rejects_record_of_another_agent() {
  !run(
    with_refs(claim_case(), [record_input(other_agent_id, supplier_record())]),
  )
}

test claim_rejects_missing_record() {
  !run(with_refs(claim_case(), []))
}

// ## Claim: value cap

test claim_rejects_value_above_cap() {
  let datum = amounts(value_cap - 2_000_000 + 1, 1_000_000, 1_000_000)
  !run(claim_of(datum, assets.from_lovelace(value_cap + 1)))
}

test claim_rejects_input_above_cap() {
  let datum = amounts(value_cap - 2_000_000, 1_000_000, 1_000_000)
  !run(claim_of(datum, assets.from_lovelace(input_cap + 1)))
}

test claim_rejects_negative_amount() {
  // The sum is at the cap, but the payment is above it.
  let datum = amounts(value_cap + 1_000_000, -2_000_000, 1_000_000)
  !run(claim_of(datum, assets.from_lovelace(value_cap)))
}

// ## Claim and Submit: continuing output

test claim_rejects_continuing_output_with_stake_credential() {
  let staked = escrow_address() |> address.with_delegation_key(stranger_pkh)
  !run(
    claim_continuing(
      output_at(staked, locked_value(), InlineDatum(claimed_datum())),
    ),
  )
}

test submit_rejects_continuing_output_with_stake_credential() {
  let staked = escrow_address() |> address.with_delegation_key(stranger_pkh)
  !run(
    submit_continuing(
      output_at(staked, locked_value(), InlineDatum(submitted_datum())),
    ),
  )
}

test claim_rejects_two_continuing_outputs() {
  let staked = escrow_address() |> address.with_delegation_key(stranger_pkh)
  and {
    !run(
      with_outputs(
        claim_case(),
        [escrow_output(claimed_datum()), escrow_output(claimed_datum())],
      ),
    ),
    !run(
      with_outputs(
        claim_case(),
        [
          escrow_output(claimed_datum()),
          output_at(staked, locked_value(), InlineDatum(claimed_datum())),
        ],
      ),
    ),
  }
}

test claim_rejects_missing_continuing_output() {
  !run(with_outputs(claim_case(), [pkh_output(supplier_pkh, locked_ap3x)]))
}

test claim_rejects_changed_value() {
  let lower = assets.from_lovelace(locked_ap3x - 1)
  let extra = locked_value() |> assets.add(other_script_hash, #"01", 1)
  and {
    !run(
      claim_continuing(
        output_at(escrow_address(), lower, InlineDatum(claimed_datum())),
      ),
    ),
    !run(
      claim_continuing(
        output_at(escrow_address(), extra, InlineDatum(claimed_datum())),
      ),
    ),
  }
}

test claim_rejects_continuing_datum_not_inline() {
  and {
    !run(
      claim_continuing(
        output_at(escrow_address(), locked_value(), DatumHash(receipt_hash_32)),
      ),
    ),
    !run(claim_continuing(output_at(escrow_address(), locked_value(), NoDatum))),
  }
}

test claim_rejects_continuing_output_with_reference_script() {
  !run(
    claim_continuing(
      Output {
        ..escrow_output(claimed_datum()),
        reference_script: Some(escrow_hash),
      },
    ),
  )
}

test claim_rejects_changed_agent_id() {
  !run(
    claim_continuing(
      escrow_output(EscrowDatum { ..claimed_datum(), agent_id: other_agent_id }),
    ),
  )
}

test claim_rejects_changed_refund() {
  and {
    !run(
      claim_continuing(
        escrow_output(with_refund(claimed_datum(), vault_refund())),
      ),
    ),
    !run(
      with_outputs(
        claim_of(with_refund(open_datum(), vault_refund()), locked_value()),
        [escrow_output(claimed_datum())],
      ),
    ),
  }
}

test claim_rejects_other_field_change() {
  and {
    !run(
      claim_continuing(
        escrow_output(EscrowDatum { ..claimed_datum(), payment_lovelace: 1 }),
      ),
    ),
    !run(
      claim_continuing(
        escrow_output(
          EscrowDatum { ..claimed_datum(), buyer_pkh: stranger_pkh },
        ),
      ),
    ),
    !run(
      claim_continuing(
        escrow_output(EscrowDatum { ..claimed_datum(), state: Open }),
      ),
    ),
  }
}

test submit_rejects_changed_agent_id() {
  !run(
    submit_continuing(
      escrow_output(
        EscrowDatum { ..submitted_datum(), agent_id: other_agent_id },
      ),
    ),
  )
}

test submit_rejects_changed_refund() {
  !run(
    submit_continuing(
      escrow_output(with_refund(submitted_datum(), buyer_refund())),
    ),
  )
}

test submit_rejects_submitted_at_other_than_hi() {
  and {
    !run(
      submit_continuing(
        escrow_output(
          EscrowDatum {
            ..submitted_datum(),
            submitted_at: Some(submitted_at_ms - 1),
          },
        ),
      ),
    ),
    !run(
      submit_continuing(
        escrow_output(EscrowDatum { ..submitted_datum(), submitted_at: None }),
      ),
    ),
  }
}

test submit_rejects_receipt_other_than_redeemer() {
  let case = submit_case()
  !run(
    Case {
      ..case,
      redeemer: Submit {
        receipt_hash: #"abababababababababababababababababababababababababababababababab",
      },
    },
  )
}

// ## Submit: identity checks

test submit_rejects_after_key_removal() {
  let record =
    IdentityDatum {
      ..supplier_record(),
      keys: [Key { key_type: Ed25519, key: other_key, purposes: 11, pop: None }],
    }
  !run(submit_with_record(record))
}

test submit_rejects_key_without_transaction_purpose() {
  !run(
    submit_with_record(
      IdentityDatum { ..supplier_record(), keys: [supplier_key_entry(3)] },
    ),
  )
}

test submit_rejects_after_suspension() {
  !run(submit_with_record(suspended_record(deliver_by_ms - 1_000_000 + 1)))
}

test submit_rejects_unaccountable_agent() {
  !run(submit_with_record(IdentityDatum { ..supplier_record(), parties: [] }))
}

test submit_rejects_after_revocation() {
  and {
    !run(submit_with_record(tombstone(revoked(None)))),
    !run(submit_with_record(tombstone(revoked(Some(submitted_at_ms))))),
  }
}

test submit_rejects_after_retirement() {
  !run(submit_with_record(tombstone(retired())))
}

test submit_rejects_subagent() {
  let subagent =
    IdentityDatum {
      ..supplier_record(),
      lineage: Subagent { parent: parent_id, parent_epoch: 0, depth: 1 },
      endpoint: "",
    }
  let refs =
    [
      record_input(parent_id, supplier_record()),
      record_input(agent_id, subagent),
    ]
  !run(with_refs(submit_case(), refs))
}

test submit_rejects_missing_record() {
  !run(with_refs(submit_case(), []))
}

// ## Payouts: refund address and datum

test accept_with_refund_rejects_payout_to_buyer_key() {
  // The refund address is the vault; the buyer key does not count.
  !run(
    accept_with_refund_paying(vault_refund(), pkh_output(buyer_pkh, 1_000_000)),
  )
}

test accept_with_refund_rejects_wrong_datum() {
  let at_vault =
    fn(datum) {
      output_at(vault_refund().address, assets.from_lovelace(1_000_000), datum)
    }
  and {
    !run(accept_with_refund_paying(vault_refund(), at_vault(NoDatum))),
    !run(accept_with_refund_paying(vault_refund(), at_vault(InlineDatum(0)))),
    !run(
      accept_with_refund_paying(
        vault_refund(),
        at_vault(DatumHash(receipt_hash_32)),
      ),
    ),
  }
}

test accept_with_buyer_refund_rejects_datum_or_stake() {
  // `refund = Some { address: buyer key, datum: None }`: only outputs at that
  // exact address without a datum count.
  and {
    !run(
      accept_with_refund_paying(
        buyer_refund(),
        output_at(
          key_address(buyer_pkh),
          assets.from_lovelace(1_000_000),
          InlineDatum(0),
        ),
      ),
    ),
    !run(
      accept_with_refund_paying(
        buyer_refund(),
        output_at(
          staked_key_address(buyer_pkh),
          assets.from_lovelace(1_000_000),
          NoDatum,
        ),
      ),
    ),
  }
}

test accept_with_refund_rejects_buyer_shorted() {
  !run(
    accept_with_refund_paying(
      vault_refund(),
      output_at(
        vault_refund().address,
        assets.from_lovelace(1_000_000 - 1),
        InlineDatum(vault_returned_datum()),
      ),
    ),
  )
}

test accept_with_refund_needs_buyer_signature() {
  !run(
    accept_with_refund_paying(buyer_refund(), pkh_output(buyer_pkh, 1_000_000))
      |> with_signers([stranger_pkh]),
  )
}

test reclaim_with_refund_rejects_wrong_address() {
  and {
    !run(reclaim_refund_paying(pkh_output(buyer_pkh, locked_ap3x))),
    !run(
      reclaim_refund_paying(
        output_at(
          address.from_script(other_script_hash)
            |> address.with_delegation_key(stranger_pkh),
          locked_value(),
          InlineDatum(vault_returned_datum()),
        ),
      ),
    ),
  }
}

test reclaim_with_refund_rejects_wrong_datum() {
  let at_vault =
    fn(datum) { output_at(vault_refund().address, locked_value(), datum) }
  and {
    !run(reclaim_refund_paying(at_vault(NoDatum))),
    !run(reclaim_refund_paying(at_vault(InlineDatum(0)))),
  }
}

test reclaim_with_refund_rejects_less_than_full_refund() {
  // The input holds 1.5 AP3X more than payment + bonds; a full refund returns
  // all of it.
  let value = assets.from_lovelace(locked_ap3x + 1_500_000)
  let case = with_input_value(reclaim_refund_case(), value)
  let paying =
    fn(lovelace) {
      with_outputs(
        case,
        [
          output_at(
            vault_refund().address,
            assets.from_lovelace(lovelace),
            InlineDatum(vault_returned_datum()),
          ),
        ],
      )
    }
  and {
    !run(paying(locked_ap3x)),
    !run(paying(locked_ap3x + 1_500_000 - 1)),
    run(paying(locked_ap3x + 1_500_000)),
  }
}

// ## Payouts: buyer key, supplier key and states

test reclaim_without_refund_needs_buyer_signature() {
  !run(with_signers(reclaim_case(), [stranger_pkh]))
}

test reclaim_rejects_buyer_shorted() {
  !run(with_outputs(reclaim_case(), [pkh_output(buyer_pkh, locked_ap3x - 1)]))
}

test reclaim_rejects_submitted_escrow() {
  let case = reclaim_case()
  !run(
    Case {
      ..with_tx(
        case,
        Transaction {
          ..case.tx,
          inputs: [escrow_input(submitted_datum()), wallet_input(buyer_pkh, 1)],
        },
      ),
      datum: submitted_datum(),
    },
  )
}

test release_rejects_supplier_shorted() {
  !run(
    with_outputs(release_case(), [pkh_output(supplier_pkh, locked_ap3x - 1)]),
  )
}

test release_rejects_non_supplier() {
  !run(with_signers(release_case(), [buyer_pkh]))
}

// ## RefundRevoked

test refund_revoked_rejects_active_agent() {
  !run(refund_revoked_case_with(open_datum(), supplier_record()))
}

test refund_revoked_rejects_suspended_agent() {
  and {
    !run(
      refund_revoked_case_with(claimed_datum(), suspended_record(deliver_by_ms)),
    ),
    !run(
      refund_revoked_case_with(
        claimed_datum(),
        IdentityDatum { ..supplier_record(), parties: [] },
      ),
    ),
  }
}

test refund_revoked_rejects_missing_record() {
  !run(with_refs(refund_revoked_case(), []))
}

test refund_revoked_rejects_record_of_another_agent() {
  !run(
    with_refs(
      refund_revoked_case(),
      [record_input(other_agent_id, tombstone(revoked(None)))],
    ),
  )
}

test refund_revoked_rejects_record_at_wrong_address() {
  let staked =
    address.from_script(identity_hash)
      |> address.with_delegation_key(stranger_pkh)
  !run(
    with_refs(
      refund_revoked_case(),
      [
        record_input_with(
          staked,
          record_value(identity_hash, agent_id),
          tombstone(revoked(None)),
        ),
      ],
    ),
  )
}

test refund_revoked_submitted_rejects_no_invalid_from() {
  !run(refund_submitted(tombstone(revoked(None))))
}

test refund_revoked_submitted_rejects_invalid_from_after_submission() {
  !run(refund_submitted(tombstone(revoked(Some(submitted_at_ms + 1)))))
}

test refund_revoked_submitted_rejects_retired_agent() {
  !run(refund_submitted(tombstone(retired())))
}

test refund_revoked_rejects_terminal_states() {
  let record = tombstone(revoked(Some(4_100_000_000)))
  and {
    !run(
      refund_revoked_case_with(
        EscrowDatum { ..submitted_datum(), state: Accepted },
        record,
      ),
    ),
    !run(
      refund_revoked_case_with(
        EscrowDatum { ..submitted_datum(), state: Reclaimed },
        record,
      ),
    ),
    !run(
      refund_revoked_case_with(
        EscrowDatum { ..submitted_datum(), state: Released },
        record,
      ),
    ),
  }
}

test refund_revoked_rejects_less_than_full_refund() {
  and {
    !run(
      with_outputs(
        refund_revoked_case(),
        [pkh_output(buyer_pkh, locked_ap3x - 1)],
      ),
    ),
    !run(
      with_input_value(
        refund_revoked_case(),
        assets.from_lovelace(locked_ap3x + 1),
      ),
    ),
  }
}

test refund_revoked_rejects_staked_buyer_address() {
  // Without a refund address, only the enterprise address of the buyer key
  // counts.
  !run(
    with_outputs(
      refund_revoked_case(),
      [output_at(staked_key_address(buyer_pkh), locked_value(), NoDatum)],
    ),
  )
}

test refund_revoked_rejects_wrong_refund_address_or_datum() {
  let datum = with_refund(claimed_datum(), vault_refund())
  let case = refund_revoked_case_with(datum, tombstone(revoked(None)))
  and {
    // The default case pays the buyer key, which is not the refund address.
    !run(case),
    !run(
      with_outputs(
        case,
        [output_at(vault_refund().address, locked_value(), NoDatum)],
      ),
    ),
    !run(
      with_outputs(
        case,
        [output_at(vault_refund().address, locked_value(), InlineDatum(1))],
      ),
    ),
  }
}

// ## Full refund: every asset of the escrow input
//
// Decision of 2026-11-02: in the two paths that anybody can submit (Reclaim
// with `refund`, and RefundRevoked), the buyer payouts also carry every
// non-AP3X asset of the escrow input. The paths that the buyer signs keep the
// AP3X-only payout rules.

/// AP3X and `quantity` units of a token.
fn with_token(lovelace: Int, quantity: Int) -> assets.Value {
  assets.from_lovelace(lovelace)
    |> assets.add(other_script_hash, "token", quantity)
}

/// An output of `stranger_pkh` with `quantity` units of the token.
fn token_to_stranger(quantity: Int) -> Output {
  output_at(key_address(stranger_pkh), with_token(1_500_000, quantity), NoDatum)
}

/// An output at the vault refund address with the refund datum.
fn at_vault_refund(value: assets.Value) -> Output {
  output_at(vault_refund().address, value, InlineDatum(vault_returned_datum()))
}

/// An output at the enterprise address of the buyer key, without a datum.
fn at_buyer_key(value: assets.Value) -> Output {
  output_at(key_address(buyer_pkh), value, NoDatum)
}

/// Reclaim with the vault refund; the escrow input holds `locked_ap3x` and
/// one token.
fn reclaim_refund_with_token(outputs: List<Output>) -> Case {
  with_input_value(reclaim_refund_case(), with_token(locked_ap3x, 1))
    |> with_outputs(outputs)
}

/// RefundRevoked without `refund`; the escrow input holds `locked_ap3x` and
/// one token.
fn refund_revoked_with_token(outputs: List<Output>) -> Case {
  with_input_value(refund_revoked_case(), with_token(locked_ap3x, 1))
    |> with_outputs(outputs)
}

/// RefundRevoked with the vault refund; the escrow input holds `locked_ap3x`
/// and one token.
fn refund_revoked_vault_with_token(outputs: List<Output>) -> Case {
  let datum = with_refund(claimed_datum(), vault_refund())
  refund_revoked_case_with(datum, tombstone(revoked(None)))
    |> with_input_value(with_token(locked_ap3x, 1))
    |> with_outputs(outputs)
}

test reclaim_with_refund_rejects_token_to_other_output() {
  // The refund address gets all the AP3X, and another output takes the token.
  !run(
    reclaim_refund_with_token(
      [at_vault_refund(locked_value()), token_to_stranger(1)],
    ),
  )
}

test reclaim_with_refund_returns_token() {
  run(reclaim_refund_with_token([at_vault_refund(with_token(locked_ap3x, 1))]))
}

test reclaim_with_refund_token_in_second_refund_output() {
  // The refund outputs count together.
  run(
    reclaim_refund_with_token(
      [
        at_vault_refund(assets.from_lovelace(locked_ap3x - 1_500_000)),
        at_vault_refund(with_token(1_500_000, 1)),
      ],
    ),
  )
}

test reclaim_with_refund_rejects_token_without_refund_datum() {
  // At the refund address, only outputs with the refund datum count.
  !run(
    reclaim_refund_with_token(
      [
        at_vault_refund(locked_value()),
        output_at(vault_refund().address, with_token(1_500_000, 1), NoDatum),
      ],
    ),
  )
}

test refund_revoked_rejects_token_to_other_output() {
  !run(
    refund_revoked_with_token(
      [pkh_output(buyer_pkh, locked_ap3x), token_to_stranger(1)],
    ),
  )
}

test refund_revoked_returns_token() {
  run(refund_revoked_with_token([at_buyer_key(with_token(locked_ap3x, 1))]))
}

test refund_revoked_with_refund_rejects_token_to_other_output() {
  !run(
    refund_revoked_vault_with_token(
      [at_vault_refund(locked_value()), token_to_stranger(1)],
    ),
  )
}

test refund_revoked_with_refund_returns_token() {
  run(
    refund_revoked_vault_with_token(
      [at_vault_refund(with_token(locked_ap3x, 1))],
    ),
  )
}

test refund_revoked_rejects_part_of_token_quantity() {
  let case = with_input_value(refund_revoked_case(), with_token(locked_ap3x, 2))
  and {
    !run(
      with_outputs(
        case,
        [at_buyer_key(with_token(locked_ap3x, 1)), token_to_stranger(1)],
      ),
    ),
    run(with_outputs(case, [at_buyer_key(with_token(locked_ap3x, 2))])),
  }
}

test reclaim_without_refund_counts_ap3x_only() {
  // The buyer signs this path, so the legacy rule stays: AP3X only.
  run(with_input_value(reclaim_case(), with_token(locked_ap3x, 1)))
}

// ## The record condition of RefundRevoked

test refund_allowed_by_state_and_status() {
  let open = open_datum()
  let submitted = submitted_datum()
  and {
    rules.refund_allowed(open, revoked(None)),
    rules.refund_allowed(open, retired()),
    !rules.refund_allowed(open, identity.Active),
    !rules.refund_allowed(
      open,
      Suspended { holds: [hold(stranger_pkh, claim_hi)] },
    ),
    rules.refund_allowed(submitted, revoked(Some(submitted_at_ms))),
    !rules.refund_allowed(submitted, revoked(Some(submitted_at_ms + 1))),
    !rules.refund_allowed(submitted, revoked(None)),
    !rules.refund_allowed(submitted, retired()),
    !rules.refund_allowed(
      EscrowDatum { ..submitted, submitted_at: None },
      revoked(Some(0)),
    ),
  }
}

/// The constants `claim_lo` and `claim_hi` match the fixture ranges.
test fixtures_match_constants() {
  and {
    claimed_datum().state == Claimed,
    claim_range() == validity_between(claim_lo, claim_hi),
    submit_range() == validity_between(claim_lo, submitted_at_ms),
    capability == "llm.text.generate.v1",
    supplier_pkh == blake2b_224(supplier_key),
  }
}
