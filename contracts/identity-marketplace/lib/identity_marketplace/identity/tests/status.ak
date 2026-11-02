//// Revoke, Retire, Reclaim and SetSuccessor tests (Part 2 §3.5 and §3.7):
//// §12.1 rows Statuses, Parties (revocation rights, successor by a party,
//// reason 64), Value and Time.

use aiken/collection/list
use cardano/transaction.{Transaction}
use identity_marketplace/identity/kit.{
  accountable, bytes, chain_id, controller, controller_tx, deposit, hash, hi,
  hold_in_force, lo, module1, module1_party, other_controller, other_record,
  output_ap3x, pkh, provider, record, record_id, record_input, responsible,
  retired_tombstone, revoked_tombstone, signed_also, signer, spend, spend_tx,
  successor_id, suspended, tombstone, with_module1, with_parties, with_refs,
  within, without_config,
}
use vector_identity.{day_ms, max_range_ms}
use vector_identity/redeemers.{
  ByController, ByParty, Reclaim, Retire, Revoke, SetSuccessor,
}
use vector_identity/types.{
  Active, ControllerSet, IdentityDatum, Party, Retired, Revoked, Signer, Status,
  Subagent,
}

/// Parties: 0 controller (Accountable), 1 signer 1 (Accountable), 2 signer 3
/// (Responsible), 3 Module-1 (Accountable), 4 signer 2 (Provider).
fn base() -> IdentityDatum {
  with_parties(
    record(),
    [
      accountable(ControllerSet),
      accountable(signer(1)),
      responsible(signer(3)),
      module1_party(),
      provider(signer(2)),
    ],
  )
}

fn revoked(
  by: Signer,
  reason: Int,
  invalid_from: Option<Int>,
  successor: Option<ByteArray>,
) -> Status {
  Revoked { by, reason, at: lo, invalid_from, successor }
}

/// The successor record as a reference input.
fn successor_ref() -> transaction.Input {
  record_input(30, successor_id, other_record())
}

/// A spend of `d` into the tombstone of `d` with `status`.
fn to_tombstone(
  d: IdentityDatum,
  status: Status,
  signers: List<ByteArray>,
) -> Transaction {
  spend_tx(d, tombstone(d, status), signers)
}

/// A tx that also reads the successor record and carries its controller's
/// signature.
fn with_successor(tx: Transaction) -> Transaction {
  signed_also(with_refs(tx, [successor_ref()]), [hash(other_controller)])
}

// ## Revoke

test revoke_by_controller() {
  let d = base()
  spend(
    Revoke { actor: ByController },
    to_tombstone(d, revoked(ControllerSet, 5, None, None), [hash(controller)]),
  )
}

test revoke_while_suspended_ends_holds() {
  let d =
    suspended(base(), [hold_in_force(signer(1)), hold_in_force(ControllerSet)])
  spend(
    Revoke { actor: ByController },
    to_tombstone(d, revoked(ControllerSet, 0, None, None), [hash(controller)]),
  )
}

test revoke_by_controller_with_successor() {
  let d = base()
  spend(
    Revoke { actor: ByController },
    with_successor(
      to_tombstone(
        d,
        revoked(ControllerSet, 4, None, Some(successor_id)),
        [hash(controller)],
      ),
    ),
  )
}

test revoke_by_accountable_party() {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 1 } },
    to_tombstone(d, revoked(signer(1), 3, None, None), [pkh(1)]),
  )
}

test revoke_by_party_with_successor() fail {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 1 } },
    with_successor(
      to_tombstone(d, revoked(signer(1), 3, None, Some(successor_id)), [pkh(1)]),
    ),
  )
}

test revoke_by_party_without_revoke_right() fail {
  let d =
    with_parties(
      record(),
      [
        accountable(ControllerSet),
        Party { ..accountable(signer(1)), rights: 1 },
      ],
    )
  spend(
    Revoke { actor: ByParty { index: 1 } },
    to_tombstone(d, revoked(signer(1), 3, None, None), [pkh(1)]),
  )
}

test revoke_by_responsible_party() fail {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 2 } },
    to_tombstone(d, revoked(signer(3), 0, None, None), [pkh(3)]),
  )
}

test revoke_by_provider() fail {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 4 } },
    to_tombstone(d, revoked(signer(2), 9, None, None), [pkh(2)]),
  )
}

test revoke_by_party_outside_period() fail {
  let d =
    with_parties(
      record(),
      [
        accountable(ControllerSet),
        Party { ..accountable(signer(1)), not_after: Some(lo) },
      ],
    )
  spend(
    Revoke { actor: ByParty { index: 1 } },
    to_tombstone(d, revoked(signer(1), 3, None, None), [pkh(1)]),
  )
}

test revoke_by_party_without_signature() fail {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 1 } },
    to_tombstone(d, revoked(signer(1), 3, None, None), [hash(controller)]),
  )
}

test revoke_by_controller_without_signature() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    to_tombstone(d, revoked(ControllerSet, 5, None, None), [pkh(1)]),
  )
}

test revoke_by_other_than_author() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    to_tombstone(d, revoked(signer(1), 5, None, None), [hash(controller)]),
  )
}

test revoke_at_not_lo() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    to_tombstone(
      d,
      Revoked {
        by: ControllerSet,
        reason: 5,
        at: hi,
        invalid_from: None,
        successor: None,
      },
      [hash(controller)],
    ),
  )
}

test revoke_every_allowed_reason() {
  let d = base()
  list.all(
    [0, 3, 4, 5, 9, 65],
    fn(reason) {
      spend(
        Revoke { actor: ByController },
        to_tombstone(
          d,
          revoked(ControllerSet, reason, None, None),
          [hash(controller)],
        ),
      )
    },
  )
}

test revoke_reason_not_allowed() {
  let d = base()
  list.all(
    [2, 6, 7, 8, 10, 63, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75],
    fn(reason) {
      !spend(
        Revoke { actor: ByController },
        to_tombstone(
          d,
          revoked(ControllerSet, reason, Some(lo), None),
          [hash(controller)],
        ),
      )
    },
  )
}

test revoke_reason_1_without_invalid_from() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    to_tombstone(d, revoked(ControllerSet, 1, None, None), [hash(controller)]),
  )
}

test revoke_reason_1_with_invalid_from() {
  let d = base()
  and {
    spend(
      Revoke { actor: ByController },
      to_tombstone(
        d,
        revoked(ControllerSet, 1, Some(lo), None),
        [hash(controller)],
      ),
    ),
    spend(
      Revoke { actor: ByParty { index: 1 } },
      to_tombstone(d, revoked(signer(1), 1, Some(d.created_at), None), [pkh(1)]),
    ),
  }
}

test revoke_invalid_from_before_created_at() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    to_tombstone(
      d,
      revoked(ControllerSet, 1, Some(d.created_at - 1), None),
      [hash(controller)],
    ),
  )
}

test revoke_invalid_from_after_lo() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    to_tombstone(
      d,
      revoked(ControllerSet, 1, Some(lo + 1), None),
      [hash(controller)],
    ),
  )
}

test revoke_reason_64_by_controller() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    to_tombstone(d, revoked(ControllerSet, 64, None, None), [hash(controller)]),
  )
}

test revoke_reason_64_by_key_party() fail {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 1 } },
    to_tombstone(d, revoked(signer(1), 64, None, None), [pkh(1)]),
  )
}

test revoke_by_module1() {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 3 } },
    with_module1(to_tombstone(d, revoked(module1(), 64, None, None), [])),
  )
}

test revoke_by_module1_without_withdrawal() fail {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 3 } },
    to_tombstone(d, revoked(module1(), 64, None, None), []),
  )
}

test revoke_by_module1_without_configuration() fail {
  let d = base()
  spend(
    Revoke { actor: ByParty { index: 3 } },
    without_config(
      with_module1(to_tombstone(d, revoked(module1(), 64, None, None), [])),
    ),
  )
}

test revoke_keeps_keys() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    spend_tx(
      d,
      IdentityDatum {
        ..tombstone(d, revoked(ControllerSet, 5, None, None)),
        keys: d.keys,
      },
      [hash(controller)],
    ),
  )
}

test revoke_changes_name() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    spend_tx(
      d,
      IdentityDatum {
        ..tombstone(d, revoked(ControllerSet, 5, None, None)),
        name: "x",
      },
      [hash(controller)],
    ),
  )
}

test revoke_takes_value() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    output_ap3x(
      to_tombstone(d, revoked(ControllerSet, 5, None, None), [hash(controller)]),
      deposit - 1,
    ),
  )
}

test revoke_of_tombstone() fail {
  let d = retired_tombstone()
  spend(
    Revoke { actor: ByController },
    spend_tx(
      d,
      IdentityDatum { ..d, status: revoked(ControllerSet, 5, None, None) },
      [hash(controller)],
    ),
  )
}

test revoke_range_over_one_hour() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    within(
      to_tombstone(d, revoked(ControllerSet, 5, None, None), [hash(controller)]),
      hi - max_range_ms - 1,
      hi,
    ),
  )
}

// ## Successor rules

test revoke_successor_is_record_itself() fail {
  let d = base()
  let tx =
    with_refs(
      to_tombstone(
        d,
        revoked(ControllerSet, 4, None, Some(record_id)),
        [hash(controller)],
      ),
      [record_input(31, record_id, other_record())],
    )
  spend(
    Revoke { actor: ByController },
    signed_also(tx, [hash(other_controller)]),
  )
}

test revoke_successor_without_consent() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    with_refs(
      to_tombstone(
        d,
        revoked(ControllerSet, 4, None, Some(successor_id)),
        [hash(controller)],
      ),
      [successor_ref()],
    ),
  )
}

test revoke_successor_is_subagent() fail {
  let d = base()
  let sub =
    IdentityDatum {
      ..other_record(),
      endpoint: "",
      lineage: Subagent { parent: chain_id(0), parent_epoch: 0, depth: 1 },
    }
  let tx =
    signed_also(
      with_refs(
        to_tombstone(
          d,
          revoked(ControllerSet, 4, None, Some(successor_id)),
          [hash(controller)],
        ),
        [record_input(30, successor_id, sub)],
      ),
      [hash(other_controller)],
    )
  spend(Revoke { actor: ByController }, tx)
}

test revoke_successor_is_tombstone() fail {
  let d = base()
  let ended =
    tombstone(other_record(), Retired { at: lo - day_ms, successor: None })
  let tx =
    signed_also(
      with_refs(
        to_tombstone(
          d,
          revoked(ControllerSet, 4, None, Some(successor_id)),
          [hash(controller)],
        ),
        [record_input(30, successor_id, ended)],
      ),
      [hash(other_controller)],
    )
  spend(Revoke { actor: ByController }, tx)
}

test revoke_successor_missing() fail {
  let d = base()
  spend(
    Revoke { actor: ByController },
    signed_also(
      to_tombstone(
        d,
        revoked(ControllerSet, 4, None, Some(successor_id)),
        [hash(controller)],
      ),
      [hash(other_controller)],
    ),
  )
}

test revoke_successor_suspended_record() {
  // A live record counts as a successor also when it is suspended.
  let d = base()
  let held = suspended(other_record(), [hold_in_force(signer(1))])
  let tx =
    signed_also(
      with_refs(
        to_tombstone(
          d,
          revoked(ControllerSet, 4, None, Some(successor_id)),
          [hash(controller)],
        ),
        [record_input(30, successor_id, held)],
      ),
      [hash(other_controller)],
    )
  spend(Revoke { actor: ByController }, tx)
}

// ## Retire

test retire_by_controller() {
  let d = base()
  spend(
    Retire,
    to_tombstone(d, Retired { at: lo, successor: None }, [hash(controller)]),
  )
}

test retire_with_successor() {
  let d = base()
  spend(
    Retire,
    with_successor(
      to_tombstone(
        d,
        Retired { at: lo, successor: Some(successor_id) },
        [hash(controller)],
      ),
    ),
  )
}

test retire_successor_without_consent() fail {
  let d = base()
  spend(
    Retire,
    with_refs(
      to_tombstone(
        d,
        Retired { at: lo, successor: Some(successor_id) },
        [hash(controller)],
      ),
      [successor_ref()],
    ),
  )
}

test retire_by_party() fail {
  let d = base()
  spend(Retire, to_tombstone(d, Retired { at: lo, successor: None }, [pkh(1)]))
}

test retire_takes_deposit_down_to_ledger_minimum() {
  let d = base()
  spend(
    Retire,
    output_ap3x(
      to_tombstone(d, Retired { at: lo, successor: None }, [hash(controller)]),
      1_500_000,
    ),
  )
}

test retire_at_not_lo() fail {
  let d = base()
  spend(
    Retire,
    to_tombstone(d, Retired { at: lo - 1, successor: None }, [hash(controller)]),
  )
}

test retire_not_tombstone() fail {
  let d = base()
  spend(
    Retire,
    spend_tx(
      d,
      IdentityDatum { ..d, status: Retired { at: lo, successor: None } },
      [hash(controller)],
    ),
  )
}

test retire_of_tombstone() fail {
  let d = revoked_tombstone()
  spend(
    Retire,
    spend_tx(
      d,
      IdentityDatum { ..d, status: Retired { at: lo, successor: None } },
      [hash(controller)],
    ),
  )
}

test retire_range_over_one_hour() fail {
  let d = base()
  spend(
    Retire,
    within(
      to_tombstone(d, Retired { at: lo, successor: None }, [hash(controller)]),
      hi - max_range_ms - 1,
      hi,
    ),
  )
}

// ## Reclaim

test reclaim_by_controller() {
  let d = revoked_tombstone()
  spend(Reclaim, output_ap3x(controller_tx(d, d), 1_500_000))
}

test reclaim_after_party_revocation() {
  let d = tombstone(base(), revoked(signer(1), 3, None, None))
  spend(Reclaim, output_ap3x(controller_tx(d, d), 1_500_000))
}

test reclaim_by_revoking_party() fail {
  let d = tombstone(base(), revoked(signer(1), 3, None, None))
  spend(Reclaim, output_ap3x(spend_tx(d, d, [pkh(1)]), 1_500_000))
}

test reclaim_of_live_record() fail {
  let d = base()
  spend(Reclaim, controller_tx(d, d))
}

test reclaim_changes_datum() fail {
  let d = revoked_tombstone()
  spend(Reclaim, controller_tx(d, IdentityDatum { ..d, name: "x" }))
}

test reclaim_back_to_live_status() fail {
  let d = revoked_tombstone()
  spend(Reclaim, controller_tx(d, IdentityDatum { ..d, status: Active }))
}

test reclaim_range_over_one_hour() fail {
  let d = revoked_tombstone()
  spend(Reclaim, within(controller_tx(d, d), hi - max_range_ms - 1, hi))
}

// ## SetSuccessor

fn set_successor_tx(
  d: IdentityDatum,
  status: Status,
  signers: List<ByteArray>,
) -> Transaction {
  with_successor(spend_tx(d, IdentityDatum { ..d, status }, signers))
}

test set_successor_after_controller_revocation() {
  let d = revoked_tombstone()
  expect Revoked { by, reason, at, invalid_from, .. } = d.status
  spend(
    SetSuccessor,
    set_successor_tx(
      d,
      Revoked { by, reason, at, invalid_from, successor: Some(successor_id) },
      [hash(controller)],
    ),
  )
}

test set_successor_after_party_revocation() {
  // Must pass (§12.1 Statuses).
  let d = tombstone(base(), revoked(signer(1), 3, None, None))
  spend(
    SetSuccessor,
    set_successor_tx(
      d,
      revoked(signer(1), 3, None, Some(successor_id)),
      [hash(controller)],
    ),
  )
}

test set_successor_after_retire() {
  let d = retired_tombstone()
  spend(
    SetSuccessor,
    set_successor_tx(
      d,
      Retired { at: lo - day_ms, successor: Some(successor_id) },
      [hash(controller)],
    ),
  )
}

test set_successor_by_revoking_party() fail {
  let d = tombstone(base(), revoked(signer(1), 3, None, None))
  spend(
    SetSuccessor,
    set_successor_tx(
      d,
      revoked(signer(1), 3, None, Some(successor_id)),
      [pkh(1)],
    ),
  )
}

test set_successor_twice() fail {
  let d =
    tombstone(
      base(),
      Retired { at: lo - day_ms, successor: Some(bytes(32, 0x5d)) },
    )
  spend(
    SetSuccessor,
    set_successor_tx(
      d,
      Retired { at: lo - day_ms, successor: Some(successor_id) },
      [hash(controller)],
    ),
  )
}

test set_successor_without_consent() fail {
  let d = retired_tombstone()
  spend(
    SetSuccessor,
    with_refs(
      spend_tx(
        d,
        IdentityDatum {
          ..d,
          status: Retired { at: lo - day_ms, successor: Some(successor_id) },
        },
        [hash(controller)],
      ),
      [successor_ref()],
    ),
  )
}

test set_successor_is_record_itself() fail {
  let d = retired_tombstone()
  let tx =
    with_refs(
      spend_tx(
        d,
        IdentityDatum {
          ..d,
          status: Retired { at: lo - day_ms, successor: Some(record_id) },
        },
        [hash(controller)],
      ),
      [record_input(31, record_id, other_record())],
    )
  spend(SetSuccessor, signed_also(tx, [hash(other_controller)]))
}

test set_successor_is_tombstone() fail {
  let d = retired_tombstone()
  let ended =
    tombstone(other_record(), Retired { at: lo - day_ms, successor: None })
  let tx =
    signed_also(
      with_refs(
        spend_tx(
          d,
          IdentityDatum {
            ..d,
            status: Retired { at: lo - day_ms, successor: Some(successor_id) },
          },
          [hash(controller)],
        ),
        [record_input(30, successor_id, ended)],
      ),
      [hash(other_controller)],
    )
  spend(SetSuccessor, tx)
}

test set_successor_changes_other_status_field() fail {
  let d = retired_tombstone()
  spend(
    SetSuccessor,
    set_successor_tx(
      d,
      Retired { at: lo, successor: Some(successor_id) },
      [hash(controller)],
    ),
  )
}

test set_successor_to_none() fail {
  let d = retired_tombstone()
  spend(SetSuccessor, controller_tx(d, d))
}

test set_successor_takes_value() fail {
  let d = retired_tombstone()
  spend(
    SetSuccessor,
    output_ap3x(
      set_successor_tx(
        d,
        Retired { at: lo - day_ms, successor: Some(successor_id) },
        [hash(controller)],
      ),
      deposit - 1,
    ),
  )
}

test set_successor_of_live_record() fail {
  // A live record cannot become a tombstone with a successor through
  // SetSuccessor.
  let d = base()
  spend(
    SetSuccessor,
    with_successor(
      to_tombstone(
        d,
        Retired { at: lo, successor: Some(successor_id) },
        [hash(controller)],
      ),
    ),
  )
}

test set_successor_range_over_one_hour() fail {
  let d = retired_tombstone()
  spend(
    SetSuccessor,
    within(
      set_successor_tx(
        d,
        Retired { at: lo - day_ms, successor: Some(successor_id) },
        [hash(controller)],
      ),
      hi - max_range_ms - 1,
      hi,
    ),
  )
}

// ## Tombstones accept only Reclaim and SetSuccessor

test tombstone_back_to_live_by_set_successor() fail {
  let d = retired_tombstone()
  spend(
    SetSuccessor,
    with_successor(
      controller_tx(d, IdentityDatum { ..record(), status: Active }),
    ),
  )
}

test tombstone_kit_matches_rules() {
  tombstone(base(), Retired { at: lo, successor: None }) == IdentityDatum {
    ..base(),
    keys: [],
    parties: [],
    guardian_threshold: 0,
    pending_recovery: None,
    description: "",
    framework: "",
    endpoint: "",
    capabilities: [],
    status: Retired { at: lo, successor: None },
  }
}

test reclaim_keeps_whole_deposit() {
  // The controller may also leave the whole deposit in the tombstone.
  let d = revoked_tombstone()
  spend(Reclaim, controller_tx(d, d))
}
