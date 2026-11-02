//// Fuzzers of valid identity spends for the property tests of Part 2 §12.3.
////
//// A `Case` is one spend of the record `kit.record_id`: the redeemer, the
//// datums `D` and `D'`, the required signers, the Module-1 withdrawal, the
//// successor reference input and the AP3X of the record input and output.
//// `transition()` covers the 12 spend actions on `kit.record()`,
//// `kit.largest()` and `kit.largest_guarded()` with random holds, authors,
//// reasons, times, guardians and amounts. The required signers are only the
//// ones that the action needs. `prop_transitions_pass` checks that the spend
//// handler accepts every case, so the properties that change a case test the
//// changed rule and nothing else.

use aiken/collection/list
use aiken/fuzz
use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Input, Transaction}
use identity_marketplace/identity/kit
use identity_marketplace/identity/rules.{
  covers, has_right, kept_holds, terminal, tombstone,
}
use identity_marketplace/identity/spend.{spend_ok}
use vector_identity.{day_ms, days_30_ms, days_7_ms, right_revoke, right_suspend}
use vector_identity/redeemers.{
  Actor, BumpEpoch, ByController, ByParty, ChangeController, IdentitySpend,
  Reclaim, RecoverCancel, RecoverFinalize, RecoverInit, Retire, Revoke,
  SetSuccessor, Suspend, Unsuspend, Update,
}
use vector_identity/types.{
  Active, ControllerSet, Hold, IdentityDatum, KeyHash, PendingRecovery, Retired,
  Revoked, Script, Signer, Status, Suspended,
}

// ## Cases

pub type Case {
  redeemer: IdentitySpend,
  /// `D`, the datum of the spent record.
  before: IdentityDatum,
  /// `D'`, the datum of the record output.
  after: IdentityDatum,
  /// The required signers.
  signers: List<ByteArray>,
  /// The withdrawal for `Script(M1)`.
  module1: Bool,
  /// The live record of `kit.successor_id` as a reference input.
  successor: Bool,
  input_ap3x: Int,
  output_ap3x: Int,
}

/// The live root record that a successor names, controlled by
/// `kit.other_controller`.
pub fn successor_record() -> IdentityDatum {
  IdentityDatum { ..kit.record(), controller: kit.other_controller }
}

/// The spend of the case: the record input and a wallet input, the
/// configuration reference input (and the successor record), one record
/// output with `output_value`, the window `[kit.lo, kit.hi]`.
pub fn tx_with_output(c: Case, output_value: Value) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: kit.record_ref(),
        output: kit.output(
          kit.identity_address(),
          kit.record_value(kit.record_id, c.input_ap3x),
          InlineDatum(c.before),
        ),
      },
      kit.wallet_input(),
    ],
    reference_inputs: if c.successor {
      [
        kit.config_input(),
        kit.record_input(30, kit.successor_id, successor_record()),
      ]
    } else {
      [kit.config_input()]
    },
    outputs: [
      kit.output(kit.identity_address(), output_value, InlineDatum(c.after)),
    ],
    withdrawals: if c.module1 {
      kit.module1_withdrawal()
    } else {
      []
    },
    validity_range: kit.range(kit.lo, kit.hi),
    extra_signatories: c.signers,
  }
}

pub fn tx(c: Case) -> Transaction {
  tx_with_output(c, kit.record_value(kit.record_id, c.output_ap3x))
}

/// The spend handler of the identity validator on `transaction`, for the
/// redeemer of the case.
pub fn run(c: Case, transaction: Transaction) -> Bool {
  spend_ok(kit.params(), c.redeemer, kit.record_ref(), transaction)
}

pub fn passes(c: Case) -> Bool {
  run(c, tx(c))
}

/// The action of a redeemer, for labels.
pub fn action(redeemer: IdentitySpend) -> String {
  when redeemer is {
    Update -> @"Update"
    ChangeController -> @"ChangeController"
    Suspend { .. } -> @"Suspend"
    Unsuspend { .. } -> @"Unsuspend"
    Revoke { .. } -> @"Revoke"
    Retire -> @"Retire"
    Reclaim -> @"Reclaim"
    SetSuccessor -> @"SetSuccessor"
    BumpEpoch -> @"BumpEpoch"
    RecoverInit { .. } -> @"RecoverInit"
    RecoverCancel { .. } -> @"RecoverCancel"
    RecoverFinalize -> @"RecoverFinalize"
  }
}

// ## Records

/// The least AP3X of a live record output.
const live_minimum: Int = 10_000_000

fn amount() -> Fuzzer<Int> {
  fuzz.int_between(live_minimum, 100_000_000)
}

/// The authors that can hold a record in these tests: the controller,
/// Module-1 and the key parties 1 to 8.
pub fn author_pool() -> List<Signer> {
  [
    ControllerSet,
    kit.module1(),
    kit.signer(1),
    kit.signer(2),
    kit.signer(3),
    kit.signer(4),
    kit.signer(5),
    kit.signer(6),
    kit.signer(7),
    kit.signer(8),
  ]
}

/// A hold by `by`: in force (`until` up to 20 days after `lo`) or lapsed
/// (`until` at most `lo`), for 1 ms to 30 days.
pub fn random_hold(by: Signer) -> Fuzzer<Hold> {
  let in_force <- fuzz.and_then(fuzz.bool())
  let offset <- fuzz.and_then(fuzz.int_between(1, 20 * day_ms))
  let length <- fuzz.map(fuzz.int_between(1, days_30_ms))
  let until =
    if in_force {
      kit.lo + offset
    } else {
      kit.lo - offset + 1
    }
  Hold { by, reason: hold_reason(by), since: until - length, until }
}

fn hold_reason(by: Signer) -> Int {
  if by == kit.module1() {
    64
  } else {
    6
  }
}

pub fn random_holds(authors: List<Signer>) -> Fuzzer<List<Hold>> {
  when authors is {
    [] -> fuzz.constant([])
    [by, ..rest] -> {
      let first <- fuzz.and_then(random_hold(by))
      let others <- fuzz.map(random_holds(rest))
      [first, ..others]
    }
  }
}

pub fn holds_of(status: Status) -> List<Hold> {
  when status is {
    Suspended { holds } -> holds
    _ -> []
  }
}

/// `d` with `holds`: Suspended, or Active when there is none.
pub fn with_holds(d: IdentityDatum, holds: List<Hold>) -> IdentityDatum {
  IdentityDatum {
    ..d,
    status: when holds is {
      [] -> Active
      _ -> Suspended { holds }
    },
  }
}

/// `kit.record()`, `kit.largest()` or `kit.largest_guarded()`.
pub fn base_record() -> Fuzzer<IdentityDatum> {
  let choice <- fuzz.map(fuzz.int_between(0, 2))
  when choice is {
    0 -> kit.record()
    1 -> kit.largest()
    _ -> kit.largest_guarded()
  }
}

/// A live record with random holds (none, some lapsed, some in force).
pub fn live_record() -> Fuzzer<IdentityDatum> {
  let base <- fuzz.and_then(base_record())
  let authors <- fuzz.and_then(fuzz.sublist(author_pool()))
  let holds <- fuzz.map(random_holds(authors))
  with_holds(base, holds)
}

/// A live record with at least one hold.
fn held_record() -> Fuzzer<IdentityDatum> {
  let base <- fuzz.and_then(base_record())
  let first <- fuzz.and_then(fuzz.one_of(author_pool()))
  let others <- fuzz.and_then(fuzz.sublist(author_pool()))
  let holds <-
    fuzz.map(random_holds([first, ..list.filter(others, fn(s) { s != first })]))
  with_holds(base, holds)
}

/// `kit.largest_guarded()` (guardians at indices 5, 6 and 7) with a random
/// threshold of 1 to 3 and random holds.
fn guarded_record() -> Fuzzer<IdentityDatum> {
  let threshold <- fuzz.and_then(fuzz.int_between(1, 3))
  let authors <- fuzz.and_then(fuzz.sublist(author_pool()))
  let holds <- fuzz.map(random_holds(authors))
  with_holds(
    IdentityDatum { ..kit.largest_guarded(), guardian_threshold: threshold },
    holds,
  )
}

/// A tombstone of a live record: revoked by the controller, a key party or
/// Module-1, or retired, 1 to 30 days before `lo`, with a successor when
/// `named` (not for Module-1).
fn ended_record(named: Bool) -> Fuzzer<IdentityDatum> {
  let d <- fuzz.and_then(live_record())
  let kind <- fuzz.and_then(fuzz.int_between(0, 3))
  let days <- fuzz.map(fuzz.int_between(1, 30))
  let at = kit.lo - days * day_ms
  let successor =
    if named {
      Some(kit.successor_id)
    } else {
      None
    }
  tombstone(
    d,
    when kind is {
      0 ->
        Revoked {
          by: ControllerSet,
          reason: 5,
          at,
          invalid_from: None,
          successor,
        }
      1 ->
        Revoked {
          by: kit.signer(1),
          reason: 3,
          at,
          invalid_from: None,
          successor,
        }
      2 ->
        Revoked {
          by: kit.module1(),
          reason: 64,
          at,
          invalid_from: None,
          successor: None,
        }
      _ -> Retired { at, successor }
    },
  )
}

// ## Actors

/// Who acts for a `Suspend` or a `Revoke`: the redeemer actor, the author,
/// the required signers and the Module-1 withdrawal.
pub type Acting {
  actor: Actor,
  author: Signer,
  signers: List<ByteArray>,
  module1: Bool,
}

fn controller_signers() -> List<ByteArray> {
  [kit.hash(kit.controller)]
}

/// The required signers and the Module-1 withdrawal that make `ok(signer)`.
pub fn signing(signer: Signer) -> (List<ByteArray>, Bool) {
  when signer is {
    KeyHash { hash } -> ([hash], False)
    Script { .. } -> ([], True)
    ControllerSet -> (controller_signers(), False)
  }
}

/// The controller, and each party of `d` with `right` that covers the window.
pub fn actors(d: IdentityDatum, right: Int) -> List<Acting> {
  let by_parties =
    list.indexed_map(d.parties, fn(index, party) { (index, party) })
      |> list.filter_map(
          fn(entry) {
            let (index, party) = entry
            if has_right(party.rights, right) && covers(party, kit.lo, kit.hi) {
              let (signers, module1) = signing(party.signer)
              Some(
                Acting {
                  actor: ByParty { index },
                  author: party.signer,
                  signers,
                  module1,
                },
              )
            } else {
              None
            }
          },
        )
  [
    Acting {
      actor: ByController,
      author: ControllerSet,
      signers: controller_signers(),
      module1: False,
    },
    ..by_parties
  ]
}

fn suspend_reasons_of(author: Signer) -> List<Int> {
  if author == kit.module1() {
    [64, 0, 6, 9, 65, 67, 68]
  } else {
    [0, 6, 9, 65, 67, 68]
  }
}

fn revoke_reasons_of(author: Signer) -> List<Int> {
  if author == kit.module1() {
    [64, 0, 1, 3, 4, 5, 9, 65]
  } else {
    [0, 1, 3, 4, 5, 9, 65]
  }
}

// ## Actions

/// Update: a new name and description; the controller can take AP3X down to
/// 10 AP3X.
fn update_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(live_record())
  let name <- fuzz.and_then(fuzz.bytearray_between(1, 64))
  let description <- fuzz.and_then(fuzz.bytearray_between(0, 256))
  let input <- fuzz.and_then(amount())
  let output <- fuzz.map(amount())
  Case {
    redeemer: Update,
    before: d,
    after: IdentityDatum { ..d, name, description },
    signers: controller_signers(),
    module1: False,
    successor: False,
    input_ap3x: input,
    output_ap3x: output,
  }
}

fn change_controller_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(live_record())
  let input <- fuzz.and_then(amount())
  let output <- fuzz.map(amount())
  Case {
    redeemer: ChangeController,
    before: d,
    after: IdentityDatum {
      ..d,
      controller: kit.new_controller,
      subagent_epoch: d.subagent_epoch + 1,
      pending_recovery: None,
    },
    signers: [kit.hash(kit.controller), kit.hash(kit.new_controller)],
    module1: False,
    successor: False,
    input_ap3x: input,
    output_ap3x: output,
  }
}

fn bump_epoch_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(live_record())
  let input <- fuzz.and_then(amount())
  let output <- fuzz.map(amount())
  Case {
    redeemer: BumpEpoch,
    before: d,
    after: IdentityDatum { ..d, subagent_epoch: d.subagent_epoch + 1 },
    signers: controller_signers(),
    module1: False,
    successor: False,
    input_ap3x: input,
    output_ap3x: output,
  }
}

/// Suspend by the controller or a party with the suspend right: the kept
/// holds of the other current authors, then the new hold.
pub fn suspend_of(d: IdentityDatum, a: Acting) -> Fuzzer<Case> {
  let until <- fuzz.and_then(fuzz.int_between(kit.hi + 1, kit.lo + days_30_ms))
  let reason <- fuzz.and_then(fuzz.one_of(suspend_reasons_of(a.author)))
  let input <- fuzz.and_then(amount())
  let extra <- fuzz.map(fuzz.int_between(0, 5_000_000))
  let holds =
    list.concat(
      kept_holds(holds_of(d.status), d.parties, kit.lo, a.author),
      [Hold { by: a.author, reason, since: kit.lo, until }],
    )
  Case {
    redeemer: Suspend { actor: a.actor },
    before: d,
    after: IdentityDatum { ..d, status: Suspended { holds } },
    signers: a.signers,
    module1: a.module1,
    successor: False,
    input_ap3x: input,
    output_ap3x: input + extra,
  }
}

fn suspend_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(live_record())
  let a <- fuzz.and_then(fuzz.one_of(actors(d, right_suspend)))
  suspend_of(d, a)
}

/// Unsuspend by the author of a hold of `d`.
pub fn unsuspend_of(d: IdentityDatum, author: Signer) -> Fuzzer<Case> {
  let input <- fuzz.and_then(amount())
  let extra <- fuzz.map(fuzz.int_between(0, 5_000_000))
  let (signers, module1) = signing(author)
  Case {
    redeemer: Unsuspend { author },
    before: d,
    after: with_holds(
      d,
      kept_holds(holds_of(d.status), d.parties, kit.lo, author),
    ),
    signers,
    module1,
    successor: False,
    input_ap3x: input,
    output_ap3x: input + extra,
  }
}

fn unsuspend_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(held_record())
  let hold <- fuzz.and_then(fuzz.one_of(holds_of(d.status)))
  unsuspend_of(d, hold.by)
}

/// Revoke by the controller (with or without a successor) or by a party with
/// the revoke right (without a successor).
fn revoke_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(live_record())
  let a <- fuzz.and_then(fuzz.one_of(actors(d, right_revoke)))
  let reason <- fuzz.and_then(fuzz.one_of(revoke_reasons_of(a.author)))
  let invalid_time <- fuzz.and_then(fuzz.int_between(d.created_at, kit.lo))
  let set_invalid <- fuzz.and_then(fuzz.bool())
  let wants_successor <- fuzz.and_then(fuzz.bool())
  let input <- fuzz.and_then(amount())
  let extra <- fuzz.map(fuzz.int_between(0, 5_000_000))
  let named = wants_successor && a.actor == ByController
  let status =
    Revoked {
      by: a.author,
      reason,
      at: kit.lo,
      invalid_from: if reason == 1 || set_invalid {
        Some(invalid_time)
      } else {
        None
      },
      successor: if named {
        Some(kit.successor_id)
      } else {
        None
      },
    }
  Case {
    redeemer: Revoke { actor: a.actor },
    before: d,
    after: tombstone(d, status),
    signers: if named {
      [kit.hash(kit.other_controller), ..a.signers]
    } else {
      a.signers
    },
    module1: a.module1,
    successor: named,
    input_ap3x: input,
    output_ap3x: input + extra,
  }
}

/// Retire, with or without a successor; the controller decides where the
/// AP3X goes.
fn retire_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(live_record())
  let named <- fuzz.and_then(fuzz.bool())
  let input <- fuzz.and_then(amount())
  let output <- fuzz.map(fuzz.int_between(1_000_000, input))
  Case {
    redeemer: Retire,
    before: d,
    after: tombstone(
      d,
      Retired {
        at: kit.lo,
        successor: if named {
          Some(kit.successor_id)
        } else {
          None
        },
      },
    ),
    signers: if named {
      [kit.hash(kit.other_controller), ..controller_signers()]
    } else {
      controller_signers()
    },
    module1: False,
    successor: named,
    input_ap3x: input,
    output_ap3x: output,
  }
}

pub fn reclaim_case() -> Fuzzer<Case> {
  let named <- fuzz.and_then(fuzz.bool())
  let d <- fuzz.and_then(ended_record(named))
  let input <- fuzz.and_then(amount())
  let output <- fuzz.map(fuzz.int_between(1_000_000, input))
  Case {
    redeemer: Reclaim,
    before: d,
    after: d,
    signers: controller_signers(),
    module1: False,
    successor: False,
    input_ap3x: input,
    output_ap3x: output,
  }
}

pub fn set_successor_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(ended_record(False))
  let input <- fuzz.and_then(amount())
  let extra <- fuzz.map(fuzz.int_between(0, 5_000_000))
  let status =
    when d.status is {
      Revoked { by, reason, at, invalid_from, .. } ->
        Revoked {
          by,
          reason,
          at,
          invalid_from,
          successor: Some(kit.successor_id),
        }
      Retired { at, .. } -> Retired { at, successor: Some(kit.successor_id) }
      other -> other
    }
  Case {
    redeemer: SetSuccessor,
    before: d,
    after: IdentityDatum { ..d, status },
    signers: [kit.hash(kit.other_controller), ..controller_signers()],
    module1: False,
    successor: True,
    input_ap3x: input,
    output_ap3x: input + extra,
  }
}

/// A random order of at least `threshold` of the guardians 5, 6 and 7 of
/// `kit.largest_guarded()`.
fn guardians(threshold: Int) -> Fuzzer<List<Int>> {
  let order <-
    fuzz.and_then(
      fuzz.one_of(
        [[5, 6, 7], [5, 7, 6], [6, 5, 7], [6, 7, 5], [7, 5, 6], [7, 6, 5]],
      ),
    )
  let count <- fuzz.map(fuzz.int_between(threshold, 3))
  list.take(order, count)
}

/// The signers of the guardians at `indices` (party 5 is signer 11).
fn guardian_signers(indices: List<Int>) -> List<ByteArray> {
  list.map(indices, fn(index) { kit.pkh(index + 6) })
}

fn recover_init_case() -> Fuzzer<Case> {
  let d <- fuzz.and_then(guarded_record())
  let chosen <- fuzz.and_then(guardians(d.guardian_threshold))
  let input <- fuzz.and_then(amount())
  let extra <- fuzz.map(fuzz.int_between(0, 5_000_000))
  Case {
    redeemer: RecoverInit { guardians: chosen },
    before: d,
    after: IdentityDatum {
      ..d,
      pending_recovery: Some(
        PendingRecovery {
          new_controller: kit.new_controller,
          effective_after: kit.hi + days_7_ms,
        },
      ),
    },
    signers: list.concat(
      guardian_signers(chosen),
      [kit.hash(kit.new_controller)],
    ),
    module1: False,
    successor: False,
    input_ap3x: input,
    output_ap3x: input + extra,
  }
}

/// A guarded record with a pending recovery that becomes effective
/// `effective_after`.
fn pending_record(effective_after: Fuzzer<Int>) -> Fuzzer<IdentityDatum> {
  let d <- fuzz.and_then(guarded_record())
  let after <- fuzz.map(effective_after)
  IdentityDatum {
    ..d,
    pending_recovery: Some(
      PendingRecovery {
        new_controller: kit.new_controller,
        effective_after: after,
      },
    ),
  }
}

fn recover_cancel_case() -> Fuzzer<Case> {
  let d <-
    fuzz.and_then(
      pending_record(fuzz.int_between(kit.lo - days_7_ms, kit.hi + days_7_ms)),
    )
  let chosen <- fuzz.and_then(guardians(d.guardian_threshold))
  let input <- fuzz.and_then(amount())
  let extra <- fuzz.map(fuzz.int_between(0, 5_000_000))
  Case {
    redeemer: RecoverCancel { guardians: chosen },
    before: d,
    after: IdentityDatum { ..d, pending_recovery: None },
    signers: guardian_signers(chosen),
    module1: False,
    successor: False,
    input_ap3x: input,
    output_ap3x: input + extra,
  }
}

/// RecoverFinalize: anybody, after `effective_after`; no signer.
fn recover_finalize_case() -> Fuzzer<Case> {
  let d <-
    fuzz.and_then(pending_record(fuzz.int_between(kit.lo - days_30_ms, kit.lo)))
  let input <- fuzz.and_then(amount())
  let extra <- fuzz.map(fuzz.int_between(0, 5_000_000))
  Case {
    redeemer: RecoverFinalize,
    before: d,
    after: IdentityDatum {
      ..d,
      controller: kit.new_controller,
      pending_recovery: None,
      subagent_epoch: d.subagent_epoch + 1,
    },
    signers: [],
    module1: False,
    successor: False,
    input_ap3x: input,
    output_ap3x: input + extra,
  }
}

/// A valid spend of one of the 12 actions.
pub fn transition() -> Fuzzer<Case> {
  let choice <- fuzz.and_then(fuzz.int_between(0, 11))
  when choice is {
    0 -> update_case()
    1 -> change_controller_case()
    2 -> suspend_case()
    3 -> unsuspend_case()
    4 -> revoke_case()
    5 -> retire_case()
    6 -> reclaim_case()
    7 -> set_successor_case()
    8 -> bump_epoch_case()
    9 -> recover_init_case()
    10 -> recover_cancel_case()
    _ -> recover_finalize_case()
  }
}

/// A valid spend of an action that keeps the record live and does not change
/// its holds (Update, ChangeController, BumpEpoch and the three recovery
/// actions), on a record with at least one hold.
pub fn holds_unchanged_transition() -> Fuzzer<Case> {
  let choice <- fuzz.and_then(fuzz.int_between(0, 5))
  let c <-
    fuzz.and_then(
      when choice is {
        0 -> update_case()
        1 -> change_controller_case()
        2 -> bump_epoch_case()
        3 -> recover_init_case()
        4 -> recover_cancel_case()
        _ -> recover_finalize_case()
      },
    )
  let held <- fuzz.map(held_record())
  Case {
    ..c,
    before: IdentityDatum { ..c.before, status: held.status },
    after: IdentityDatum { ..c.after, status: held.status },
  }
}

// ## The fuzzers give valid spends

/// Every case of `transition()` passes the spend handler. The other
/// properties change one thing in such a case.
test prop_transitions_pass(c via transition()) {
  fuzz.label(action(c.redeemer))
  passes(c)
}

/// The same for `holds_unchanged_transition()`.
test prop_holds_unchanged_transitions_pass(c via holds_unchanged_transition()) {
  fuzz.label(action(c.redeemer))
  and {
    passes(c),
    !terminal(c.after.status),
  }
}
