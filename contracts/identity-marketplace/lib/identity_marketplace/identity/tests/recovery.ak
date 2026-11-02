//// ChangeController, BumpEpoch and recovery tests (Part 2 §3.5): §12.1 rows
//// Recovery, Signatures (new controller), Value, Subagents (survival of an
//// epoch increase, a controller change or a recovery) and Time.

use identity_marketplace/identity/kit.{
  accountable, controller, controller_tx, deposit, guardian, hash, hi,
  hold_in_force, lo, new_controller, output_ap3x, pkh, provider, record,
  record_id, record_input, revoked_tombstone, signer, spend, spend_tx, subagent,
  suspended, with_parties, within,
}
use vector_identity.{days_7_ms, effective, max_range_ms}
use vector_identity/redeemers.{
  BumpEpoch, ChangeController, RecoverCancel, RecoverFinalize, RecoverInit,
}
use vector_identity/types.{
  ControllerSet, EffActive, EffRevoked, Effective, IdentityDatum, Party,
  PendingRecovery,
}

/// Parties: 0 controller (Accountable), 1–3 guardians (signers 11–13),
/// 4 signer 2 (Provider). Threshold 2.
fn guarded() -> IdentityDatum {
  IdentityDatum {
    ..with_parties(
      record(),
      [
        accountable(ControllerSet),
        guardian(signer(11)),
        guardian(signer(12)),
        guardian(signer(13)),
        provider(signer(2)),
      ],
    ),
    guardian_threshold: 2,
  }
}

fn pending(effective_after: Int) -> Option<PendingRecovery> {
  Some(PendingRecovery { new_controller, effective_after })
}

fn with_pending(d: IdentityDatum, effective_after: Int) -> IdentityDatum {
  IdentityDatum { ..d, pending_recovery: pending(effective_after) }
}

fn init(
  guardians: List<Int>,
  d: IdentityDatum,
  d2: IdentityDatum,
  signers: List<ByteArray>,
) -> Bool {
  spend(RecoverInit { guardians }, spend_tx(d, d2, signers))
}

fn init_signers() -> List<ByteArray> {
  [pkh(11), pkh(12), hash(new_controller)]
}

/// The record after a finalised recovery of `d`.
fn recovered(d: IdentityDatum) -> IdentityDatum {
  IdentityDatum {
    ..d,
    controller: new_controller,
    pending_recovery: None,
    subagent_epoch: d.subagent_epoch + 1,
  }
}

// ## RecoverInit

test recover_init() {
  let d = guarded()
  init([1, 2], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_with_every_guardian() {
  let d = guarded()
  init(
    [3, 1, 2],
    d,
    with_pending(d, hi + days_7_ms),
    [pkh(13), ..init_signers()],
  )
}

test recover_init_while_suspended() {
  let d = suspended(guarded(), [hold_in_force(signer(2))])
  init([1, 2], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_below_threshold() fail {
  let d = guarded()
  init([1], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_same_index_twice() fail {
  let d = guarded()
  init([1, 1], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_same_signer_twice() fail {
  // Two guardian parties with one signer: a valid datum never has them.
  let d =
    IdentityDatum {
      ..with_parties(
        record(),
        [
          accountable(ControllerSet),
          guardian(signer(11)),
          Party { ..guardian(signer(11)), not_before: lo - 1 },
        ],
      ),
      guardian_threshold: 2,
    }
  init([1, 2], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_with_non_guardian() fail {
  let d = guarded()
  init([1, 4], d, with_pending(d, hi + days_7_ms), [pkh(2), ..init_signers()])
}

test recover_init_guardian_without_recover_right() fail {
  let d =
    with_parties(
      guarded(),
      [
        accountable(ControllerSet),
        guardian(signer(11)),
        Party { ..guardian(signer(12)), rights: 0 },
        guardian(signer(13)),
        provider(signer(2)),
      ],
    )
  init([1, 2], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_guardian_before_its_period() fail {
  let d =
    with_parties(
      guarded(),
      [
        accountable(ControllerSet),
        guardian(signer(11)),
        Party { ..guardian(signer(12)), not_before: lo + 1 },
        guardian(signer(13)),
        provider(signer(2)),
      ],
    )
  init([1, 2], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_guardian_after_its_period() fail {
  let d =
    with_parties(
      guarded(),
      [
        accountable(ControllerSet),
        guardian(signer(11)),
        Party { ..guardian(signer(12)), not_after: Some(hi - 1) },
        guardian(signer(13)),
        provider(signer(2)),
      ],
    )
  init([1, 2], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_guardian_does_not_sign() fail {
  let d = guarded()
  init(
    [1, 2],
    d,
    with_pending(d, hi + days_7_ms),
    [pkh(11), hash(new_controller)],
  )
}

test recover_init_without_new_key_signature() fail {
  let d = guarded()
  init([1, 2], d, with_pending(d, hi + days_7_ms), [pkh(11), pkh(12)])
}

test recover_init_with_recovery_pending() fail {
  let d = with_pending(guarded(), hi)
  init([1, 2], d, with_pending(d, hi + days_7_ms), init_signers())
}

test recover_init_delay_from_lo() fail {
  let d = guarded()
  init([1, 2], d, with_pending(d, lo + days_7_ms), init_signers())
}

test recover_init_short_delay() fail {
  let d = guarded()
  init([1, 2], d, with_pending(d, hi + days_7_ms - 1), init_signers())
}

test recover_init_threshold_0() fail {
  let d = IdentityDatum { ..guarded(), guardian_threshold: 0 }
  init(
    [1, 2],
    d,
    IdentityDatum { ..with_pending(d, hi + days_7_ms), guardian_threshold: 1 },
    init_signers(),
  )
}

test recover_init_changes_other_field() fail {
  let d = guarded()
  init(
    [1, 2],
    d,
    IdentityDatum { ..with_pending(d, hi + days_7_ms), name: "x" },
    init_signers(),
  )
}

test recover_init_takes_value() fail {
  let d = guarded()
  spend(
    RecoverInit { guardians: [1, 2] },
    output_ap3x(
      spend_tx(d, with_pending(d, hi + days_7_ms), init_signers()),
      deposit - 1,
    ),
  )
}

test recover_init_new_controller_not_32_bytes() fail {
  let d = guarded()
  let short = kit.bytes(31, 0xc1)
  init(
    [1, 2],
    d,
    IdentityDatum {
      ..d,
      pending_recovery: Some(
        PendingRecovery {
          new_controller: short,
          effective_after: hi + days_7_ms,
        },
      ),
    },
    [pkh(11), pkh(12), hash(short)],
  )
}

test recover_init_of_tombstone() fail {
  let d = revoked_tombstone()
  init([], d, d, init_signers())
}

test recover_init_range_over_one_hour() fail {
  let d = guarded()
  spend(
    RecoverInit { guardians: [1, 2] },
    within(
      spend_tx(d, with_pending(d, hi + days_7_ms), init_signers()),
      hi - max_range_ms - 1,
      hi,
    ),
  )
}

// ## RecoverCancel

fn cancel(
  guardians: List<Int>,
  d: IdentityDatum,
  d2: IdentityDatum,
  signers: List<ByteArray>,
) -> Bool {
  spend(RecoverCancel { guardians }, spend_tx(d, d2, signers))
}

test recover_cancel() {
  let d = with_pending(guarded(), hi)
  cancel([2, 3], d, guarded(), [pkh(12), pkh(13)])
}

test recover_cancel_below_threshold() fail {
  let d = with_pending(guarded(), hi)
  cancel([2], d, guarded(), [pkh(12), pkh(13)])
}

test recover_cancel_without_pending() fail {
  cancel([2, 3], guarded(), guarded(), [pkh(12), pkh(13)])
}

test recover_cancel_with_non_guardian() fail {
  let d = with_pending(guarded(), hi)
  cancel([2, 4], d, guarded(), [pkh(12), pkh(2)])
}

test recover_cancel_by_controller() fail {
  let d = with_pending(guarded(), hi)
  cancel([], d, guarded(), [hash(controller)])
}

test recover_cancel_keeps_pending() fail {
  let d = with_pending(guarded(), hi)
  cancel([2, 3], d, d, [pkh(12), pkh(13)])
}

test recover_cancel_takes_value() fail {
  let d = with_pending(guarded(), hi)
  spend(
    RecoverCancel { guardians: [2, 3] },
    output_ap3x(spend_tx(d, guarded(), [pkh(12), pkh(13)]), deposit - 1),
  )
}

test recover_cancel_range_over_one_hour() fail {
  let d = with_pending(guarded(), hi)
  spend(
    RecoverCancel { guardians: [2, 3] },
    within(
      spend_tx(d, guarded(), [pkh(12), pkh(13)]),
      hi - max_range_ms - 1,
      hi,
    ),
  )
}

// ## RecoverFinalize

test recover_finalize_by_anybody() {
  let d = with_pending(guarded(), lo)
  spend(RecoverFinalize, spend_tx(d, recovered(d), []))
}

test recover_finalize_keeps_holds() {
  let d =
    with_pending(
      suspended(
        guarded(),
        [hold_in_force(signer(2)), hold_in_force(ControllerSet)],
      ),
      lo,
    )
  spend(RecoverFinalize, spend_tx(d, recovered(d), []))
}

test recover_finalize_before_effective_after() fail {
  let d = with_pending(guarded(), lo + 1)
  spend(RecoverFinalize, spend_tx(d, recovered(d), []))
}

test recover_finalize_without_pending() fail {
  let d = guarded()
  spend(RecoverFinalize, spend_tx(d, recovered(d), []))
}

test recover_finalize_other_controller() fail {
  let d = with_pending(guarded(), lo)
  spend(
    RecoverFinalize,
    spend_tx(
      d,
      IdentityDatum { ..recovered(d), controller: kit.other_controller },
      [],
    ),
  )
}

test recover_finalize_epoch_not_increased() fail {
  let d = with_pending(guarded(), lo)
  spend(
    RecoverFinalize,
    spend_tx(
      d,
      IdentityDatum { ..recovered(d), subagent_epoch: d.subagent_epoch },
      [],
    ),
  )
}

test recover_finalize_takes_value() fail {
  let d = with_pending(guarded(), lo)
  spend(
    RecoverFinalize,
    output_ap3x(spend_tx(d, recovered(d), []), deposit - 1),
  )
}

test recover_finalize_after_guardian_period_ended() {
  // Must pass (§12.1 Recovery): the guardians' periods ended after the start.
  let d =
    with_pending(
      with_parties(
        guarded(),
        [
          accountable(ControllerSet),
          Party { ..guardian(signer(11)), not_after: Some(lo - 1) },
          Party { ..guardian(signer(12)), not_after: Some(lo - 1) },
          guardian(signer(13)),
          provider(signer(2)),
        ],
      ),
      lo,
    )
  spend(RecoverFinalize, spend_tx(d, recovered(d), []))
}

test recover_finalize_range_over_one_hour() fail {
  let d = with_pending(guarded(), lo - max_range_ms)
  spend(
    RecoverFinalize,
    within(spend_tx(d, recovered(d), []), hi - max_range_ms - 1, hi),
  )
}

// ## ChangeController

fn changed(d: IdentityDatum) -> IdentityDatum {
  IdentityDatum {
    ..d,
    controller: new_controller,
    subagent_epoch: d.subagent_epoch + 1,
    pending_recovery: None,
  }
}

fn change_signers() -> List<ByteArray> {
  [hash(controller), hash(new_controller)]
}

test change_controller() {
  let d = guarded()
  spend(ChangeController, spend_tx(d, changed(d), change_signers()))
}

test change_controller_cancels_pending_recovery() {
  let d = with_pending(guarded(), hi)
  spend(ChangeController, spend_tx(d, changed(d), change_signers()))
}

test change_controller_keeps_pending_recovery() fail {
  let d = with_pending(guarded(), hi)
  spend(
    ChangeController,
    spend_tx(
      d,
      IdentityDatum { ..changed(d), pending_recovery: d.pending_recovery },
      change_signers(),
    ),
  )
}

test change_controller_keeps_holds() {
  let d =
    suspended(
      guarded(),
      [hold_in_force(signer(2)), hold_in_force(ControllerSet)],
    )
  spend(ChangeController, spend_tx(d, changed(d), change_signers()))
}

test change_controller_lifts_holds() fail {
  let d = suspended(guarded(), [hold_in_force(signer(2))])
  spend(
    ChangeController,
    spend_tx(
      d,
      IdentityDatum {
        ..changed(d),
        status: kit.with_status(d, kit.record().status).status,
      },
      change_signers(),
    ),
  )
}

test change_controller_new_key_does_not_sign() fail {
  let d = guarded()
  spend(ChangeController, spend_tx(d, changed(d), [hash(controller)]))
}

test change_controller_old_key_does_not_sign() fail {
  let d = guarded()
  spend(ChangeController, spend_tx(d, changed(d), [hash(new_controller)]))
}

test change_controller_epoch_not_increased() fail {
  let d = guarded()
  spend(
    ChangeController,
    spend_tx(
      d,
      IdentityDatum { ..changed(d), subagent_epoch: d.subagent_epoch },
      change_signers(),
    ),
  )
}

test change_controller_changes_other_field() fail {
  let d = guarded()
  spend(
    ChangeController,
    spend_tx(d, IdentityDatum { ..changed(d), name: "x" }, change_signers()),
  )
}

test change_controller_down_to_floor() {
  let d = guarded()
  spend(
    ChangeController,
    output_ap3x(spend_tx(d, changed(d), change_signers()), 10_000_000),
  )
}

test change_controller_below_floor() fail {
  let d = guarded()
  spend(
    ChangeController,
    output_ap3x(spend_tx(d, changed(d), change_signers()), 9_999_999),
  )
}

test change_controller_of_tombstone() fail {
  let d = revoked_tombstone()
  spend(
    ChangeController,
    spend_tx(
      d,
      IdentityDatum { ..d, controller: new_controller, subagent_epoch: 1 },
      change_signers(),
    ),
  )
}

test change_controller_range_over_one_hour() fail {
  let d = guarded()
  spend(
    ChangeController,
    within(spend_tx(d, changed(d), change_signers()), hi - max_range_ms - 1, hi),
  )
}

test recovery_after_controller_change() fail {
  // The controller change cancelled the pending recovery, so it cannot
  // complete.
  let d = changed(with_pending(guarded(), lo))
  spend(RecoverFinalize, spend_tx(d, recovered(with_pending(d, lo)), []))
}

// ## BumpEpoch

fn bumped(d: IdentityDatum) -> IdentityDatum {
  IdentityDatum { ..d, subagent_epoch: d.subagent_epoch + 1 }
}

test bump_epoch() {
  let d = guarded()
  spend(BumpEpoch, controller_tx(d, bumped(d)))
}

test bump_epoch_by_party() fail {
  let d = guarded()
  spend(BumpEpoch, spend_tx(d, bumped(d), [pkh(2)]))
}

test bump_epoch_by_two() fail {
  let d = guarded()
  spend(BumpEpoch, controller_tx(d, bumped(bumped(d))))
}

test bump_epoch_changes_other_field() fail {
  let d = guarded()
  spend(
    BumpEpoch,
    controller_tx(d, IdentityDatum { ..bumped(d), guardian_threshold: 1 }),
  )
}

test bump_epoch_down_to_floor() {
  let d = guarded()
  spend(BumpEpoch, output_ap3x(controller_tx(d, bumped(d)), 10_000_000))
}

test bump_epoch_below_floor() fail {
  let d = guarded()
  spend(BumpEpoch, output_ap3x(controller_tx(d, bumped(d)), 9_999_999))
}

test bump_epoch_of_tombstone() fail {
  let d = revoked_tombstone()
  spend(BumpEpoch, controller_tx(d, bumped(d)))
}

test bump_epoch_range_over_one_hour() fail {
  let d = guarded()
  spend(
    BumpEpoch,
    within(controller_tx(d, bumped(d)), hi - max_range_ms - 1, hi),
  )
}

// ## Subagents do not survive an epoch increase, a controller change or a
// recovery

/// The effective status of a subagent (lineage epoch 0) of `parent`.
fn child_status(parent: IdentityDatum) -> Effective {
  let child = IdentityDatum { ..subagent(record_id, 0, 1), created_at: lo - 1 }
  effective(child, [record_input(5, record_id, parent)], kit.own, lo, hi)
}

test subagent_active_before_epoch_increase() {
  child_status(guarded()) == EffActive
}

test subagent_ends_with_epoch_increase() {
  let d = guarded()
  spend(BumpEpoch, controller_tx(d, bumped(d))) && child_status(bumped(d)) == EffRevoked
}

test subagent_ends_with_controller_change() {
  let d = guarded()
  spend(ChangeController, spend_tx(d, changed(d), change_signers())) && child_status(
    changed(d),
  ) == EffRevoked
}

test subagent_ends_with_recovery() {
  let d = with_pending(guarded(), lo)
  spend(RecoverFinalize, spend_tx(d, recovered(d), [])) && child_status(
    recovered(d),
  ) == EffRevoked
}
