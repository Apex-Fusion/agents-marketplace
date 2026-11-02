//// Property tests of Part 2 §12.3 for the spend rules of the identity
//// contract (§3.5–§3.7):
////
//// - no sequence of valid transactions moves a tombstone back to a live
////   status;
//// - no sequence changes `created_at` or the token name;
//// - no path lets anybody except the controller reduce a record's value;
//// - no action by one author removes or shortens the hold in force of another
////   current author.
////
//// Each "never" property starts from a valid spend (`transitions`), changes
//// one thing and expects the spend handler to reject every case (`fail`
//// properties). One step is enough for "no sequence": every valid step keeps
//// the invariant, so every sequence of valid steps keeps it.

use aiken/collection/list
use aiken/fuzz
use cardano/assets
use identity_marketplace/identity/kit
use identity_marketplace/identity/rules.{terminal, tombstone}
use identity_marketplace/properties/transitions.{
  Case, action, actors, author_pool, base_record, holds_of,
  holds_unchanged_transition, live_record, passes, random_hold, random_holds,
  reclaim_case, run, set_successor_case, suspend_of, transition, tx_with_output,
  unsuspend_of, with_holds,
}
use vector_identity.{day_ms, days_7_ms, right_suspend}
use vector_identity/types.{
  Active, ControllerSet, Hold, IdentityDatum, KeyHash, Party, Retired, Revoked,
  Script, Signer, Status,
}

// ## Tombstones

/// Every key that can authorise something in these tests: the controllers,
/// the party keys 1 to 13 and the successor's controller.
fn every_signer() -> List<ByteArray> {
  list.concat(
    [
      kit.hash(kit.controller),
      kit.hash(kit.new_controller),
      kit.hash(kit.other_controller),
    ],
    list.map(list.range(1, 13), kit.pkh),
  )
}

/// A terminal status for the tombstone of `d`.
fn ended_status(d: IdentityDatum) -> Fuzzer<Status> {
  let kind <- fuzz.and_then(fuzz.int_between(0, 3))
  let days <- fuzz.and_then(fuzz.int_between(1, 30))
  let named <- fuzz.map(fuzz.bool())
  let at = kit.lo - days * day_ms
  let successor =
    if named {
      Some(kit.successor_id)
    } else {
      None
    }
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
        reason: 1,
        at,
        invalid_from: Some(d.created_at),
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
  }
}

/// A tombstone, any spend redeemer, and a live `D'`: the record before it
/// ended, the tombstone made Active or Suspended again, or the `D'` of a valid
/// spend of a live record. The transaction has every signer, the Module-1
/// withdrawal and the successor reference input, and the value stays.
fn revival() -> Fuzzer<Case> {
  let c <- fuzz.and_then(transition())
  let live <- fuzz.and_then(live_record())
  let status <- fuzz.and_then(ended_status(live))
  let holds <- fuzz.and_then(random_holds([ControllerSet, kit.signer(1)]))
  let choice <- fuzz.map(fuzz.int_between(0, 3))
  let ended = tombstone(live, status)
  let after =
    when choice is {
      0 -> live
      1 -> IdentityDatum { ..ended, status: Active }
      2 -> with_holds(ended, holds)
      _ ->
        if terminal(c.after.status) {
          live
        } else {
          IdentityDatum { ..c.after, created_at: ended.created_at }
        }
    }
  Case {
    ..c,
    before: ended,
    after,
    signers: every_signer(),
    module1: True,
    successor: True,
    output_ap3x: c.input_ap3x,
  }
}

/// Part 2 §12.3: no spend moves a tombstone to a live status.
test prop_tombstone_never_returns_to_live(c via revival()) fail {
  fuzz.label(action(c.redeemer))
  passes(c)
}

/// Part 2 §12.3, the other half: the two spends that a tombstone allows
/// (Reclaim and SetSuccessor, §3.5 rule 4) pass, and their `D'` is still a
/// tombstone with the same `created_at`. Together with the property above,
/// every valid spend of a tombstone gives a tombstone.
test prop_tombstone_spends_stay_terminal(
  c via fuzz.either(reclaim_case(), set_successor_case()),
) {
  fuzz.label(action(c.redeemer))
  and {
    passes(c),
    terminal(c.before.status),
    terminal(c.after.status),
    c.after.created_at == c.before.created_at,
  }
}

// ## `created_at` and the token name

/// A valid spend and a time difference of 1 ms to 400 days, either sign.
fn created_at_change() -> Fuzzer<(Case, Int)> {
  let c <- fuzz.and_then(transition())
  let size <- fuzz.and_then(fuzz.int_between(1, 400 * day_ms))
  let later <- fuzz.map(fuzz.bool())
  (
    c,
    if later {
      size
    } else {
      -size
    },
  )
}

/// Part 2 §12.3: no spend changes `created_at`.
test prop_created_at_never_changes(case via created_at_change()) fail {
  let (c, delta) = case
  fuzz.label(action(c.redeemer))
  passes(
    Case {
      ..c,
      after: IdentityDatum { ..c.after, created_at: c.after.created_at + delta },
    },
  )
}

/// A valid spend, a 32-byte name other than `kit.record_id` and one of three
/// token changes.
fn token_change() -> Fuzzer<(Case, ByteArray, Int)> {
  let c <- fuzz.and_then(transition())
  let name <-
    fuzz.and_then(
      fuzz.such_that(fuzz.bytearray(), fn(n) { n != kit.record_id }),
    )
  let change <- fuzz.map(fuzz.int_between(0, 2))
  (c, name, change)
}

/// Part 2 §12.3: no spend changes the token name. The record output holds
/// the token under another name, a second token of the policy, or the name
/// under another policy.
test prop_token_name_never_changes(case via token_change()) fail {
  let (c, name, change) = case
  let ap3x = assets.from_lovelace(c.output_ap3x)
  let value =
    when change is {
      0 -> assets.add(ap3x, kit.own, name, 1)
      1 ->
        assets.add(
          kit.record_value(kit.record_id, c.output_ap3x),
          kit.own,
          name,
          1,
        )
      _ -> assets.add(ap3x, kit.other_script, kit.record_id, 1)
    }
  fuzz.label(
    when change is {
      0 -> @"other name"
      1 -> @"second name"
      _ -> @"other policy"
    },
  )
  run(c, tx_with_output(c, value))
}

// ## Value

/// A valid spend without the controller's signature, and an amount to take.
fn value_cut() -> Fuzzer<(Case, Int)> {
  let c <- fuzz.and_then(transition())
  let cut <- fuzz.map(fuzz.int_between(1, c.input_ap3x - 10_000_000 + 1))
  (c, cut)
}

/// Part 2 §12.3: without the controller's signature, no spend reduces the
/// record's AP3X. The case keeps every other signer of the valid spend.
test prop_only_controller_reduces_value(case via value_cut()) fail {
  let (c, cut) = case
  let controller = kit.hash(kit.controller)
  fuzz.label(
    if list.has(c.signers, controller) {
      @"controller signature removed"
    } else {
      @"no controller signature needed"
    },
  )
  passes(
    Case {
      ..c,
      signers: list.filter(c.signers, fn(s) { s != controller }),
      output_ap3x: c.input_ap3x - cut,
    },
  )
}

// ## Holds of other authors

/// A Suspend or an Unsuspend by `author`, on a record that has a hold in
/// force (`victim`) of another current author.
type HoldCase {
  case: Case,
  author: Signer,
  victim: Hold,
}

/// The current authors of a record (§3.2): the controller, each party's
/// signer and Module-1 (any `Script` signer).
fn current_authors(d: IdentityDatum) -> List<Signer> {
  list.foldl(
    d.parties,
    [ControllerSet, kit.module1()],
    fn(party: Party, authors: List<Signer>) {
      if list.has(authors, party.signer) {
        authors
      } else {
        list.concat(authors, [party.signer])
      }
    },
  )
}

/// A hold in force of `by` that ends 1 to 20 days after `lo`.
fn hold_in_force(by: Signer) -> Fuzzer<Hold> {
  let until <- fuzz.map(fuzz.int_between(kit.lo + day_ms, kit.lo + 20 * day_ms))
  Hold {
    by,
    reason: if by == kit.module1() {
      64
    } else {
      6
    },
    since: until - days_7_ms,
    until,
  }
}

fn hold_case() -> Fuzzer<HoldCase> {
  let base <- fuzz.and_then(base_record())
  let a <- fuzz.and_then(fuzz.one_of(actors(base, right_suspend)))
  let victim_by <-
    fuzz.and_then(
      fuzz.one_of(list.filter(current_authors(base), fn(s) { s != a.author })),
    )
  let victim <- fuzz.and_then(hold_in_force(victim_by))
  let own <- fuzz.and_then(random_hold(a.author))
  let others <-
    fuzz.and_then(
      fuzz.sublist(
        list.filter(author_pool(), fn(s) { s != a.author && s != victim_by }),
      ),
    )
  // At most 8 more holds, so the record has at most 10.
  let other_holds <- fuzz.and_then(random_holds(list.take(others, 8)))
  let position <- fuzz.and_then(fuzz.int_between(0, list.length(other_holds)))
  let unsuspend <- fuzz.and_then(fuzz.bool())
  let d =
    with_holds(
      base,
      [
        own,
        ..list.concat(
          list.take(other_holds, position),
          [victim, ..list.drop(other_holds, position)],
        )
      ],
    )
  let c <-
    fuzz.map(
      if unsuspend {
        unsuspend_of(d, a.author)
      } else {
        suspend_of(d, a)
      },
    )
  HoldCase { case: c, author: a.author, victim }
}

/// The spec text of the property, without the contract's helpers: each hold
/// of `d` in force (`until > lo`) whose author is a current author other than
/// `author` is in `d2` with the same `until` or a later one.
fn other_holds_kept(d: IdentityDatum, d2: IdentityDatum, author: Signer) -> Bool {
  let current =
    fn(by: Signer) {
      when by is {
        ControllerSet -> True
        Script { .. } -> True
        KeyHash { .. } -> list.any(d.parties, fn(p) { p.signer == by })
      }
    }
  list.all(
    holds_of(d.status),
    fn(h) {
      or {
        h.until <= kit.lo,
        h.by == author,
        !current(h.by),
        list.any(
          holds_of(d2.status),
          fn(h2) { h2.by == h.by && h2.until >= h.until },
        ),
      }
    },
  )
}

fn label_hold_case(hc: HoldCase) -> Void {
  fuzz.label(
    when hc.victim.by is {
      ControllerSet -> @"victim: controller hold"
      Script { .. } -> @"victim: Module-1 hold"
      KeyHash { .. } -> @"victim: party hold"
    },
  )
}

/// Part 2 §12.3: every valid Suspend and Unsuspend keeps the holds in force
/// of the other current authors.
test prop_other_authors_holds_kept(hc via hold_case()) {
  label_hold_case(hc)
  and {
    passes(hc.case),
    other_holds_kept(hc.case.before, hc.case.after, hc.author),
  }
}

/// The holds of `d` with `change` applied to the hold of `by`; Active when
/// none remains.
fn change_hold(
  d: IdentityDatum,
  by: Signer,
  change: fn(Hold) -> Option<Hold>,
) -> IdentityDatum {
  with_holds(
    d,
    list.filter_map(
      holds_of(d.status),
      fn(h) {
        if h.by == by {
          change(h)
        } else {
          Some(h)
        }
      },
    ),
  )
}

/// Part 2 §12.3: a Suspend or an Unsuspend that also removes the hold in
/// force of another current author fails.
test prop_other_authors_holds_never_removed(hc via hold_case()) fail {
  label_hold_case(hc)
  let c = hc.case
  passes(
    Case { ..c, after: change_hold(c.after, hc.victim.by, fn(_) { None }) },
  )
}

/// A hold case and a shorter `until` for the victim, after `lo`.
fn shortened() -> Fuzzer<(HoldCase, Int)> {
  let hc <- fuzz.and_then(hold_case())
  let until <- fuzz.map(fuzz.int_between(kit.lo + 1, hc.victim.until - 1))
  (hc, until)
}

/// Part 2 §12.3: a Suspend or an Unsuspend that also shortens the hold in
/// force of another current author fails.
test prop_other_authors_holds_never_shortened(case via shortened()) fail {
  let (hc, until) = case
  label_hold_case(hc)
  let c = hc.case
  passes(
    Case {
      ..c,
      after: change_hold(
        c.after,
        hc.victim.by,
        fn(h) { Some(Hold { ..h, until }) },
      ),
    },
  )
}

/// A spend that keeps the holds (Update, ChangeController, BumpEpoch and the
/// three recovery actions) on a record with a hold in force of an author other
/// than the controller, and whether to remove that hold or shorten it.
fn untouched_holds() -> Fuzzer<(Case, Hold, Bool)> {
  let c <- fuzz.and_then(holds_unchanged_transition())
  let by <-
    fuzz.and_then(
      fuzz.one_of(list.filter(author_pool(), fn(s) { s != ControllerSet })),
    )
  let victim <- fuzz.and_then(hold_in_force(by))
  let remove <- fuzz.map(fuzz.bool())
  // The victim and at most 9 other holds.
  let holds =
    [
      victim,
      ..list.take(
        list.filter(holds_of(c.before.status), fn(h) { h.by != by }),
        9,
      )
    ]
  (
    Case {
      ..c,
      before: with_holds(c.before, holds),
      after: with_holds(c.after, holds),
    },
    victim,
    remove,
  )
}

/// Part 2 §12.3: the actions that do not set holds (Update, ChangeController,
/// BumpEpoch and the recovery actions) remove or shorten no hold in force.
test prop_other_actions_never_touch_holds(case via untouched_holds()) fail {
  let (c, victim, remove) = case
  fuzz.label(action(c.redeemer))
  passes(
    Case {
      ..c,
      after: change_hold(
        c.after,
        victim.by,
        fn(h) {
          if remove {
            None
          } else {
            Some(Hold { ..h, until: kit.lo + 1 })
          }
        },
      ),
    },
  )
}
