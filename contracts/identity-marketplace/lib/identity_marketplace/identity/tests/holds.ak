//// Suspend and Unsuspend tests (Part 2 §3.5): §12.1 rows Holds, Parties
//// (rights, period, reason 64, Module-1 withdrawal), Module-1 verdicts
//// (identity side), Value and Recovery (actions after a guardian's period).

use aiken/collection/list
use identity_marketplace/identity/kit.{
  accountable, controller, distributor, guardian, hash, hi, hold_in_force,
  hold_lapsed, lo, module1, module1_party, output_ap3x, pkh, provider, record,
  responsible, revoked_tombstone, signer, spend, spend_tx, suspended,
  with_module1, with_parties, within, without_config,
}
use vector_identity.{day_ms, days_30_ms, max_range_ms}
use vector_identity/redeemers.{Actor, ByController, ByParty, Suspend, Unsuspend}
use vector_identity/types.{
  Active, ControllerSet, Hold, IdentityDatum, KeyHash, Party, Signer, Suspended,
}

/// Parties: 0 controller (Accountable), 1 signer 1 (Accountable), 2 signer 3
/// (Responsible), 3 signer 2 (Provider), 4 signer 5 (Distributor), 5 signer 4
/// (Guardian), 6 Module-1 (Accountable).
fn parties() -> List<Party> {
  [
    accountable(ControllerSet),
    accountable(signer(1)),
    responsible(signer(3)),
    provider(signer(2)),
    distributor(signer(5)),
    guardian(signer(4)),
    module1_party(),
  ]
}

fn base() -> IdentityDatum {
  with_parties(record(), parties())
}

/// A new hold by `by` with reason 6 from `lo`, for one day.
fn new_hold(by: Signer) -> Hold {
  Hold { by, reason: 6, since: lo, until: lo + day_ms }
}

fn with_holds(d: IdentityDatum, holds: List<Hold>) -> IdentityDatum {
  when holds is {
    [] -> IdentityDatum { ..d, status: Active }
    _ -> suspended(d, holds)
  }
}

/// A Suspend from `d` to `d` with `holds`, signed by `signers`.
fn suspend(
  actor: Actor,
  d: IdentityDatum,
  holds: List<Hold>,
  signers: List<ByteArray>,
) -> Bool {
  spend(Suspend { actor }, spend_tx(d, with_holds(d, holds), signers))
}

/// An Unsuspend from `d` to `d` with `holds`, signed by `signers`.
fn unsuspend(
  author: Signer,
  d: IdentityDatum,
  holds: List<Hold>,
  signers: List<ByteArray>,
) -> Bool {
  spend(Unsuspend { author }, spend_tx(d, with_holds(d, holds), signers))
}

// ## Suspend

test suspend_by_controller() {
  suspend(ByController, base(), [new_hold(ControllerSet)], [hash(controller)])
}

test suspend_by_party() {
  suspend(ByParty { index: 3 }, base(), [new_hold(signer(2))], [pkh(2)])
}

test suspend_for_30_days() {
  suspend(
    ByParty { index: 1 },
    base(),
    [Hold { by: signer(1), reason: 65, since: lo, until: lo + days_30_ms }],
    [pkh(1)],
  )
}

test suspend_over_30_days() fail {
  suspend(
    ByParty { index: 1 },
    base(),
    [Hold { by: signer(1), reason: 65, since: lo, until: lo + days_30_ms + 1 }],
    [pkh(1)],
  )
}

test suspend_until_not_after_hi() fail {
  suspend(
    ByController,
    base(),
    [Hold { by: ControllerSet, reason: 6, since: lo, until: hi }],
    [hash(controller)],
  )
}

test suspend_since_not_lo() fail {
  suspend(
    ByController,
    base(),
    [Hold { by: ControllerSet, reason: 6, since: lo - 1, until: lo + day_ms }],
    [hash(controller)],
  )
}

test suspend_hold_of_other_author() fail {
  suspend(ByController, base(), [new_hold(signer(2))], [hash(controller)])
}

test suspend_every_allowed_reason() {
  let d = base()
  list.all(
    [0, 6, 9, 65, 67, 68],
    fn(reason) {
      suspend(
        ByController,
        d,
        [Hold { ..new_hold(ControllerSet), reason }],
        [hash(controller)],
      )
    },
  )
}

test suspend_reason_not_allowed() {
  let d = base()
  list.all(
    [1, 3, 4, 5, 66, 69, 74, 75],
    fn(reason) {
      !suspend(
        ByController,
        d,
        [Hold { ..new_hold(ControllerSet), reason }],
        [hash(controller)],
      )
    },
  )
}

test suspend_keeps_holds_of_other_authors() {
  let d =
    suspended(base(), [hold_in_force(ControllerSet), hold_in_force(signer(1))])
  suspend(
    ByParty { index: 3 },
    d,
    [
      hold_in_force(ControllerSet),
      hold_in_force(signer(1)),
      new_hold(signer(2)),
    ],
    [pkh(2)],
  )
}

test suspend_drops_hold_in_force_of_other_author() fail {
  let d =
    suspended(base(), [hold_in_force(ControllerSet), hold_in_force(signer(1))])
  suspend(
    ByParty { index: 3 },
    d,
    [hold_in_force(ControllerSet), new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_shortens_hold_of_other_author() fail {
  let d = suspended(base(), [hold_in_force(signer(1))])
  suspend(
    ByParty { index: 3 },
    d,
    [Hold { ..hold_in_force(signer(1)), until: lo + 1 }, new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_reorders_holds() fail {
  let d =
    suspended(base(), [hold_in_force(ControllerSet), hold_in_force(signer(1))])
  suspend(
    ByParty { index: 3 },
    d,
    [
      hold_in_force(signer(1)),
      hold_in_force(ControllerSet),
      new_hold(signer(2)),
    ],
    [pkh(2)],
  )
}

test suspend_renews_own_hold() {
  let d =
    suspended(base(), [hold_in_force(signer(2)), hold_in_force(ControllerSet)])
  suspend(
    ByParty { index: 3 },
    d,
    [hold_in_force(ControllerSet), new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_shortens_own_hold() {
  // Each author owns its hold; only Module-1 has the "never shorter" rule,
  // and Module-1 enforces it.
  let d =
    suspended(
      base(),
      [Hold { ..hold_in_force(signer(2)), until: lo + 20 * day_ms }],
    )
  suspend(ByParty { index: 3 }, d, [new_hold(signer(2))], [pkh(2)])
}

test suspend_two_holds_by_one_author() fail {
  let d = suspended(base(), [hold_in_force(signer(2))])
  suspend(
    ByParty { index: 3 },
    d,
    [hold_in_force(signer(2)), new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_drops_lapsed_holds() {
  let d =
    suspended(base(), [hold_lapsed(signer(1)), hold_in_force(ControllerSet)])
  suspend(
    ByParty { index: 3 },
    d,
    [hold_in_force(ControllerSet), new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_keeps_lapsed_hold() fail {
  let d =
    suspended(base(), [hold_lapsed(signer(1)), hold_in_force(ControllerSet)])
  suspend(
    ByParty { index: 3 },
    d,
    [hold_lapsed(signer(1)), hold_in_force(ControllerSet), new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_drops_hold_of_removed_key_party() {
  // Must pass (§12.1 Holds): signer 9 is no longer a party.
  let d =
    suspended(base(), [hold_in_force(signer(9)), hold_in_force(ControllerSet)])
  suspend(
    ByParty { index: 3 },
    d,
    [hold_in_force(ControllerSet), new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_keeps_hold_of_removed_key_party() fail {
  let d =
    suspended(base(), [hold_in_force(signer(9)), hold_in_force(ControllerSet)])
  suspend(
    ByParty { index: 3 },
    d,
    [
      hold_in_force(signer(9)),
      hold_in_force(ControllerSet),
      new_hold(signer(2)),
    ],
    [pkh(2)],
  )
}

/// Holds by nine removed key parties (signers 21–29) and by the controller.
fn ten_holds() -> List<Hold> {
  [
    hold_in_force(ControllerSet),
    ..list.map(
      [21, 22, 23, 24, 25, 26, 27, 28, 29],
      fn(n) { hold_in_force(signer(n)) },
    )
  ]
}

test suspend_not_blocked_by_holds_of_removed_party_keys() {
  // The controller cannot fill the 10 holds with party keys that it removed
  // and so block another party's Suspend.
  let d = suspended(base(), ten_holds())
  suspend(
    ByParty { index: 3 },
    d,
    [hold_in_force(ControllerSet), new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_more_than_10_holds() fail {
  let d = suspended(base(), ten_holds())
  suspend(
    ByParty { index: 3 },
    d,
    list.concat(ten_holds(), [new_hold(signer(2))]),
    [pkh(2)],
  )
}

test suspend_controller_party_key_does_not_block() {
  // The controller's own key is also a party (Provider) with a hold. Another
  // party's Suspend keeps both controller holds and adds its own.
  let own_key = KeyHash { hash: hash(controller) }
  let d =
    suspended(
      with_parties(
        record(),
        [accountable(ControllerSet), provider(own_key), provider(signer(2))],
      ),
      [hold_in_force(ControllerSet), hold_in_force(own_key)],
    )
  suspend(
    ByParty { index: 2 },
    d,
    [hold_in_force(ControllerSet), hold_in_force(own_key), new_hold(signer(2))],
    [pkh(2)],
  )
}

test suspend_controller_party_key_cannot_lift_other_hold() fail {
  let own_key = KeyHash { hash: hash(controller) }
  let d =
    suspended(
      with_parties(
        record(),
        [accountable(ControllerSet), provider(own_key), provider(signer(2))],
      ),
      [hold_in_force(signer(2))],
    )
  unsuspend(signer(2), d, [], [hash(controller)])
}

test suspend_by_distributor() fail {
  suspend(ByParty { index: 4 }, base(), [new_hold(signer(5))], [pkh(5)])
}

test suspend_by_guardian() fail {
  suspend(ByParty { index: 5 }, base(), [new_hold(signer(4))], [pkh(4)])
}

test suspend_by_party_without_suspend_right() fail {
  let d =
    with_parties(
      record(),
      [accountable(ControllerSet), Party { ..provider(signer(2)), rights: 0 }],
    )
  suspend(ByParty { index: 1 }, d, [new_hold(signer(2))], [pkh(2)])
}

test suspend_by_party_before_its_period() fail {
  let d =
    with_parties(
      record(),
      [
        accountable(ControllerSet),
        Party { ..provider(signer(2)), not_before: lo + 1 },
      ],
    )
  suspend(ByParty { index: 1 }, d, [new_hold(signer(2))], [pkh(2)])
}

test suspend_by_party_after_its_period() fail {
  let d =
    with_parties(
      record(),
      [
        accountable(ControllerSet),
        Party { ..provider(signer(2)), not_after: Some(hi - 1) },
      ],
    )
  suspend(ByParty { index: 1 }, d, [new_hold(signer(2))], [pkh(2)])
}

test suspend_by_party_without_signature() fail {
  suspend(
    ByParty { index: 3 },
    base(),
    [new_hold(signer(2))],
    [hash(controller)],
  )
}

test suspend_by_controller_without_signature() fail {
  suspend(ByController, base(), [new_hold(ControllerSet)], [pkh(2)])
}

test suspend_by_party_index_out_of_range() fail {
  suspend(ByParty { index: 7 }, base(), [new_hold(signer(2))], [pkh(2)])
}

test suspend_takes_value() fail {
  let d = base()
  let tx =
    spend_tx(d, with_holds(d, [new_hold(ControllerSet)]), [hash(controller)])
  spend(Suspend { actor: ByController }, output_ap3x(tx, kit.deposit - 1))
}

test suspend_adds_value() {
  let d = base()
  let tx =
    spend_tx(d, with_holds(d, [new_hold(ControllerSet)]), [hash(controller)])
  spend(Suspend { actor: ByController }, output_ap3x(tx, kit.deposit + 1))
}

test suspend_changes_other_field() fail {
  let d = base()
  let tx =
    spend_tx(
      d,
      IdentityDatum { ..with_holds(d, [new_hold(ControllerSet)]), name: "x" },
      [hash(controller)],
    )
  spend(Suspend { actor: ByController }, tx)
}

test suspend_of_tombstone() fail {
  let d = revoked_tombstone()
  spend(
    Suspend { actor: ByController },
    spend_tx(
      d,
      IdentityDatum {
        ..d,
        status: Suspended { holds: [new_hold(ControllerSet)] },
      },
      [hash(controller)],
    ),
  )
}

test suspend_range_over_one_hour() fail {
  let d = base()
  let tx =
    spend_tx(d, with_holds(d, [new_hold(ControllerSet)]), [hash(controller)])
  spend(Suspend { actor: ByController }, within(tx, hi - max_range_ms - 1, hi))
}

// ## Module-1 holds (identity side)

fn module1_hold(until: Int) -> Hold {
  Hold { by: module1(), reason: 64, since: lo, until }
}

test suspend_by_module1() {
  let d = base()
  let tx = spend_tx(d, with_holds(d, [module1_hold(lo + 3 * day_ms)]), [])
  spend(Suspend { actor: ByParty { index: 6 } }, with_module1(tx))
}

test suspend_by_module1_without_withdrawal() fail {
  let d = base()
  let tx = spend_tx(d, with_holds(d, [module1_hold(lo + 3 * day_ms)]), [])
  spend(Suspend { actor: ByParty { index: 6 } }, tx)
}

test suspend_by_module1_without_configuration() fail {
  let d = base()
  let tx = spend_tx(d, with_holds(d, [module1_hold(lo + 3 * day_ms)]), [])
  spend(
    Suspend { actor: ByParty { index: 6 } },
    without_config(with_module1(tx)),
  )
}

test suspend_reason_64_by_controller() fail {
  suspend(
    ByController,
    base(),
    [Hold { ..new_hold(ControllerSet), reason: 64 }],
    [hash(controller)],
  )
}

test suspend_reason_64_by_key_party() fail {
  suspend(
    ByParty { index: 1 },
    base(),
    [Hold { ..new_hold(signer(1)), reason: 64 }],
    [pkh(1)],
  )
}

test suspend_keeps_module1_hold_after_removal_without_configuration() {
  // Module-1 is no longer a party; its hold in force stays. The transaction
  // has no configuration reference input.
  let d =
    suspended(
      with_parties(record(), [accountable(ControllerSet), provider(signer(2))]),
      [module1_hold(lo + 10 * day_ms)],
    )
  let tx =
    spend_tx(
      d,
      with_holds(d, [module1_hold(lo + 10 * day_ms), new_hold(signer(2))]),
      [pkh(2)],
    )
  spend(Suspend { actor: ByParty { index: 1 } }, without_config(tx))
}

test suspend_drops_module1_hold_after_removal_without_configuration() fail {
  let d =
    suspended(
      with_parties(record(), [accountable(ControllerSet), provider(signer(2))]),
      [module1_hold(lo + 10 * day_ms)],
    )
  let tx = spend_tx(d, with_holds(d, [new_hold(signer(2))]), [pkh(2)])
  spend(Suspend { actor: ByParty { index: 1 } }, without_config(tx))
}

test suspend_drops_module1_hold_after_removal_with_configuration() fail {
  let d =
    suspended(
      with_parties(record(), [accountable(ControllerSet), provider(signer(2))]),
      [module1_hold(lo + 10 * day_ms)],
    )
  suspend(ByParty { index: 1 }, d, [new_hold(signer(2))], [pkh(2)])
}

test unsuspend_keeps_module1_hold_after_removal_without_configuration() {
  let d =
    suspended(
      with_parties(record(), [accountable(ControllerSet), provider(signer(2))]),
      [module1_hold(lo + 10 * day_ms), hold_in_force(signer(2))],
    )
  let tx =
    spend_tx(d, with_holds(d, [module1_hold(lo + 10 * day_ms)]), [pkh(2)])
  spend(Unsuspend { author: signer(2) }, without_config(tx))
}

test unsuspend_drops_module1_hold_after_removal() fail {
  let d =
    suspended(
      with_parties(record(), [accountable(ControllerSet), provider(signer(2))]),
      [module1_hold(lo + 10 * day_ms), hold_in_force(signer(2))],
    )
  let tx = spend_tx(d, with_holds(d, []), [pkh(2)])
  spend(Unsuspend { author: signer(2) }, without_config(tx))
}

test unsuspend_module1_hold_without_withdrawal() fail {
  let d = suspended(base(), [module1_hold(lo + 10 * day_ms)])
  unsuspend(module1(), d, [], [hash(controller)])
}

test unsuspend_module1_hold_by_controller() fail {
  let d = suspended(base(), [module1_hold(lo + 10 * day_ms)])
  unsuspend(ControllerSet, d, [], [hash(controller)])
}

test unsuspend_by_module1_relies_on_module1_withdraw_rule() {
  // Identity side: `ok(Script { M1 })` holds with the withdrawal. Module-1's
  // withdraw handler approves only Consent and verdict applications, so this
  // transaction fails on-chain there (Part 2 §3.8).
  let d = suspended(base(), [module1_hold(lo + 10 * day_ms)])
  let tx = spend_tx(d, with_holds(d, []), [])
  spend(Unsuspend { author: module1() }, with_module1(tx))
}

// ## Unsuspend

test unsuspend_by_author() {
  let d =
    suspended(base(), [hold_in_force(ControllerSet), hold_in_force(signer(2))])
  unsuspend(signer(2), d, [hold_in_force(ControllerSet)], [pkh(2)])
}

test unsuspend_last_hold_gives_active() {
  let d = suspended(base(), [hold_in_force(signer(2))])
  unsuspend(signer(2), d, [], [pkh(2)])
}

test unsuspend_last_hold_kept_suspended() fail {
  let d = suspended(base(), [hold_in_force(signer(2))])
  spend(
    Unsuspend { author: signer(2) },
    spend_tx(
      d,
      IdentityDatum { ..d, status: Suspended { holds: [] } },
      [pkh(2)],
    ),
  )
}

test unsuspend_controller_hold() {
  let d =
    suspended(base(), [hold_in_force(ControllerSet), hold_in_force(signer(2))])
  unsuspend(ControllerSet, d, [hold_in_force(signer(2))], [hash(controller)])
}

test unsuspend_by_other_signer() fail {
  let d =
    suspended(base(), [hold_in_force(ControllerSet), hold_in_force(signer(2))])
  unsuspend(
    signer(2),
    d,
    [hold_in_force(ControllerSet)],
    [hash(controller), pkh(1)],
  )
}

test unsuspend_controller_drops_party_hold() fail {
  let d =
    suspended(base(), [hold_in_force(ControllerSet), hold_in_force(signer(2))])
  unsuspend(ControllerSet, d, [], [hash(controller)])
}

test unsuspend_author_without_hold() fail {
  let d = suspended(base(), [hold_in_force(ControllerSet)])
  unsuspend(signer(2), d, [hold_in_force(ControllerSet)], [pkh(2)])
}

test unsuspend_of_active_record() fail {
  unsuspend(ControllerSet, base(), [], [hash(controller)])
}

test unsuspend_lapsed_own_hold() {
  let d = suspended(base(), [hold_lapsed(signer(2)), hold_in_force(signer(1))])
  unsuspend(signer(2), d, [hold_in_force(signer(1))], [pkh(2)])
}

test unsuspend_drops_lapsed_and_removed_holds() {
  let d =
    suspended(
      base(),
      [
        hold_lapsed(signer(1)),
        hold_in_force(signer(9)),
        hold_in_force(ControllerSet),
        hold_in_force(signer(2)),
      ],
    )
  unsuspend(signer(2), d, [hold_in_force(ControllerSet)], [pkh(2)])
}

test unsuspend_shortens_other_hold() fail {
  let d =
    suspended(base(), [hold_in_force(ControllerSet), hold_in_force(signer(2))])
  unsuspend(
    signer(2),
    d,
    [Hold { ..hold_in_force(ControllerSet), until: lo + 1 }],
    [pkh(2)],
  )
}

test unsuspend_takes_value() fail {
  let d = suspended(base(), [hold_in_force(signer(2))])
  let tx = spend_tx(d, with_holds(d, []), [pkh(2)])
  spend(Unsuspend { author: signer(2) }, output_ap3x(tx, kit.deposit - 1))
}

test unsuspend_range_over_one_hour() fail {
  let d = suspended(base(), [hold_in_force(signer(2))])
  let tx = spend_tx(d, with_holds(d, []), [pkh(2)])
  spend(Unsuspend { author: signer(2) }, within(tx, hi - max_range_ms - 1, hi))
}

// ## After a guardian's period ended (§12.1 Recovery, must pass)

fn ended_guardian() -> IdentityDatum {
  IdentityDatum {
    ..with_parties(
      record(),
      [
        accountable(ControllerSet),
        provider(signer(2)),
        Party { ..guardian(signer(4)), not_after: Some(lo - 1) },
      ],
    ),
    guardian_threshold: 1,
  }
}

test suspend_after_guardian_period_ended() {
  suspend(
    ByParty { index: 1 },
    ended_guardian(),
    [new_hold(signer(2))],
    [pkh(2)],
  )
}

test unsuspend_after_guardian_period_ended() {
  let d = suspended(ended_guardian(), [hold_in_force(signer(2))])
  unsuspend(signer(2), d, [], [pkh(2)])
}
