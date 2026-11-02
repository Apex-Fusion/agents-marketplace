//// Update tests (Part 2 §3.5 and §3.6): §12.1 rows Signatures, Parties
//// (removal, notice, changes, order, `Script` party), Recovery (guardian
//// bound, threshold 0), Time (`created_at` changed) and Value (floor).

use aiken/collection/list
use cardano/address
use cardano/transaction.{Transaction}
use identity_marketplace/identity/kit.{
  accountable, controller_tx, ed, ed_key, guardian, hash, hi, hold_in_force, lo,
  module1_party, other_script, output_ap3x, p256, pkh, pop, provider, record,
  responsible, revoked_tombstone, signed_also, signer, spend, spend_tx,
  suspended, with_module1, with_parties, within, without_config,
}
use vector_identity.{days_7_ms, max_range_ms}
use vector_identity/redeemers.{Update}
use vector_identity/types.{
  ControllerSet, IdentityDatum, Key, Party, PendingRecovery, Subagent,
} as identity

/// A record with the controller as Accountable Party, a Provider (signer 2)
/// and a guardian (signer 4) with threshold 1.
fn base() -> IdentityDatum {
  IdentityDatum {
    ..with_parties(
      record(),
      [accountable(ControllerSet), provider(signer(2)), guardian(signer(4))],
    ),
    guardian_threshold: 1,
  }
}

fn update(d: IdentityDatum, d2: IdentityDatum) -> Bool {
  spend(Update, controller_tx(d, d2))
}

fn update_signed(
  d: IdentityDatum,
  d2: IdentityDatum,
  extra: List<ByteArray>,
) -> Bool {
  spend(Update, signed_also(controller_tx(d, d2), extra))
}

fn notice(party: Party, t: Int) -> Party {
  Party { ..party, removal_after: Some(t) }
}

// ## Profile and value

test update_profile() {
  let d = base()
  update(
    d,
    IdentityDatum {
      ..d,
      name: "renamed",
      description: "new description",
      framework: "other",
      endpoint: "https://new.example",
      capabilities: ["a.v1", "b.v1"],
    },
  )
}

test update_without_change() {
  update(base(), base())
}

test update_takes_ap3x_down_to_floor() {
  spend(Update, output_ap3x(controller_tx(base(), base()), 10_000_000))
}

test update_below_floor() fail {
  spend(Update, output_ap3x(controller_tx(base(), base()), 9_999_999))
}

test update_while_suspended() {
  let d = suspended(base(), [hold_in_force(signer(2))])
  update(d, IdentityDatum { ..d, description: "changed" })
}

test update_controller_does_not_sign() fail {
  let d = base()
  spend(Update, spend_tx(d, IdentityDatum { ..d, name: "x" }, [pkh(2)]))
}

test update_range_over_one_hour() fail {
  spend(
    Update,
    within(controller_tx(base(), base()), hi - max_range_ms - 1, hi),
  )
}

// ## Fields that Update does not change

test update_changes_controller() fail {
  let d = base()
  update_signed(
    d,
    IdentityDatum { ..d, controller: kit.new_controller },
    [hash(kit.new_controller)],
  )
}

test update_changes_lineage() fail {
  let d = IdentityDatum { ..base(), endpoint: "" }
  update(
    d,
    IdentityDatum {
      ..d,
      lineage: Subagent { parent: kit.bytes(32, 7), parent_epoch: 0, depth: 1 },
    },
  )
}

test update_changes_epoch() fail {
  let d = base()
  update(d, IdentityDatum { ..d, subagent_epoch: 1 })
}

test update_changes_created_at() fail {
  let d = base()
  update(d, IdentityDatum { ..d, created_at: d.created_at + 1 })
}

test update_changes_status() fail {
  let d = suspended(base(), [hold_in_force(signer(2))])
  update(d, IdentityDatum { ..d, status: identity.Active })
}

test update_of_tombstone() fail {
  let d = revoked_tombstone()
  update(d, IdentityDatum { ..d, name: "x" })
}

// ## Keys

test update_adds_signed_ed25519_key() {
  let d = base()
  update_signed(
    d,
    IdentityDatum { ..d, keys: [ed(1, 27), ed(2, 3)] },
    [hash(ed_key(2))],
  )
}

test update_adds_unsigned_ed25519_key() fail {
  let d = base()
  update(d, IdentityDatum { ..d, keys: [ed(1, 27), ed(2, 3)] })
}

test update_adds_p256_key() {
  let d = base()
  update(d, IdentityDatum { ..d, keys: [ed(1, 27), p256(1, 3)] })
}

test update_adds_p256_key_without_pop() fail {
  let d = base()
  update(
    d,
    IdentityDatum { ..d, keys: [ed(1, 27), Key { ..p256(1, 3), pop: None }] },
  )
}

test update_removes_key() {
  let d = base()
  update(d, IdentityDatum { ..d, keys: [] })
}

test update_reorders_keys() {
  let d = IdentityDatum { ..base(), keys: [ed(1, 27), p256(1, 3)] }
  update(d, IdentityDatum { ..d, keys: [p256(1, 3), ed(1, 27)] })
}

test update_kept_key_changes_purposes() fail {
  let d = base()
  update_signed(d, IdentityDatum { ..d, keys: [ed(1, 3)] }, [hash(ed_key(1))])
}

test update_kept_p256_key_changes_pop() fail {
  let d = IdentityDatum { ..base(), keys: [p256(1, 3)] }
  update(
    d,
    IdentityDatum {
      ..d,
      keys: [Key { ..p256(1, 3), pop: Some(kit.bytes(64, 0x51)) }],
    },
  )
}

test update_kept_key_changes_purposes_with_pop_unchanged() fail {
  let d = IdentityDatum { ..base(), keys: [p256(1, 3)] }
  update(
    d,
    IdentityDatum {
      ..d,
      keys: [Key { ..p256(1, 3), purposes: 1, pop: Some(pop) }],
    },
  )
}

// ## Parties: appointment and change

test update_appoints_signed_party() {
  let d = base()
  update_signed(
    d,
    IdentityDatum {
      ..d,
      parties: list.concat(d.parties, [responsible(signer(5))]),
    },
    [pkh(5)],
  )
}

test update_appointment_not_signed() fail {
  let d = base()
  update(
    d,
    IdentityDatum {
      ..d,
      parties: list.concat(d.parties, [responsible(signer(5))]),
    },
  )
}

test update_changes_party_with_signature() {
  let d = base()
  update_signed(
    d,
    IdentityDatum {
      ..d,
      parties: [
        accountable(ControllerSet),
        Party { ..provider(signer(2)), rights: 0 },
        guardian(signer(4)),
      ],
    },
    [pkh(2)],
  )
}

test update_changes_party_without_signature() fail {
  let d = base()
  update(
    d,
    IdentityDatum {
      ..d,
      parties: [
        accountable(ControllerSet),
        Party { ..provider(signer(2)), not_after: Some(hi + days_7_ms) },
        guardian(signer(4)),
      ],
    },
  )
}

test update_rights_above_role() fail {
  let d = base()
  update_signed(
    d,
    IdentityDatum {
      ..d,
      parties: [
        accountable(ControllerSet),
        Party { ..provider(signer(2)), rights: 3 },
        guardian(signer(4)),
      ],
    },
    [pkh(2)],
  )
}

test update_appoints_party_twice() fail {
  let d = base()
  update_signed(
    d,
    IdentityDatum {
      ..d,
      parties: list.concat(
        d.parties,
        [Party { ..provider(signer(2)), rights: 0 }],
      ),
    },
    [pkh(2)],
  )
}

// ## Parties: removal and notice

test update_gives_notice_of_7_days() {
  let d = base()
  update(
    d,
    IdentityDatum {
      ..d,
      parties: [
        accountable(ControllerSet),
        notice(provider(signer(2)), hi + days_7_ms),
        guardian(signer(4)),
      ],
    },
  )
}

test update_notice_shorter_than_7_days() fail {
  let d = base()
  update(
    d,
    IdentityDatum {
      ..d,
      parties: [
        accountable(ControllerSet),
        notice(provider(signer(2)), hi + days_7_ms - 1),
        guardian(signer(4)),
      ],
    },
  )
}

test update_notice_counted_from_lo() fail {
  // 7 days from `lo` is less than 7 days from `hi`.
  let d = base()
  update(
    d,
    IdentityDatum {
      ..d,
      parties: [
        accountable(ControllerSet),
        notice(provider(signer(2)), lo + days_7_ms),
        guardian(signer(4)),
      ],
    },
  )
}

test update_notice_with_other_change() fail {
  let d = base()
  update(
    d,
    IdentityDatum {
      ..d,
      parties: [
        accountable(ControllerSet),
        Party { ..notice(provider(signer(2)), hi + days_7_ms), rights: 0 },
        guardian(signer(4)),
      ],
    },
  )
}

test update_moves_notice_without_signature() fail {
  let d =
    with_parties(
      base(),
      [
        accountable(ControllerSet),
        notice(provider(signer(2)), hi + 9 * 86_400_000),
        guardian(signer(4)),
      ],
    )
  update(
    d,
    IdentityDatum {
      ..d,
      parties: [
        accountable(ControllerSet),
        notice(provider(signer(2)), hi + days_7_ms),
        guardian(signer(4)),
      ],
    },
  )
}

test update_cancels_notice_without_signature() fail {
  let d =
    with_parties(
      base(),
      [
        accountable(ControllerSet),
        notice(provider(signer(2)), hi + days_7_ms),
        guardian(signer(4)),
      ],
    )
  update(d, base())
}

test update_removes_party_after_notice() {
  let d =
    with_parties(
      base(),
      [
        accountable(ControllerSet),
        notice(provider(signer(2)), lo),
        guardian(signer(4)),
      ],
    )
  update(d, with_parties(d, [accountable(ControllerSet), guardian(signer(4))]))
}

test update_removes_party_before_notice_ends() fail {
  let d =
    with_parties(
      base(),
      [
        accountable(ControllerSet),
        notice(provider(signer(2)), lo + 1),
        guardian(signer(4)),
      ],
    )
  update(d, with_parties(d, [accountable(ControllerSet), guardian(signer(4))]))
}

test update_removes_party_without_consent_or_notice() fail {
  let d = base()
  update(d, with_parties(d, [accountable(ControllerSet), guardian(signer(4))]))
}

test update_removes_party_with_consent() {
  let d = base()
  update_signed(
    d,
    with_parties(d, [accountable(ControllerSet), guardian(signer(4))]),
    [pkh(2)],
  )
}

test update_removes_last_accountable_party() {
  let d = with_parties(base(), [accountable(signer(1)), guardian(signer(4))])
  update_signed(d, with_parties(d, [guardian(signer(4))]), [pkh(1)])
}

// ## Parties: order

test update_keeps_order_and_appends() {
  let d = base()
  update_signed(
    d,
    with_parties(
      d,
      [accountable(ControllerSet), guardian(signer(4)), provider(signer(6))],
    ),
    [pkh(2), pkh(6)],
  )
}

test update_reorders_matched_parties() fail {
  let d = base()
  update_signed(
    d,
    with_parties(
      d,
      [accountable(ControllerSet), guardian(signer(4)), provider(signer(2))],
    ),
    [pkh(2), pkh(4)],
  )
}

test update_new_party_before_matched_party() fail {
  let d = base()
  update_signed(
    d,
    with_parties(
      d,
      [
        accountable(ControllerSet),
        provider(signer(6)),
        provider(signer(2)),
        guardian(signer(4)),
      ],
    ),
    [pkh(6)],
  )
}

// ## Guardian threshold and recovery

test update_threshold_above_guardian_bound() fail {
  let d = base()
  update(d, IdentityDatum { ..d, guardian_threshold: 2 })
}

test update_guardian_leaves_threshold_lowered() {
  let d =
    IdentityDatum {
      ..with_parties(
        record(),
        [
          accountable(ControllerSet),
          guardian(signer(4)),
          notice(guardian(signer(5)), lo),
        ],
      ),
      guardian_threshold: 2,
    }
  update(
    d,
    IdentityDatum {
      ..with_parties(d, [accountable(ControllerSet), guardian(signer(4))]),
      guardian_threshold: 1,
    },
  )
}

test update_guardian_leaves_threshold_kept() fail {
  let d =
    IdentityDatum {
      ..with_parties(
        record(),
        [
          accountable(ControllerSet),
          guardian(signer(4)),
          notice(guardian(signer(5)), lo),
        ],
      ),
      guardian_threshold: 2,
    }
  update(d, with_parties(d, [accountable(ControllerSet), guardian(signer(4))]))
}

test update_profile_with_threshold_above_bound_kept() {
  // The bound is checked only when parties or the threshold change: a
  // guardian whose period ended does not block a profile change.
  let d =
    with_parties(
      base(),
      [
        accountable(ControllerSet),
        provider(signer(2)),
        Party { ..guardian(signer(4)), not_after: Some(lo) },
      ],
    )
  update(d, IdentityDatum { ..d, description: "changed" })
}

fn pending() -> Option<PendingRecovery> {
  Some(
    PendingRecovery {
      new_controller: kit.new_controller,
      effective_after: hi + days_7_ms,
    },
  )
}

test update_threshold_0_cancels_pending_recovery() {
  let d = IdentityDatum { ..base(), pending_recovery: pending() }
  update(
    d,
    IdentityDatum { ..d, guardian_threshold: 0, pending_recovery: None },
  )
}

test update_threshold_0_with_pending_recovery() fail {
  let d = IdentityDatum { ..base(), pending_recovery: pending() }
  update(d, IdentityDatum { ..d, guardian_threshold: 0 })
}

test update_clears_pending_recovery_without_threshold_0() fail {
  let d = IdentityDatum { ..base(), pending_recovery: pending() }
  update(d, IdentityDatum { ..d, pending_recovery: None })
}

test update_sets_pending_recovery() fail {
  let d = base()
  update(d, IdentityDatum { ..d, pending_recovery: pending() })
}

test update_keeps_pending_recovery() {
  let d = IdentityDatum { ..base(), pending_recovery: pending() }
  update(d, IdentityDatum { ..d, name: "x" })
}

// ## Module-1 as a party

fn with_module1_party() -> IdentityDatum {
  with_parties(
    base(),
    [
      accountable(ControllerSet),
      provider(signer(2)),
      guardian(signer(4)),
      module1_party(),
    ],
  )
}

test update_appoints_module1() {
  let d = base()
  spend(Update, with_module1(controller_tx(d, with_module1_party())))
}

test update_appoints_module1_without_withdrawal() fail {
  update(base(), with_module1_party())
}

test update_appoints_module1_without_configuration() fail {
  spend(
    Update,
    without_config(with_module1(controller_tx(base(), with_module1_party()))),
  )
}

test update_appoints_other_script() fail {
  let d2 =
    with_parties(
      base(),
      [
        accountable(ControllerSet),
        provider(signer(2)),
        guardian(signer(4)),
        responsible(identity.Script { hash: other_script }),
      ],
    )
  spend(
    Update,
    Transaction {
      ..controller_tx(base(), d2),
      withdrawals: [Pair(address.Script(other_script), 0)],
    },
  )
}

test update_with_module1_party_kept() {
  let d = with_module1_party()
  update(d, IdentityDatum { ..d, name: "x" })
}

test update_with_module1_party_needs_configuration() fail {
  // Decision: a record output with a `Script` party is a valid datum only
  // with `M1` from the configuration reference input.
  let d = with_module1_party()
  spend(
    Update,
    without_config(controller_tx(d, IdentityDatum { ..d, name: "x" })),
  )
}

test update_gives_module1_notice() {
  let d = with_module1_party()
  update(
    d,
    with_parties(
      d,
      [
        accountable(ControllerSet),
        provider(signer(2)),
        guardian(signer(4)),
        notice(module1_party(), hi + days_7_ms),
      ],
    ),
  )
}

test update_removes_module1_after_notice_without_configuration() {
  let d =
    with_parties(
      base(),
      [
        accountable(ControllerSet),
        provider(signer(2)),
        guardian(signer(4)),
        notice(module1_party(), lo),
      ],
    )
  spend(Update, without_config(controller_tx(d, base())))
}

test update_removes_module1_before_notice_ends() fail {
  let d = with_module1_party()
  update(d, base())
}

test update_removes_module1_with_withdrawal_relies_on_module1() {
  // Identity side: `ok(Script { M1 })` holds with the withdrawal, so the
  // removal counts as consented. Module-1's withdraw handler never consents
  // to its own early removal (Part 2 §3.8), so this transaction fails
  // on-chain there.
  let d = with_module1_party()
  spend(Update, with_module1(controller_tx(d, base())))
}
