//// Register tests (Part 2 §3.4): §12.1 rows Identifier, Record output, Time,
//// Signatures, Parties (appointment, `Script` party, Module-1 withdrawal),
//// Recovery (guardian bound) and Subagents.

use aiken/interval.{
  Finite, Interval, IntervalBound, NegativeInfinity, PositiveInfinity,
}
use cardano/address
use cardano/assets
use cardano/transaction.{DatumHash, InlineDatum, NoDatum, Output, Transaction}
use identity_marketplace/identity/kit.{
  accountable, bytes, chain_id, chain_record, chain_refs, config_input,
  controller, creation_signers, deposit, distributor, ed, ed_key, guardian, hash,
  hi, hold_in_force, id_of, identity_address, legacy_hash, lo, mint, module1,
  new_record, new_subagent, other_controller, other_script, output, output_ap3x,
  own, p256, pkh, provider, range, record_input, record_output, record_value,
  register, register_tx, responsible, seed, signed_also, signer, staked,
  subagent_tx, suspended, wallet_input, with_mint, with_module1, with_outputs,
  with_parties, with_refs, within, without_config,
}
use vector_identity.{days_7_ms, max_range_ms, max_time_ms}
use vector_identity/redeemers.{Register}
use vector_identity/types.{
  ControllerSet, IdentityDatum, Party, PendingRecovery, Retired, Subagent,
} as identity

fn ok_tx() -> Transaction {
  register_tx(new_record(), creation_signers())
}

fn id() -> ByteArray {
  id_of(seed())
}

/// A record with every kind of party: the controller and a key as
/// Accountable, Module-1 as Responsible, a Provider, a Distributor and a
/// guardian (threshold 1).
fn all_parties() -> IdentityDatum {
  IdentityDatum {
    ..with_parties(
      new_record(),
      [
        accountable(ControllerSet),
        accountable(signer(1)),
        responsible(module1()),
        provider(signer(2)),
        distributor(signer(3)),
        guardian(signer(4)),
      ],
    ),
    guardian_threshold: 1,
  }
}

fn all_parties_tx() -> Transaction {
  with_module1(
    register_tx(
      all_parties(),
      [pkh(1), pkh(2), pkh(3), pkh(4), ..creation_signers()],
    ),
  )
}

// ## Valid registrations

test register_root() {
  register(ok_tx())
}

test register_every_party_kind() {
  register(all_parties_tx())
}

test register_p256_key_without_signature() {
  register(
    register_tx(
      IdentityDatum { ..new_record(), keys: [ed(1, 27), p256(1, 3)] },
      creation_signers(),
    ),
  )
}

test register_without_keys() {
  register(
    register_tx(IdentityDatum { ..new_record(), keys: [] }, [hash(controller)]),
  )
}

test register_range_of_one_hour() {
  let tx = within(ok_tx(), hi - max_range_ms, hi)
  register(tx)
}

test register_exactly_10_ap3x() {
  register(output_ap3x(ok_tx(), 10_000_000))
}

test register_identifier_vectors() {
  // Part 1 §3.1 test vectors.
  and {
    id_of(
      transaction.OutputReference {
        transaction_id: bytes(32, 0),
        output_index: 0,
      },
    ) == #"a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9",
    id_of(
      transaction.OutputReference {
        transaction_id: bytes(32, 0xab),
        output_index: 24,
      },
    ) == #"3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b",
  }
}

// ## Identifier

test register_name_not_from_seed() fail {
  let other = bytes(32, 0x44)
  let tx =
    with_outputs(
      with_mint(ok_tx(), assets.from_asset(own, other, 1)),
      [record_output(other, new_record())],
    )
  register(tx)
}

test register_seed_not_spent() fail {
  register(Transaction { ..ok_tx(), inputs: [wallet_input()] })
}

test register_quantity_2() fail {
  let tx =
    with_outputs(
      with_mint(ok_tx(), assets.from_asset(own, id(), 2)),
      [
        record_output(id(), new_record()),
        output(
          address.from_verification_key(pkh(5)),
          record_value(id(), 2_000_000),
          NoDatum,
        ),
      ],
    )
  register(tx)
}

test register_second_name() fail {
  let other = bytes(32, 0x44)
  let tx =
    with_outputs(
      with_mint(
        ok_tx(),
        assets.from_asset(own, id(), 1) |> assets.add(own, other, 1),
      ),
      [
        record_output(id(), new_record()),
        output(
          address.from_verification_key(pkh(5)),
          record_value(other, 2_000_000),
          NoDatum,
        ),
      ],
    )
  register(tx)
}

test register_with_legacy_mint() fail {
  let tx =
    with_mint(
      ok_tx(),
      assets.from_asset(own, id(), 1) |> assets.add(legacy_hash, id(), 1),
    )
  register(tx)
}

test register_with_legacy_burn() fail {
  let other = bytes(32, 0x44)
  let tx =
    with_mint(
      ok_tx(),
      assets.from_asset(own, id(), 1) |> assets.add(legacy_hash, other, -1),
    )
  register(tx)
}

test register_with_redeemer_of_other_seed() fail {
  let other_seed =
    transaction.OutputReference {
      transaction_id: bytes(32, 0x5f),
      output_index: 1,
    }
  mint(Register { seed: other_seed }, ok_tx())
}

// ## Record output

test register_token_leaves_identity_address() fail {
  register(
    with_outputs(
      ok_tx(),
      [
        output(
          address.from_verification_key(pkh(5)),
          record_value(id(), deposit),
          InlineDatum(new_record()),
        ),
      ],
    ),
  )
}

test register_output_with_stake_credential() fail {
  register(
    with_outputs(
      ok_tx(),
      [
        output(
          staked(identity_address()),
          record_value(id(), deposit),
          InlineDatum(new_record()),
        ),
      ],
    ),
  )
}

test register_datum_hash() fail {
  register(
    with_outputs(
      ok_tx(),
      [
        Output {
          ..record_output(id(), new_record()),
          datum: DatumHash(bytes(32, 1)),
        },
      ],
    ),
  )
}

test register_no_datum() fail {
  register(
    with_outputs(
      ok_tx(),
      [Output { ..record_output(id(), new_record()), datum: NoDatum }],
    ),
  )
}

test register_foreign_asset() fail {
  register(
    with_outputs(
      ok_tx(),
      [
        Output {
          ..record_output(id(), new_record()),
          value: record_value(id(), deposit) |> assets.add(other_script, "x", 1),
        },
      ],
    ),
  )
}

test register_reference_script() fail {
  register(
    with_outputs(
      ok_tx(),
      [
        Output {
          ..record_output(id(), new_record()),
          reference_script: Some(other_script),
        },
      ],
    ),
  )
}

test register_less_than_10_ap3x() fail {
  register(output_ap3x(ok_tx(), 9_999_999))
}

test register_two_outputs_at_identity_address() fail {
  register(
    with_outputs(
      ok_tx(),
      [
        record_output(id(), new_record()),
        output(
          identity_address(),
          assets.from_lovelace(2_000_000),
          InlineDatum(new_record()),
        ),
      ],
    ),
  )
}

test register_field_outside_limit() fail {
  register(
    register_tx(
      IdentityDatum { ..new_record(), name: bytes(65, 0x6e) },
      creation_signers(),
    ),
  )
}

test register_duplicate_keys() fail {
  register(
    register_tx(
      IdentityDatum { ..new_record(), keys: [ed(1, 27), ed(1, 1)] },
      creation_signers(),
    ),
  )
}

test register_duplicate_capabilities() fail {
  register(
    register_tx(
      IdentityDatum { ..new_record(), capabilities: ["a.v1", "a.v1"] },
      creation_signers(),
    ),
  )
}

test register_same_role_and_signer() fail {
  register(
    register_tx(
      with_parties(
        new_record(),
        [accountable(signer(1)), Party { ..accountable(signer(1)), rights: 1 }],
      ),
      [pkh(1), ..creation_signers()],
    ),
  )
}

test register_p256_transaction_purpose() fail {
  register(
    register_tx(
      IdentityDatum { ..new_record(), keys: [ed(1, 27), p256(1, 9)] },
      creation_signers(),
    ),
  )
}

test register_p256_without_pop() fail {
  register(
    register_tx(
      IdentityDatum {
        ..new_record(),
        keys: [ed(1, 27), identity.Key { ..p256(1, 3), pop: None }],
      },
      creation_signers(),
    ),
  )
}

test register_purpose_value_4() fail {
  register(
    register_tx(
      IdentityDatum { ..new_record(), keys: [ed(1, 4)] },
      creation_signers(),
    ),
  )
}

test register_rights_above_role() fail {
  register(
    register_tx(
      with_parties(
        new_record(),
        [accountable(ControllerSet), Party { ..provider(signer(2)), rights: 3 }],
      ),
      [pkh(2), ..creation_signers()],
    ),
  )
}

// ## Time

test register_unbounded_lower() fail {
  register(
    Transaction {
      ..ok_tx(),
      validity_range: Interval {
        lower_bound: IntervalBound {
          bound_type: NegativeInfinity,
          is_inclusive: True,
        },
        upper_bound: IntervalBound {
          bound_type: Finite(hi),
          is_inclusive: True,
        },
      },
    },
  )
}

test register_unbounded_upper() fail {
  register(
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

test register_range_over_one_hour() fail {
  register(within(ok_tx(), hi - max_range_ms - 1, hi))
}

test register_created_at_not_hi() fail {
  register(
    register_tx(
      IdentityDatum { ..new_record(), created_at: lo },
      creation_signers(),
    ),
  )
}

test register_created_at_after_hi() fail {
  register(
    register_tx(
      IdentityDatum { ..new_record(), created_at: hi + 1 },
      creation_signers(),
    ),
  )
}

test register_after_year_9999() fail {
  let late = max_time_ms + 1
  let d0 = IdentityDatum { ..new_record(), created_at: late }
  let tx = register_tx(d0, creation_signers())
  register(Transaction { ..tx, validity_range: range(late - 600_000, late) })
}

test register_party_time_after_year_9999() fail {
  register(
    register_tx(
      with_parties(
        new_record(),
        [
          Party {
            ..accountable(ControllerSet),
            not_after: Some(max_time_ms + 1),
          },
        ],
      ),
      creation_signers(),
    ),
  )
}

test register_negative_time() fail {
  register(
    register_tx(
      with_parties(
        new_record(),
        [
          accountable(ControllerSet),
          Party { ..provider(signer(2)), not_before: -1 },
        ],
      ),
      [pkh(2), ..creation_signers()],
    ),
  )
}

// ## Status, recovery and epoch at creation

test register_not_active() fail {
  register(
    register_tx(
      suspended(new_record(), [hold_in_force(ControllerSet)]),
      creation_signers(),
    ),
  )
}

test register_with_pending_recovery() fail {
  let d0 =
    IdentityDatum {
      ..with_parties(
        new_record(),
        [accountable(ControllerSet), guardian(signer(4))],
      ),
      guardian_threshold: 1,
      pending_recovery: Some(
        PendingRecovery {
          new_controller: bytes(32, 9),
          effective_after: hi + days_7_ms,
        },
      ),
    }
  register(register_tx(d0, [pkh(4), ..creation_signers()]))
}

test register_epoch_not_0() fail {
  register(
    register_tx(
      IdentityDatum { ..new_record(), subagent_epoch: 1 },
      creation_signers(),
    ),
  )
}

test register_as_tombstone() fail {
  let d0 = kit.tombstone(new_record(), Retired { at: lo, successor: None })
  register(register_tx(d0, [hash(controller)]))
}

// ## Accountability and guardian bound

test register_without_accountable_party() fail {
  register(
    register_tx(
      with_parties(new_record(), [responsible(ControllerSet)]),
      creation_signers(),
    ),
  )
}

test register_accountable_party_not_yet_started() fail {
  register(
    register_tx(
      with_parties(
        new_record(),
        [Party { ..accountable(ControllerSet), not_before: lo + 1 }],
      ),
      creation_signers(),
    ),
  )
}

test register_accountable_party_ends_before_hi() fail {
  register(
    register_tx(
      with_parties(
        new_record(),
        [Party { ..accountable(ControllerSet), not_after: Some(hi - 1) }],
      ),
      creation_signers(),
    ),
  )
}

test register_threshold_above_guardian_bound() fail {
  let d0 =
    IdentityDatum {
      ..with_parties(
        new_record(),
        [accountable(ControllerSet), guardian(signer(4))],
      ),
      guardian_threshold: 2,
    }
  register(register_tx(d0, [pkh(4), ..creation_signers()]))
}

test register_guardian_ended_does_not_count() fail {
  let d0 =
    IdentityDatum {
      ..with_parties(
        new_record(),
        [
          accountable(ControllerSet),
          Party { ..guardian(signer(4)), not_after: Some(hi - 1) },
        ],
      ),
      guardian_threshold: 1,
    }
  register(register_tx(d0, [pkh(4), ..creation_signers()]))
}

test register_future_guardian_counts() {
  let d0 =
    IdentityDatum {
      ..with_parties(
        new_record(),
        [
          accountable(ControllerSet),
          Party { ..guardian(signer(4)), not_before: hi + days_7_ms },
        ],
      ),
      guardian_threshold: 1,
    }
  register(register_tx(d0, [pkh(4), ..creation_signers()]))
}

// ## Signatures

test register_controller_does_not_sign() fail {
  register(register_tx(new_record(), [hash(ed_key(1))]))
}

test register_ed25519_key_does_not_sign() fail {
  register(register_tx(new_record(), [hash(controller)]))
}

test register_party_does_not_sign() fail {
  register(
    register_tx(
      with_parties(
        new_record(),
        [accountable(ControllerSet), provider(signer(2))],
      ),
      creation_signers(),
    ),
  )
}

test register_controller_set_party_needs_controller() fail {
  // The controller signs only as an Ed25519 key hash of another key.
  register(
    register_tx(IdentityDatum { ..new_record(), keys: [] }, [hash(ed_key(1))]),
  )
}

// ## Module-1 as a party

test register_module1_without_withdrawal() fail {
  register(Transaction { ..all_parties_tx(), withdrawals: [] })
}

test register_module1_withdrawal_of_other_script() fail {
  register(
    Transaction {
      ..all_parties_tx(),
      withdrawals: [Pair(address.Script(other_script), 0)],
    },
  )
}

test register_module1_without_configuration() fail {
  register(without_config(all_parties_tx()))
}

test register_script_party_not_module1() fail {
  let d0 =
    with_parties(
      new_record(),
      [
        accountable(ControllerSet),
        responsible(identity.Script { hash: other_script }),
      ],
    )
  let tx =
    Transaction {
      ..register_tx(d0, creation_signers()),
      withdrawals: [Pair(address.Script(other_script), 0)],
    }
  register(tx)
}

test register_configuration_at_other_address() fail {
  let fake =
    transaction.Input {
      ..config_input(),
      output: Output {
        ..config_input().output,
        address: staked(kit.holder_address()),
      },
    }
  register(
    Transaction { ..without_config(all_parties_tx()), reference_inputs: [fake] },
  )
}

test register_module1_party_with_stray_withdrawal_is_harmless() {
  // A Module-1 withdrawal in a Register without a Module-1 party changes
  // nothing on the identity side.
  register(with_module1(ok_tx()))
}

// ## Spend scope at creation

test register_with_identity_input() fail {
  let tx = ok_tx()
  register(
    Transaction {
      ..tx,
      inputs: [record_input(0, kit.record_id, kit.record()), ..tx.inputs],
    },
  )
}

test register_with_staked_identity_input() fail {
  let tx = ok_tx()
  let input = record_input(0, kit.record_id, kit.record())
  register(
    Transaction {
      ..tx,
      inputs: [
        transaction.Input {
          ..input,
          output: Output { ..input.output, address: staked(identity_address()) },
        },
        ..tx.inputs
      ],
    },
  )
}

// ## Subagents

test register_subagent_depth_1() {
  register(subagent_tx(1))
}

test register_subagent_depth_4() {
  register(subagent_tx(4))
}

test register_subagent_depth_5() fail {
  register(subagent_tx(5))
}

test register_subagent_stale_parent_epoch() fail {
  let tx =
    register_tx(new_subagent(1), [hash(other_controller), ..creation_signers()])
  let parent = IdentityDatum { ..chain_record(0), subagent_epoch: 1 }
  register(with_refs(tx, [record_input(10, chain_id(0), parent)]))
}

test register_subagent_current_parent_epoch() {
  let tx =
    register_tx(
      IdentityDatum {
        ..new_subagent(1),
        lineage: Subagent { parent: chain_id(0), parent_epoch: 1, depth: 1 },
      },
      [hash(other_controller), ..creation_signers()],
    )
  let parent = IdentityDatum { ..chain_record(0), subagent_epoch: 1 }
  register(with_refs(tx, [record_input(10, chain_id(0), parent)]))
}

test register_subagent_wrong_depth() fail {
  let tx =
    register_tx(
      IdentityDatum {
        ..new_subagent(1),
        lineage: Subagent { parent: chain_id(0), parent_epoch: 0, depth: 2 },
      },
      [hash(other_controller), ..creation_signers()],
    )
  register(with_refs(tx, chain_refs(1)))
}

test register_subagent_parent_does_not_sign() fail {
  register(
    with_refs(register_tx(new_subagent(1), creation_signers()), chain_refs(1)),
  )
}

test register_subagent_parent_suspended() fail {
  let tx =
    register_tx(new_subagent(1), [hash(other_controller), ..creation_signers()])
  let parent = suspended(chain_record(0), [hold_in_force(signer(1))])
  register(with_refs(tx, [record_input(10, chain_id(0), parent)]))
}

test register_subagent_parent_unaccountable() fail {
  let tx =
    register_tx(new_subagent(1), [hash(other_controller), ..creation_signers()])
  let parent = with_parties(chain_record(0), [responsible(ControllerSet)])
  register(with_refs(tx, [record_input(10, chain_id(0), parent)]))
}

test register_subagent_parent_tombstone() fail {
  let tx =
    register_tx(new_subagent(1), [hash(other_controller), ..creation_signers()])
  let parent =
    kit.tombstone(chain_record(0), Retired { at: lo - 1, successor: None })
  register(with_refs(tx, [record_input(10, chain_id(0), parent)]))
}

test register_subagent_grandparent_epoch_increased() fail {
  // The parent (depth 1) was created under epoch 0 of the root, and the root
  // has epoch 1 now: the parent is not Active.
  let tx =
    register_tx(new_subagent(2), [hash(other_controller), ..creation_signers()])
  let root = IdentityDatum { ..chain_record(0), subagent_epoch: 1 }
  register(
    with_refs(
      tx,
      [
        record_input(11, chain_id(1), chain_record(1)),
        record_input(10, chain_id(0), root),
      ],
    ),
  )
}

test register_subagent_parent_missing() fail {
  register(
    register_tx(new_subagent(1), [hash(other_controller), ..creation_signers()]),
  )
}

test register_subagent_parent_at_other_address() fail {
  let tx =
    register_tx(new_subagent(1), [hash(other_controller), ..creation_signers()])
  let parent = record_input(10, chain_id(0), chain_record(0))
  let moved =
    transaction.Input {
      ..parent,
      output: Output { ..parent.output, address: staked(identity_address()) },
    }
  register(with_refs(tx, [moved]))
}

test register_subagent_with_endpoint() fail {
  let tx =
    register_tx(
      IdentityDatum { ..new_subagent(1), endpoint: "https://sub.example" },
      [hash(other_controller), ..creation_signers()],
    )
  register(with_refs(tx, chain_refs(1)))
}

test register_subagent_signers_also_cover_parent() {
  // The parent's controller is also allowed to be the new record's
  // controller.
  let d0 =
    IdentityDatum { ..new_subagent(1), controller: other_controller, keys: [] }
  register(with_refs(register_tx(d0, [hash(other_controller)]), chain_refs(1)))
}

test register_unrelated_signer_is_harmless() {
  register(signed_also(ok_tx(), [pkh(77)]))
}
