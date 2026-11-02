//// Spend scope and record output tests for spends (Part 2 §3.2 and §3.5):
//// §12.1 rows Spend scope, Record output, Time, and a lifecycle sequence for
//// the §12.3 properties (a tombstone never becomes live again; `created_at`
//// and the token name never change).

use aiken/collection/list
use aiken/interval.{Finite, Interval, IntervalBound, PositiveInfinity}
use cardano/address
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, Transaction,
}
use identity_marketplace/identity/kit.{
  accountable, bytes, controller_tx, creation_signers, deposit, hi, id_of,
  identity_address, lo, new_record, other_script, output, own, pkh, provider,
  record, record_id, record_input, record_output, record_value, ref, register,
  register_tx, seed, signer, spend, spend_tx, staked, suspended, tombstone,
  wallet_input, with_mint, with_outputs, with_parties, within,
}
use vector_identity.{day_ms, max_range_ms}
use vector_identity/redeemers.{
  BumpEpoch, ByController, ByParty, Reclaim, Revoke, Suspend, Unsuspend, Update,
}
use vector_identity/types.{
  Active, ControllerSet, Hold, IdentityDatum, Revoked, Suspended,
}

fn base() -> IdentityDatum {
  with_parties(record(), [accountable(ControllerSet), provider(signer(2))])
}

fn ok_tx() -> Transaction {
  let d = base()
  controller_tx(d, IdentityDatum { ..d, name: "renamed" })
}

/// The tx with `input` as the spent record input.
fn with_record_input(tx: Transaction, input: Input) -> Transaction {
  expect [_, ..rest] = tx.inputs
  Transaction { ..tx, inputs: [input, ..rest] }
}

test scope_update() {
  spend(Update, ok_tx())
}

test scope_range_of_one_hour() {
  spend(Update, within(ok_tx(), hi - max_range_ms, hi))
}

test scope_unbounded_range() fail {
  spend(
    Update,
    Transaction {
      ..ok_tx(),
      validity_range: Interval {
        lower_bound: IntervalBound {
          bound_type: Finite(lo),
          is_inclusive: True,
        },
        upper_bound: IntervalBound {
          bound_type: PositiveInfinity,
          is_inclusive: True,
        },
      },
    },
  )
}

// ## Spend scope

test scope_two_identity_inputs() fail {
  // A second record after the spent one.
  let tx = ok_tx()
  let second = record_input(1, bytes(32, 0x42), base())
  spend(Update, Transaction { ..tx, inputs: list.concat(tx.inputs, [second]) })
}

test scope_second_identity_input_first() fail {
  // A second record before the spent one.
  let tx = ok_tx()
  let second = record_input(1, bytes(32, 0x42), base())
  spend(Update, Transaction { ..tx, inputs: [second, ..tx.inputs] })
}

test scope_second_identity_input_with_stake_credential() fail {
  let tx = ok_tx()
  let second = record_input(1, bytes(32, 0x42), base())
  let moved =
    Input {
      ..second,
      output: Output { ..second.output, address: staked(identity_address()) },
    }
  spend(Update, Transaction { ..tx, inputs: [moved, ..tx.inputs] })
}

test scope_identity_input_with_stake_credential() fail {
  let tx = ok_tx()
  let input = record_input(0, record_id, base())
  spend(
    Update,
    with_record_input(
      tx,
      Input {
        ..input,
        output: Output { ..input.output, address: staked(identity_address()) },
      },
    ),
  )
}

test scope_input_without_token() fail {
  let input = record_input(0, record_id, base())
  spend(
    Update,
    with_record_input(
      ok_tx(),
      Input {
        ..input,
        output: Output { ..input.output, value: assets.from_lovelace(deposit) },
      },
    ),
  )
}

test scope_input_with_two_tokens() fail {
  let input = record_input(0, record_id, base())
  spend(
    Update,
    with_record_input(
      ok_tx(),
      Input {
        ..input,
        output: Output {
          ..input.output,
          value: record_value(record_id, deposit)
            |> assets.add(own, bytes(32, 0x42), 1),
        },
      },
    ),
  )
}

test scope_input_datum_hash() fail {
  let input = record_input(0, record_id, base())
  spend(
    Update,
    with_record_input(
      ok_tx(),
      Input {
        ..input,
        output: Output { ..input.output, datum: DatumHash(bytes(32, 1)) },
      },
    ),
  )
}

test scope_input_datum_not_a_record() fail {
  let input = record_input(0, record_id, base())
  spend(
    Update,
    with_record_input(
      ok_tx(),
      Input {
        ..input,
        output: Output { ..input.output, datum: InlineDatum(42) },
      },
    ),
  )
}

test scope_register_together_with_update() fail {
  let id = id_of(seed())
  let tx = ok_tx()
  let tx =
    Transaction {
      ..tx,
      inputs: [
        Input {
          output_reference: seed(),
          output: output(
            address.from_verification_key(pkh(99)),
            assets.from_lovelace(50_000_000),
            NoDatum,
          ),
        },
        ..tx.inputs
      ],
      outputs: [record_output(id, new_record()), ..tx.outputs],
      mint: assets.from_asset(own, id, 1),
    }
  spend(Update, tx)
}

test scope_register_together_with_update_mint_side() fail {
  let tx = register_tx(new_record(), creation_signers())
  register(
    Transaction {
      ..tx,
      inputs: [record_input(0, record_id, base()), ..tx.inputs],
    },
  )
}

test scope_burn_of_own_token() fail {
  let d = base()
  let tx = controller_tx(d, d)
  spend(Update, with_mint(tx, assets.from_asset(own, bytes(32, 0x42), -1)))
}

test scope_mint_of_own_policy() fail {
  spend(Update, with_mint(ok_tx(), assets.from_asset(own, bytes(32, 0x42), 1)))
}

test scope_other_script_input_allowed() {
  // Only inputs of the identity script are limited.
  let tx = ok_tx()
  let other =
    Input {
      output_reference: ref(60),
      output: output(
        address.from_script(other_script),
        assets.from_lovelace(5_000_000),
        NoDatum,
      ),
    }
  spend(Update, Transaction { ..tx, inputs: [other, ..tx.inputs] })
}

test scope_own_input_missing() fail {
  let tx = ok_tx()
  spend(Update, Transaction { ..tx, inputs: [wallet_input()] })
}

// ## Record output on a spend

fn next() -> IdentityDatum {
  IdentityDatum { ..base(), name: "renamed" }
}

test scope_token_leaves_identity_address() fail {
  spend(
    Update,
    with_outputs(
      ok_tx(),
      [
        output(
          address.from_verification_key(pkh(5)),
          record_value(record_id, deposit),
          InlineDatum(next()),
        ),
      ],
    ),
  )
}

test scope_output_with_stake_credential() fail {
  spend(
    Update,
    with_outputs(
      ok_tx(),
      [
        output(
          staked(identity_address()),
          record_value(record_id, deposit),
          InlineDatum(next()),
        ),
      ],
    ),
  )
}

test scope_output_datum_hash() fail {
  spend(
    Update,
    with_outputs(
      ok_tx(),
      [
        Output {
          ..record_output(record_id, next()),
          datum: DatumHash(bytes(32, 1)),
        },
      ],
    ),
  )
}

test scope_output_no_datum() fail {
  spend(
    Update,
    with_outputs(
      ok_tx(),
      [Output { ..record_output(record_id, next()), datum: NoDatum }],
    ),
  )
}

test scope_output_foreign_asset() fail {
  spend(
    Update,
    with_outputs(
      ok_tx(),
      [
        Output {
          ..record_output(record_id, next()),
          value: record_value(record_id, deposit)
            |> assets.add(other_script, "x", 1),
        },
      ],
    ),
  )
}

test scope_output_reference_script() fail {
  spend(
    Update,
    with_outputs(
      ok_tx(),
      [
        Output {
          ..record_output(record_id, next()),
          reference_script: Some(other_script),
        },
      ],
    ),
  )
}

test scope_two_outputs_at_identity_address() fail {
  spend(
    Update,
    with_outputs(
      ok_tx(),
      [
        record_output(record_id, next()),
        output(
          identity_address(),
          assets.from_lovelace(2_000_000),
          InlineDatum(next()),
        ),
      ],
    ),
  )
}

test scope_output_with_other_token_name() fail {
  spend(Update, with_outputs(ok_tx(), [record_output(bytes(32, 0x42), next())]))
}

test scope_output_field_outside_limit() fail {
  let d = base()
  spend(
    Update,
    controller_tx(d, IdentityDatum { ..d, framework: bytes(65, 0x66) }),
  )
}

test scope_created_at_changed_on_suspend() fail {
  let d = base()
  let d2 =
    IdentityDatum {
      ..d,
      created_at: d.created_at + 1,
      status: Suspended {
        holds: [
          Hold { by: ControllerSet, reason: 6, since: lo, until: lo + day_ms },
        ],
      },
    }
  spend(Suspend { actor: ByController }, controller_tx(d, d2))
}

test scope_created_at_changed_on_reclaim() fail {
  let d = kit.revoked_tombstone()
  spend(
    Reclaim,
    controller_tx(d, IdentityDatum { ..d, created_at: d.created_at + 1 }),
  )
}

// ## Lifecycle (§12.3): each step spends the previous record output

test lifecycle_sequence() {
  let d0 =
    with_parties(
      new_record(),
      [accountable(ControllerSet), provider(signer(2))],
    )
  let registered = register(register_tx(d0, [pkh(2), ..creation_signers()]))
  let d1 = IdentityDatum { ..d0, description: "updated" }
  let updated = spend(Update, controller_tx(d0, d1))
  let d2 =
    suspended(
      d1,
      [Hold { by: signer(2), reason: 9, since: lo, until: lo + day_ms }],
    )
  let held =
    spend(Suspend { actor: ByParty { index: 1 } }, spend_tx(d1, d2, [pkh(2)]))
  let d3 = IdentityDatum { ..d2, status: Active }
  let released =
    spend(Unsuspend { author: signer(2) }, spend_tx(d2, d3, [pkh(2)]))
  let d4 = IdentityDatum { ..d3, subagent_epoch: 1 }
  let bumped = spend(BumpEpoch, controller_tx(d3, d4))
  let d5 =
    tombstone(
      d4,
      Revoked {
        by: ControllerSet,
        reason: 5,
        at: lo,
        invalid_from: None,
        successor: None,
      },
    )
  let revoked = spend(Revoke { actor: ByController }, controller_tx(d4, d5))
  let reclaimed =
    spend(Reclaim, kit.output_ap3x(controller_tx(d5, d5), 1_500_000))
  and {
    registered,
    updated,
    held,
    released,
    bumped,
    revoked,
    reclaimed,
    d5.created_at == d0.created_at,
    d5.name == d0.name,
    d5.controller == d0.controller,
  }
}

test lifecycle_tombstone_stays_terminal() fail {
  let d = kit.revoked_tombstone()
  spend(
    Unsuspend { author: ControllerSet },
    controller_tx(d, IdentityDatum { ..record(), status: Active }),
  )
}
