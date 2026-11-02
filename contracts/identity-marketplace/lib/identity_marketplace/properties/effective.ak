//// Property tests of Part 2 §12.3 for the library function `effective`
//// (Part 2 §3.10, Part 1 §7.3):
////
//// - the effective status of a child is never better than its parent's;
//// - a subagent under an old epoch is Revoked, whatever its own live status.
////
//// The fuzzers build chains of one to five records (a root and up to four
//// subagents) as reference inputs. Each record gets a random status (Active,
//// a hold in force, lapsed holds, a revocation or a retirement tombstone), a
//// random Accountable Party (covering, none, ending inside the window or
//// starting after it), a random `subagent_epoch` and a current or an old
//// `parent_epoch`. The window `[lo, hi]` is at most one hour long.

use aiken/collection/list
use aiken/fuzz
use cardano/transaction.{Input}
use identity_marketplace/identity/kit
use vector_identity.{day_ms, effective, max_depth, max_range_ms}
use vector_identity/types.{
  Active, ControllerSet, EffActive, EffRetired, EffRevoked, EffSuspended,
  Effective, Hold, IdentityDatum, Party, Retired, Revoked, Status, Subagent,
  Suspended,
}

// ## Chains

/// The form of one record of a chain.
type Shape {
  /// 0 Active, 1 a hold in force, 2 lapsed holds, 3 Revoked, 4 Retired.
  status: Int,
  /// 0 an Accountable Party covers the window, 1 no party, 2 the party ends
  /// inside the window, 3 the party starts after `lo`.
  accountable: Int,
  subagent_epoch: Int,
  /// For a subagent: 0 an old `parent_epoch` (one less than the parent's
  /// `subagent_epoch`, when that is at least 1), else the current one.
  link: Int,
}

type Chain {
  /// Root first.
  shapes: List<Shape>,
  lo: Int,
  hi: Int,
}

/// Every status, with more weight on the live ones.
const any_status: List<Int> = [0, 0, 0, 1, 2, 2, 3, 4]

const live_status: List<Int> = [0, 0, 1, 2]

fn shape(statuses: List<Int>) -> Fuzzer<Shape> {
  fuzz.map4(
    fuzz.one_of(statuses),
    fuzz.one_of([0, 0, 0, 1, 2, 3]),
    fuzz.int_between(0, 3),
    fuzz.one_of([0, 1, 1, 1, 1]),
    fn(status, accountable, subagent_epoch, link) {
      Shape { status, accountable, subagent_epoch, link }
    },
  )
}

fn shapes(statuses: List<Int>, count: Int) -> Fuzzer<List<Shape>> {
  fuzz.list_between(shape(statuses), count, count)
}

fn window(chain_shapes: List<Shape>) -> Fuzzer<Chain> {
  let width <- fuzz.map(fuzz.int_between(0, max_range_ms))
  Chain { shapes: chain_shapes, lo: kit.lo, hi: kit.lo + width }
}

/// A chain of one to five records with random shapes.
fn chain() -> Fuzzer<Chain> {
  let count <- fuzz.and_then(fuzz.int_between(1, max_depth + 1))
  let chain_shapes <- fuzz.and_then(shapes(any_status, count))
  window(chain_shapes)
}

/// A chain of two to five records whose link `old` (from 1) has an old
/// epoch: the parent's `subagent_epoch` is at least 1 and the child's
/// `parent_epoch` is one less. The records from that child down to the parent
/// of the leaf are live; the leaf has any status. Returns the chain and
/// `old`.
fn old_epoch_chain() -> Fuzzer<(Chain, Int)> {
  let above <- fuzz.and_then(fuzz.int_between(0, max_depth - 1))
  let below <- fuzz.and_then(fuzz.int_between(0, max_depth - 1 - above))
  let upper <- fuzz.and_then(shapes(any_status, above))
  let parent <- fuzz.and_then(shape(any_status))
  let parent_epoch <- fuzz.and_then(fuzz.int_between(1, 3))
  let middle <- fuzz.and_then(shapes(live_status, below))
  let leaf <- fuzz.and_then(shape(any_status))
  expect [child, ..rest] = list.concat(middle, [leaf])
  let chain_shapes =
    list.concat(
      upper,
      [
        Shape { ..parent, subagent_epoch: parent_epoch },
        Shape { ..child, link: 0 },
        ..rest
      ],
    )
  let c <- fuzz.map(window(chain_shapes))
  (c, above + 1)
}

// ## Records

/// The record at `index` of the chain: `kit.record()` controlled by
/// `kit.other_controller`, with the shape's status, party and epoch. A
/// subagent names the record at `index - 1` as its parent, with
/// `parent_epoch`.
fn record_at(index: Int, s: Shape, parent_epoch: Int, c: Chain) -> IdentityDatum {
  let base = kit.record()
  let party = kit.accountable(ControllerSet)
  let parties =
    when s.accountable is {
      0 -> [party]
      1 -> []
      2 ->
        [
          Party {
            ..party,
            not_before: c.lo - day_ms,
            not_after: Some(c.hi - 1),
          },
        ]
      _ -> [Party { ..party, not_before: c.lo + 1 }]
    }
  let live =
    if index == 0 {
      IdentityDatum {
        ..base,
        controller: kit.other_controller,
        parties,
        subagent_epoch: s.subagent_epoch,
      }
    } else {
      IdentityDatum {
        ..base,
        controller: kit.other_controller,
        parties,
        subagent_epoch: s.subagent_epoch,
        endpoint: "",
        lineage: Subagent {
          parent: kit.chain_id(index - 1),
          parent_epoch,
          depth: index,
        },
      }
    }
  let ended_at = c.lo - day_ms
  when s.status is {
    0 -> IdentityDatum { ..live, status: Active }
    1 -> IdentityDatum { ..live, status: held(c.hi + 1) }
    2 -> IdentityDatum { ..live, status: held(c.lo) }
    3 ->
      kit.tombstone(
        live,
        Revoked {
          by: ControllerSet,
          reason: 5,
          at: ended_at,
          invalid_from: None,
          successor: None,
        },
      )
    _ -> kit.tombstone(live, Retired { at: ended_at, successor: None })
  }
}

/// Suspended with one hold by the controller that ends at `until`.
fn held(until: Int) -> Status {
  Suspended {
    holds: [Hold { by: ControllerSet, reason: 6, since: until - day_ms, until }],
  }
}

fn records(c: Chain) -> List<IdentityDatum> {
  link_records(c, c.shapes, 0, 0)
}

/// The records from `index` on; `epoch` is the `subagent_epoch` of the record
/// at `index - 1`.
fn link_records(
  c: Chain,
  rest: List<Shape>,
  index: Int,
  epoch: Int,
) -> List<IdentityDatum> {
  when rest is {
    [] -> []
    [s, ..others] -> {
      let parent_epoch =
        if s.link == 0 && epoch >= 1 {
          epoch - 1
        } else {
          epoch
        }
      [
        record_at(index, s, parent_epoch, c),
        ..link_records(c, others, index + 1, s.subagent_epoch)
      ]
    }
  }
}

fn refs(datums: List<IdentityDatum>) -> List<Input> {
  list.indexed_map(
    datums,
    fn(index, d) { kit.record_input(10 + index, kit.chain_id(index), d) },
  )
}

/// The effective status of every record of the chain, root first.
fn effectives(c: Chain) -> List<Effective> {
  let datums = records(c)
  let inputs = refs(datums)
  list.map(datums, fn(d) { effective(d, inputs, kit.own, c.lo, c.hi) })
}

// ## Properties

/// Active 0, Suspended 1, Revoked and Retired 2: a higher rank is worse.
fn rank(e: Effective) -> Int {
  when e is {
    EffActive -> 0
    EffSuspended -> 1
    EffRevoked -> 2
    EffRetired -> 2
  }
}

fn never_better(statuses: List<Effective>) -> Bool {
  when statuses is {
    [parent, child, ..rest] ->
      rank(child) >= rank(parent) && never_better([child, ..rest])
    _ -> True
  }
}

/// Part 2 §12.3: the effective status of a child is never better than its
/// parent's, at every link of the chain.
test prop_child_never_better_than_parent(c via chain()) {
  let statuses = effectives(c)
  expect Some(leaf) = list.last(statuses)
  fuzz.label(
    when leaf is {
      EffActive -> @"leaf Active"
      EffSuspended -> @"leaf Suspended"
      EffRevoked -> @"leaf Revoked"
      EffRetired -> @"leaf Retired"
    },
  )
  never_better(statuses)
}

/// Part 2 §12.3: a subagent under an old epoch is Revoked, whatever its own
/// live status, and so is every live record below it. A tombstone keeps its
/// own status (Part 1 §7.3, rule 1): a retired leaf stays Retired.
test prop_old_epoch_subagent_is_revoked(case via old_epoch_chain()) {
  let (c, old) = case
  let below = list.drop(c.shapes, old)
  expect Some(leaf) = list.last(below)
  fuzz.label(
    when leaf.status is {
      3 -> @"leaf revoked tombstone"
      4 -> @"leaf retired tombstone"
      _ -> @"leaf live"
    },
  )
  list.all(
    list.zip(below, list.drop(effectives(c), old)),
    fn(pair) {
      let (s, e) = pair
      if s.status == 4 {
        e == EffRetired
      } else {
        e == EffRevoked
      }
    },
  )
}
