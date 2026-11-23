//// Property tests of the supplier lists of delegations (Part 2 §5.1 to §5.3):
////
//// - a sub-delegation names suppliers by the narrowing rule: when the parent
////   lists `did` patterns, the child lists `did` patterns too, and each one is
////   a `did` pattern of the parent; `*` never widens a supplier list;
//// - a vault payment funds an escrow only for a supplier that the delegation
////   in use and each of its ancestors name, when they list `did` patterns.
////
//// The fuzzers draw resource lists from the patterns `*` and
//// `script:<escrow hash>` and from three `did` patterns. The narrowing test
//// builds a sub-delegation at depth 2 to 4 and compares the contract with the
//// rule. The payment tests build a chain of depth 1 to 4 whose lists are
//// random (also lists that no real chain has: a parent that is wider than its
//// child) and one to three escrow outputs for random suppliers.

use aiken/collection/list
use aiken/fuzz
use cardano/assets
use cardano/transaction.{Transaction}
use identity_marketplace/delegation/fixtures.{
  agent_id, chain_link, delegation_hash, delegation_id, delegation_input,
  delegation_key, delegation_output, did_a, did_b, did_c, escrow_pattern, hash,
  identity_hash, new_id, now, principal_delegator, records, seed, wallet_input,
}
use identity_marketplace/delegation/handlers.{delegation_mint}
use identity_marketplace/types.{Delegate, DelegationDatum}
use identity_marketplace/vault/tests.{pay_listing}

// ## Resource lists

/// The suppliers: the agent identifier and the `did` pattern of the agent.
fn suppliers() -> List<(ByteArray, ByteArray)> {
  [(agent_id(10), did_a), (agent_id(11), did_b), (agent_id(12), did_c)]
}

fn did_patterns() -> List<ByteArray> {
  [did_a, did_b, did_c]
}

fn is_did_pattern(resource: ByteArray) -> Bool {
  list.has(did_patterns(), resource)
}

// ## Sub-delegation

type Narrowing {
  depth: Int,
  parent: List<ByteArray>,
  child: List<ByteArray>,
}

/// Some of `*` and `script:<escrow hash>`, then some `did` patterns.
fn resource_list() -> Fuzzer<List<ByteArray>> {
  let others <- fuzz.and_then(fuzz.sublist(["*", escrow_pattern]))
  fuzz.map(fuzz.sublist(did_patterns()), fn(dids) { list.concat(others, dids) })
}

fn narrowing() -> Fuzzer<Narrowing> {
  let depth <- fuzz.and_then(fuzz.int_between(2, 4))
  let parent <- fuzz.and_then(resource_list())
  fuzz.map(resource_list(), fn(child) { Narrowing { depth, parent, child } })
}

/// The narrowing rule for resources: each other pattern of the child is `*`
/// or a pattern that the parent holds, or the parent holds `*`; a parent
/// without `did` patterns lets the child list any; else the child lists
/// `did` patterns, all of them in the parent.
fn narrows(parent: List<ByteArray>, child: List<ByteArray>) -> Bool {
  let parent_dids = list.filter(parent, is_did_pattern)
  let child_dids = list.filter(child, is_did_pattern)
  and {
    list.all(
      list.filter(child, fn(pattern) { !is_did_pattern(pattern) }),
      fn(pattern) { list.has(parent, "*") || list.has(parent, pattern) },
    ),
    when parent_dids is {
      [] -> True
      _ ->
        child_dids != [] && list.all(
          child_dids,
          fn(did) { list.has(parent_dids, did) },
        )
    },
  }
}

/// The delegation contract on the sub-delegation of link `depth`, whose
/// parent (link `depth - 1`) and child list the given resources.
fn delegates(n: Narrowing) -> Bool {
  let parent =
    DelegationDatum {
      ..chain_link(n.depth - 1, principal_delegator()),
      resources: n.parent,
    }
  let child =
    DelegationDatum {
      ..chain_link(n.depth, principal_delegator()),
      resources: n.child,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [wallet_input(seed())],
      reference_inputs: [
        delegation_input(delegation_id(n.depth - 1), parent),
        ..records(n.depth - 1, n.depth)
      ],
      outputs: [delegation_output(new_id(), child)],
      mint: assets.from_asset(delegation_hash, new_id(), 1),
      extra_signatories: [
        hash(delegation_key(n.depth - 1)),
        hash(delegation_key(n.depth)),
      ],
      validity_range: now(),
    }
  delegation_mint(identity_hash, Delegate { seed: seed() }, delegation_hash, tx)
}

/// The contract and the rule agree on every pair of lists, at depth 2 to 4.
test prop_sub_delegation_narrows_supplier_lists(n via narrowing()) {
  let allowed = narrows(n.parent, n.child)
  fuzz.label(
    if allowed {
      @"narrower"
    } else {
      @"wider"
    },
  )
  delegates(n) == allowed
}

// ## Payment

type Payment {
  /// The resource list of each link, link 1 first.
  lists: List<List<ByteArray>>,
  /// The suppliers that the escrow outputs pay.
  paid: List<(ByteArray, ByteArray)>,
}

/// `script:<escrow hash>` (the delegation in use must cover the escrow), maybe
/// `*`, then some `did` patterns.
fn payment_list() -> Fuzzer<List<ByteArray>> {
  let star <- fuzz.and_then(fuzz.bool())
  fuzz.map(
    fuzz.sublist(did_patterns()),
    fn(dids) {
      list.concat(
        if star {
          ["*", escrow_pattern]
        } else {
          [escrow_pattern]
        },
        dids,
      )
    },
  )
}

fn payment() -> Fuzzer<Payment> {
  let depth <- fuzz.and_then(fuzz.int_between(1, 4))
  let lists <- fuzz.and_then(fuzz.list_between(payment_list(), depth, depth))
  fuzz.map(
    fuzz.list_between(fuzz.one_of(suppliers()), 1, 3),
    fn(paid) { Payment { lists, paid } },
  )
}

/// Each list that has `did` patterns holds the `did` pattern of each paid
/// supplier.
fn all_named(p: Payment) -> Bool {
  list.all(
    p.lists,
    fn(resources) {
      !list.any(resources, is_did_pattern) || list.all(
        p.paid,
        fn(supplier) { list.has(resources, supplier.2nd) },
      )
    },
  )
}

fn pays(p: Payment) -> Bool {
  pay_listing(
    list.length(p.lists),
    p.lists,
    list.map(p.paid, fn(supplier) { supplier.1st }),
  )
}

fn label_payment(p: Payment) -> Void {
  fuzz.label(
    when list.length(p.lists) is {
      1 -> @"depth 1"
      2 -> @"depth 2"
      3 -> @"depth 3"
      _ -> @"depth 4"
    },
  )
}

/// A payment that leaves a paid supplier out of some list that has `did`
/// patterns.
fn unnamed_payment() -> Fuzzer<Payment> {
  fuzz.such_that(payment(), fn(p) { !all_named(p) })
}

/// A payment whose every list that has `did` patterns names each paid
/// supplier.
fn named_payment() -> Fuzzer<Payment> {
  fuzz.such_that(payment(), all_named)
}

/// No Pay funds an escrow for a supplier that a list of the chain leaves out:
/// not the leaf list, not an ancestor list, and not one output among several.
test prop_pay_never_funds_unnamed_supplier(p via unnamed_payment()) fail {
  label_payment(p)
  pays(p)
}

/// The positive control: when each list that has `did` patterns names every
/// paid supplier, the same Pay passes.
test prop_pay_funds_named_suppliers(p via named_payment()) {
  label_payment(p)
  pays(p)
}
